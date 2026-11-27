'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import LinearProgress from '@mui/material/LinearProgress'
import Snackbar from '@mui/material/Snackbar'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useState } from 'react'

import { useTRPC } from '@/trpc/client'

import { artifactErrorData } from './artifact-access-error'

// «Исправить» on a note of a «Документ» (docs/plan/98-quick-edits.md, БПр9, БПр12): the agent
// makes the edit at once, without a chat turn; the result shows in the section, with «Отменить».

export const quickEditTexts = Object.freeze({
  button: 'Исправить',
  label: 'Исправить по заметке',
  hint: 'Агент сразу поправит это место по заметке.',
  moved: 'Место заметки изменилось — отправьте её агенту.',
  pending: 'Готовим правку…',
  busy: 'Подождите — готовим предыдущую правку.',
  done: 'Правка внесена.',
  undo: 'Отменить',
  undone: 'Правка отменена.',
  undoKept: 'Раздел уже изменили после правки — его мы не трогали.',
  confirmTitle: 'Сделать, как просит автор заметки?',
  confirm: (name: string) =>
    `Заметку написал(а) ${name || 'другой участник'}. Агент поправит текст так, как в ней просят.`,
  confirmYes: 'Сделать',
  cancel: 'Отмена',
  off: 'Быстрые правки сейчас недоступны — отправьте заметку агенту.',
  failed: 'Не получилось подготовить правку. Попробуйте ещё раз или отправьте заметку агенту.',
  reasons: {
    needs_agent: 'Здесь быстро не получится — отправьте заметку агенту.',
    no_change: 'Агент не стал менять текст — ответ в заметке.',
    stale: 'Раздел изменился, пока готовилась правка. Попробуйте ещё раз.',
    held: 'Раздел сейчас правит другой человек. Попробуйте, когда он закончит.',
    moved: 'Место заметки изменилось — отправьте её агенту.',
    check: 'Правку не внесли: в ней оказалось что-то похожее на пароль или ключ доступа.',
    links: 'Правку не внесли: в ней появились ссылки или контакты, которых не было в тексте.',
    limit: 'Здесь быстро не получится — отправьте заметку агенту.',
    paused: 'Быстрые правки сейчас недоступны — отправьте заметку агенту.',
  } as Record<string, string>,
})

const refusalOf = (code: string | null | undefined): string => {
  switch (code) {
    case 'QUICK_EDIT_BUSY':
      return quickEditTexts.busy
    case 'QUICK_EDIT_UNAVAILABLE':
    case 'QUICK_EDITS_OFF':
      return quickEditTexts.off
    case 'CREDITS_INSUFFICIENT':
      return 'Не хватает кредитов для правки.'
    default:
      return quickEditTexts.failed
  }
}

interface QuickEditRun {
  id: string
  threadId: string
}

/**
 * The quick edits of one notes panel: the one under way, what the last one came to, «Отменить».
 * It lives with the panel, not with a note: a note the edit closed leaves the list, and its
 * outcome and «Отменить» must not leave with it.
 */
