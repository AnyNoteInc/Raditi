'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { useTRPC } from '@/trpc/client'

import { callErrorText } from './call-error'
import { queueText } from './chat-texts'
import { uuidv7 } from './uuid'

// The queue of a chat under its feed (docs/plan/75-chat-input-output.md, ВВ1–ВВ4): the words the
// client wrote while the agent worked, oldest first. Each can be changed or removed until the
// agent takes them; «Отправить сейчас» stops the pass for them. When the dialog waits and they
// are still there — the pass failed, or the credits ran out — «Отправить» sends them by hand
// (ВВ3), as one message.

/** How often the queue is read while it has words or the agent works. */
const QUEUE_REFRESH_MS = 2_000

export interface QueueItem {
  id: string
  requestId: string
  text: string
  attachments: string[]
}

/** The queue of the chat, read while it matters; empty while the server has not answered. */
export function useChatQueue(taskId: string, active: boolean) {
  const trpc = useTRPC()
  return useQuery({
    ...trpc.task.queueList.queryOptions({ taskId }),
    refetchInterval: (query) =>
      active || (query.state.data?.items.length ?? 0) > 0 ? QUEUE_REFRESH_MS : false,
  })
}

export function QueueCards({
  taskId,
  items,
  canInterrupt,
  waiting,
  onSendAll,
  onChanged,
}: {
  taskId: string
  items: readonly QueueItem[]
  /** A pass runs: «Отправить сейчас» stops it for these words. */
  canInterrupt: boolean
  /** The dialog waits and the words did not go by themselves: «Отправить» sends them. */
  waiting: boolean
  /** Sends the words as one message; resolves true when the server took them. */
  onSendAll: (text: string, attachments: readonly string[]) => Promise<boolean>
  onChanged: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const edit = useMutation(trpc.task.queueEdit.mutationOptions())
  const remove = useMutation(trpc.task.queueRemove.mutationOptions())
  const sendNow = useMutation(trpc.task.queueSendNow.mutationOptions())
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  if (items.length === 0) return null

  const settled = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.task.queueList.queryKey({ taskId }) })
    onChanged()
  }
  const act = async (work: () => Promise<unknown>) => {
    setError(null)
    try {
      await work()
    } catch (failure) {
      setError(callErrorText(failure))
    }
    settled()
  }

  return (
    <Box
      component="section"
      aria-label={queueText.title}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-end' }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'flex-end' }}>
        {waiting ? queueText.waitingHint : queueText.hint}
      </Typography>
      <Box
        component="ol"
        sx={{
          m: 0,
          p: 0,
          listStyle: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          alignItems: 'flex-end',
          width: '100%',
        }}
      >
        {items.map((item) => (
          <Box
            component="li"
            key={item.id}
            sx={{
              maxWidth: '80%',
              px: 2,
              py: 1,
              borderRadius: '20px',
              border: '1px dashed',
              borderColor: 'divider',
              color: 'text.secondary',
            }}
          >
            {editing?.id === item.id ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Box
                  component="textarea"
                  aria-label={queueText.editLabel}
                  value={editing.text}
                  rows={2}
                  onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
                  sx={{
                    font: 'inherit',
                    fontSize: 15,
                    color: 'text.primary',
                    bgcolor: 'transparent',
                    border: 0,
                    outline: 'none',
                    resize: 'vertical',
                    minWidth: { xs: 220, sm: 320 },
                  }}
                />
                <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                  <Button size="small" onClick={() => setEditing(null)} sx={{ minHeight: 44 }}>
                    {queueText.cancel}
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    disableElevation
                    loading={edit.isPending}
                    sx={{ minHeight: 44, borderRadius: '999px' }}
                    onClick={() =>
                      void act(async () => {
                        await edit.mutateAsync({ taskId, id: item.id, text: editing.text })
                        setEditing(null)
                      })
                    }
                  >
                    {queueText.save}
                  </Button>
                </Box>
              </Box>
            ) : (
              <>
                <Typography
                  component="p"
                  sx={{ m: 0, fontSize: 15, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {item.text}
                </Typography>
                <Box sx={{ display: 'flex', gap: 0.5, justifyContent: 'flex-end', mt: 0.5 }}>
                  <Button
                    size="small"
                    onClick={() => setEditing({ id: item.id, text: item.text })}
                    sx={{ minHeight: 44, color: 'text.secondary' }}
                  >
                    {queueText.edit}
                  </Button>
                  <Button
                    size="small"
                    onClick={() => void act(() => remove.mutateAsync({ taskId, id: item.id }))}
                    sx={{ minHeight: 44, color: 'text.secondary' }}
                  >
                    {queueText.remove}
                  </Button>
                </Box>
              </>
            )}
          </Box>
        ))}
      </Box>
      {canInterrupt ? (
        <Button
          variant="outlined"
          size="small"
          loading={sendNow.isPending}
          sx={{ minHeight: 44, borderRadius: '999px' }}
          onClick={() => void act(() => sendNow.mutateAsync({ taskId, requestId: uuidv7() }))}
        >
          {queueText.sendNow}
        </Button>
      ) : null}
      {waiting ? (
        <Button
          variant="contained"
          disableElevation
          size="small"
          loading={sending}
          sx={{ minHeight: 44, borderRadius: '999px' }}
          onClick={() =>
            void act(async () => {
              setSending(true)
              try {
                const text = items.map((item) => item.text).join('\n\n')
                const files = items.flatMap((item) => item.attachments)
                if (await onSendAll(text, files))
                  for (const item of items) await remove.mutateAsync({ taskId, id: item.id })
              } finally {
                setSending(false)
              }
            })
          }
        >
          {queueText.send}
        </Button>
      ) : null}
      {error ? (
        <Typography role="alert" variant="body2" color="error.main">
          {error}
        </Typography>
      ) : null}
    </Box>
  )
}
