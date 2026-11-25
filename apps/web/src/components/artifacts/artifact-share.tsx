'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Collapse from '@mui/material/Collapse'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import {
  artifactLinkUrl,
  artifactRefusalTexts,
  artifactRoleAtLeast,
  type ArtifactOpenGrantRole,
} from '@repo/domain/artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { artifactErrorData } from './artifact-access-error'
import { ArtifactHeadButton } from './artifact-head'
import type { CabinetArtifact } from './use-artifact'

export const shareTexts = Object.freeze({
  open: 'Поделиться',
  title: (name: string) => `Поделиться «${name}»`,
  linkTitle: 'Ссылка',
  linkSwitch: 'Доступ по ссылке',
  linkHint: 'Откроет только тот, кто войдёт в Радити.',
  link: 'Ссылка на артефакт',
  role: 'Доступ',
  linkRole: 'Права по ссылке',
  copy: 'Скопировать',
  copied: 'Ссылка скопирована.',
  live: (opens: number, until: string | null) =>
    `Ссылка работает${until ? ` до ${until}` : ''} · открыли ${opens}`,
  newLink: 'Скопировать новую ссылку',
  newLinkHint: 'Адрес ссылки виден только сразу после создания. Новая ссылка заменит прежнюю.',
  peopleTitle: 'Люди',
  email: 'Адрес почты',
  invite: 'Пригласить',
  invited: 'Приглашение отправлено.',
  nobody: 'Пока доступа нет ни у кого.',
  waiting: 'Ждут принятия',
  revokeInvite: 'Отозвать',
  remove: 'Убрать доступ',
  more: 'Дополнительно',
  term: 'Срок новой ссылки',
  noTerm: 'Без срока',
  days: (n: number) => `${n} дней`,
  allowCopy: 'Разрешить делать копию',
  personalData:
    'Если в артефакте есть данные других людей, лучше приглашайте поимённо: ссылку может переслать любой получатель.',
  closeAll: 'Закрыть доступ всем',
  close: 'Готово',
  leave: 'Покинуть',
  makeCopy: 'Сделать копию',
  failed: 'Не удалось. Попробуйте ещё раз.',
})

/** The roles as the owner gives them (АТ9): «Может смотреть», «Может править». */
export const shareRoleLabels: Readonly<Record<ArtifactOpenGrantRole, string>> = Object.freeze({
  view: 'Может смотреть',
  comment: 'Может комментировать',
  edit: 'Может править',
})

const roles: readonly ArtifactOpenGrantRole[] = ['view', 'edit']
const day = (iso: string) => new Date(iso).toLocaleDateString('ru-RU')

