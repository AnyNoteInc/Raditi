'use client'

import { accountSkillLimits } from '@repo/domain'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { AppRouter } from '@repo/trpc'
import { useMutation } from '@tanstack/react-query'
import type { inferRouterOutputs } from '@trpc/server'
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'

import { callErrorText, OFFLINE_TEXT } from '@/components/chat/call-error'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { accountSkillsText as text } from './account-skills-text'

// Installing a skill of the account (docs/plan/97-skills.md, Нв8, Нв9, Нв12): by a link to a
// public repository, from an archive, or from a marketplace. Each starts with the warning of Нв12
// — a skill is instructions and programs the agent runs in the client's sandbox. An address with
// several skills asks which one; a skill of a name the account has asks whether to replace it.

export type InstallAnswer = inferRouterOutputs<AppRouter>['accountSkills']['installFromAddress']
type FoundSkill = Extract<InstallAnswer, { status: 'choose' }>['skills'][number]

/** What the dialog installs. */
export type InstallTarget =
  | { kind: 'address' }
  | { kind: 'file' }
  | { kind: 'marketplace'; marketplaceId: string; plugin: string; path?: string; name: string }

/** A refusal of the upload route, in its words. */
class UploadRefusal extends Error {}

/**
 * «Добавить из файла»: the archive as the raw body of `POST /api/skills/upload` — a body of tRPC
 * is 256 KiB at most. Throws an Error with the words to show.
 */
