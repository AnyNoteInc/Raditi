'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import type { ProjectStack } from '@/components/projects/project-labels'
import {
  CheckProblem,
  HostKeyPanel,
  type HostKeyPrompt,
} from '@/components/projects/wizard/check-panels'
import { callErrorText, sourceReasonText } from '@/components/projects/wizard/reason-text'
import { sourceFieldId, SourceFields } from '@/components/projects/wizard/source-fields'
import {
  emptySource,
  firstProblem,
  pinnedHostKey,
  sourceErrors,
  sourceFieldOrder,
  sourceInput,
  type CheckRefusal,
  type PublicSource,
  type SourceDraft,
} from '@/components/projects/wizard/wizard-model'
import { useTRPC } from '@/trpc/client'

/**
 * A changed access of a working site becomes the site's variables again, as at creation (owner's
 * decision of 26.10.2026): the panel says so, as the last step of the wizard does.
 */
export const ACCESS_VARIABLES_NOTE =
  'Новый доступ мы сохраним и как переменные сайта, как при добавлении проекта: их получат команды агента и предпросмотр. Это можно отключить в списке переменных.'

const FIELDS = 'replace-access'
const PROBLEM = 'replace-access-problem'
const HOST_KEY_TITLE = 'replace-access-host-key-title'
export const REPLACE_ACCESS_TITLE = 'replace-access-title'

/**
 * «Изменить доступ» on a failed setup, and «Изменить» of the access to the files of a working site
 * (`working`, «Переменные → Доступы»): the fields of the wizard's second step, started from the
 * public part of the saved source — kind, server, port, folder, protection — and never from a
 * secret. The same SSH server and port must present the key confirmed for it before: the
 * replacement goes with that key, so a server that presents another answers «Ключ сервера
 * изменился», and the new key is taken only by its own button (`acceptNewHostKey`). Another
 * server or port is a first check: a check without a key learns its key and logs in nowhere.
 * The server checks the access once more and writes it only if the connection with it passed.
 */
