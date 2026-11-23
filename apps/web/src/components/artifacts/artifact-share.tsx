'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Checkbox from '@mui/material/Checkbox'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import {
  artifactGrantAllowed,
  artifactLinkUrl,
  artifactRefusalTexts,
  artifactRoleAtLeast,
  artifactRoleLabels,
  type ArtifactKind,
  type ArtifactOpenGrantRole,
} from '@repo/domain/artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { artifactErrorData } from './artifact-access-error'
import type { CabinetArtifact } from './use-artifact'

export const shareTexts = Object.freeze({
  open: 'Поделиться',
  title: 'Поделиться',
  linkTitle: 'Ссылка для пользователей Радити',
  linkHint: 'Откроет только тот, кто войдёт в Радити. Почту и имя получателя вы увидите ниже.',
  role: 'Доступ',
  term: 'Срок',
  noTerm: 'Без срока',
  days: (n: number) => `${n} дней`,
  makeLink: 'Создать ссылку',
  newLink: 'Новая ссылка',
  revoke: 'Отключить ссылку',
  copy: 'Скопировать',
  copied: 'Ссылка скопирована. Она показывается один раз: сохраните её или создайте новую.',
  live: (role: string, until: string | null, opens: number) =>
    `Ссылка работает: ${role}${until ? `, до ${until}` : ''} · открыли ${opens}`,
  inviteTitle: 'Пригласить по почте',
  email: 'Адрес почты',
  invite: 'Пригласить',
  invited: 'Приглашение отправлено.',
  people: 'У кого есть доступ',
  nobody: 'Пока ни у кого.',
  waiting: 'Ждут принятия',
  revokeInvite: 'Отозвать',
  remove: 'Убрать доступ',
  closeAll: 'Закрыть доступ всем',
  close: 'Готово',
  leave: 'Выйти из артефакта',
  allowCopy: 'Разрешить получателям делать себе копию',
  makeCopy: 'Сделать копию',
  failed: 'Не удалось. Попробуйте ещё раз.',
  personalData:
    'Если в артефакте есть данные других людей, лучше пригласите поимённо, чем по ссылке: её может переслать любой получатель.',
})

const roles: readonly ArtifactOpenGrantRole[] = ['view', 'edit']
const day = (iso: string) => new Date(iso).toLocaleDateString('ru-RU')

/**
 * «Поделиться» (docs/plan/88-artifacts.md, Ар33–Ар36; board E-share): only the owner — a link for
 * those who sign in, invitations by address, who has access and «Закрыть доступ всем». A token is
 * shown once, right after it is made: the server keeps only its hash.
 */
