'use client'

import { repoMergeTexts, repoPushRefusalTexts, repoRefusalTexts } from '@repo/domain/repo'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { callErrorText } from '@/components/chat/call-error'
import { useTRPC } from '@/trpc/client'

// «Выкатить» on the repository page (docs/plan/84-projects.md, ПР15; P-repo, P-deploy described in
// words, §4.8; slice 84.22): a manual job of the newest build of the main branch — never of a branch
// of the agent. The card names the commit that goes out («Выкатится коммит <sha>»); core reads the
// head of the main branch again before it plays the job and says «Изменения обновились» when it
// moved. The deploy itself is the client's build; the platform promises no rollback.

export const deployText = Object.freeze({
  button: 'Выкатить',
  title: (branch: string) => `Выкатить основную ветку ${branch}?`,
  commit: (sha: string) => `Выкатится коммит ${sha.slice(0, 7)}.`,
  body: repoMergeTexts.deployBody,
  job: 'Задание выкладки',
  none: 'У последней сборки основной ветки нет ручных заданий выкладки. Если ваша сборка выкатывает сама, она сделает это после принятия запроса на слияние.',
  loading: 'Читаем сборки основной ветки…',
  start: 'Запустить выкладку',
  cancel: 'Отмена',
  close: 'Закрыть',
  running: 'Запускаем выкладку…',
  started: 'Выкладка запущена — следите за сборкой в списке ниже.',
})

/** The words of the refusal of a press, or a plain «не получилось». */
function refusalText(code: string | null | undefined): string {
  const texts: Record<string, string> = { ...repoRefusalTexts, ...repoPushRefusalTexts }
  const text = code ? texts[code] : undefined
  return text ? `${text}.` : 'Не получилось — попробуйте ещё раз.'
}

const LOOK_AGAIN_MS = 2000
const LOOKS = 60

function usePrepare() {
  const trpc = useTRPC()
  return useMutation(trpc.projectRepo.prepareDeploy.mutationOptions())
}

type Ready = Extract<
  Awaited<ReturnType<ReturnType<typeof usePrepare>['mutateAsync']>>,
  { state: 'ready' }
>

/** The press and how far core got: read until it ends. */
function PressState({ projectId, actionId }: { projectId: string; actionId: string }) {
  const trpc = useTRPC()
  const action = useQuery({
    ...trpc.projectRepo.action.queryOptions({ projectId, actionId }),
    refetchInterval: (query) => {
      const state = query.state.data?.state
      return state === 'done' || state === 'failed' ? false : LOOK_AGAIN_MS
    },
  })
  const state = action.data?.state
  return (
    <Typography
      role={state === 'failed' ? 'alert' : 'status'}
      variant="body2"
      data-repo-deploy-state={state ?? 'queued'}
      sx={{ color: state === 'failed' ? 'error.main' : 'text.secondary' }}
    >
      {state === 'done'
        ? deployText.started
        : state === 'failed'
          ? refusalText(action.data?.error)
          : deployText.running}
    </Typography>
  )
}

export function DeployButton({ projectId }: { projectId: string }) {
  const trpc = useTRPC()
  const prepare = usePrepare()
  const confirm = useMutation(trpc.projectRepo.confirmDeploy.mutationOptions())
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState<Ready | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionId, setActionId] = useState<string | null>(null)
  const { mutateAsync } = prepare

  // Core reads the builds in its own job: the card looks again every two seconds until it can show them.
  useEffect(() => {
    if (!open) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const look = async (round: number) => {
      try {
        const prepared = await mutateAsync({ projectId })
        if (stopped) return
        if (prepared.state === 'ready') {
          setReady(prepared)
          setChosen(prepared.actions[0]?.id ?? null)
        } else if (round + 1 < LOOKS) timer = setTimeout(() => void look(round + 1), LOOK_AGAIN_MS)
      } catch (failure) {
        if (!stopped) setError(callErrorText(failure))
      }
    }
    void look(0)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [open, mutateAsync, projectId])

  function show() {
    setReady(null)
    setError(null)
    setActionId(null)
    setOpen(true)
  }

  async function start() {
    const action = ready?.actions.find((item) => item.id === chosen)
    if (!action) return
    setError(null)
    try {
      const { actionId: id } = await confirm.mutateAsync({ confirmToken: action.confirmToken })
      setActionId(id)
      setOpen(false)
    } catch (failure) {
      setError(callErrorText(failure))
    }
  }

  return (
    <>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Button size="small" variant="outlined" onClick={show} sx={{ minHeight: 44 }}>
          {deployText.button}
        </Button>
      </Box>
      {actionId ? (
        <Box sx={{ flexBasis: '100%' }}>
          <PressState projectId={projectId} actionId={actionId} />
        </Box>
      ) : null}
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{deployText.title(ready?.ref ?? 'main')}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {ready === null && error === null ? (
            <Typography role="status" variant="body2" sx={{ color: 'text.secondary' }}>
              {deployText.loading}
            </Typography>
          ) : null}
          {ready && ready.sha && ready.actions.length > 0 ? (
            <>
              <Typography variant="body2" data-repo-deploy-commit="">
                {deployText.commit(ready.sha)}
              </Typography>
              <RadioGroup
                aria-label={deployText.job}
                value={chosen ?? ''}
                onChange={(event) => setChosen(event.target.value)}
              >
                {ready.actions.map((action) => (
                  <FormControlLabel
                    key={action.id}
                    value={action.id}
                    control={<Radio size="small" />}
                    label={
                      <Typography
                        variant="body2"
                        sx={{ fontFamily: 'var(--font-mono, monospace)' }}
                      >
                        {action.name}
                      </Typography>
                    }
                  />
                ))}
              </RadioGroup>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {deployText.body}
              </Typography>
            </>
          ) : null}
          {ready && ready.actions.length === 0 ? (
            <Typography variant="body2">{deployText.none}</Typography>
          ) : null}
          {error ? (
            <Typography role="alert" variant="body2" sx={{ color: 'error.main' }}>
              {error}
            </Typography>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setOpen(false)} disabled={confirm.isPending}>
            {ready && ready.actions.length === 0 ? deployText.close : deployText.cancel}
          </Button>
          {ready && ready.actions.length > 0 ? (
            <Button
              variant="contained"
              onClick={() => void start()}
              disabled={confirm.isPending || chosen === null}
            >
              {deployText.start}
            </Button>
          ) : null}
        </DialogActions>
      </Dialog>
    </>
  )
}
