'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'

import type { ProjectStack } from '@/components/projects/project-labels'
import { CheckProblem } from '@/components/projects/wizard/check-panels'
import { databaseFieldId, DatabaseFields } from '@/components/projects/wizard/database-fields'
import { callErrorText, databaseReasonText } from '@/components/projects/wizard/reason-text'
import {
  databaseErrors,
  databaseFieldOrder,
  databaseInput,
  firstProblem,
  type DatabaseDraft,
  type PublicSource,
} from '@/components/projects/wizard/wizard-model'
import { formatMoscowMoment } from '@/lib/moscow-date'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { ACCESS_VARIABLES_NOTE, ReplaceAccessForm } from './replace-access'
import { SectionTitle } from './section-empty'
import { SiteCard } from './site-cards'
import { accessFieldsOf, accessLabel, accessPurpose } from './site-format'
import { SiteSidePanel } from './site-side-panel'

type Access = { kind: string; version: number; updatedAt: Date }

/** `siteConnection.editableAccess`: who may change an access, why not now, and what a form starts from. */
export interface EditableAccessView {
  canChange: boolean
  busy: 'release' | 'unresolved' | 'setup' | null
  source: (PublicSource & { kind: 'sftp' | 'ftp' | 'git' }) | null
  database: {
    engine: 'mysql' | 'postgres'
    host: string
    port: number
    databaseName: string
    tls: DatabaseDraft['tls']
  } | null
}

/** The form a change opens: of the access to the files, or of the one to the database. */
type Changing = 'files' | 'database'

export const accessText = Object.freeze({
  title: 'Доступы',
  note: 'Пароли и ключи лежат в защищённом хранилище. После сохранения посмотреть их нельзя — ни вам, ни нам в этом кабинете. Здесь видно, какие параметры записаны, для чего и когда.',
  change: 'Изменить',
  files: 'Изменить доступ к файлам',
  database: 'Изменить доступ к базе данных',
  savedFiles: 'Доступ к файлам проверен и сохранён.',
  savedDatabase: 'Доступ к базе данных проверен и сохранён.',
  busy: {
    release: 'Сейчас идёт выпуск новой версии сайта. Изменить доступ можно, когда он закончится.',
    unresolved:
      'Мы проверяем, чем закончился последний выпуск сайта. Изменить доступ можно, когда проверка закончится.',
    setup: 'Сайт ещё настраивается. Изменить доступ можно, когда настройка закончится.',
  },
  managersOnly: 'Изменить доступ могут владелец и администраторы.',
  footer:
    'Запись в списке значит, что доступ сохранён и проверен при сохранении. Новый доступ сохраняется, только если с ним удалось подключиться.',
})

/** The access to the files is stored by the kind of its source: SFTP as `ssh`, FTP as `ftp`. */
const fileAccessKind = (source: EditableAccessView['source']) =>
  source?.kind === 'sftp' ? 'ssh' : source?.kind === 'ftp' ? 'ftp' : null

function changingOf(kind: string, editable: EditableAccessView | null): Changing | null {
  if (!editable?.canChange) return null
  if (kind === fileAccessKind(editable.source)) return 'files'
  if (kind === 'db' && editable.database) return 'database'
  return null
}

const columns = '170px minmax(0, 0.8fr) minmax(0, 1.8fr) 130px 112px'
const DATABASE_FIELDS = 'change-database'
const DATABASE_PROBLEM = 'change-database-problem'

/**
 * The new login and password of the database of a working site: the server, the port, the name and
 * the protection start from what is saved, the user and the password are typed anew. Saved only if
 * `SELECT 1` passed with them (`siteConnection.changeDatabase`).
 */
