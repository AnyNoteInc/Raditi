'use client'

import { envVarLimits, envVarNameProblem } from '@repo/domain/workspace-env/env-vars'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState, type FormEvent } from 'react'

import {
  pageHeading,
  sectionHeading,
  sectionPadding,
  surface,
} from '@/components/billing/billing-surface'
import { ConfirmDialog } from '@/components/billing/confirm-dialog'
import { callErrorCode, callErrorText } from '@/components/chat/call-error'
import { formatMoscowMoment } from '@/lib/moscow-date'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

// «Настройки → Переменные» (docs/plan/83-remove-projects.md, БП4): keys and passwords of services
// the agent needs. Every chat of the workspace gets them in the commands the agent runs; the value
// goes to the vault and is never shown again — not to the client, not on this page.

export const variablesText = Object.freeze({
  title: 'Переменные',
  lead: 'Ключи и пароли сервисов, которые нужны агенту.',
  note: 'Переменные доступны агенту в каждом чате этого пространства: в командах, которые он запускает. Значение хранится в защищённом хранилище и после сохранения не показывается — ни вам, ни нам.',
  readOnly: 'Добавлять и менять переменные могут только владелец и администраторы пространства.',
  add: 'Добавить переменную',
  formTitle: 'Новая переменная',
  editTitle: (name: string) => `Новое значение ${name}`,
  edit: 'Заменить значение',
  remove: 'Удалить',
  empty: 'Переменных пока нет.',
  loadFailed: 'Не удалось загрузить переменные.',
  loading: 'Загружаем переменные',
  retry: 'Повторить',
  name: 'Имя',
  nameHelp: 'Заглавные латинские буквы, цифры и знак подчёркивания, например DELIVERY_KEY.',
  nameFormat:
    'Имя может состоять только из заглавных латинских букв, цифр и знака подчёркивания и должно начинаться с буквы.',
  nameReserved: 'Это имя занято платформой. Выберите другое.',
  value: 'Значение',
  valueHelp: 'После сохранения значение не показывается. Чтобы изменить его, введите заново.',
  valueShort: 'Введите значение.',
  save: 'Сохранить',
  cancel: 'Отмена',
  saved: (name: string) => `Переменная ${name} сохранена.`,
  removed: (name: string) => `Переменная ${name} удалена.`,
  removeTitle: (name: string) => `Удалить переменную ${name}?`,
  removeBody:
    'Агент перестанет её получать. Значение вернуть не получится — его нужно будет ввести заново.',
  keep: 'Не удалять',
  updated: (at: string) => `Изменена ${at}`,
})

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength

interface Draft {
  /** null — a new variable; otherwise the name whose value is replaced. */
  editing: string | null
  name: string
  value: string
}

/** The fields of a variable: its name (fixed when the value is replaced) and its value. */
function VariableForm({
  draft,
  saving,
  onSave,
  onClose,
  onStale,
}: {
  draft: Draft
  saving: boolean
  onSave: (variable: { name: string; value: string }) => Promise<unknown>
  onClose: () => void
  /** Someone else changed the variable meanwhile: the list is read again. */
  onStale: () => void
}) {
  const titleId = useId()
  const [form, setForm] = useState(draft)
  const [errors, setErrors] = useState<{ name?: string; value?: string }>({})
  const [refusal, setRefusal] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const valueInput = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const found: typeof errors = {}
    const problem = envVarNameProblem(form.name)
    if (problem === 'format') found.name = variablesText.nameFormat
    else if (problem === 'reserved') found.name = variablesText.nameReserved
    if (utf8Bytes(form.value) < envVarLimits.valueMinBytes) found.value = variablesText.valueShort
    setErrors(found)
    if (found.name) return nameInput.current?.focus()
    if (found.value) return valueInput.current?.focus()
    setRefusal(null)
    try {
      await onSave({ name: form.name, value: form.value })
    } catch (failure) {
      setRefusal(callErrorText(failure))
      if (callErrorCode(failure) === 'WORKSPACE_ENV_CHANGED') onStale()
    }
  }

  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-labelledby={titleId}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, mt: 3 }}
    >
      <Typography id={titleId} component="h3" sx={{ fontWeight: 600, fontSize: 16 }}>
        {draft.editing === null ? variablesText.formTitle : variablesText.editTitle(draft.editing)}
      </Typography>
      <TextField
        inputRef={nameInput}
        autoFocus={form.editing === null}
        label={variablesText.name}
        value={form.name}
        onChange={(event) => setForm({ ...form, name: event.target.value.trim() })}
        disabled={form.editing !== null || saving}
        error={Boolean(errors.name)}
        helperText={errors.name ?? variablesText.nameHelp}
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
        label={variablesText.value}
        type="password"
        value={form.value}
        onChange={(event) => setForm({ ...form, value: event.target.value })}
        disabled={saving}
        error={Boolean(errors.value)}
        helperText={errors.value ?? variablesText.valueHelp}
        required
        fullWidth
        slotProps={{ htmlInput: { autoComplete: 'new-password', spellCheck: false } }}
      />
      {refusal ? <Alert severity="error">{refusal}</Alert> : null}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Button type="submit" variant="contained" loading={saving}>
          {variablesText.save}
        </Button>
        <Button onClick={onClose} disabled={saving}>
          {variablesText.cancel}
        </Button>
      </Box>
    </Box>
  )
}

