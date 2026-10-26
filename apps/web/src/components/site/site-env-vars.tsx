'use client'

import { envVarLimits, envVarNameProblem } from '@repo/domain/release/env-vars'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import Skeleton from '@mui/material/Skeleton'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState, type FormEvent } from 'react'

import { ConfirmDialog } from '@/components/billing/confirm-dialog'
import { callErrorCode, callErrorText } from '@/components/chat/call-error'
import type { SiteEnvVar } from '@/components/chat/chat-types'
import { AppIcon } from '@/components/application/app-icon'
import { formatMoscowMoment } from '@/lib/moscow-date'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { SectionTitle } from './section-empty'
import { SiteCard } from './site-cards'
import { SiteSidePanel } from './site-side-panel'

// «Переменные» — the section `vault` of the site (docs/plan/53-chat-preview-release.md, Р13): the keys of
// services the code of the site needs. The value goes to the vault and is never shown again —
// not to the client, not on this page; the page knows the name, the addresses it may reach and
// whom it is given to. Only an owner or an admin of the workspace sees and changes them.

export const envText = Object.freeze({
  title: 'Переменные окружения',
  note: 'Ключи и адреса сервисов, которые нужны коду сайта: например, ключ службы доставки. Значение хранится в защищённом хранилище и после сохранения не показывается — ни вам, ни нам в этом кабинете.',
  add: 'Добавить переменную',
  edit: 'Изменить',
  remove: 'Удалить',
  empty: 'Переменных пока нет.',
  loadFailed: 'Не удалось загрузить переменные.',
  retry: 'Повторить',
  name: 'Имя',
  nameHelp: 'Заглавные латинские буквы, цифры и знак подчёркивания, например DELIVERY_KEY.',
  nameFormat:
    'Имя может состоять только из заглавных латинских букв, цифр и знака подчёркивания и должно начинаться с буквы.',
  nameReserved: 'Это имя занято платформой. Выберите другое.',
  value: 'Значение',
  valueHelp:
    'После сохранения значение не показывается. Чтобы изменить переменную, введите значение заново.',
  valueShort: 'Введите значение.',
  hosts: 'Адреса сервиса',
  hostsHelp:
    'По одному в строке: имя сайта сервиса и, если нужно, порт через двоеточие — например, api.example.ru или api.example.ru:8443. Обратиться к сервису можно будет только по этим адресам.',
  toAgent: 'Передавать агенту',
  toAgentHelp:
    'Агент сможет использовать переменную в командах, которые запускает, — например, чтобы проверить, как сайт работает с сервисом.',
  /** A workspace of real client data before the gate of 152-FZ (`siteEnv.list` → `agentAllowed`). */
  toAgentClosed:
    'Для этого сайта передавать переменные агенту пока нельзя, а без агента их не получает и предпросмотр.',
  consent: 'Я понимаю: агент увидит то, что вернёт этот сервис.',
  consentNeeded: 'Чтобы передать переменную агенту, отметьте согласие.',
  toPreview: 'Передавать предпросмотру',
  toPreviewHelp:
    'Предпросмотр — рабочая копия сайта с изменениями диалога. В нём работает код, который пишет агент, поэтому переменная попадёт в предпросмотр, только если её передают и агенту.',
  save: 'Сохранить',
  cancel: 'Отмена',
  saved: (name: string) => `Переменная ${name} сохранена.`,
  removed: (name: string) => `Переменная ${name} удалена.`,
  removeTitle: (name: string) => `Удалить переменную ${name}?`,
  removeBody:
    'Агент и предпросмотр перестанут её получать. Значение вернуть не получится — его нужно будет ввести заново.',
  keep: 'Не удалять',
  updated: (at: string) => `Изменена ${at}`,
  valueHidden: 'значение скрыто',
  noHosts: 'адреса не указаны',
})

/**
 * Whom a variable is given to, in words. A preview gets only what the agent may see, and in a
 * workspace that may not give variables to the agent (`agentAllowed`) nobody gets them.
 */
