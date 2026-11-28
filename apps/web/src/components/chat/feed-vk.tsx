'use client'

import {
  feedVkActionText,
  feedVkProposalText,
  type VkActionKind,
  type VkActionState,
} from '@repo/domain/tasks/client-feed-labels'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useMutation } from '@tanstack/react-query'
import { createContext, useContext, useState } from 'react'

import { callErrorText } from '@/components/chat/call-error'
import { useTRPC } from '@/trpc/client'

// The cards of VK in the chat (docs/plan/99-vk-community.md, §3.3): the post or the reply the agent
// prepared, with «Опубликовать» — the only way it reaches VK (rule 4) —, and what the press did.

export const vkCardText = Object.freeze({
  publish: 'Опубликовать',
  schedule: 'Запланировать',
  edit: 'Изменить текст',
  done: 'Готово',
  sent: 'Отправлено на публикацию — результат появится здесь.',
  open: 'Открыть во ВКонтакте',
  comment: 'Комментарий',
  when: (at: string) =>
    `Выйдет ${new Date(at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`,
})

/**
 * The proposals of the chat that a press has reached already (a `feed.vk_action` row names them):
 * their card shows no button again after a reload. The server refuses a second press anyway.
 */
export const VkPressed = createContext<ReadonlySet<string>>(new Set())

/** The proposals a `feed.vk_action` of these rows names. */
export function vkPressedOf(rows: readonly { type: string; reservedId?: unknown }[]): Set<string> {
  const pressed = new Set<string>()
  for (const row of rows)
    if (row.type === 'feed.vk_action' && typeof row.reservedId === 'string')
      pressed.add(row.reservedId)
  return pressed
}

export function FeedVkProposal({
  row,
}: {
  row: {
    kind: VkActionKind
    reservedId: string
    community: string
    text: string
    publishAt?: string | null | undefined
    commentUrl?: string | undefined
  }
}) {
  const trpc = useTRPC()
  const publish = useMutation(trpc.builtinMcp.vkPublish.mutationOptions())
  const [text, setText] = useState(row.text)
  const [editing, setEditing] = useState(false)
  const [pressed, setPressed] = useState(false)
  const pressedBefore = useContext(VkPressed).has(row.reservedId)
  const sent = pressed || pressedBefore
  const [problem, setProblem] = useState<string | null>(null)
  const press = async () => {
    setProblem(null)
    try {
      await publish.mutateAsync({ reservedId: row.reservedId, text: text.trim() })
      setPressed(true)
      setEditing(false)
    } catch (failure) {
      setProblem(callErrorText(failure))
    }
  }
  return (
    <Box
      data-feed-vk-proposal={row.kind}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        border: 1,
        borderColor: 'divider',
        borderRadius: '12px',
        p: 1.5,
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {feedVkProposalText(row)}
      </Typography>
      {row.commentUrl ? (
        <Link href={row.commentUrl} target="_blank" rel="noreferrer" variant="body2">
          {vkCardText.comment}
        </Link>
      ) : null}
      {editing ? (
        <TextField
          value={text}
          onChange={(event) => setText(event.target.value)}
          multiline
          minRows={3}
          size="small"
          fullWidth
          autoFocus
        />
      ) : (
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
          {text}
        </Typography>
      )}
      {row.publishAt ? (
        <Typography variant="caption" color="text.secondary">
          {vkCardText.when(row.publishAt)}
        </Typography>
      ) : null}
      {problem ? (
        <Alert severity="error" role="alert">
          {problem}
        </Alert>
      ) : null}
      {sent ? (
        <Typography variant="body2" color="text.secondary">
          {vkCardText.sent}
        </Typography>
      ) : (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            size="small"
            disabled={publish.isPending || text.trim() === ''}
            onClick={() => void press()}
          >
            {row.publishAt ? vkCardText.schedule : vkCardText.publish}
          </Button>
          <Button
            size="small"
            color="inherit"
            disabled={publish.isPending}
            onClick={() => setEditing((now) => !now)}
          >
            {editing ? vkCardText.done : vkCardText.edit}
          </Button>
        </Box>
      )}
    </Box>
  )
}

export function FeedVkAction({
  row,
}: {
  row: {
    kind: VkActionKind
    state: VkActionState
    url?: string | undefined
    publishAt?: string | undefined
    error?: string | undefined
  }
}) {
  return (
    <Box data-feed-vk-action={row.state} sx={{ display: 'flex', gap: 1, color: 'text.secondary' }}>
      <Typography variant="body2">{feedVkActionText(row)}</Typography>
      {row.url && row.state === 'done' ? (
        <Link href={row.url} target="_blank" rel="noreferrer" variant="body2">
          {vkCardText.open}
        </Link>
      ) : null}
    </Box>
  )
}
