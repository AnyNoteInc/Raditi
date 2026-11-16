'use client'

import {
  gitConnectionReasonTexts,
  repoProviderBrands,
  type GitConnectionReason,
} from '@repo/domain/repo'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { callErrorText } from '@/components/chat/call-error'
import { useTRPC } from '@/trpc/client'

import type { ProjectDetails } from './project-types'
import { RepositoryRunsLine } from './repo-runs'
import { repoText } from './repo-texts'

// The repository of a project in the cabinet (docs/plan/84-projects.md, ПР6, ПР9, ПР10, §4.8;
// slice 84.17): its row inside «Контекст», the windows «Подключить репозиторий» (P-git-connect),
// «Выберите репозиторий» (P-git-repo-pick) and «Ссылка на репозиторий». Core reads a repository
// after it is attached: the row asks again every two seconds while it syncs.

const POLL_MS = 2000

function WindowFrame({
  open,
  onClose,
  titleId,
  width = 560,
  children,
}: {
  open: boolean
  onClose: () => void
  titleId: string
  width?: number
  children: ReactNode
}) {
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'))
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={fullScreen}
      aria-labelledby={titleId}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: { sm: width },
            m: { sm: 2 },
            border: { sm: 1 },
            borderColor: { sm: 'divider' },
            borderRadius: { xs: 0, sm: '14px' },
          },
        },
      }}
    >
      {open ? children : null}
    </Dialog>
  )
}

/** Reads the repository of the project, asking again while core syncs it. */
export function useProjectRepository(project: Pick<ProjectDetails, 'id' | 'repository'>) {
  const trpc = useTRPC()
  return useQuery({
    ...trpc.projectRepo.get.queryOptions({ projectId: project.id }),
    initialData: project.repository,
    refetchInterval: (query) => (query.state.data?.mirrorState === 'syncing' ? POLL_MS : false),
  })
}

/**
 * The repository inside «Контекст» (ПР6): «Репозиторий: <путь> · подключён как … · Открыть»,
 * what core says of it, the files like secrets, «Обновить» and «Отключить».
 */
