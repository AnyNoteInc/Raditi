'use client'

import { feedMemoryChangeText } from '@repo/domain/tasks/client-feed-labels'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { memoryText } from '@/components/projects/project-texts'
import { useTRPC } from '@/trpc/client'

import { callErrorText } from './call-error'

type MemoryChangeAction =
  'saved' | 'proposed' | 'updated' | 'update_proposed' | 'forgotten' | 'forget_proposed'

/** The actions of the agent the client decides on (ПР18): its proposals. */
const PROPOSALS: ReadonlySet<MemoryChangeAction> = new Set([
  'proposed',
  'update_proposed',
  'forget_proposed',
])

/**
 * A note of memory the end of a pass kept (`feed.memory_change`, docs/plan/84-projects.md, ПР18;
 * P-chat): «Запомнено: …», or a proposal with «Сохранить» and «Не надо» while the entry still
 * waits for the client — it is read again, so a proposal decided in «Память» shows no buttons.
 */
export function FeedMemoryChange({
  entryId,
  action,
  text,
}: {
  entryId: string
  action: MemoryChangeAction
  text: string
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const proposal = PROPOSALS.has(action)
  const entry = useQuery({
    ...trpc.projectMemory.get.queryOptions({ id: entryId }),
    enabled: proposal,
  })
  const confirm = useMutation(trpc.projectMemory.confirm.mutationOptions())
  const reject = useMutation(trpc.projectMemory.reject.mutationOptions())
  const [said, setSaid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = entry.data ?? null
  const waits =
    proposal &&
    current !== null &&
    (action === 'proposed'
      ? current.status === 'proposed'
      : current.pendingAction === (action === 'update_proposed' ? 'update' : 'forget'))
  const busy = confirm.isPending || reject.isPending

  async function decide(yes: boolean) {
    if (!current) return
    setError(null)
    try {
      const at = { id: current.id, expectedVersion: current.version }
      if (yes) await confirm.mutateAsync(at)
      else await reject.mutateAsync(at)
      setSaid(
        yes
          ? action === 'forget_proposed'
            ? memoryText.forgotten
            : memoryText.kept
          : memoryText.dropped,
      )
    } catch (failure) {
      setError(callErrorText(failure, memoryText.failed))
    }
    void queryClient.invalidateQueries({ queryKey: trpc.projectMemory.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.project.pathKey() })
  }

  return (
    <Box
      data-feed-memory={action}
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 1,
        rowGap: 0.5,
        color: 'text.secondary',
      }}
    >
      <Box sx={{ display: 'flex' }} aria-hidden>
        <AppIcon name="memory" size={16} />
      </Box>
      <Typography variant="body2" sx={{ flex: '0 1 auto', minWidth: 0, overflowWrap: 'anywhere' }}>
        {feedMemoryChangeText({ action, text })}
      </Typography>
      {waits && said === null ? (
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <Button
            size="small"
            disabled={busy}
            onClick={() => void decide(true)}
            sx={{ minHeight: 36 }}
          >
            {action === 'forget_proposed' ? memoryText.forget : memoryText.save}
          </Button>
          <Button
            size="small"
            color="inherit"
            disabled={busy}
            onClick={() => void decide(false)}
            sx={{ minHeight: 36 }}
          >
            {memoryText.drop}
          </Button>
        </Box>
      ) : null}
      {said ? (
        <Typography role="status" variant="body2" sx={{ color: 'text.secondary' }}>
          · {said}
        </Typography>
      ) : null}
      {error ? (
        <Typography role="alert" variant="body2" sx={{ color: 'error.main', flexBasis: '100%' }}>
          {error}
        </Typography>
      ) : null}
    </Box>
  )
}
