'use client'

import { repoPressRefusalText, repoRunTexts } from '@repo/domain/repo'
import type { RepoProviderKind } from '@repo/domain'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { callErrorText } from '@/components/chat/call-error'
import { useTRPC } from '@/trpc/client'

// The buttons of the rest of the second queue on the repository page (docs/plan/84-projects.md,
// ПР15, ПР17; slice 84.26): «Запустить снова» and «Остановить» of a build, «Отменить» of a merged
// request. Each is a trusted card, as «Выкатить» is: the card is prepared by web from what core last
// read, the press is written once and core reads the provider again before it acts. A rerun of a
// build of the main branch or of one with deploy jobs is a card of a deploy (ПР15): its words say
// that it may put that version out.

export const pressText = Object.freeze({
  rerun: 'Запустить снова',
  cancel: 'Остановить',
  revert: 'Отменить',
  rerunTitle: repoRunTexts.rerunTitle,
  cancelTitle: repoRunTexts.cancelTitle,
  revertTitle: repoRunTexts.revertTitle,
  rerunBody: repoRunTexts.rerunBody,
  rerunDeployBody: repoRunTexts.rerunDeployBody,
  cancelBody: repoRunTexts.cancelBody,
  revertBody: repoRunTexts.revertBody,
  commit: (ref: string, sha: string) => `Ветка ${ref}, версия ${sha.slice(0, 7)}.`,
  preparing: 'Готовим…',
  confirmRerun: 'Запустить',
  confirmCancel: 'Остановить сборку',
  confirmRevert: 'Открыть запрос на отмену',
  close: 'Отмена',
  running: 'Выполняем…',
  rerunDone: 'Сборка запущена снова — она появится в списке.',
  cancelDone: 'Сборка остановлена.',
  revertDone: 'Запрос на слияние, который отменяет изменения, открыт.',
  openRequest: 'Открыть запрос',
})

/**
 * The words of the refusal of a press, or a plain «не получилось»; a sign-in to renew names the
 * provider of the repository pressed on.
 */
function refusalText(code: string | null | undefined, provider: RepoProviderKind | null): string {
  const text = repoPressRefusalText(code, provider)
  return text ? `${text}.` : 'Не получилось — попробуйте ещё раз.'
}

const LOOK_AGAIN_MS = 2000

/** The press and how far core got: read until it ends. */
function PressState({
  projectId,
  actionId,
  done,
}: {
  projectId: string
  actionId: string
  done: string
}) {
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
      data-repo-press-state={state ?? 'queued'}
      sx={{ color: state === 'failed' ? 'error.main' : 'text.secondary' }}
    >
      {state === 'done'
        ? done
        : state === 'failed'
          ? refusalText(action.data?.error, action.data?.provider ?? null)
          : pressText.running}
    </Typography>
  )
}

interface Card {
  title: string
  body: string
  detail: string | null
  confirm: string
  token: string
}

/** One card: prepared on open, pressed once, its state below the button. */
function PressButton({
  projectId,
  label,
  prepare,
  press,
  done,
}: {
  projectId: string
  label: string
  prepare: () => Promise<Card>
  press: (token: string) => Promise<{ actionId: string }>
  done: string
}) {
  const [open, setOpen] = useState(false)
  const [card, setCard] = useState<Card | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [actionId, setActionId] = useState<string | null>(null)

  async function show() {
    setCard(null)
    setError(null)
    setActionId(null)
    setOpen(true)
    try {
      setCard(await prepare())
    } catch (failure) {
      setError(callErrorText(failure))
    }
  }

  async function confirm() {
    if (card === null) return
    setPending(true)
    setError(null)
    try {
      const { actionId: id } = await press(card.token)
      setActionId(id)
      setOpen(false)
    } catch (failure) {
      setError(callErrorText(failure))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Button size="small" variant="outlined" onClick={() => void show()} sx={{ minHeight: 44 }}>
        {label}
      </Button>
      {actionId ? (
        <Box sx={{ flexBasis: '100%' }}>
          <PressState projectId={projectId} actionId={actionId} done={done} />
        </Box>
      ) : null}
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{card?.title ?? label}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {card === null && error === null ? (
            <Typography role="status" variant="body2" sx={{ color: 'text.secondary' }}>
              {pressText.preparing}
            </Typography>
          ) : null}
          {card ? (
            <>
              {card.detail ? (
                <Typography variant="body2" data-repo-press-detail="">
                  {card.detail}
                </Typography>
              ) : null}
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {card.body}
              </Typography>
            </>
          ) : null}
          {error ? (
            <Typography role="alert" variant="body2" sx={{ color: 'error.main' }}>
              {error}
            </Typography>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setOpen(false)} disabled={pending}>
            {pressText.close}
          </Button>
          {card ? (
            <Button variant="contained" onClick={() => void confirm()} disabled={pending}>
              {card.confirm}
            </Button>
          ) : null}
        </DialogActions>
      </Dialog>
    </>
  )
}

/** «Запустить снова» or «Остановить» of a build (ПР17). */
export function RunActionButton({
  projectId,
  runId,
  kind,
}: {
  projectId: string
  runId: string
  kind: 'rerun' | 'cancel'
}) {
  const trpc = useTRPC()
  const prepare = useMutation(trpc.projectRepo.prepareRunAction.mutationOptions())
  const confirm = useMutation(trpc.projectRepo.confirmRunAction.mutationOptions())
  return (
    <PressButton
      projectId={projectId}
      label={kind === 'rerun' ? pressText.rerun : pressText.cancel}
      done={kind === 'rerun' ? pressText.rerunDone : pressText.cancelDone}
      prepare={async () => {
        const card = await prepare.mutateAsync({ projectId, runId, kind })
        return {
          title: kind === 'rerun' ? pressText.rerunTitle : pressText.cancelTitle,
          body:
            kind === 'cancel'
              ? pressText.cancelBody
              : card.deploy
                ? pressText.rerunDeployBody
                : pressText.rerunBody,
          detail: pressText.commit(card.ref, card.sha),
          confirm: kind === 'rerun' ? pressText.confirmRerun : pressText.confirmCancel,
          token: card.confirmToken,
        }
      }}
      press={(confirmToken) => confirm.mutateAsync({ confirmToken })}
    />
  )
}

/** «Отменить» of a merged request (ПР15): a new merge request that takes the changes out. */
export function RevertButton({ projectId, number }: { projectId: string; number: number }) {
  const trpc = useTRPC()
  const prepare = useMutation(trpc.projectRepo.prepareRevert.mutationOptions())
  const confirm = useMutation(trpc.projectRepo.confirmRevert.mutationOptions())
  return (
    <PressButton
      projectId={projectId}
      label={pressText.revert}
      done={pressText.revertDone}
      prepare={async () => {
        const card = await prepare.mutateAsync({ projectId, number })
        return {
          title: pressText.revertTitle,
          body: pressText.revertBody,
          detail: `«${card.title}» · ${pressText.commit(card.target, card.mergeSha)}`,
          confirm: pressText.confirmRevert,
          token: card.confirmToken,
        }
      }}
      press={(confirmToken) => confirm.mutateAsync({ confirmToken })}
    />
  )
}