export function ProjectRepositoryRow({
  project,
  compact = false,
  onSignIn,
}: {
  project: Pick<ProjectDetails, 'id' | 'repository'>
  compact?: boolean
  /** «Войти заново» of a connection whose sign-in is to be renewed (ревью P3). */
  onSignIn?: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: repo } = useProjectRepository(project)
  const detach = useMutation(trpc.projectRepo.detach.mutationOptions())
  const retry = useMutation(trpc.projectRepo.retry.mutationOptions())
  const [error, setError] = useState<string | null>(null)
  if (!repo) return null
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.projectRepo.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.project.pathKey() })
  }
  async function act(run: () => Promise<unknown>) {
    setError(null)
    try {
      await run()
      refresh()
    } catch (failure) {
      setError(callErrorText(failure))
    }
  }
  const how = repo.connection ? repoText.connectedAs(repo.connection.login) : repoText.byLink
  return (
    <Box data-project-repository="" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', color: 'text.secondary' }} aria-hidden>
          <AppIcon name={repoProviderBrands[repo.provider].icon} size={16} />
        </Box>
        <Typography
          component="span"
          sx={{
            flex: '0 1 auto',
            minWidth: 0,
            fontSize: 14,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {repoText.row}: {repo.path}
        </Typography>
        <Box sx={{ flex: '1 1 auto' }} />
        <Button
          size="small"
          component="a"
          href={repo.webUrl}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={repoText.openLabel(repo.path)}
          sx={{ minHeight: 44, flex: 'none' }}
        >
          {repoText.open}
        </Button>
      </Box>
      <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
        {how}
        {repo.mirrorState === 'syncing' ? ' · Получаем репозиторий…' : ''}
      </Typography>
      {/* The state of the repository under its row (ПР17): the newest build and «Сборки». */}
      {repo.mirrorState === 'ready' ? <RepositoryRunsLine projectId={project.id} /> : null}
      {repo.refusal ? (
        <Alert
          severity="warning"
          action={
            repo.refusal.code === 'GIT_CONNECTION_REAUTH' && onSignIn ? (
              <Button color="inherit" size="small" onClick={onSignIn} sx={{ minHeight: 44 }}>
                {repoText.signInAgain}
              </Button>
            ) : repo.mirrorState === 'failed' || repo.mirrorState === 'unreachable' ? (
              <Button
                color="inherit"
                size="small"
                onClick={() => void act(() => retry.mutateAsync({ projectId: project.id }))}
              >
                {repoText.retry}
              </Button>
            ) : undefined
          }
        >
          {repo.refusal.message}
        </Alert>
      ) : null}
      {repo.secretsFound.length > 0 && !compact ? (
        <Alert severity="info">{repoText.secrets(repo.secretsFound)}</Alert>
      ) : null}
      {error ? <Alert severity="error">{error}</Alert> : null}
      {compact ? null : (
        <Box>
          <Button
            size="small"
            color="inherit"
            aria-label={repoText.detachLabel(repo.path)}
            disabled={detach.isPending}
            onClick={() => void act(() => detach.mutateAsync({ projectId: project.id }))}
            sx={{ minHeight: 44 }}
          >
            {repoText.detach}
          </Button>
        </Box>
      )}
    </Box>
  )
}

/** A refusal of the window itself, already in the client's words. */
export class LinkRefusal extends Error {}

/** «Ссылка на репозиторий» (ПР9): the link of an open repository, read only. */
export function RepoLinkDialog({
  open,
  onClose,
  onAdd,
}: {
  open: boolean
  onClose: () => void
  /** Resolves when the link is taken; throws what the server refused. */
  onAdd: (url: string) => Promise<void>
}) {
  const titleId = useId()
  return (
    <WindowFrame open={open} onClose={onClose} titleId={titleId}>
      <LinkForm titleId={titleId} onClose={onClose} onAdd={onAdd} />
    </WindowFrame>
  )
}

function LinkForm({
  titleId,
  onClose,
  onAdd,
}: {
  titleId: string
  onClose: () => void
  onAdd: (url: string) => Promise<void>
}) {
  const [url, setUrl] = useState('')
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (url.trim() === '') return setMissing(true)
    setBusy(true)
    setError(null)
    try {
      await onAdd(url.trim())
      onClose()
    } catch (failure) {
      setError(failure instanceof LinkRefusal ? failure.message : callErrorText(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event: FormEvent) => void submit(event)}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: { xs: 2.5, sm: 3 } }}
    >
      <Typography id={titleId} component="h2" sx={{ fontSize: 20, fontWeight: 600 }}>
        {repoText.linkTitle}
      </Typography>
      <Typography sx={{ color: 'text.secondary', fontSize: 14 }}>{repoText.linkLead}</Typography>
      <TextField
        label={repoText.linkField}
        placeholder={repoText.linkPlaceholder}
        value={url}
        autoFocus
        required
        error={missing}
        helperText={missing ? repoText.linkRequired : undefined}
        onChange={(event) => {
          setUrl(event.target.value)
          setMissing(false)
        }}
        slotProps={{ htmlInput: { maxLength: 500, inputMode: 'url' } }}
      />
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        <Button onClick={onClose} disabled={busy} sx={{ minHeight: 44 }}>
          {repoText.cancel}
        </Button>
        <Button type="submit" variant="contained" loading={busy} sx={{ minHeight: 44 }}>
          {repoText.linkAdd}
        </Button>
      </Box>
    </Box>
  )
}

type Way = 'github' | 'gitlab' | 'gitlab-self'

/**
 * «Подключить репозиторий» (P-git-connect): GitHub — «Скоро» until Э10; GitLab.com — a sign-in
 * (`/api/git/gitlab/start`), «Скоро» where it is not offered (ПР29); an own GitLab server — its
 * address and a token, which core checks. The connections the user has are offered first.
 */