/**
 * «Поделиться» (docs/plan/88-artifacts.md, Ар33–Ар36; docs/plan/93-artifacts-trim.md, АТ9): only
 * the owner — two blocks, «Ссылка» (on or off, its role, «Скопировать») and «Люди» (an invitation
 * by address, who has access); the term of a link, «Разрешить делать копию» and «Закрыть доступ
 * всем» under «Дополнительно». A token is shown once, right after it is made: the server keeps
 * only its hash, and a new link replaces the old one.
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
  const [more, setMore] = useState(false)
  const [notice, setNotice] = useState<{ severity: 'success' | 'error'; text: string } | null>(null)
  const titleId = useId()
  const moreId = useId()
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
  const data = state.data
  const link = data?.link ?? null
  const linkOn = link !== null || url !== null
  const linkRole: ArtifactOpenGrantRole = link?.role === 'edit' ? 'edit' : link ? 'view' : role

  const createLink = (withRole: ArtifactOpenGrantRole) =>
    run(async () => {
      const made = await makeLink.mutateAsync({
        artifactId,
        role: withRole,
        term: term === 'none' ? null : term === '7' ? 7 : 30,
      })
      setUrl(artifactLinkUrl(window.location.origin, made.token))
    })()
  const copy = (address: string) => {
    void navigator.clipboard?.writeText(address)
    setNotice({ severity: 'success', text: shareTexts.copied })
  }

  return (
    <>
      <ArtifactHeadButton
        variant="contained"
        disableElevation
        icon={<AppIcon name="people" size={16} />}
        label={shareTexts.open}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      />
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        aria-labelledby={titleId}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle id={titleId} sx={{ overflowWrap: 'anywhere' }}>
          {shareTexts.title(artifact.title)}
        </DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 3 }}>
          <Box
            component="section"
            aria-label={shareTexts.linkTitle}
            sx={{ display: 'grid', gap: 1 }}
          >
            <Typography component="h3" variant="subtitle2">
              {shareTexts.linkTitle}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <FormControlLabel
                sx={{ mr: 'auto' }}
                label={shareTexts.linkSwitch}
                control={
                  <Switch
                    checked={linkOn}
                    disabled={!data || makeLink.isPending || revoke.isPending}
                    onChange={(event) => {
                      if (event.target.checked) void createLink(role)
                      else
                        void run(async () => {
                          await revoke.mutateAsync({ artifactId })
                          setUrl(null)
                        })()
                    }}
                  />
                }
              />
              <TextField
                select
                size="small"
                label={shareTexts.linkRole}
                value={linkRole}
                disabled={makeLink.isPending}
                onChange={(event) => {
                  const next = event.target.value as ArtifactOpenGrantRole
                  setRole(next)
                  // A link has one role: another role is a new link, the old one stops working.
                  if (linkOn && next !== linkRole) void createLink(next)
                }}
                sx={{ minWidth: 180 }}
              >
                {roles.map((each) => (
                  <MenuItem key={each} value={each}>
                    {shareRoleLabels[each]}
                  </MenuItem>
                ))}
              </TextField>
            </Box>
            {url ? (
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <TextField
                  size="small"
                  value={url}
                  fullWidth
                  slotProps={{ htmlInput: { readOnly: true, 'aria-label': shareTexts.link } }}
                  onFocus={(event) => event.target.select()}
                />
                <Button
                  variant="outlined"
                  startIcon={<AppIcon name="copy" size={16} />}
                  onClick={() => copy(url)}
                  sx={{ flexShrink: 0 }}
                >
                  {shareTexts.copy}
                </Button>
              </Box>
            ) : link ? (
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography variant="body2" color="text.secondary" sx={{ flex: '1 1 200px' }}>
                  {shareTexts.live(link.opens, link.expiresAt ? day(link.expiresAt) : null)}
                </Typography>
                <Tooltip title={shareTexts.newLinkHint}>
                  <Button
                    size="small"
                    disabled={makeLink.isPending}
                    onClick={() => void createLink(linkRole)}
                  >
                    {shareTexts.newLink}
                  </Button>
                </Tooltip>
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary">
                {shareTexts.linkHint}
              </Typography>
            )}
          </Box>
          <Box
            component="section"
            aria-label={shareTexts.peopleTitle}
            sx={{ display: 'grid', gap: 1.25 }}
          >
            <Typography component="h3" variant="subtitle2">
              {shareTexts.peopleTitle}
            </Typography>
            <Box
              component="form"
              onSubmit={(event) => {
                event.preventDefault()
                void run(async () => {
                  await invite.mutateAsync({ artifactId, email: email.trim(), role: inviteRole })
                  setEmail('')
                }, shareTexts.invited)()
              }}
              sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}
            >
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
                sx={{ minWidth: 180 }}
              >
                {roles.map((each) => (
                  <MenuItem key={each} value={each}>
                    {shareRoleLabels[each]}
                  </MenuItem>
                ))}
              </TextField>
              <Button type="submit" variant="outlined" disabled={invite.isPending || !email.trim()}>
                {shareTexts.invite}
              </Button>
            </Box>
            {data && data.people.length === 0 && data.invites.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                {shareTexts.nobody}
              </Typography>
            )}
            {data && data.people.length > 0 && (
              <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 1 }}>
                {data.people.map((person) => (
                  <Box
                    component="li"
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
                      slotProps={{
                        htmlInput: { 'aria-label': `${shareTexts.role}: ${person.name}` },
                      }}
                      onChange={(event) =>
                        void run(() =>
                          setRecipient.mutateAsync({
                            artifactId,
                            recipientId: person.userId,
                            role: event.target.value as ArtifactOpenGrantRole,
                          }),
                        )()
                      }
                      sx={{ minWidth: 180 }}
                    >
                      {roles.map((each) => (
                        <MenuItem key={each} value={each}>
                          {shareRoleLabels[each]}
                        </MenuItem>
                      ))}
                    </TextField>
                    <Tooltip title={shareTexts.remove}>
                      <IconButton
                        aria-label={`${shareTexts.remove}: ${person.name}`}
                        onClick={() =>
                          void run(() =>
                            remove.mutateAsync({ artifactId, recipientId: person.userId }),
                          )()
                        }
                      >
                        <AppIcon name="close" size={16} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                ))}
              </Box>
            )}
            {data && data.invites.length > 0 && (
              <Box sx={{ display: 'grid', gap: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {shareTexts.waiting}
                </Typography>
                {data.invites.map((each) => (
                  <Box key={each.id} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    <Typography variant="body2" sx={{ flex: '1 1 auto', overflowWrap: 'anywhere' }}>
                      {each.email} · {shareRoleLabels[each.role]}
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
              </Box>
            )}
          </Box>
          <Box component="section" aria-label={shareTexts.more}>
            <Button
              color="inherit"
              size="small"
              aria-expanded={more}
              aria-controls={moreId}
              onClick={() => setMore((was) => !was)}
              endIcon={
                <Box
                  component="span"
                  sx={{
                    display: 'flex',
                    transition: 'transform 150ms',
                    transform: more ? 'rotate(180deg)' : 'none',
                  }}
                >
                  <AppIcon name="down" size={16} />
                </Box>
              }
              sx={{ ml: -1, color: 'text.secondary' }}
            >
              {shareTexts.more}
            </Button>
            <Collapse in={more} id={moreId}>
              <Box sx={{ display: 'grid', gap: 1.5, pt: 1.5, justifyItems: 'start' }}>
                <TextField
                  select
                  size="small"
                  label={shareTexts.term}
                  value={term}
                  onChange={(event) => setTerm(event.target.value as 'none' | '7' | '30')}
                  sx={{ minWidth: 180 }}
                >
                  <MenuItem value="none">{shareTexts.noTerm}</MenuItem>
                  <MenuItem value="7">{shareTexts.days(7)}</MenuItem>
                  <MenuItem value="30">{shareTexts.days(30)}</MenuItem>
                </TextField>
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
                <Typography variant="caption" color="text.secondary">
                  {shareTexts.personalData}
                </Typography>
                <Button
                  color="error"
                  size="small"
                  disabled={
                    !data || (data.people.length === 0 && data.invites.length === 0 && !link)
                  }
                  onClick={() =>
                    void run(async () => {
                      await closeAll.mutateAsync({ artifactId })
                      setUrl(null)
                    })()
                  }
                  sx={{ ml: -1 }}
                >
                  {shareTexts.closeAll}
                </Button>
              </Box>
            </Collapse>
          </Box>
          {notice && (
            <Alert severity={notice.severity} onClose={() => setNotice(null)}>
              {notice.text}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="contained" disableElevation onClick={() => setOpen(false)}>
            {shareTexts.close}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

/** «Покинуть» of a recipient (Ар34), an item of «⋯»: their access goes, the gallery opens. */
export function useArtifactLeave(artifact: CabinetArtifact, sharing: boolean) {
  const trpc = useTRPC()
  const router = useRouter()
  const leave = useMutation(trpc.artifact.shareLeave.mutationOptions())
  return {
    available: sharing && !artifactRoleAtLeast(artifact.role, 'owner'),
    pending: leave.isPending,
    run: () =>
      void leave
        .mutateAsync({ artifactId: artifact.id })
        .then(() => router.push('/artifacts'))
        .catch(() => undefined),
  }
}

/**
 * «Сделать копию» of a recipient when the owner allowed it (§7.8, 88.16-4), an item of «⋯»: the
 * copy opens; a refusal comes back as words.
 */
export function useArtifactCopy(
  artifact: CabinetArtifact,
  sharing: boolean,
  onError: (text: string) => void,
) {
  const trpc = useTRPC()
  const router = useRouter()
  const recipient = sharing && !artifactRoleAtLeast(artifact.role, 'owner')
  const mine = useQuery({
    ...trpc.artifact.shareMine.queryOptions({ artifactId: artifact.id }),
    enabled: recipient,
  })
  const copy = useMutation(trpc.artifact.shareCopy.mutationOptions())
  return {
    available: recipient && mine.data?.copyAllowed === true,
    pending: copy.isPending,
    run: () =>
      void copy
        .mutateAsync({ artifactId: artifact.id })
        .then(({ id }) => router.push(`/artifacts/${id}`))
        .catch((failure: unknown) => {
          const code = artifactErrorData(failure)?.domainCode
          onError(
            code === 'ARTIFACT_COPY_REFUSED' ? `${artifactRefusalTexts[code]}.` : shareTexts.failed,
          )
        }),
  }
}