export function ArtifactShareButton({ artifact }: { artifact: CabinetArtifact }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [role, setRole] = useState<ArtifactOpenGrantRole>('view')
  const [term, setTerm] = useState<'none' | '7' | '30'>('none')
  const [url, setUrl] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<ArtifactOpenGrantRole>('view')
  const [notice, setNotice] = useState<{ severity: 'success' | 'error'; text: string } | null>(null)
  const titleId = useId()
  const artifactId = artifact.id
  const state = useQuery({
    ...trpc.artifact.shareState.queryOptions({ artifactId }),
    enabled: open,
  })
  const reread = () =>
    queryClient.invalidateQueries({ queryKey: trpc.artifact.shareState.queryKey({ artifactId }) })
  const fail = (error: unknown) => {
    const code = artifactErrorData(error)?.domainCode
    setNotice({
      severity: 'error',
      text:
        code && code in artifactRefusalTexts
          ? `${artifactRefusalTexts[code as keyof typeof artifactRefusalTexts]}.`
          : shareTexts.failed,
    })
  }
  const run = (work: () => Promise<unknown>, done?: string) => async () => {
    setNotice(null)
    try {
      await work()
      if (done) setNotice({ severity: 'success', text: done })
      void reread()
    } catch (error) {
      fail(error)
    }
  }
  const makeLink = useMutation(trpc.artifact.shareLink.mutationOptions())
  const revoke = useMutation(trpc.artifact.shareRevoke.mutationOptions())
  const invite = useMutation(trpc.artifact.shareInvite.mutationOptions())
  const revokeInvite = useMutation(trpc.artifact.shareInviteRevoke.mutationOptions())
  const setRecipient = useMutation(trpc.artifact.shareSetRole.mutationOptions())
  const remove = useMutation(trpc.artifact.shareRemove.mutationOptions())
  const closeAll = useMutation(trpc.artifact.shareCloseAll.mutationOptions())
  const setCopy = useMutation(trpc.artifact.shareSetCopy.mutationOptions())
  if (!artifactRoleAtLeast(artifact.role, 'owner')) return null
  const editAllowed = artifactGrantAllowed(artifact.kind as ArtifactKind, 'edit')
  const shownRoles = roles.filter((each) => each !== 'edit' || editAllowed)
  const data = state.data

  const createLink = run(async () => {
    const link = await makeLink.mutateAsync({
      artifactId,
      role,
      term: term === 'none' ? null : term === '7' ? 7 : 30,
    })
    setUrl(artifactLinkUrl(window.location.origin, link.token))
  })

  return (
    <>
      <Button
        variant="text"
        color="inherit"
        startIcon={<AppIcon name="share" size={16} />}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {shareTexts.open}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        aria-labelledby={titleId}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle id={titleId}>{shareTexts.title}</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 2 }}>
          <Box
            component="section"
            aria-label={shareTexts.linkTitle}
            sx={{ display: 'grid', gap: 1 }}
          >
            <Typography variant="subtitle2">{shareTexts.linkTitle}</Typography>
            <Typography variant="body2" color="text.secondary">
              {shareTexts.linkHint}
            </Typography>
            {data?.link && (
              <Typography variant="body2">
                {shareTexts.live(
                  artifactRoleLabels[data.link.role],
                  data.link.expiresAt ? day(data.link.expiresAt) : null,
                  data.link.opens,
                )}
              </Typography>
            )}
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
              <TextField
                select
                size="small"
                label={shareTexts.role}
                value={role}
                onChange={(event) => setRole(event.target.value as ArtifactOpenGrantRole)}
                sx={{ minWidth: 140 }}
              >
                {shownRoles.map((each) => (
                  <MenuItem key={each} value={each}>
                    {artifactRoleLabels[each]}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                size="small"
                label={shareTexts.term}
                value={term}
                onChange={(event) => setTerm(event.target.value as 'none' | '7' | '30')}
                sx={{ minWidth: 140 }}
              >
                <MenuItem value="none">{shareTexts.noTerm}</MenuItem>
                <MenuItem value="7">{shareTexts.days(7)}</MenuItem>
                <MenuItem value="30">{shareTexts.days(30)}</MenuItem>
              </TextField>
              <Button
                variant="outlined"
                onClick={() => void createLink()}
                disabled={makeLink.isPending}
              >
                {data?.link ? shareTexts.newLink : shareTexts.makeLink}
              </Button>
              {data?.link && (
                <Button
                  color="inherit"
                  onClick={() => void run(() => revoke.mutateAsync({ artifactId }))()}
                >
                  {shareTexts.revoke}
                </Button>
              )}
            </Box>
            {url && (
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <TextField
                  size="small"
                  value={url}
                  fullWidth
                  slotProps={{ htmlInput: { readOnly: true, 'aria-label': shareTexts.linkTitle } }}
                />
                <Button
                  onClick={() => {
                    void navigator.clipboard?.writeText(url)
                    setNotice({ severity: 'success', text: shareTexts.copied })
                  }}
                >
                  {shareTexts.copy}
                </Button>
              </Box>
            )}
            <Typography variant="caption" color="text.secondary">
              {shareTexts.personalData}
            </Typography>
          </Box>
          <Divider />
          <Box
            component="form"
            aria-label={shareTexts.inviteTitle}
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                await invite.mutateAsync({ artifactId, email: email.trim(), role: inviteRole })
                setEmail('')
              }, shareTexts.invited)()
            }}
            sx={{ display: 'grid', gap: 1 }}
          >
            <Typography variant="subtitle2">{shareTexts.inviteTitle}</Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <TextField
                size="small"
                type="email"
                label={shareTexts.email}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                sx={{ flex: '1 1 220px' }}
              />
              <TextField
                select
                size="small"
                label={shareTexts.role}
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as ArtifactOpenGrantRole)}
                sx={{ minWidth: 140 }}
              >
                {shownRoles.map((each) => (
                  <MenuItem key={each} value={each}>
                    {artifactRoleLabels[each]}
                  </MenuItem>
                ))}
              </TextField>
              <Button type="submit" variant="outlined" disabled={invite.isPending || !email.trim()}>
                {shareTexts.invite}
              </Button>
            </Box>
          </Box>
          <Divider />
          <Box component="section" aria-label={shareTexts.people} sx={{ display: 'grid', gap: 1 }}>
            <Typography variant="subtitle2">{shareTexts.people}</Typography>
            {data && data.people.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                {shareTexts.nobody}
              </Typography>
            )}
            {data?.people.map((person) => (
              <Box
                key={person.userId}
                sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}
              >
                <Box sx={{ flex: '1 1 200px', minWidth: 0 }}>
                  <Typography variant="body2">{person.name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {person.email}
                  </Typography>
                </Box>
                <TextField
                  select
                  size="small"
                  value={person.role === 'edit' ? 'edit' : 'view'}
                  slotProps={{ htmlInput: { 'aria-label': `${shareTexts.role}: ${person.name}` } }}
                  onChange={(event) =>
                    void run(() =>
                      setRecipient.mutateAsync({
                        artifactId,
                        recipientId: person.userId,
                        role: event.target.value as ArtifactOpenGrantRole,
                      }),
                    )()
                  }
                >
                  {shownRoles.map((each) => (
                    <MenuItem key={each} value={each}>
                      {artifactRoleLabels[each]}
                    </MenuItem>
                  ))}
                </TextField>
                <IconButton
                  aria-label={`${shareTexts.remove}: ${person.name}`}
                  onClick={() =>
                    void run(() => remove.mutateAsync({ artifactId, recipientId: person.userId }))()
                  }
                >
                  <AppIcon name="close" size={16} />
                </IconButton>
              </Box>
            ))}
            {data && data.invites.length > 0 && (
              <>
                <Typography variant="caption" color="text.secondary">
                  {shareTexts.waiting}
                </Typography>
                {data.invites.map((each) => (
                  <Box key={each.id} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    <Typography variant="body2" sx={{ flex: '1 1 auto', overflowWrap: 'anywhere' }}>
                      {each.email} · {artifactRoleLabels[each.role]}
                    </Typography>
                    <Button
                      size="small"
                      color="inherit"
                      onClick={() =>
                        void run(() =>
                          revokeInvite.mutateAsync({ artifactId, inviteId: each.id }),
                        )()
                      }
                    >
                      {shareTexts.revokeInvite}
                    </Button>
                  </Box>
                ))}
              </>
            )}
          </Box>
          <FormControlLabel
            label={shareTexts.allowCopy}
            control={
              <Checkbox
                checked={data?.copyAllowed === true}
                disabled={!data || setCopy.isPending}
                onChange={(event) =>
                  void run(() =>
                    setCopy.mutateAsync({ artifactId, allowed: event.target.checked }),
                  )()
                }
              />
            }
          />
          {notice && <Alert severity={notice.severity}>{notice.text}</Alert>}
        </DialogContent>
        <DialogActions sx={{ justifyContent: 'space-between' }}>
          <Button
            color="error"
            disabled={
              !data || (data.people.length === 0 && data.invites.length === 0 && !data.link)
            }
            onClick={() =>
              void run(async () => {
                await closeAll.mutateAsync({ artifactId })
                setUrl(null)
              })()
            }
          >
            {shareTexts.closeAll}
          </Button>
          <Button onClick={() => setOpen(false)}>{shareTexts.close}</Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

