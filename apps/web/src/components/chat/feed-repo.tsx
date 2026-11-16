'use client'

import {
  repoActionText,
  repoPushRefusalTexts,
  repoRefusalTexts,
  type CiRefusal,
  type CiStatus,
  type RepoActionKind,
  type RepoActionState,
} from '@repo/domain/repo'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Link from '@mui/material/Link'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import NextLink from 'next/link'
import { useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { CiStatusChip, RUNS_POLL_MS, runHref } from '@/components/projects/repo-runs'
import { useTRPC } from '@/trpc/client'

import { callErrorText } from './call-error'
import { CiChangeCard, CiChangeNote } from './feed-repo-ci'
import { MergeCard } from './feed-repo-merge'

// The chat's branch in the repository of its project (docs/plan/84-projects.md, ПР13, ПР14, ПР26;
// P-chat): the card «Изменения в ветке» — the branch, «N файлов · +A −D», up to ten files,
// «Посмотреть изменения» and «Открыть запрос на слияние» or «Отправить в ветку»; the agent's
// proposal of a merge request; what a press did. Nothing reaches the client's repository but by a
// press: the card asks for a token bound to what it shows, and core checks it again. A change of
// build settings has its own card under it (feed-repo-ci.tsx, ПР16).

export const repoCardText = Object.freeze({
  title: 'Изменения в ветке',
  openMergeRequest: 'Открыть запрос на слияние',
  push: 'Отправить в ветку',
  view: 'Посмотреть изменения',
  sent: 'Отправлено в ветку',
  sending: 'Отправляем…',
  merging: 'Принимаем в основную ветку…',
  mergeRequest: 'Запрос на слияние',
  confirmTitlePush: 'Отправить изменения в ветку?',
  confirmTitleMr: 'Открыть запрос на слияние?',
  confirmBody:
    'Изменения уйдут в ветку вашего репозитория, и ваша сборка запустится на ней, как на ветке любого разработчика. В основную ветку агент ничего не отправляет.',
  rewinds: 'Вы отменили часть изменений: в ветку уйдут правки, которые их убирают.',
  mrTitle: 'Название запроса',
  mrDescription: 'Описание',
  draft: 'Черновик',
  cancel: 'Отмена',
  close: 'Закрыть',
  diffTitle: 'Изменения',
  diffMissing: 'Изменения больше 2 МБ — посмотрите их в репозитории после отправки.',
  diffLoading: 'Загружаем изменения…',
  proposal: 'Агент предлагает открыть запрос на слияние',
  failed: 'Не получилось — попробуйте ещё раз.',
  build: 'Сборка',
  merged: 'Принято в основную ветку',
  waitingMerge: 'Примем в основную ветку, когда сборка пройдёт.',
  mergedTakenBack: repoPushRefusalTexts.REPO_ALREADY_MERGED,
  more: (n: number) => `и ещё ${n}`,
  /** Why the card has no buttons (ревью P3). */
  blocked: {
    reauth: 'Отправить нельзя: нужно войти в GitLab заново',
    other_member: 'Отправить нельзя: репозиторий подключил другой участник',
  },
  openProject: 'Открыть проект',
})

const pluralFiles = (n: number) => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'файл'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'файла'
  return 'файлов'
}

/** «N файлов · +A −D». */
export const statLine = (stat: { files: number; additions: number; deletions: number }) =>
  `${stat.files} ${pluralFiles(stat.files)} · +${stat.additions} −${stat.deletions}`

/** The words of a refusal code of a press, without a code the client cannot read. */
export function repoErrorText(code: string | null | undefined): string {
  if (!code) return repoCardText.failed
  const texts: Record<string, string> = { ...repoRefusalTexts, ...repoPushRefusalTexts }
  const text = texts[code]
  return text ? `${text}.` : repoCardText.failed
}

/** A sent branch whose build has not shown up is looked at for this long (no CI — no build). */
const AWAIT_RUN_MS = 10 * 60_000

/**
 * The chat's branch as core keeps it: refreshed while a press is on its way, and while its build or
 * its merge request may still change (ПР17; slice 84.21) — core polls the provider, the card reads
 * what core wrote. No reload, no webhook.
 */