function DatabaseAccessForm({
  siteId,
  titleId,
  saved,
  onBusyChange,
  onCancel,
  onChanged,
}: {
  siteId: string
  titleId: string
  saved: NonNullable<EditableAccessView['database']>
  onBusyChange: (busy: boolean) => void
  onCancel: () => void
  onChanged: () => void
}) {
  const trpc = useTRPC()
  const [draft, setDraft] = useState<DatabaseDraft>(() => ({
    engine: saved.engine,
    host: saved.host,
    port: String(saved.port),
    portTouched: true,
    database: saved.databaseName,
    username: '',
    password: '',
    tls: saved.tls,
  }))
  const [shown, setShown] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const alive = useRef(true)
  const focusNext = useRef<string | null>(titleId)
  const change = useMutation(trpc.siteConnection.changeDatabase.mutationOptions({ gcTime: 0 }))

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

  function markBusy(value: boolean) {
    busyRef.current = value
    if (alive.current) setBusy(value)
    onBusyChange(value)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busyRef.current) return
    setShown(true)
    const field = firstProblem(databaseFieldOrder, databaseErrors(draft))
    if (field) {
      document.getElementById(databaseFieldId(DATABASE_FIELDS, field))?.focus()
      setProblem(null)
      return
    }
    const database = databaseInput(draft)
    if (database === null) return
    markBusy(true)
    setProblem(null)
    try {
      const outcome = await change.mutateAsync({ id: siteId, database })
      if (!alive.current) return
      if (outcome.outcome === 'replaced') return onChanged()
      setProblem(databaseReasonText(outcome.reason))
      focusNext.current = DATABASE_PROBLEM
    } catch (error) {
      if (!alive.current) return
      setProblem(
        callErrorText(error, {
          invalid: 'Проверьте данные базы: сервер, порт, имя базы и пользователя.',
          failed: 'Не удалось сохранить доступ. Попробуйте ещё раз.',
        }),
      )
      focusNext.current = DATABASE_PROBLEM
    } finally {
      change.reset()
      markBusy(false)
    }
  }

  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-labelledby={titleId}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}
    >
      <Box>
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>
          Пароль мы не показываем: введите пользователя и пароль заново. Сначала мы подключимся к
          базе с новыми данными и сохраним их, только если подключение пройдёт, — тогда они заменят
          прежние.
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.6 }}>
          {ACCESS_VARIABLES_NOTE}
        </Typography>
      </Box>
      <DatabaseFields
        idPrefix={DATABASE_FIELDS}
        value={draft}
        onChange={(next) => {
          setDraft(next)
          setProblem(null)
        }}
        errors={shown ? databaseErrors(draft) : {}}
        disabled={busy}
        required
      />
      {problem ? <CheckProblem id={DATABASE_PROBLEM} text={problem} disabled={busy} /> : null}
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

/**
 * «Доступы», a block of «Переменные»: which accesses are saved — of each its kind, what it is for,
 * the parts it is made of, its version and date; the values live in the vault and never come back. An
 * owner or an admin changes the access to the files or to the database in a panel that slides in from
 * the left: the server saves it only once a connection with it passed, and the page is read again.
 * `accesses` and `editable` — null when they could not be read.
 */