export async function uploadSkillArchive(
  file: File,
  replace: boolean,
  fetchFn: typeof fetch = fetch,
): Promise<InstallAnswer> {
  if (file.size > accountSkillLimits.uploadBytes) throw new UploadRefusal(text.fileTooLarge)
  const query = new URLSearchParams({ name: file.name })
  if (replace) query.set('replace', '1')
  let response: Response
  try {
    response = await fetchFn(`/api/skills/upload?${query.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    })
  } catch {
    throw new UploadRefusal(OFFLINE_TEXT)
  }
  const body = (await response.json().catch(() => null)) as
    (InstallAnswer & { message?: undefined }) | { message?: string; status?: undefined } | null
  if (!response.ok || body === null || body.status === undefined)
    throw new UploadRefusal(
      body && typeof body.message === 'string' && body.message !== '' ? body.message : text.failed,
    )
  return body
}

const errorText = (failure: unknown) =>
  failure instanceof UploadRefusal ? failure.message : callErrorText(failure)

/** The frame of the dialogs of the page: a title, what it holds and its buttons. */
export function SkillDialog({
  open,
  onClose,
  title,
  busy = false,
  wide = false,
  children,
  actions,
}: {
  open: boolean
  onClose: () => void
  title: string
  busy?: boolean
  wide?: boolean
  children: ReactNode
  actions?: ReactNode
}) {
  const titleId = useId()
  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      aria-labelledby={titleId}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: wide ? 760 : 520,
            m: 2,
            p: { xs: 2, sm: 3 },
            border: 1,
            borderColor: 'divider',
            borderRadius: '14px',
          },
        },
      }}
    >
      <Typography
        component="h2"
        id={titleId}
        sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3, overflowWrap: 'anywhere' }}
      >
        {title}
      </Typography>
      <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        {children}
      </Box>
      {actions ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
          {actions}
        </Box>
      ) : null}
    </Dialog>
  )
}

type Step =
  { kind: 'form' } | { kind: 'choose'; skills: FoundSkill[] } | { kind: 'exists'; name: string }

/**
 * The dialog of an install: the warning, what is installed (a link, a file or a skill of a
 * marketplace), then the questions the answer asks. `onInstalled` — the skill is in the account.
 */
export function InstallSkillDialog({
  target,
  onClose,
  onInstalled,
  upload = uploadSkillArchive,
}: {
  target: InstallTarget | null
  onClose: () => void
  onInstalled: (answer: Extract<InstallAnswer, { status: 'installed' }>) => void
  upload?: (file: File, replace: boolean) => Promise<InstallAnswer>
}) {
  const trpc = useTRPC()
  const fromAddress = useMutation(trpc.accountSkills.installFromAddress.mutationOptions())
  const fromMarketplace = useMutation(trpc.accountSkills.installFromMarketplace.mutationOptions())
  const [address, setAddress] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [step, setStep] = useState<Step>({ kind: 'form' })
  // The folder chosen of several: an answer «exists» repeats the install with it.
  const [path, setPath] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const fileHelpId = useId()

  const formId = useId()

  const reset = () => {
    setAddress('')
    setFile(null)
    setStep({ kind: 'form' })
    setPath(undefined)
    setProblem(null)
  }
  const close = () => {
    if (busy) return
    reset()
    onClose()
  }

  const install = async (extra: { path?: string; replace?: boolean }) => {
    if (target === null) return
    const options = {
      ...(extra.path !== undefined ? { path: extra.path } : {}),
      ...(extra.replace ? { replace: true } : {}),
    }
    if (target.kind === 'address') {
      if (address.trim() === '') return setProblem(text.linkEmpty)
      return fromAddress.mutateAsync({ address: address.trim(), ...options })
    }
    if (target.kind === 'file') {
      if (file === null) return setProblem(text.fileEmpty)
      return upload(file, extra.replace ?? false)
    }
    const folder = extra.path ?? target.path
    return fromMarketplace.mutateAsync({
      marketplaceId: target.marketplaceId,
      plugin: target.plugin,
      ...(folder !== undefined ? { path: folder } : {}),
      ...(extra.replace ? { replace: true } : {}),
    })
  }

  const run = async (extra: { path?: string; replace?: boolean }) => {
    setProblem(null)
    setBusy(true)
    try {
      const answer = await install(extra)
      if (!answer) return
      if (answer.status === 'installed') {
        reset()
        onInstalled(answer)
        onClose()
        return
      }
      if (answer.status === 'exists') setStep({ kind: 'exists', name: answer.name })
      else setStep({ kind: 'choose', skills: answer.skills })
    } catch (failure) {
      setProblem(errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void run({ path })
  }

  const title =
    step.kind === 'exists'
      ? text.existsTitle
      : step.kind === 'choose'
        ? text.chooseTitle
        : target?.kind === 'address'
          ? text.linkTitle
          : target?.kind === 'file'
            ? text.fileTitle
            : text.installTitle(target?.name ?? '')

  const problemAlert = problem ? (
    <Alert severity="error" role="alert">
      {problem}
    </Alert>
  ) : null

  if (step.kind === 'exists')
    return (
      <SkillDialog
        open={target !== null}
        onClose={close}
        title={title}
        busy={busy}
        actions={
          <>
            <Button onClick={close} disabled={busy}>
              {text.cancel}
            </Button>
            <Button
              variant="contained"
              loading={busy}
              onClick={() => void run({ path, replace: true })}
            >
              {text.replace}
            </Button>
          </>
        }
      >
        <Typography>{nbsp(text.existsBody(step.name))}</Typography>
        {problemAlert}
      </SkillDialog>
    )

  if (step.kind === 'choose')
    return (
      <SkillDialog
        open={target !== null}
        onClose={close}
        title={title}
        busy={busy}
        actions={
          <Button onClick={close} disabled={busy}>
            {text.cancel}
          </Button>
        }
      >
        <Typography color="text.secondary">{text.chooseNote}</Typography>
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {step.skills.map((skill) => (
            <Box
              component="li"
              key={skill.path}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                py: 1.25,
                borderTop: 1,
                borderColor: 'divider',
              }}
            >
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere' }} translate="no">
                  {skill.name}
                </Typography>
                {skill.description ? (
                  <Typography variant="body2" color="text.secondary">
                    {skill.description}
                  </Typography>
                ) : null}
              </Box>
              <Button
                size="small"
                variant="outlined"
                disabled={busy}
                aria-label={`${text.install} ${skill.name}`}
                onClick={() => {
                  setPath(skill.path)
                  void run({ path: skill.path })
                }}
                sx={{ flexShrink: 0 }}
              >
                {text.install}
              </Button>
            </Box>
          ))}
        </Box>
        {problemAlert}
      </SkillDialog>
    )

  return (
    <SkillDialog
      open={target !== null}
      onClose={close}
      title={title}
      busy={busy}
      actions={
        <>
          <Button onClick={close} disabled={busy}>
            {text.cancel}
          </Button>
          <Button type="submit" form={formId} variant="contained" loading={busy}>
            {text.install}
          </Button>
        </>
      }
    >
      <Alert severity="warning" role="note">
        {nbsp(text.warning)}
      </Alert>
      <Box
        component="form"
        id={formId}
        noValidate
        onSubmit={submit}
        sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}
      >
        {target?.kind === 'address' ? (
          <TextField
            autoFocus
            label={text.linkAddress}
            helperText={text.linkHelp}
            value={address}
            type="url"
            onChange={(event) => setAddress(event.target.value)}
            disabled={busy}
            fullWidth
            slotProps={{
              htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' },
            }}
          />
        ) : null}
        {target?.kind === 'file' ? (
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,.skill"
              hidden
              aria-describedby={fileHelpId}
              data-testid="skill-file"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null)
                setProblem(null)
              }}
            />
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5 }}>
              <Button variant="outlined" disabled={busy} onClick={() => fileInput.current?.click()}>
                {text.chooseFile}
              </Button>
              {file ? (
                <Typography sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>{file.name}</Typography>
              ) : null}
            </Box>
            <Typography id={fileHelpId} variant="body2" color="text.secondary">
              {nbsp(text.fileHelp)}
            </Typography>
          </>
        ) : null}
      </Box>
      {problemAlert}
    </SkillDialog>
  )
}