export function ReplaceAccessForm({
  siteId,
  stack,
  platform,
  saved,
  working = false,
  titleId,
  onBusyChange,
  onCancel,
  onReplaced,
}: {
  siteId: string
  stack: ProjectStack
  platform: string
  saved: PublicSource | null
  /** A site that works: the access is changed by `changeSource`, and no import is queued. */
  working?: boolean
  /** Inside a panel whose heading has this id: the form has no heading of its own. */
  titleId?: string
  /** A check or a save is on its way, or no longer: a panel holds still meanwhile. */
  onBusyChange?: (busy: boolean) => void
  onCancel: () => void
  onReplaced: () => void
}) {
  const trpc = useTRPC()
  const [source, setSource] = useState<SourceDraft>(() => emptySource(saved))
  /** The key the server must present: the saved one for the saved server, or one the user confirmed. */
  const [hostKey, setHostKey] = useState<string | null>(() =>
    pinnedHostKey(emptySource(saved), saved),
  )
  /** The user took a key other than the saved one by «Принять новый ключ». */
  const [keyChangeAccepted, setKeyChangeAccepted] = useState(false)
  const [keyPrompt, setKeyPrompt] = useState<HostKeyPrompt | null>(null)
  const [shown, setShown] = useState(false)
  const [problem, setProblem] = useState<{ text: string; suggestedRoot?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const alive = useRef(true)
  const heading = titleId ?? REPLACE_ACCESS_TITLE
  const focusNext = useRef<string | null>(heading)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    const id = focusNext.current
    if (id === null) return
    focusNext.current = null
    document.getElementById(id)?.focus()
  })

  const gcTime = { gcTime: 0 }
  const checkSource = useMutation(trpc.siteConnection.checkSource.mutationOptions(gcTime))
  const replaceAccess = useMutation(trpc.siteConnection.replaceAccess.mutationOptions(gcTime))
  const changeSource = useMutation(trpc.siteConnection.changeSource.mutationOptions(gcTime))
  const save = working ? changeSource : replaceAccess

  function markBusy(value: boolean) {
    busyRef.current = value
    if (alive.current) setBusy(value)
    onBusyChange?.(value)
  }

  function edit(next: SourceDraft) {
    // Another server is another key: the saved one belongs to the saved server and port only.
    if (next.sftp.host !== source.sftp.host || next.sftp.port !== source.sftp.port) {
      setHostKey(pinnedHostKey(next, saved))
      setKeyChangeAccepted(false)
    }
    setSource(next)
    setKeyPrompt(null)
    setProblem(null)
  }

  function refuse(refusal: CheckRefusal) {
    if (
      (refusal.reason === 'host_key_unknown' || refusal.reason === 'host_key_changed') &&
      refusal.hostKey
    ) {
      setKeyPrompt({
        kind: refusal.reason === 'host_key_unknown' ? 'unknown' : 'changed',
        hostKey: refusal.hostKey,
      })
      focusNext.current = HOST_KEY_TITLE
      return
    }
    setProblem({
      text: sourceReasonText(refusal.reason, { kind: source.kind, platform }),
      ...(refusal.reason === 'not_site_root' && refusal.suggestedRoot
        ? { suggestedRoot: refusal.suggestedRoot }
        : {}),
    })
    focusNext.current = PROBLEM
  }

  async function run(key: string | null, acceptNewHostKey: boolean) {
    if (busyRef.current) return
    markBusy(true)
    setProblem(null)
    setKeyPrompt(null)
    try {
      // SSH without a confirmed key: learn the key first; a check without one logs in nowhere, so
      // the password reaches the client's server only after the user compared the key.
      if (source.kind === 'sftp' && key === null) {
        const outcome = await checkSource.mutateAsync({ stack, source: sourceInput(source, null) })
        if (!alive.current) return
        if (!outcome.ok) return refuse(outcome)
        if (outcome.hostKey === null) return refuse({ reason: 'unsupported' })
        key = outcome.hostKey
        setHostKey(key)
      }
      const outcome = await save.mutateAsync({
        id: siteId,
        source: sourceInput(source, key),
        ...(acceptNewHostKey ? { acceptNewHostKey: true } : {}),
      })
      if (!alive.current) return
      if (outcome.outcome === 'replaced') onReplaced()
      else refuse(outcome)
    } catch (error) {
      if (!alive.current) return
      setProblem({
        text: callErrorText(error, {
          invalid: 'Проверьте данные доступа: сервер, порт, пользователя и папку сайта.',
          failed: 'Не удалось сохранить доступ. Попробуйте ещё раз.',
        }),
      })
      focusNext.current = PROBLEM
    } finally {
      checkSource.reset()
      save.reset()
      markBusy(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busyRef.current) return
    setShown(true)
    const field = firstProblem(sourceFieldOrder, sourceErrors(source))
    if (field) {
      // At once: a second press with nothing fixed renders nothing, and a move left for the
      // next render would pull the cursor out of whatever field the user types in next.
      focusNext.current = null
      document.getElementById(sourceFieldId(FIELDS, field))?.focus()
      setProblem(null)
      return
    }
    if (source.kind === 'sftp') void run(hostKey, keyChangeAccepted)
    else void run(null, false)
  }

  return (
    <Box
      component="form"
      noValidate
      onSubmit={submit}
      aria-labelledby={heading}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}
    >
      <Box>
        {titleId === undefined ? (
          <Typography
            component="h3"
            id={REPLACE_ACCESS_TITLE}
            tabIndex={-1}
            sx={{ fontSize: 17, fontWeight: 600, outline: 'none', mb: 0.5 }}
          >
            Новый доступ к файлам
          </Typography>
        ) : null}
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>
          {working
            ? 'Пароли и ключи мы не показываем: введите их заново. Сначала мы подключимся с новым доступом и сохраним его, только если подключение пройдёт, — тогда он заменит прежний.'
            : 'Пароли и ключи мы не показываем: введите их заново. Новый доступ заменит прежний.'}
        </Typography>
        {working ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.6 }}>
            {ACCESS_VARIABLES_NOTE}
          </Typography>
        ) : null}
      </Box>
      <SourceFields
        idPrefix={FIELDS}
        value={source}
        onChange={edit}
        errors={shown ? sourceErrors(source) : {}}
        disabled={busy}
      />
      {keyPrompt ? (
        <HostKeyPanel
          titleId={HOST_KEY_TITLE}
          prompt={keyPrompt}
          onAccept={() => {
            if (busyRef.current) return
            const changed = keyPrompt.kind === 'changed'
            setHostKey(keyPrompt.hostKey)
            setKeyChangeAccepted(changed)
            void run(keyPrompt.hostKey, changed)
          }}
          disabled={busy}
        />
      ) : null}
      {problem ? (
        <CheckProblem
          id={PROBLEM}
          text={problem.text}
          suggestedRoot={problem.suggestedRoot}
          onUseRoot={(root) => {
            edit(
              source.kind === 'ftp'
                ? { ...source, ftp: { ...source.ftp, rootPath: root } }
                : { ...source, sftp: { ...source.sftp, rootPath: root } },
            )
            focusNext.current = sourceFieldId(FIELDS, 'rootPath')
          }}
          disabled={busy}
        />
      ) : null}
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column-reverse', sm: 'row' },
          alignItems: { xs: 'stretch', sm: 'center' },
          gap: 1.5,
        }}
      >
        <Button color="inherit" onClick={onCancel} disabled={busy}>
          Отмена
        </Button>
        <Typography
          role="status"
          variant="body2"
          color="text.secondary"
          sx={{ flex: 1, textAlign: { xs: 'center', sm: 'right' }, minHeight: '1.43em' }}
        >
          {busy ? 'Проверяем подключение…' : ''}
        </Typography>
        <Button type="submit" variant="contained" loading={busy} loadingPosition="end">
          Сохранить доступ
        </Button>
      </Box>
    </Box>
  )
}