export function useQuickEdits({ artifactId, onDone }: { artifactId: string; onDone: () => void }) {
  const trpc = useTRPC()
  const client = useQueryClient()
  const [run, setRun] = useState<QuickEditRun | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [applied, setApplied] = useState<{ taskId: string; attempt: number } | null>(null)
  const start = useMutation(trpc.artifact.quickEdit.mutationOptions())
  const undo = useMutation(trpc.artifact.undoTurn.mutationOptions())
  const editsQuery = trpc.artifact.quickEdits.queryOptions({ artifactId })
  const edits = useQuery({
    ...editsQuery,
    enabled: run !== null,
    // Until the edit ends; the signal of the artifact usually comes first.
    refetchInterval: (query) =>
      query.state.data?.find((edit) => edit.id === run?.id)?.finishedAt ? false : 2000,
  })
  const current = edits.data?.find((edit) => edit.id === run?.id) ?? null

  const finish = useEffectEvent((edit: NonNullable<typeof current>) => {
    // Seen once: the panel says how it ended, the page reads the artifact and the notes again.
    setRun(null)
    if (edit.state === 'applied') {
      setApplied({ taskId: edit.taskId, attempt: edit.attempt })
      setMessage(null)
    } else {
      setMessage((edit.reason && quickEditTexts.reasons[edit.reason]) ?? quickEditTexts.failed)
    }
    onDone()
  })
  useEffect(() => {
    // The end of an edit arrives from the server: the panel follows it once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (current?.finishedAt) finish(current)
  }, [current])

  /** Starts an edit; `confirm` — the note is someone else's and the clicker has not confirmed. */
  async function begin(threadId: string, confirmOthers: boolean): Promise<'confirm' | null> {
    setMessage(null)
    try {
      const { quickEditId } = await start.mutateAsync({
        artifactId,
        threadIds: [threadId],
        requestId: crypto.randomUUID(),
        confirmOthers,
      })
      setRun({ id: quickEditId, threadId })
      void client.invalidateQueries({ queryKey: editsQuery.queryKey })
      return null
    } catch (error) {
      const code = artifactErrorData(error)?.domainCode
      if (code === 'QUICK_EDIT_CONFIRM') return 'confirm'
      setMessage(refusalOf(code))
      return null
    }
  }

  async function undoEdit() {
    if (!applied) return
    const done = await undo
      .mutateAsync({ artifactId, taskId: applied.taskId, turnNo: applied.attempt })
      .catch(() => null)
    setApplied(null)
    setMessage(
      done === null
        ? quickEditTexts.failed
        : done.kept > 0
          ? quickEditTexts.undoKept
          : quickEditTexts.undone,
    )
    onDone()
  }

  const busy = start.isPending || run !== null
  const notices = (
    <>
      {run !== null && (
        <Box sx={{ my: 0.5 }} role="status">
          <LinearProgress />
          <Typography variant="caption" color="text.secondary">
            {quickEditTexts.pending}
          </Typography>
        </Box>
      )}
      {message && (
        <Alert severity="info" sx={{ my: 0.5 }} onClose={() => setMessage(null)}>
          {message}
        </Alert>
      )}
      <Snackbar
        open={applied !== null}
        autoHideDuration={10_000}
        onClose={() => setApplied(null)}
        message={quickEditTexts.done}
        action={
          <Button
            color="inherit"
            size="small"
            disabled={undo.isPending}
            onClick={() => void undoEdit()}
          >
            {quickEditTexts.undo}
          </Button>
        }
      />
    </>
  )
  return { begin, busy, runningThread: run?.threadId ?? null, notices }
}

export type QuickEdits = ReturnType<typeof useQuickEdits>

/** «Исправить» of one note: the edit itself is the panel's (`useQuickEdits`). */
export function ArtifactQuickEdit({
  quick,
  threadId,
  own,
  authorName,
  moved,
}: {
  quick: Pick<QuickEdits, 'begin' | 'busy'>
  threadId: string
  /** The clicker wrote the note: no confirmation. */
  own: boolean
  authorName: string
  moved: boolean
}) {
  const [confirming, setConfirming] = useState(false)

  async function run(confirmOthers: boolean) {
    setConfirming(false)
    if ((await quick.begin(threadId, confirmOthers)) === 'confirm') setConfirming(true)
  }

  return (
    <>
      <Tooltip
        title={
          moved ? quickEditTexts.moved : quick.busy ? quickEditTexts.busy : quickEditTexts.hint
        }
      >
        <span>
          <Button
            size="small"
            aria-label={quickEditTexts.label}
            disabled={moved || quick.busy}
            onClick={() => (own ? void run(false) : setConfirming(true))}
          >
            {quickEditTexts.button}
          </Button>
        </span>
      </Tooltip>
      <Dialog open={confirming} onClose={() => setConfirming(false)}>
        <DialogTitle>{quickEditTexts.confirmTitle}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">{quickEditTexts.confirm(authorName)}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(false)}>{quickEditTexts.cancel}</Button>
          <Button variant="contained" onClick={() => void run(true)}>
            {quickEditTexts.confirmYes}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
