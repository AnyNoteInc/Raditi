'use client'

import { checksStateWords, repoMergeTexts } from '@repo/domain/repo'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import FormControlLabel from '@mui/material/FormControlLabel'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { callErrorText } from './call-error'

// The card «Принять запрос в основную ветку?» (docs/plan/84-projects.md, ПР15; P-chat-merge, the
// upper card; slice 84.22): under the card «Изменения в ветке» of the chat's head once its merge
// request is open. Its token is bound to the request, its target branch and its head; core reads
// the request again and merges only with that head. The text about a deploy is even: the build of
// the client is not read by the platform (the review's fix of the board). The agent never comes here.

export const mergeCardText = Object.freeze({
  title: (target: string) => `Принять запрос в основную ветку ${target}?`,
  onlyYou: 'Подтверждаете только вы',
  commit: 'Версия',
  checks: (state: keyof typeof checksStateWords) => checksStateWords[state],
  after: repoMergeTexts.afterMerge,
  deleteBranch: (branch: string) => `Удалить ветку ${branch} после принятия`,
  now: 'Принять в основную ветку',
  whenGreen: 'Принять, когда сборка пройдёт',
  later: 'Не сейчас',
  /** The card folded by «Не сейчас» (ревью P15): one press opens it again. */
  unfold: 'Принять запрос в основную ветку…',
  open: 'Открыть запрос',
  loading: 'Готовим карточку…',
  again: 'Обновить карточку',
})

function usePrepare() {
  const trpc = useTRPC()
  return useMutation(trpc.projectRepo.prepareMerge.mutationOptions())
}

type Prepared = Awaited<ReturnType<ReturnType<typeof usePrepare>['mutateAsync']>>

/** The card itself; prepared again when the head of the request moves. */
export function MergeCard({
  taskId,
  projectId,
  number,
  headSha,
}: {
  taskId: string
  projectId: string
  number: number
  headSha: string
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const prepare = usePrepare()
  const confirm = useMutation(trpc.projectRepo.confirmMerge.mutationOptions())
  const [shown, setShown] = useState<Prepared | null>(null)
  const [deleteBranch, setDeleteBranch] = useState(true)
  const [hidden, setHidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  const { mutateAsync } = prepare

  useEffect(() => {
    let stopped = false
    void (async () => {
      try {
        const prepared = await mutateAsync({ projectId, number })
        if (stopped) return
        setShown(prepared)
        setDeleteBranch(prepared.deleteBranch)
        setError(null)
      } catch (failure) {
        if (!stopped) setError(callErrorText(failure))
      }
    })()
    return () => {
      stopped = true
    }
  }, [mutateAsync, projectId, number, headSha, round])

  async function accept(mode: 'now' | 'when_green') {
    if (!shown) return
    setError(null)
    try {
      await confirm.mutateAsync({ confirmToken: shown.confirmToken, mode, deleteBranch })
      setShown(null)
    } catch (failure) {
      setError(callErrorText(failure))
    }
    void queryClient.invalidateQueries({ queryKey: trpc.projectRepo.branch.queryKey({ taskId }) })
  }

  if (hidden)
    return (
      <Box>
        <Button
          size="small"
          color="inherit"
          onClick={() => {
            setHidden(false)
            setRound((value) => value + 1)
          }}
          sx={{ minHeight: 44 }}
        >
          {mergeCardText.unfold}
        </Button>
      </Box>
    )
  const busy = confirm.isPending
  return (
    <Box
      data-repo-merge-card=""
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        minWidth: 0,
        flexBasis: '100%',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <AppIcon name="changes" size={16} />
        <Typography variant="subtitle2">{mergeCardText.title(shown?.target ?? 'main')}</Typography>
        <Chip size="small" variant="outlined" label={mergeCardText.onlyYou} />
      </Box>
      {shown === null && error === null ? (
        <Typography role="status" variant="body2" sx={{ color: 'text.secondary' }}>
          {mergeCardText.loading}
        </Typography>
      ) : null}
      {shown ? (
        <>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            «{shown.title}» ·{' '}
            <Box component="span" sx={{ fontFamily: 'var(--font-mono, monospace)' }}>
              {shown.source} → {shown.target}
            </Box>
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {mergeCardText.commit}{' '}
            <Box component="span" sx={{ fontFamily: 'var(--font-mono, monospace)' }}>
              {shown.headSha.slice(0, 7)}
            </Box>
            {' · '}
            {mergeCardText.checks(shown.checks)}. {mergeCardText.after}
          </Typography>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={deleteBranch}
                onChange={(event) => setDeleteBranch(event.target.checked)}
              />
            }
            label={
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {mergeCardText.deleteBranch(shown.source)}
              </Typography>
            }
          />
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            <Button
              size="small"
              variant="contained"
              disabled={busy}
              onClick={() => void accept('now')}
              sx={{ minHeight: 44 }}
            >
              {mergeCardText.now}
            </Button>
            {shown.whenGreen ? (
              <Button
                size="small"
                variant="outlined"
                disabled={busy}
                onClick={() => void accept('when_green')}
                sx={{ minHeight: 44 }}
              >
                {mergeCardText.whenGreen}
              </Button>
            ) : null}
            <Button
              size="small"
              color="inherit"
              disabled={busy}
              onClick={() => setHidden(true)}
              sx={{ minHeight: 44 }}
            >
              {mergeCardText.later}
            </Button>
            <Link
              href={shown.url}
              target="_blank"
              rel="noreferrer"
              variant="body2"
              sx={{ alignSelf: 'center' }}
            >
              {mergeCardText.open}
            </Link>
          </Box>
        </>
      ) : null}
      {error ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
          <Typography role="alert" variant="body2" sx={{ color: 'error.main' }}>
            {error}
          </Typography>
          <Button size="small" color="inherit" onClick={() => setRound((n) => n + 1)}>
            {mergeCardText.again}
          </Button>
        </Box>
      ) : null}
    </Box>
  )
}
