'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { artifactCommentRefusalText } from '@repo/domain/artifacts'
import { FEED_REQUEST_TEXT_LIMIT } from '@repo/domain/tasks/client-feed-text'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react'

import { callErrorText } from '@/components/chat/call-error'
import { dialogListKey } from '@/components/chat/dialog-actions'
import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC, useTRPCClient } from '@/trpc/client'

import { artifactAccessLost, artifactErrorData, readPrivateArtifact } from './artifact-access-error'

export function ArtifactCommentDispatch({
  artifactId,
  threadIds,
  onClose,
  onAccessLost,
  onSelectionStale,
  onSent,
}: {
  artifactId: string
  threadIds: string[]
  onClose: () => void
  onAccessLost: () => void
  /** A selected note was resolved or became unavailable: the same request cannot succeed. */
  onSelectionStale: () => void
  onSent: () => void
}) {
  const trpc = useTRPC()
  const rpc = useTRPCClient()
  const client = useQueryClient()
  const titleId = useId()
  const query = trpc.artifact.commentDispatchChats.queryOptions({ artifactId })
  const chats = useQuery({
    queryKey: query.queryKey,
    queryFn: (context) => readPrivateArtifact(() => query.queryFn!(context)),
    gcTime: 0,
  })
  const [choice, setChoice] = useState({ id: 'new', title: 'Новый чат' })
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const active = useRef<AbortController | null>(null)
  // Keep the new chat ID as well as the request ID after a lost response.
  const attempts = useRef(new Map<string, { requestId: string; taskId: string }>())
  const denied = chats.data === null
  const reportLost = useEffectEvent(onAccessLost)

  useLayoutEffect(() => {
    const keys = attempts.current
    return () => {
      active.current?.abort()
      active.current = null
      keys.clear()
    }
  }, [denied])
  useEffect(() => {
    if (denied) reportLost()
  }, [denied])

  const options = chats.data ?? []
  // A successfully queued chat can disappear from the list before its receipt reaches us.
  const missingChoice = choice.id !== 'new' && !options.some(({ taskId }) => taskId === choice.id)

  async function send() {
    if (active.current || sent || denied || threadIds.length === 0) return
    const words = text.trim()
    if (words.length > FEED_REQUEST_TEXT_LIMIT) return
    const key = JSON.stringify([choice.id, words])
    const ids = attempts.current.get(key) ?? {
      requestId: crypto.randomUUID(),
      taskId: choice.id === 'new' ? uuidv7() : choice.id,
    }
    attempts.current.set(key, ids)
    const controller = new AbortController()
    active.current = controller
    setPending(true)
    setError(null)
    try {
      const result = await rpc.artifact.dispatchComments.mutate(
        {
          artifactId,
          threadIds,
          requestId: ids.requestId,
          target: { kind: choice.id === 'new' ? 'new' : 'existing', taskId: ids.taskId },
          text: words,
        },
        { signal: controller.signal },
      )
      if (active.current !== controller) return
      setSent(result.taskId)
      void client.invalidateQueries({ queryKey: dialogListKey })
      void client.invalidateQueries({ queryKey: trpc.artifact.chats.queryKey({ artifactId }) })
      onSent()
    } catch (failure) {
      if (active.current !== controller) return
      if (artifactAccessLost(failure)) {
        onAccessLost()
        return
      }
      if (artifactErrorData(failure)?.domainCode === 'ARTIFACT_COMMENT_UNAVAILABLE') {
        onSelectionStale()
        return
      }
      setError(
        artifactCommentRefusalText(artifactErrorData(failure)?.domainCode) ??
          callErrorText(failure, 'Не удалось подтвердить отправку. Повторите её в этом окне.'),
      )
    } finally {
      if (active.current === controller) {
        active.current = null
        setPending(false)
      }
    }
  }

  if (denied) return null
  return (
    <Dialog open onClose={onClose} aria-labelledby={titleId} fullWidth maxWidth="sm">
      <DialogTitle id={titleId}>Отправить заметки агенту</DialogTitle>
      {sent ? (
        <>
          <DialogContent>Заметки отправлены в чат.</DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Закрыть</Button>
            <Button component={Link} href={`/chats/${sent}`} variant="contained" onClick={onClose}>
              Открыть чат
            </Button>
          </DialogActions>
        </>
      ) : (
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <DialogContent sx={{ display: 'grid', gap: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Выбрано заметок: {threadIds.length}. Агент получит их вместе с ответами. Работа в чате
              оплачивается как обычно.
            </Typography>
            <TextField
              select
              label="Чат"
              value={choice.id}
              disabled={pending}
              onChange={(event) => {
                const id = event.target.value
                const title = options.find(({ taskId }) => taskId === id)?.title
                setChoice({ id, title: id === 'new' ? 'Новый чат' : title || 'Чат без названия' })
                setError(null)
              }}
            >
              <MenuItem value="new">Новый чат</MenuItem>
              {missingChoice && <MenuItem value={choice.id}>{choice.title}</MenuItem>}
              {options.map(({ taskId, title }) => (
                <MenuItem key={taskId} value={taskId}>
                  {title || 'Чат без названия'}
                </MenuItem>
              ))}
            </TextField>
            {chats.isPending && <Typography variant="caption">Загружаем список чатов…</Typography>}
            {chats.isError && (
              <Alert
                severity="warning"
                action={<Button onClick={() => void chats.refetch()}>Повторить</Button>}
              >
                Не удалось загрузить список чатов. Можно начать новый чат.
              </Alert>
            )}
            <TextField
              label="Сообщение агенту (необязательно)"
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={pending}
              multiline
              minRows={3}
              slotProps={{ htmlInput: { maxLength: FEED_REQUEST_TEXT_LIMIT } }}
            />
            {error && <Alert severity="error">{error}</Alert>}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{pending ? 'Закрыть' : 'Отмена'}</Button>
            <Button type="submit" variant="contained" disabled={pending}>
              {pending ? 'Отправляем…' : `Отправить агенту (${threadIds.length})`}
            </Button>
          </DialogActions>
        </Box>
      )}
    </Dialog>
  )
}