function useBranch(taskId: string | undefined) {
  const trpc = useTRPC()
  const [since] = useState(() => Date.now())
  return useQuery({
    ...trpc.projectRepo.branch.queryOptions({ taskId: taskId ?? '' }),
    enabled: Boolean(taskId),
    refetchInterval: (query) => {
      const view = query.state.data
      const state = view?.lastAction?.state
      if (state === 'queued' || state === 'running') return 2000
      if (!view || view.state === 'merged' || view.state === 'closed') return false
      const run = view.lastRun?.status
      if (run === 'pending' || run === 'running') return RUNS_POLL_MS
      if (
        view.mergeRequest &&
        (view.mergeRequest.state === 'open' || view.mergeRequest.state === 'draft')
      )
        return RUNS_POLL_MS
      if (view.sent && view.lastRun === null && Date.now() - since < AWAIT_RUN_MS)
        return RUNS_POLL_MS
      return false
    },
  })
}

/** «Сборка: Идёт» of the chat's branch at the client, linking to the build in «Репозиторий». */
function BuildLine({
  projectId,
  run,
}: {
  projectId: string
  run: { id: string; status: CiStatus; refusal: CiRefusal | null }
}) {
  return (
    <Box data-feed-repo-build={run.status} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {repoCardText.build}:
      </Typography>
      <Link component={NextLink} href={runHref(projectId, run.id)} underline="none">
        <CiStatusChip status={run.status} refusal={run.refusal} />
      </Link>
    </Box>
  )
}

/** «Отправить в ветку» and «Открыть запрос на слияние»: the card's token, then the press. */
function PushButton({ taskId, label }: { taskId: string; label: string }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const prepare = useMutation(trpc.projectRepo.preparePush.mutationOptions())
  const confirm = useMutation(trpc.projectRepo.confirmPush.mutationOptions())
  const [shown, setShown] = useState<Awaited<ReturnType<typeof prepare.mutateAsync>> | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function open() {
    setError(null)
    try {
      const prepared = await prepare.mutateAsync({ taskId })
      setTitle(prepared.proposal?.title ?? '')
      setDescription(prepared.proposal?.description ?? '')
      setShown(prepared)
    } catch (failure) {
      setError(callErrorText(failure))
    }
  }

  async function press() {
    if (!shown) return
    setError(null)
    try {
      await confirm.mutateAsync({
        confirmToken: shown.confirmToken,
        ...(shown.opensMergeRequest
          ? {
              mergeRequest: {
                title: title.trim() || 'Изменения агента',
                description,
                draft: shown.proposal?.draft ?? false,
                reservedId: shown.proposal?.reservedId ?? null,
              },
            }
          : {}),
      })
      setShown(null)
    } catch (failure) {
      setError(callErrorText(failure))
    }
    void queryClient.invalidateQueries({ queryKey: trpc.projectRepo.branch.queryKey({ taskId }) })
  }

  const busy = prepare.isPending || confirm.isPending
  return (
    <>
      <Button
        size="small"
        variant="contained"
        disabled={busy}
        onClick={() => void open()}
        sx={{ minHeight: 44 }}
      >
        {label}
      </Button>
      {error && !shown ? (
        <Typography role="alert" variant="body2" sx={{ color: 'error.main', flexBasis: '100%' }}>
          {error}
        </Typography>
      ) : null}
      <Dialog open={shown !== null} onClose={() => setShown(null)} fullWidth maxWidth="sm">
        {shown ? (
          <>
            <DialogTitle>
              {shown.opensMergeRequest
                ? repoCardText.confirmTitleMr
                : repoCardText.confirmTitlePush}
            </DialogTitle>
            <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              <Typography variant="body2" sx={{ fontFamily: 'var(--font-mono, monospace)' }}>
                {shown.branch}
              </Typography>
              <Typography variant="body2">{statLine(shown.stat)}</Typography>
              {shown.rewinds ? (
                <Typography variant="body2">{repoCardText.rewinds}</Typography>
              ) : null}
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {repoCardText.confirmBody}
              </Typography>
              {shown.opensMergeRequest ? (
                <>
                  <TextField
                    label={repoCardText.mrTitle}
                    value={title}
                    onChange={(event) => setTitle(event.target.value.slice(0, 120))}
                    size="small"
                  />
                  <TextField
                    label={repoCardText.mrDescription}
                    value={description}
                    onChange={(event) => setDescription(event.target.value.slice(0, 4000))}
                    size="small"
                    multiline
                    minRows={3}
                  />
                </>
              ) : null}
              {error ? (
                <Typography role="alert" variant="body2" sx={{ color: 'error.main' }}>
                  {error}
                </Typography>
              ) : null}
            </DialogContent>
            <DialogActions>
              <Button color="inherit" onClick={() => setShown(null)} disabled={busy}>
                {repoCardText.cancel}
              </Button>
              <Button variant="contained" onClick={() => void press()} disabled={busy}>
                {shown.opensMergeRequest ? repoCardText.openMergeRequest : repoCardText.push}
              </Button>
            </DialogActions>
          </>
        ) : null}
      </Dialog>
    </>
  )
}

