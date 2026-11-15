'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { CLIENT_INSTRUCTIONS_LIMIT } from '@repo/domain/agent/client-instructions'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'

import { callErrorText } from '@/components/chat/call-error'
import { useTRPC } from '@/trpc/client'

// «Инструкции агенту» of the settings (docs/plan/76-agent-instructions.md, И1): what the agent
// should always know or do, in every chat of the client. They go to the model with every pass.

export const instructionsText = Object.freeze({
  title: 'Инструкции агенту',
  hint: 'Что агенту знать и как работать во всех ваших чатах: о вашем деле, тоне ответов, о чём не забывать. Паролей и ключей здесь не пишите.',
  placeholder: 'Например: мы — кофейня у метро «Сокол». Отвечайте коротко, без терминов.',
  save: 'Сохранить',
  saved: 'Сохранено. Агент учтёт это со следующего ответа.',
  cleared: 'Инструкции убраны.',
  counter: (length: number) => `${length} из ${CLIENT_INSTRUCTIONS_LIMIT}`,
  loading: 'Загружаем инструкции агенту',
})

export function AgentInstructions() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const current = useQuery(trpc.user.agentInstructions.queryOptions())
  const save = useMutation(trpc.user.setAgentInstructions.mutationOptions())
  const [draft, setDraft] = useState<string | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const fieldId = useId()
  const hintId = useId()
  const text = draft ?? current.data?.text ?? ''
  const changed = draft !== null && draft.trim() !== (current.data?.text ?? '')

  async function submit() {
    setSaid(null)
    try {
      const saved = await save.mutateAsync({ text })
      setDraft(null)
      setSaid(saved.text === '' ? instructionsText.cleared : instructionsText.saved)
      await queryClient.invalidateQueries({ queryKey: trpc.user.agentInstructions.queryKey() })
    } catch {
      // The alert below says why.
    }
  }

  return (
    <Box component="section" aria-labelledby={`${fieldId}-title`} sx={{ p: { xs: 2.5, sm: 4 } }}>
      <Typography id={`${fieldId}-title`} component="h2" sx={{ fontWeight: 600, fontSize: 17 }}>
        {instructionsText.title}
      </Typography>
      <Typography
        id={hintId}
        color="text.secondary"
        variant="body2"
        sx={{ mt: 0.5, maxWidth: 560 }}
      >
        {instructionsText.hint}
      </Typography>
      {current.isPending ? (
        <Box role="status" aria-label={instructionsText.loading}>
          <Skeleton variant="rounded" height={120} sx={{ mt: 2 }} />
        </Box>
      ) : (
        <>
          <Box
            component="textarea"
            id={fieldId}
            aria-labelledby={`${fieldId}-title`}
            aria-describedby={hintId}
            value={text}
            rows={5}
            placeholder={instructionsText.placeholder}
            onChange={(event) => {
              setSaid(null)
              setDraft(event.target.value)
            }}
            sx={{
              display: 'block',
              width: '100%',
              maxWidth: 640,
              mt: 2,
              p: 1.5,
              borderRadius: '12px',
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: 'transparent',
              color: 'text.primary',
              font: 'inherit',
              fontSize: 15,
              lineHeight: 1.6,
              resize: 'vertical',
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
            }}
          />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 1.5, maxWidth: 640 }}>
            <Button
              variant="contained"
              disableElevation
              disabled={!changed || text.trim().length > CLIENT_INSTRUCTIONS_LIMIT}
              loading={save.isPending}
              onClick={() => void submit()}
              sx={{ minHeight: 44, borderRadius: '999px' }}
            >
              {instructionsText.save}
            </Button>
            <Typography
              variant="caption"
              color={
                text.trim().length > CLIENT_INSTRUCTIONS_LIMIT ? 'error.main' : 'text.secondary'
              }
              sx={{ ml: 'auto' }}
            >
              {instructionsText.counter(text.trim().length)}
            </Typography>
          </Box>
        </>
      )}
      {said ? (
        <Typography role="status" variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          {said}
        </Typography>
      ) : null}
      {save.isError ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {callErrorText(save.error)}
        </Alert>
      ) : null}
    </Box>
  )
}