export function recipientsText(
  variable: Pick<SiteEnvVar, 'toAgent' | 'toPreview' | 'agentConsentAt'>,
  agentAllowed = true,
): string {
  if (!agentAllowed) return `Не передаётся. ${envText.toAgentClosed}`
  const agent = variable.toAgent && variable.agentConsentAt !== null
  if (agent && variable.toPreview) return 'Передаётся агенту и предпросмотру.'
  if (agent) return 'Передаётся агенту.'
  if (variable.toPreview)
    return 'Пока не передаётся: предпросмотр получит её, только когда её начнут передавать агенту.'
  return 'Не передаётся ни агенту, ни предпросмотру.'
}

/** Addresses as the client typed them: one per line, or apart by commas and spaces. */
export function hostsOf(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((host) => host.trim())
    .filter((host) => host !== '')
}

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength

interface Draft {
  /** null — a new variable; otherwise the name of the one being changed. */
  editing: string | null
  name: string
  value: string
  hosts: string
  toAgent: boolean
  consent: boolean
  toPreview: boolean
}

const emptyDraft: Draft = {
  editing: null,
  name: '',
  value: '',
  hosts: '',
  toAgent: false,
  consent: false,
  toPreview: true,
}

/** What `siteEnv.set` takes, besides the site. */
type EnvSave = {
  name: string
  value: string
  hosts: string[]
  toPreview: boolean
  toAgent: boolean
  agentConsent: boolean
}

/** The fields of a variable, inside the side panel that names it (`titleId`). */
function EnvForm({
  titleId,
  draft,
  agentAllowed,
  saving,
  onSave,
  onClose,
  onSaved,
  onStale,
}: {
  titleId: string
  draft: Draft
  /** false — the workspace may not give variables to the agent: the switch stays off. */
  agentAllowed: boolean
  /** The save is on its way: the fields wait for its answer. */
  saving: boolean
  onSave: (variable: EnvSave) => Promise<unknown>
  onClose: () => void
  onSaved: (name: string) => void
  /** Someone else changed the variables meanwhile: the list is read again. */
  onStale: () => void
}) {
  const agentHelpId = useId()
  const [form, setForm] = useState<Draft>(
    agentAllowed ? draft : { ...draft, toAgent: false, consent: false },
  )
  const [errors, setErrors] = useState<{ name?: string; value?: string; consent?: string }>({})
  const [refusal, setRefusal] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const valueInput = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const found: typeof errors = {}
    const problem = envVarNameProblem(form.name)
    if (problem === 'format') found.name = envText.nameFormat
    else if (problem === 'reserved') found.name = envText.nameReserved
    if (utf8Bytes(form.value) < envVarLimits.valueMinBytes) found.value = envText.valueShort
    if (form.toAgent && !form.consent) found.consent = envText.consentNeeded
    setErrors(found)
    if (found.name) {
      nameInput.current?.focus()
      return
    }
    if (found.value) {
      valueInput.current?.focus()
      return
    }
    if (found.consent) return
    setRefusal(null)
    try {
      await onSave({
        name: form.name,
        value: form.value,
        hosts: hostsOf(form.hosts),
        toPreview: form.toPreview,
        toAgent: form.toAgent,
        agentConsent: form.toAgent && form.consent,
      })
      onSaved(form.name)
    } catch (failure) {
      setRefusal(callErrorText(failure))
      if (callErrorCode(failure) === 'SITE_ENV_CHANGED') onStale()
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
      <TextField
        inputRef={nameInput}
        // A new variable starts with its name, a change with the value typed anew.
        autoFocus={form.editing === null}
        label={envText.name}
        value={form.name}
        onChange={(event) => setForm({ ...form, name: event.target.value.trim() })}
        disabled={form.editing !== null || saving}
        error={Boolean(errors.name)}
        helperText={errors.name ?? envText.nameHelp}
        required
        fullWidth
        slotProps={{
          htmlInput: {
            maxLength: 64,
            autoCapitalize: 'characters',
            spellCheck: false,
            autoComplete: 'off',
          },
        }}
      />
      <TextField
        inputRef={valueInput}
        autoFocus={form.editing !== null}
        label={envText.value}
        type="password"
        value={form.value}
        onChange={(event) => setForm({ ...form, value: event.target.value })}
        disabled={saving}
        error={Boolean(errors.value)}
        helperText={errors.value ?? envText.valueHelp}
        required
        fullWidth
        slotProps={{ htmlInput: { autoComplete: 'new-password', spellCheck: false } }}
      />
      <TextField
        label={envText.hosts}
        value={form.hosts}
        onChange={(event) => setForm({ ...form, hosts: event.target.value })}
        disabled={saving}
        helperText={envText.hostsHelp}
        multiline
        minRows={2}
        fullWidth
        slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'none' } }}
      />
      <Box>
        <FormControlLabel
          control={
            <Switch
              checked={form.toAgent}
              onChange={(_event, toAgent) =>
                setForm({ ...form, toAgent, consent: toAgent && form.consent })
              }
              disabled={saving || !agentAllowed}
              slotProps={{ input: { 'aria-describedby': agentHelpId } }}
            />
          }
          label={envText.toAgent}
          sx={{ minHeight: 44 }}
        />
        <Typography id={agentHelpId} variant="body2" color="text.secondary" sx={{ maxWidth: 640 }}>
          {nbsp(agentAllowed ? envText.toAgentHelp : envText.toAgentClosed)}
        </Typography>
        {form.toAgent ? (
          <Box sx={{ mt: 1 }}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={form.consent}
                  onChange={(_event, consent) => setForm({ ...form, consent })}
                  disabled={saving}
                />
              }
              label={envText.consent}
              sx={{ minHeight: 44 }}
            />
            {errors.consent ? (
              <Typography role="alert" variant="body2" color="error.main">
                {errors.consent}
              </Typography>
            ) : null}
          </Box>
        ) : null}
      </Box>
      <Box>
        <FormControlLabel
          control={
            <Switch
              checked={form.toPreview}
              onChange={(_event, toPreview) => setForm({ ...form, toPreview })}
              disabled={saving}
            />
          }
          label={envText.toPreview}
          sx={{ minHeight: 44 }}
        />
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 640 }}>
          {nbsp(envText.toPreviewHelp)}
        </Typography>
      </Box>
      {refusal ? <Alert severity="error">{refusal}</Alert> : null}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Button type="submit" variant="contained" loading={saving}>
          {envText.save}
        </Button>
        <Button onClick={onClose} disabled={saving}>
          {envText.cancel}
        </Button>
      </Box>
    </Box>
  )
}