/** «Посмотреть изменения»: the diff of the turn of the card, up to 2 MiB. */
function DiffButton({ taskId, headSha }: { taskId: string; headSha: string }) {
  const trpc = useTRPC()
  const [open, setOpen] = useState(false)
  const diff = useQuery({
    ...trpc.projectRepo.diff.queryOptions({ taskId, headSha }),
    enabled: open,
  })
  return (
    <>
      <Button size="small" color="inherit" onClick={() => setOpen(true)} sx={{ minHeight: 44 }}>
        {repoCardText.view}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>{repoCardText.diffTitle}</DialogTitle>
        <DialogContent>
          {diff.isPending ? (
            <Typography variant="body2">{repoCardText.diffLoading}</Typography>
          ) : diff.data?.patch ? (
            <Box
              component="pre"
              data-repo-diff=""
              sx={{
                m: 0,
                fontSize: 12,
                lineHeight: '18px',
                fontFamily: 'var(--font-mono, monospace)',
                whiteSpace: 'pre',
                overflowX: 'auto',
              }}
            >
              {diff.data.patch}
            </Box>
          ) : (
            <Typography variant="body2">
              {diff.error ? callErrorText(diff.error) : repoCardText.diffMissing}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{repoCardText.close}</Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

interface RepoChangesRow {
  branch: string
  headSha: string
  files: number
  additions: number
  deletions: number
  list: readonly { path: string; additions: number; deletions: number }[]
}

const CARD_FILES = 10

/** The card «Изменения в ветке» of one turn; the buttons stand on the card of the chat's head. */
export function FeedRepoChanges({
  taskId,
  row,
}: {
  taskId: string | undefined
  row: RepoChangesRow
}) {
  const branch = useBranch(taskId)
  const view = taskId ? branch.data : null
  const current = view?.headSha === row.headSha
  const pressing = view?.lastAction?.state === 'queued' || view?.lastAction?.state === 'running'
  const files = row.list.slice(0, CARD_FILES)
  return (
    <Box
      data-feed-repo-changes=""
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        minWidth: 0,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AppIcon name="changes" size={16} />
        <Typography variant="subtitle2">{repoCardText.title}</Typography>
      </Box>
      <Typography
        variant="body2"
        sx={{ fontFamily: 'var(--font-mono, monospace)', overflowWrap: 'anywhere' }}
      >
        {view?.branch ?? row.branch}
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {statLine(row)}
      </Typography>
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
        {files.map((file) => (
          <Box
            component="li"
            key={file.path}
            sx={{ display: 'flex', gap: 1, justifyContent: 'space-between', minWidth: 0 }}
          >
            <Typography
              variant="body2"
              sx={{ fontFamily: 'var(--font-mono, monospace)', overflowWrap: 'anywhere' }}
            >
              {file.path}
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary', flexShrink: 0 }}>
              +{file.additions} −{file.deletions}
            </Typography>
          </Box>
        ))}
        {row.files > files.length ? (
          <Typography component="li" variant="body2" sx={{ color: 'text.secondary' }}>
            {repoCardText.more(row.files - files.length)}
          </Typography>
        ) : null}
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
        {taskId &&
        current &&
        view?.canPush &&
        !view.sent &&
        !pressing &&
        !(view.state === 'merged' && view.rewinds) &&
        view.ciChange === 'none' ? (
          <PushButton
            taskId={taskId}
            label={view.mergeRequest ? repoCardText.push : repoCardText.openMergeRequest}
          />
        ) : null}
        {taskId ? <DiffButton taskId={taskId} headSha={row.headSha} /> : null}
        {current && pressing ? (
          <Typography role="status" variant="body2" sx={{ color: 'text.secondary' }}>
            {view?.lastAction?.kind === 'merge' ? repoCardText.merging : repoCardText.sending}
          </Typography>
        ) : null}
        {current && view?.sent && view.state !== 'merged' ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {repoCardText.sent}
          </Typography>
        ) : null}
        {current && view?.state === 'merged' && !view.rewinds ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {repoCardText.merged}
          </Typography>
        ) : null}
        {view?.mergeRequest ? (
          <Link href={view.mergeRequest.url} target="_blank" rel="noreferrer" variant="body2">
            {repoCardText.mergeRequest}
          </Link>
        ) : null}
      </Box>
      {current && view?.lastRun ? (
        <BuildLine projectId={view.projectId} run={view.lastRun} />
      ) : null}
      {current && view?.pushBlocked && !view.sent ? (
        <Typography role="status" variant="body2" data-feed-repo-blocked="">
          {repoCardText.blocked[view.pushBlocked]}.{' '}
          <Link
            href={`/projects/${view.projectId}`}
            sx={{ display: 'inline-flex', minHeight: 44, alignItems: 'center' }}
          >
            {repoCardText.openProject}
          </Link>
        </Typography>
      ) : null}
      {/* «Принять в основную ветку» (ПР15): only a press of the client, never the agent. */}
      {taskId && current && view?.canPush && view.sent && !pressing && view.state === 'pushed' ? (
        view.mergeRequest?.autoMerge ||
        (view.lastAction?.kind === 'merge' && view.lastAction.state === 'waiting') ? (
          <Typography role="status" variant="body2" data-feed-repo-waiting="">
            {repoCardText.waitingMerge}
          </Typography>
        ) : view.mergeRequest?.state === 'open' ? (
          <MergeCard
            taskId={taskId}
            projectId={view.projectId}
            number={view.mergeRequest.number}
            headSha={view.mergeRequest.headSha}
          />
        ) : view.mergeRequest === null ? (
          // Sent, and its merge request did not open (ревью C5): it opens alone, nothing is sent.
          <Box>
            <PushButton taskId={taskId} label={repoCardText.openMergeRequest} />
          </Box>
        ) : null
      ) : null}
      {/* `/undo` after the merge request was accepted (ПР25). */}
      {current && view?.state === 'merged' && view.rewinds ? (
        <Typography role="status" variant="body2" data-feed-repo-merged="">
          {repoCardText.mergedTakenBack}.
        </Typography>
      ) : null}
      {/* Build settings go only by their own card (ПР16). */}
      {taskId && current && view?.canPush && !view.sent && !pressing ? (
        view.ciChange === 'needed' ? (
          <CiChangeCard taskId={taskId} />
        ) : view.ciChange === 'declined' || view.ciChange === 'foreign' ? (
          <CiChangeNote state={view.ciChange} />
        ) : null
      ) : null}
    </Box>
  )
}

/** The agent's proposal of a merge request (ПР14): the client opens it with the button. */
export function FeedRepoProposal({
  taskId,
  title,
  description,
}: {
  taskId: string | undefined
  title: string
  description: string
}) {
  const branch = useBranch(taskId)
  const view = taskId ? branch.data : null
  const pressing = view?.lastAction?.state === 'queued' || view?.lastAction?.state === 'running'
  return (
    <Box data-feed-repo-proposal="" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Typography variant="body2">
        {repoCardText.proposal}: «{title}»
      </Typography>
      {description ? (
        <Typography variant="body2" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap' }}>
          {description}
        </Typography>
      ) : null}
      {taskId &&
      view?.canPush &&
      (!view.sent || view.state === 'pushed') &&
      !view.mergeRequest &&
      !pressing &&
      view.ciChange === 'none' ? (
        <Box>
          <PushButton taskId={taskId} label={repoCardText.openMergeRequest} />
        </Box>
      ) : null}
    </Box>
  )
}

/** What a press did (`feed.repo_action`). */
export function FeedRepoAction({
  kind,
  state,
  url,
  error,
}: {
  kind: RepoActionKind
  state: RepoActionState
  url?: string | undefined
  error?: string | undefined
}) {
  const text =
    state === 'failed' ? repoErrorText(error) : `${repoActionText({ kind, state }, null)}.`
  return (
    <Box data-feed-repo-action={state} sx={{ display: 'flex', gap: 1, color: 'text.secondary' }}>
      <Typography variant="body2">{text}</Typography>
      {url && state === 'done' ? (
        <Link href={url} target="_blank" rel="noreferrer" variant="body2">
          {repoCardText.mergeRequest}
        </Link>
      ) : null}
    </Box>
  )
}
