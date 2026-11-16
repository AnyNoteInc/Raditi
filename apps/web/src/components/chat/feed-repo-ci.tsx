'use client'

import { repoPushRefusalTexts } from '@repo/domain/repo'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { callErrorText } from './call-error'

// The card «Агент хочет изменить настройки сборки» (docs/plan/84-projects.md, ПР16; P-chat-merge,
// the lower card): what waits to be sent touches build settings, so it goes only by this card —
// the diff of those files, CI Lint where the provider has it, «Разрешить и отправить» and «Не
// отправлять». The token of the card is bound to the SHA-256 of the diff it shows; core makes the
// diff again before it sends anything.

export const ciCardText = Object.freeze({
  title: 'Агент хочет изменить настройки сборки',
  needed: 'Нужно ваше разрешение',
  loading: 'Проверяем изменение настроек сборки…',
  body: 'Изменение настроек сборки отправится в репозиторий только после вашего разрешения: такая ветка сразу запускает сборку с переменными проекта.',
  lintPassed: 'Проверка настроек сборки ошибок не нашла.',
  lintFailed: 'Проверка настроек сборки нашла ошибки:',
  opensMergeRequest: (title: string) => `Откроется запрос на слияние «${title}».`,
  allow: 'Разрешить и отправить',
  decline: 'Не отправлять',
  declined: `${repoPushRefusalTexts.REPO_CI_DECLINED}.`,
  foreign: `${repoPushRefusalTexts.REPO_CI_CONFIG_FOREIGN}.`,
})

/** How long the card waits between two looks while core reads the change (`loading`). */
const LOOK_AGAIN_MS = 2000
/** Then it stops asking: two minutes. */
const LOOKS = 60

type Prepared = Extract<
  Awaited<ReturnType<ReturnType<typeof usePrepare>['mutateAsync']>>,
  { state: 'ready' }
>

function usePrepare() {
  const trpc = useTRPC()
  return useMutation(trpc.projectRepo.prepareCiChange.mutationOptions())
}

/** The words of a branch whose build settings cannot go, or have been declined. */
export function CiChangeNote({ state }: { state: 'declined' | 'foreign' }) {
  return (
    <Typography
      variant="body2"
      data-repo-ci-note={state}
      sx={{ color: 'text.secondary', flexBasis: '100%' }}
    >
      {state === 'declined' ? ciCardText.declined : ciCardText.foreign}
    </Typography>
  )
}

/** The card itself, under the card «Изменения в ветке» of the chat's head. */
export function CiChangeCard({ taskId }: { taskId: string }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const prepare = usePrepare()
  const confirm = useMutation(trpc.projectRepo.confirmCiChange.mutationOptions())
  const decline = useMutation(trpc.projectRepo.declineCiChange.mutationOptions())
  const [shown, setShown] = useState<Prepared | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { mutateAsync } = prepare

  // Core reads the change in its own job: the card looks again every two seconds until it can show it.
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const look = async (round: number) => {
      try {
        const prepared = await mutateAsync({ taskId })
        if (stopped) return
        if (prepared.state === 'ready') setShown(prepared)
        else if (round + 1 < LOOKS) timer = setTimeout(() => void look(round + 1), LOOK_AGAIN_MS)
      } catch (failure) {
        if (!stopped) setError(callErrorText(failure))
      }
    }
    void look(0)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [mutateAsync, taskId])

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: trpc.projectRepo.branch.queryKey({ taskId }) })

  async function allow() {
    if (!shown) return
    setError(null)
    try {
      await confirm.mutateAsync({
        confirmToken: shown.confirmToken,
        ...(shown.opensMergeRequest && shown.proposal
          ? {
              mergeRequest: {
                title: shown.proposal.title.trim() || 'Изменения агента',
                description: shown.proposal.description,
                draft: shown.proposal.draft,
                reservedId: shown.proposal.reservedId,
              },
            }
          : {}),
      })
    } catch (failure) {
      setError(callErrorText(failure))
    }
    void refresh()
  }

  async function refuse() {
    setError(null)
    try {
      await decline.mutateAsync({ taskId })
    } catch (failure) {
      setError(callErrorText(failure))
    }
    void refresh()
  }

  const busy = confirm.isPending || decline.isPending
  return (
    <Box
      data-repo-ci-card=""
      sx={{
        border: '1px solid',
        borderColor: 'warning.main',
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
        <Typography variant="subtitle2">{ciCardText.title}</Typography>
        <Chip size="small" color="warning" variant="outlined" label={ciCardText.needed} />
      </Box>
      {shown === null && error === null ? (
        <Typography role="status" variant="body2" sx={{ color: 'text.secondary' }}>
          {ciCardText.loading}
        </Typography>
      ) : null}
      {shown
        ? shown.files.map((file) => (
            <Box key={file.path} sx={{ minWidth: 0 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
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
              <Box
                component="pre"
                data-repo-ci-diff=""
                sx={{
                  m: 0,
                  mt: 0.5,
                  fontSize: 12,
                  lineHeight: '18px',
                  fontFamily: 'var(--font-mono, monospace)',
                  whiteSpace: 'pre',
                  overflowX: 'auto',
                  maxHeight: 320,
                }}
              >
                {file.diff}
              </Box>
            </Box>
          ))
        : null}
      {shown?.lint ? (
        shown.lint.valid ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {ciCardText.lintPassed}
          </Typography>
        ) : (
          <Box data-repo-ci-lint="">
            <Typography variant="body2">{ciCardText.lintFailed}</Typography>
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              {shown.lint.errors.map((line) => (
                <Typography component="li" variant="body2" key={line}>
                  {line}
                </Typography>
              ))}
            </Box>
          </Box>
        )
      ) : null}
      {shown ? (
        <>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {ciCardText.body}
          </Typography>
          {shown.opensMergeRequest && shown.proposal ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {ciCardText.opensMergeRequest(shown.proposal.title)}
            </Typography>
          ) : null}
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            <Button
              size="small"
              variant="contained"
              disabled={busy}
              onClick={() => void allow()}
              sx={{ minHeight: 44 }}
            >
              {ciCardText.allow}
            </Button>
            <Button
              size="small"
              color="inherit"
              disabled={busy}
              onClick={() => void refuse()}
              sx={{ minHeight: 44 }}
            >
              {ciCardText.decline}
            </Button>
          </Box>
        </>
      ) : null}
      {error ? (
        <Typography role="alert" variant="body2" sx={{ color: 'error.main' }}>
          {error}
        </Typography>
      ) : null}
    </Box>
  )
}