export function GitConnectDialog({
  open,
  onClose,
  project,
  onConnection,
}: {
  open: boolean
  onClose: () => void
  project: Pick<ProjectDetails, 'id' | 'name'>
  /** A connection to choose a repository of (P-git-repo-pick). */
  onConnection: (connectionId: string) => void
}) {
  const titleId = useId()
  return (
    <WindowFrame open={open} onClose={onClose} titleId={titleId} width={600}>
      <ConnectForm
        titleId={titleId}
        project={project}
        onClose={onClose}
        onConnection={onConnection}
      />
    </WindowFrame>
  )
}

function ConnectForm({
  titleId,
  project,
  onClose,
  onConnection,
}: {
  titleId: string
  project: Pick<ProjectDetails, 'id' | 'name'>
  onClose: () => void
  onConnection: (connectionId: string) => void
}) {
  const trpc = useTRPC()
  const list = useQuery(trpc.gitConnection.list.queryOptions())
  const addToken = useMutation(trpc.gitConnection.addToken.mutationOptions())
  const available = list.data?.available
  // GitLab.com by its sign-in when it is offered (ревью P2), else an own server by a token.
  const [way, setWay] = useState<Way>('gitlab')
  const [host, setHost] = useState('')
  const [token, setToken] = useState('')
  const [shown, setShown] = useState(false)
  const [missing, setMissing] = useState<'host' | 'token' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const gitlabCom = available?.gitlabCom === true
  const chosen: Way = way === 'gitlab' && !gitlabCom ? 'gitlab-self' : way

  async function submit(event: FormEvent) {
    event.preventDefault()
    event.stopPropagation()
    setError(null)
    if (chosen === 'gitlab') {
      setBusy(true)
      try {
        const answer = await fetch('/api/git/gitlab/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: project.id }),
        })
        const body = (await answer.json().catch(() => ({}))) as {
          authorizationUrl?: string
          message?: string
        }
        if (!answer.ok || !body.authorizationUrl) {
          setError(body.message ?? repoText.signInFailed)
          setBusy(false)
          return
        }
        window.location.assign(body.authorizationUrl)
      } catch {
        setError(repoText.signInFailed)
        setBusy(false)
      }
      return
    }
    if (host.trim() === '') return setMissing('host')
    if (token.trim() === '') return setMissing('token')
    setBusy(true)
    try {
      const { connectionId } = await addToken.mutateAsync({
        host: host.trim(),
        token: token.trim(),
      })
      onConnection(connectionId)
    } catch (failure) {
      setError(callErrorText(failure))
    } finally {
      setBusy(false)
    }
  }

  const ways: {
    value: Way
    icon: 'github' | 'gitlab'
    title: string
    hint: string
    soon: boolean
  }[] = [
    {
      value: 'github',
      icon: 'github',
      title: repoText.github,
      hint: repoText.githubHint,
      soon: available?.github !== true,
    },
    {
      value: 'gitlab',
      icon: 'gitlab',
      title: repoText.gitlabCom,
      hint: repoText.gitlabComHint,
      soon: !gitlabCom,
    },
    {
      value: 'gitlab-self',
      icon: 'gitlab',
      title: repoText.ownServer,
      hint: repoText.ownServerHint,
      soon: available?.ownServer === false,
    },
  ]
  const connections = (list.data?.connections ?? []).filter((c) => c.state !== 'suspended')

  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event: FormEvent) => void submit(event)}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, p: { xs: 2.5, sm: 3 } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
          <Typography id={titleId} component="h2" sx={{ fontSize: 20, fontWeight: 600 }}>
            {repoText.connectTitle}
          </Typography>
          <Typography sx={{ mt: 1, color: 'text.secondary', fontSize: 14 }}>
            {repoText.connectLead(project.name)}
          </Typography>
        </Box>
        <IconButton aria-label={repoText.cancel} onClick={onClose} sx={{ width: 44, height: 44 }}>
          <AppIcon name="close" size={20} />
        </IconButton>
      </Box>

      {connections.length > 0 ? (
        <Box component="section" aria-label={repoText.yours}>
          <Typography component="h3" sx={{ fontSize: 14, fontWeight: 600, mb: 1 }}>
            {repoText.yours}
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {connections.map((connection) => (
              <ButtonBase
                key={connection.id}
                onClick={() => onConnection(connection.id)}
                sx={{
                  justifyContent: 'flex-start',
                  gap: 1,
                  minHeight: 44,
                  px: 1.5,
                  borderRadius: '10px',
                  border: 1,
                  borderColor: 'divider',
                  '&:hover': { bgcolor: 'action.hover' },
                  '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' },
                }}
              >
                <AppIcon name="gitlab" size={16} />
                <Box component="span" sx={{ fontSize: 14 }}>
                  {repoText.account(connection.login, connection.host)}
                </Box>
                <Box component="span" sx={{ ml: 'auto', fontSize: 12.5, color: 'text.secondary' }}>
                  {repoText.connectionState[connection.state]}
                </Box>
              </ButtonBase>
            ))}
          </Box>
        </Box>
      ) : null}

      <Box
        role="radiogroup"
        aria-label={repoText.where}
        sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}
      >
        <Typography component="h3" sx={{ fontSize: 14, fontWeight: 600 }}>
          {repoText.where}
        </Typography>
        {ways.map((item) => {
          const checked = chosen === item.value
          return (
            <ButtonBase
              key={item.value}
              role="radio"
              aria-checked={checked}
              aria-disabled={item.soon}
              disabled={item.soon}
              onClick={() => setWay(item.value)}
              sx={{
                justifyContent: 'flex-start',
                textAlign: 'left',
                gap: 1.5,
                p: 1.5,
                minHeight: 56,
                borderRadius: '12px',
                border: 1,
                borderColor: checked ? 'primary.main' : 'divider',
                opacity: item.soon ? 0.6 : 1,
                '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' },
              }}
            >
              <AppIcon name={item.icon} size={20} />
              <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
                <Typography sx={{ fontSize: 14, fontWeight: 500 }}>{item.title}</Typography>
                <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                  {item.hint}
                </Typography>
              </Box>
              {item.soon ? (
                <Box
                  component="span"
                  sx={{
                    px: 1,
                    py: 0.25,
                    borderRadius: '999px',
                    fontSize: 12,
                    bgcolor: 'action.selected',
                    color: 'text.secondary',
                  }}
                >
                  {repoText.soon}
                </Box>
              ) : null}
            </ButtonBase>
          )
        })}
      </Box>

      {chosen === 'gitlab-self' ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label={repoText.serverAddress}
            placeholder={repoText.serverPlaceholder}
            value={host}
            error={missing === 'host'}
            helperText={missing === 'host' ? repoText.addressRequired : undefined}
            onChange={(event) => {
              setHost(event.target.value)
              setMissing(null)
            }}
            slotProps={{ htmlInput: { maxLength: 300, inputMode: 'url', autoComplete: 'off' } }}
          />
          <TextField
            label={repoText.token}
            value={token}
            type={shown ? 'text' : 'password'}
            error={missing === 'token'}
            helperText={missing === 'token' ? repoText.tokenRequired : repoText.tokenHint}
            onChange={(event) => {
              setToken(event.target.value)
              setMissing(null)
            }}
            slotProps={{
              htmlInput: { maxLength: 512, autoComplete: 'off', spellCheck: false },
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label={shown ? repoText.hideToken : repoText.showToken}
                      onClick={() => setShown((value) => !value)}
                      edge="end"
                    >
                      <AppIcon name="eye" size={18} />
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mt: -1 }}>
            {repoText.tokenAdvice}
          </Typography>
        </Box>
      ) : null}

      <Box component="section" aria-label={repoText.can}>
        <Typography component="h3" sx={{ fontSize: 14, fontWeight: 600, mb: 1 }}>
          {repoText.can}
        </Typography>
        <Box
          component="ul"
          sx={{
            m: 0,
            p: 0,
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 0.75,
          }}
        >
          {repoText.canItems.map((item) => (
            <Box component="li" key={item} sx={{ display: 'flex', gap: 1, fontSize: 14 }}>
              <Box sx={{ display: 'flex', color: 'text.secondary', pt: 0.25 }} aria-hidden>
                <AppIcon name="check" size={16} />
              </Box>
              {item}
            </Box>
          ))}
        </Box>
        <Typography sx={{ mt: 1, fontSize: 12.5, color: 'text.secondary' }}>
          {repoText.ciVariables}
        </Typography>
      </Box>

      {error ? <Alert severity="error">{error}</Alert> : null}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, flexWrap: 'wrap' }}>
        <Button onClick={onClose} disabled={busy} sx={{ minHeight: 44 }}>
          {repoText.cancel}
        </Button>
        <Button type="submit" variant="contained" loading={busy} sx={{ minHeight: 44 }}>
          {chosen === 'gitlab' ? repoText.signIn : repoText.check}
        </Button>
      </Box>
    </Box>
  )
}