/** The page «Переменные»: the names of the variables, their form and their removal. */
export function WorkspaceVariables() {
  const titleId = useId()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const list = useQuery({ ...trpc.workspaceEnv.list.queryOptions({}), retry: false })
  const save = useMutation(trpc.workspaceEnv.set.mutationOptions())
  const remove = useMutation(trpc.workspaceEnv.remove.mutationOptions())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [round, setRound] = useState(0)
  const [removing, setRemoving] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const reread = () =>
    queryClient.invalidateQueries({ queryKey: trpc.workspaceEnv.list.queryKey() })
  const workspaceId = list.data?.workspaceId ?? undefined
  const at = workspaceId === undefined ? {} : { workspaceId }

  function open(next: Draft) {
    setNotice(null)
    save.reset()
    setDraft(next)
    setRound((value) => value + 1)
  }

  async function confirmRemove() {
    if (removing === null) return
    setRemoveError(null)
    try {
      await remove.mutateAsync({ ...at, name: removing })
      setNotice(variablesText.removed(removing))
      setRemoving(null)
      await reread()
    } catch (failure) {
      setRemoveError(callErrorText(failure))
    }
  }

  return (
    <Box>
      <Typography component="h1" sx={pageHeading}>
        {variablesText.title}
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 1 }}>
        {variablesText.lead}
      </Typography>
      <Box
        component="section"
        aria-labelledby={titleId}
        sx={{ ...surface, mt: 3, p: sectionPadding }}
      >
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1.5,
          }}
        >
          <Typography id={titleId} component="h2" sx={sectionHeading}>
            {variablesText.title}
          </Typography>
          {list.data?.canEdit && draft === null ? (
            <Button
              variant="contained"
              onClick={() => open({ editing: null, name: '', value: '' })}
            >
              {variablesText.add}
            </Button>
          ) : null}
        </Box>
        <Typography color="text.secondary" variant="body2" sx={{ mt: 1, maxWidth: 640 }}>
          {nbsp(variablesText.note)}
        </Typography>
        {list.data && !list.data.canEdit ? (
          <Typography color="text.secondary" variant="body2" sx={{ mt: 1 }}>
            {variablesText.readOnly}
          </Typography>
        ) : null}
        {notice ? (
          <Alert severity="success" sx={{ mt: 2 }} role="status">
            {notice}
          </Alert>
        ) : null}
        {draft !== null ? (
          <VariableForm
            key={round}
            draft={draft}
            saving={save.isPending}
            onClose={() => setDraft(null)}
            onStale={() => void reread()}
            onSave={async (variable) => {
              await save.mutateAsync({ ...at, ...variable })
              setDraft(null)
              setNotice(variablesText.saved(variable.name))
              await reread()
            }}
          />
        ) : null}
        {list.isPending ? (
          <Box role="status" aria-label={variablesText.loading} sx={{ mt: 2 }}>
            <Skeleton variant="rounded" height={56} />
          </Box>
        ) : list.isError ? (
          <Alert
            severity="error"
            sx={{ mt: 2 }}
            action={
              <Button color="inherit" size="small" onClick={() => void list.refetch()}>
                {variablesText.retry}
              </Button>
            }
          >
            {variablesText.loadFailed}
          </Alert>
        ) : list.data.variables.length === 0 ? (
          <Typography color="text.secondary" sx={{ mt: 2 }}>
            {variablesText.empty}
          </Typography>
        ) : (
          <Box
            component="ul"
            sx={{ listStyle: 'none', m: 0, p: 0, mt: 2, display: 'grid', gap: 1 }}
          >
            {list.data.variables.map((variable) => (
              <Box
                component="li"
                key={variable.name}
                sx={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 1,
                  py: 1,
                  borderTop: 1,
                  borderColor: 'divider',
                }}
              >
                <Box sx={{ flex: '1 1 240px', minWidth: 0 }}>
                  <Typography
                    sx={{ fontFamily: 'monospace', fontSize: 15, wordBreak: 'break-all' }}
                  >
                    {variable.name}
                  </Typography>
                  <Typography color="text.secondary" variant="body2">
                    {variablesText.updated(formatMoscowMoment(variable.updatedAt))}
                  </Typography>
                </Box>
                {list.data.canEdit ? (
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <Button
                      variant="outlined"
                      size="small"
                      onClick={() =>
                        open({ editing: variable.name, name: variable.name, value: '' })
                      }
                    >
                      {variablesText.edit}
                    </Button>
                    <Button
                      color="error"
                      size="small"
                      onClick={() => {
                        setRemoveError(null)
                        setRemoving(variable.name)
                      }}
                    >
                      {variablesText.remove}
                    </Button>
                  </Box>
                ) : null}
              </Box>
            ))}
          </Box>
        )}
      </Box>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing === null ? '' : variablesText.removeTitle(removing)}
        busy={remove.isPending}
        error={removeError}
        keepLabel={variablesText.keep}
        confirmLabel={variablesText.remove}
        danger
        onConfirm={() => void confirmRemove()}
      >
        <Typography sx={{ mt: 1.5 }}>{nbsp(variablesText.removeBody)}</Typography>
      </ConfirmDialog>
    </Box>
  )
}