export function SiteAccesses({
  siteId,
  stack,
  platform,
  accesses,
  editable,
  nested = false,
}: {
  siteId: string
  stack: ProjectStack
  platform: string
  accesses: readonly Access[] | null
  editable: EditableAccessView | null
  /** Beside the menu that holds the h1 of «Переменные»: the heading is an h2. */
  nested?: boolean
}) {
  const router = useRouter()
  const titleId = useId()
  const panelTitleId = useId()
  const [panel, setPanel] = useState<{ changing: Changing; round: number } | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const closed = editable?.canChange ? editable.busy : null

  function open(changing: Changing) {
    setNotice(null)
    setPanel((current) => ({ changing, round: (current?.round ?? 0) + 1 }))
    setPanelOpen(true)
  }

  function changed(changing: Changing) {
    setPanelOpen(false)
    setNotice(changing === 'files' ? accessText.savedFiles : accessText.savedDatabase)
    router.refresh()
  }

  return (
    <Box
      component="section"
      aria-labelledby={titleId}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}
    >
      <Box>
        <SectionTitle id={titleId} level={nested ? 'h2' : 'h1'}>
          {accessText.title}
        </SectionTitle>
        <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 720 }}>
          {nbsp(accessText.note)}
        </Typography>
      </Box>
      <SiteCard>
        <Box role="status" aria-live="polite" sx={{ px: { xs: 2, sm: 2.75 } }}>
          {notice ? (
            <Typography variant="body2" sx={{ pt: 2 }}>
              {notice}
            </Typography>
          ) : null}
        </Box>
        {accesses === null ? (
          <Typography role="alert" sx={{ px: { xs: 2, sm: 2.75 }, py: 2.25 }}>
            Не удалось загрузить список доступов. Обновите страницу через пару минут.
          </Typography>
        ) : accesses.length === 0 ? (
          <Typography color="text.secondary" sx={{ px: { xs: 2, sm: 2.75 }, py: 2.25 }}>
            Доступов пока нет. Они появятся, когда сайт будет подключён.
          </Typography>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Box role="table" aria-label="Сохранённые доступы" sx={{ minWidth: 840 }}>
              <Box
                role="row"
                sx={{
                  display: 'grid',
                  gridTemplateColumns: columns,
                  gap: 2,
                  px: { xs: 2, sm: 2.75 },
                  py: 1.25,
                  bgcolor: 'action.hover',
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: 'text.secondary',
                }}
              >
                <span role="columnheader">Подключение</span>
                <span role="columnheader">Для чего</span>
                <span role="columnheader">Что записано</span>
                <span role="columnheader">Запись</span>
                <span role="columnheader">Действие</span>
              </Box>
              {accesses.map((access, index) => {
                const changing = changingOf(access.kind, editable)
                return (
                  <Box
                    role="row"
                    key={`${access.kind}-${index}`}
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: columns,
                      gap: 2,
                      alignItems: 'center',
                      px: { xs: 2, sm: 2.75 },
                      py: 1.75,
                      borderTop: 1,
                      borderColor: 'divider',
                    }}
                  >
                    <Typography role="cell" sx={{ fontWeight: 600 }}>
                      {accessLabel(access.kind)}
                    </Typography>
                    <Typography role="cell" variant="body2">
                      {accessPurpose(access.kind)}
                    </Typography>
                    <Box role="cell" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                      {accessFieldsOf(access.kind).map((field) => (
                        <Typography
                          key={field}
                          component="span"
                          variant="body2"
                          sx={{ px: 1, borderRadius: '999px', border: 1, borderColor: 'divider' }}
                        >
                          {field} · скрыто
                        </Typography>
                      ))}
                    </Box>
                    <Box role="cell" sx={{ display: 'flex', flexDirection: 'column' }}>
                      <Typography variant="body2">версия {access.version}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {formatMoscowMoment(access.updatedAt)}
                      </Typography>
                    </Box>
                    <Box role="cell">
                      {changing ? (
                        <Button
                          variant="outlined"
                          disabled={closed !== null}
                          onClick={() => open(changing)}
                          aria-label={`${accessText.change}: ${accessLabel(access.kind)}`}
                          sx={{ minHeight: 40 }}
                        >
                          {accessText.change}
                        </Button>
                      ) : null}
                    </Box>
                  </Box>
                )
              })}
            </Box>
          </Box>
        )}
        {closed !== null ? (
          <Typography variant="body2" sx={{ px: { xs: 2, sm: 2.75 }, pb: 1.75 }}>
            {nbsp(accessText.busy[closed])}
          </Typography>
        ) : null}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            display: 'block',
            px: { xs: 2, sm: 2.75 },
            py: 1.5,
            borderTop: 1,
            borderColor: 'divider',
          }}
        >
          {accessText.footer}
          {editable && !editable.canChange ? ` ${accessText.managersOnly}` : ''}
        </Typography>
      </SiteCard>
      <SiteSidePanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        onExited={() => setPanel(null)}
        titleId={panelTitleId}
        title={panel?.changing === 'database' ? accessText.database : accessText.files}
        busy={busy}
      >
        {panel?.changing === 'files' && editable?.source ? (
          <ReplaceAccessForm
            key={panel.round}
            siteId={siteId}
            stack={stack}
            platform={platform}
            saved={editable.source}
            working
            titleId={panelTitleId}
            onBusyChange={setBusy}
            onCancel={() => setPanelOpen(false)}
            onReplaced={() => changed('files')}
          />
        ) : null}
        {panel?.changing === 'database' && editable?.database ? (
          <DatabaseAccessForm
            key={panel.round}
            siteId={siteId}
            titleId={panelTitleId}
            saved={editable.database}
            onBusyChange={setBusy}
            onCancel={() => setPanelOpen(false)}
            onChanged={() => changed('database')}
          />
        ) : null}
      </SiteSidePanel>
    </Box>
  )
}