/**
 * The section of the variables of a site: its heading with «Добавить переменную» at the right, a
 * list, and their removal. A variable is added or changed in a panel that slides in from the right
 * over the page; what was typed in it goes once the panel slid out.
 */
export function SiteEnvVars({
  siteId,
  nested = false,
}: {
  siteId: string
  /** At the root of «Переменные», beside the menu that holds the h1: the heading is an h2. */
  nested?: boolean
}) {
  const titleId = useId()
  const panelTitleId = useId()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const list = useQuery({ ...trpc.siteEnv.list.queryOptions({ siteId }), retry: false })
  const save = useMutation(trpc.siteEnv.set.mutationOptions())
  const remove = useMutation(trpc.siteEnv.remove.mutationOptions())
  const [panel, setPanel] = useState<{ draft: Draft; round: number } | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const reread = () =>
    queryClient.invalidateQueries({ queryKey: trpc.siteEnv.list.queryKey({ siteId }) })

  function open(next: Draft) {
    setNotice(null)
    save.reset()
    setPanel((current) => ({ draft: next, round: (current?.round ?? 0) + 1 }))
    setPanelOpen(true)
  }

  async function confirmRemove() {
    if (removing === null) return
    setRemoveError(null)
    try {
      await remove.mutateAsync({ siteId, name: removing })
      setNotice(envText.removed(removing))
      setRemoving(null)
      void reread()
    } catch (failure) {
      setRemoveError(callErrorText(failure))
    }
  }

  let body
  if (list.isPending) {
    body = (
      <Box role="status" sx={{ px: { xs: 2, sm: 2.75 }, py: 2.25 }}>
        <Skeleton variant="rounded" height={48} />
      </Box>
    )
  } else if (list.isError) {
    body =
      callErrorCode(list.error) === 'SITE_ENV_NOT_ALLOWED' ? (
        <Typography color="text.secondary" sx={{ px: { xs: 2, sm: 2.75 }, py: 2.25 }}>
          {callErrorText(list.error)}
        </Typography>
      ) : (
        <Alert
          severity="error"
          sx={{ m: { xs: 2, sm: 2.75 } }}
          action={
            <Button
              color="inherit"
              size="small"
              sx={{ minHeight: 44 }}
              loading={list.isFetching}
              onClick={() => void list.refetch()}
            >
              {envText.retry}
            </Button>
          }
        >
          {envText.loadFailed}
        </Alert>
      )
  } else {
    body =
      list.data.variables.length === 0 ? (
        <Typography color="text.secondary" sx={{ px: { xs: 2, sm: 2.75 }, py: 2.25 }}>
          {envText.empty}
        </Typography>
      ) : (
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {list.data.variables.map((variable, index) => (
            <Box
              component="li"
              key={variable.name}
              sx={{
                px: { xs: 2, sm: 2.75 },
                py: 1.75,
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: '8px 24px',
                borderTop: index === 0 ? 0 : 1,
                borderColor: 'divider',
              }}
            >
              <Box sx={{ minWidth: 0, flex: '1 1 320px' }}>
                <Typography
                  sx={{
                    fontWeight: 600,
                    fontFamily:
                      'var(--font-jetbrains, ui-monospace), ui-monospace, Menlo, monospace',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {variable.name}
                </Typography>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ overflowWrap: 'anywhere' }}
                >
                  {variable.hosts.length > 0 ? variable.hosts.join(', ') : envText.noHosts} ·{' '}
                  {envText.valueHidden}
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  {nbsp(recipientsText(variable, list.data.agentAllowed))}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {envText.updated(formatMoscowMoment(variable.updatedAt))}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button
                  variant="outlined"
                  onClick={() =>
                    open({
                      editing: variable.name,
                      name: variable.name,
                      value: '',
                      hosts: variable.hosts.join('\n'),
                      toAgent: variable.toAgent,
                      consent: false,
                      toPreview: variable.toPreview,
                    })
                  }
                  aria-label={`${envText.edit} ${variable.name}`}
                >
                  {envText.edit}
                </Button>
                <Button
                  color="error"
                  onClick={() => {
                    setRemoveError(null)
                    setRemoving(variable.name)
                  }}
                  aria-label={`${envText.remove} ${variable.name}`}
                >
                  {envText.remove}
                </Button>
              </Box>
            </Box>
          ))}
        </Box>
      )
  }

  return (
    <Box
      component="section"
      aria-labelledby={titleId}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}
    >
      <Box>
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px 24px',
          }}
        >
          <SectionTitle id={titleId} level={nested ? 'h2' : 'h1'}>
            {envText.title}
          </SectionTitle>
          {/* There from the first paint, so nothing moves once the list is read; a member who
              may not see the variables learns it from the list and gets no button. */}
          {list.isError ? null : (
            <Button
              variant="contained"
              startIcon={<AppIcon name="plus" size={18} />}
              disabled={!list.isSuccess}
              onClick={() => open(emptyDraft)}
              sx={{ minHeight: 44, borderRadius: '999px', whiteSpace: 'nowrap' }}
            >
              {envText.add}
            </Button>
          )}
        </Box>
        <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 720 }}>
          {nbsp(envText.note)}
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
        {body}
      </SiteCard>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing === null ? '' : envText.removeTitle(removing)}
        busy={remove.isPending}
        error={removeError}
        keepLabel={envText.keep}
        confirmLabel={envText.remove}
        danger
        onConfirm={() => void confirmRemove()}
      >
        <Typography sx={{ mt: 1.5 }}>{nbsp(envText.removeBody)}</Typography>
      </ConfirmDialog>
      <SiteSidePanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        onExited={() => setPanel(null)}
        titleId={panelTitleId}
        title={
          panel === null || panel.draft.editing === null
            ? envText.add
            : `${envText.edit} ${panel.draft.editing}`
        }
        busy={save.isPending}
      >
        {panel && list.isSuccess ? (
          <EnvForm
            key={panel.round}
            titleId={panelTitleId}
            draft={panel.draft}
            agentAllowed={list.data.agentAllowed}
            saving={save.isPending}
            onSave={(variable) => save.mutateAsync({ siteId, ...variable })}
            onClose={() => setPanelOpen(false)}
            onSaved={(name) => {
              setPanelOpen(false)
              setNotice(envText.saved(name))
              void reread()
            }}
            onStale={() => void reread()}
          />
        ) : null}
      </SiteSidePanel>
    </Box>
  )
}