/**
 * «Выберите репозиторий» (P-git-repo-pick): the account, a search, the repositories core listed
 * with «Закрытый»/«Открытый», «Основная ветка» and «Подключить к проекту». Waits for core's check of
 * a new connection, asking every two seconds.
 */
export function GitRepoPickDialog({
  open,
  onClose,
  onBack,
  project,
  connectionId,
}: {
  open: boolean
  onClose: () => void
  onBack: () => void
  project: Pick<ProjectDetails, 'id'>
  connectionId: string | null
}) {
  const titleId = useId()
  return (
    <WindowFrame
      open={open && connectionId !== null}
      onClose={onClose}
      titleId={titleId}
      width={600}
    >
      {connectionId ? (
        <PickForm
          titleId={titleId}
          project={project}
          connectionId={connectionId}
          onClose={onClose}
          onBack={onBack}
        />
      ) : null}
    </WindowFrame>
  )
}

function PickForm({
  titleId,
  project,
  connectionId,
  onClose,
  onBack,
}: {
  titleId: string
  project: Pick<ProjectDetails, 'id'>
  connectionId: string
  onClose: () => void
  onBack: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const connections = useQuery(trpc.gitConnection.list.queryOptions())
  const connection = connections.data?.connections.find((item) => item.id === connectionId)
  const repos = useQuery({
    ...trpc.gitConnection.repositories.queryOptions({
      connectionId,
      ...(query.trim() ? { query: query.trim() } : {}),
    }),
    refetchInterval: (q) => (q.state.data?.state === 'syncing' ? POLL_MS : false),
  })
  const refresh = useMutation(trpc.gitConnection.refresh.mutationOptions())
  const attach = useMutation(trpc.projectRepo.attach.mutationOptions())
  const items = repos.data?.items ?? []
  const chosen = items.find((item) => item.providerRepoId === picked) ?? null
  const branches = useQuery({
    ...trpc.projectRepo.branches.queryOptions({
      connectionId,
      providerRepoId: chosen?.providerRepoId ?? '1',
    }),
    enabled: chosen !== null,
    refetchInterval: (q) => (q.state.data?.state === 'syncing' ? POLL_MS : false),
  })
  const names = branches.data?.names ?? (chosen ? [chosen.defaultBranch] : [])
  const main = branch ?? chosen?.defaultBranch ?? 'main'

  async function submit(event: FormEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (chosen === null) return setError(repoText.chooseOne)
    setError(null)
    try {
      await attach.mutateAsync({
        projectId: project.id,
        connectionId,
        providerRepoId: chosen.providerRepoId,
        defaultBranch: main,
      })
      void queryClient.invalidateQueries({ queryKey: trpc.projectRepo.pathKey() })
      void queryClient.invalidateQueries({ queryKey: trpc.project.pathKey() })
      onClose()
    } catch (failure) {
      setError(callErrorText(failure))
    }
  }

  const state = repos.data?.state
  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event: FormEvent) => void submit(event)}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: { xs: 2.5, sm: 3 } }}
    >
      <Typography id={titleId} component="h2" sx={{ fontSize: 20, fontWeight: 600 }}>
        {repoText.pickTitle}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AppIcon name="gitlab" size={18} />
        <Typography sx={{ flex: '1 1 auto', fontSize: 14 }}>
          {connection ? repoText.account(connection.login, connection.host) : repoText.checking}
        </Typography>
        <Button size="small" onClick={onBack} sx={{ minHeight: 44 }}>
          {repoText.change}
        </Button>
      </Box>

      {state === 'syncing' || repos.isPending ? (
        <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}>
          <CircularProgress size={18} />
          <Typography sx={{ fontSize: 14 }}>{repoText.checking}</Typography>
        </Box>
      ) : state === 'failed' ? (
        <Alert
          severity="warning"
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() =>
                void refresh
                  .mutateAsync({ connectionId })
                  .then(() =>
                    queryClient.invalidateQueries({ queryKey: trpc.gitConnection.pathKey() }),
                  )
              }
            >
              {repoText.refresh}
            </Button>
          }
        >
          {reasonText(repos.data?.reason ?? null)}
        </Alert>
      ) : (
        <>
          <TextField
            label={repoText.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            slotProps={{ htmlInput: { maxLength: 100 } }}
          />
          <Box component="section" aria-label={repoText.listed(items.length)}>
            <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 1 }}>
              {repoText.listed(items.length)}
            </Typography>
            {items.length === 0 ? (
              <Typography sx={{ fontSize: 14, color: 'text.secondary' }}>
                {query.trim() ? repoText.nothingFound : repoText.none}
              </Typography>
            ) : (
              <Box
                role="radiogroup"
                aria-label={repoText.pickTitle}
                sx={{ display: 'flex', flexDirection: 'column', maxHeight: 320, overflowY: 'auto' }}
              >
                {items.map((item) => {
                  const checked = item.providerRepoId === picked
                  return (
                    <ButtonBase
                      key={item.providerRepoId}
                      role="radio"
                      aria-checked={checked}
                      onClick={() => {
                        setPicked(item.providerRepoId)
                        setBranch(null)
                      }}
                      sx={{
                        justifyContent: 'flex-start',
                        textAlign: 'left',
                        gap: 1,
                        p: 1.25,
                        minHeight: 52,
                        borderRadius: '10px',
                        bgcolor: checked ? 'action.selected' : 'transparent',
                        '&:hover': { bgcolor: checked ? 'action.selected' : 'action.hover' },
                        '&.Mui-focusVisible': {
                          outline: '2px solid',
                          outlineColor: 'primary.main',
                        },
                      }}
                    >
                      <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
                        <Typography sx={{ fontSize: 14, fontWeight: 500 }}>
                          {item.name}{' '}
                          <Box
                            component="span"
                            sx={{ ml: 0.5, fontSize: 12, color: 'text.secondary', fontWeight: 400 }}
                          >
                            {item.visibility === 'public' ? repoText.public : repoText.private}
                          </Box>
                        </Typography>
                        <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                          {item.path}
                        </Typography>
                      </Box>
                    </ButtonBase>
                  )
                })}
              </Box>
            )}
          </Box>
          {chosen ? (
            <Box>
              <TextField
                select
                fullWidth
                label={repoText.branch}
                value={names.includes(main) ? main : (names[0] ?? main)}
                onChange={(event) => setBranch(event.target.value)}
                helperText={
                  branches.data?.state === 'syncing' ? repoText.branchesLoading : undefined
                }
              >
                {(names.length ? names : [main]).map((name) => (
                  <MenuItem key={name} value={name}>
                    {name}
                  </MenuItem>
                ))}
              </TextField>
              <Typography sx={{ mt: 1, fontSize: 12.5, color: 'text.secondary' }}>
                {repoText.agentBranches(main)}
              </Typography>
            </Box>
          ) : null}
        </>
      )}

      {error ? <Alert severity="error">{error}</Alert> : null}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, flexWrap: 'wrap' }}>
        <Button onClick={onBack} disabled={attach.isPending} sx={{ minHeight: 44 }}>
          {repoText.back}
        </Button>
        <Button
          type="submit"
          variant="contained"
          loading={attach.isPending}
          disabled={state !== 'ready'}
          sx={{ minHeight: 44 }}
        >
          {repoText.attach}
        </Button>
      </Box>
    </Box>
  )
}