/** «Выйти» of a recipient (Ар34): their access goes, the gallery opens. */
export function ArtifactLeaveButton({ artifact }: { artifact: CabinetArtifact }) {
  const trpc = useTRPC()
  const router = useRouter()
  const leave = useMutation(trpc.artifact.shareLeave.mutationOptions())
  if (artifactRoleAtLeast(artifact.role, 'owner')) return null
  return (
    <Button
      variant="text"
      color="inherit"
      disabled={leave.isPending}
      onClick={() =>
        void leave
          .mutateAsync({ artifactId: artifact.id })
          .then(() => router.push('/artifacts'))
          .catch(() => undefined)
      }
    >
      {shareTexts.leave}
    </Button>
  )
}

/** «Сделать копию» of a recipient, when the owner allowed it (§7.8, 88.16-4). */
export function ArtifactCopyButton({ artifact }: { artifact: CabinetArtifact }) {
  const trpc = useTRPC()
  const router = useRouter()
  const mine = useQuery({
    ...trpc.artifact.shareMine.queryOptions({ artifactId: artifact.id }),
    enabled: !artifactRoleAtLeast(artifact.role, 'owner'),
  })
  const copy = useMutation(trpc.artifact.shareCopy.mutationOptions())
  const [error, setError] = useState<string | null>(null)
  if (artifactRoleAtLeast(artifact.role, 'owner') || mine.data?.copyAllowed !== true) return null
  return (
    <>
      <Button
        variant="text"
        color="inherit"
        startIcon={<AppIcon name="copy" size={16} />}
        disabled={copy.isPending}
        onClick={() => {
          setError(null)
          void copy
            .mutateAsync({ artifactId: artifact.id })
            .then(({ id }) => router.push(`/artifacts/${id}`))
            .catch((failure: unknown) => {
              const code = artifactErrorData(failure)?.domainCode
              setError(
                code === 'ARTIFACT_COPY_REFUSED'
                  ? `${artifactRefusalTexts[code]}.`
                  : shareTexts.failed,
              )
            })
        }}
      >
        {shareTexts.makeCopy}
      </Button>
      {error && <Alert severity="warning">{error}</Alert>}
    </>
  )
}