function reasonText(reason: string | null): string {
  return reason !== null && reason in gitConnectionReasonTexts
    ? gitConnectionReasonTexts[reason as GitConnectionReason]
    : gitConnectionReasonTexts.unreachable
}

/**
 * The windows of the repository of a project and the handlers of «Ссылка на GitHub» and
 * «Подключить GitLab» of the menu of «Контекст». The return from gitlab.com (`?git=connected`)
 * opens «Выберите репозиторий» of the connection it made; `?connect=repository` — after «Создать
 * проект» with «Подключить GitLab» chosen (ПР5) — opens «Подключить репозиторий».
 */
export function useRepositoryWindows(project: Pick<ProjectDetails, 'id' | 'name'>) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const attach = useMutation(trpc.projectRepo.attach.mutationOptions())
  const [linking, setLinking] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [picking, setPicking] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Back from gitlab.com: «Выберите репозиторий» of its newest sign-in, until it is closed.
  const [signedIn, setSignedIn] = useState(false)
  const connections = useQuery({ ...trpc.gitConnection.list.queryOptions(), enabled: signedIn })

  // The address after the return: read once after the first paint, then put back without it.
  useEffect(() => {
    const later = setTimeout(() => {
      const params = new URLSearchParams(window.location.search)
      const git = params.get('git')
      const connect = params.get('connect')
      if (git === null && connect === null) return
      if (connect === 'repository') setConnecting(true)
      if (git === 'connected') setSignedIn(true)
      else if (git !== null && git in repoText.outcome)
        setNotice(repoText.outcome[git as keyof typeof repoText.outcome])
      params.delete('git')
      params.delete('connect')
      const rest = params.toString()
      window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`)
    }, 0)
    return () => clearTimeout(later)
  }, [])
  const newest = signedIn
    ? (connections.data?.connections.filter((c) => c.signsIn).at(-1)?.id ?? null)
    : null
  const shownPick = picking ?? newest
  const closePick = () => {
    setPicking(null)
    setSignedIn(false)
  }

  const windows = (
    <>
      <RepoLinkDialog
        open={linking}
        onClose={() => setLinking(false)}
        onAdd={async (publicUrl) => {
          await attach.mutateAsync({ projectId: project.id, publicUrl })
          void queryClient.invalidateQueries({ queryKey: trpc.projectRepo.pathKey() })
          void queryClient.invalidateQueries({ queryKey: trpc.project.pathKey() })
        }}
      />
      <GitConnectDialog
        open={connecting}
        onClose={() => setConnecting(false)}
        project={project}
        onConnection={(connectionId) => {
          setConnecting(false)
          setPicking(connectionId)
        }}
      />
      <GitRepoPickDialog
        open={shownPick !== null}
        connectionId={shownPick}
        project={project}
        onClose={closePick}
        onBack={() => {
          closePick()
          setConnecting(true)
        }}
      />
    </>
  )
  return {
    onLink: () => setLinking(true),
    onGitlab: () => setConnecting(true),
    notice,
    clearNotice: () => setNotice(null),
    windows,
  }
}
