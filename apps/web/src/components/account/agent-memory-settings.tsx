'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Skeleton from '@mui/material/Skeleton'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId } from 'react'

import { callErrorText } from '@/components/chat/call-error'
import { MemoryPanel } from '@/components/projects/project-memory'
import { memoryText } from '@/components/projects/project-texts'
import { useTRPC } from '@/trpc/client'

/**
 * «Настройки → Общее → Память агента» (docs/plan/84-projects.md, ПР18, §4.8 — без макета):
 * «Агент запоминает важное» (`users.agent_memory`; off — the agent of every chat of the user has
 * neither the tools of memory nor its section) and the memory of the account, of the chats
 * without a project.
 */
export function AgentMemorySettings() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const list = useQuery(trpc.projectMemory.list.queryOptions({ projectId: null }))
  const toggle = useMutation(trpc.user.setAgentMemory.mutationOptions())
  const titleId = useId()
  const switchId = useId()
  const hintId = useId()

  return (
    <Box
      component="section"
      id="memory"
      aria-labelledby={titleId}
      sx={{ p: { xs: 2.5, sm: 4 }, scrollMarginTop: 80 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ flex: '1 1 auto', maxWidth: 560 }}>
          <Typography id={titleId} component="h2" sx={{ fontWeight: 600, fontSize: 17 }}>
            {memoryText.settingsTitle}
          </Typography>
          <Typography
            component="label"
            htmlFor={switchId}
            sx={{ display: 'block', mt: 1, fontSize: 15, fontWeight: 500 }}
          >
            {memoryText.settingsSwitch}
          </Typography>
          <Typography id={hintId} color="text.secondary" variant="body2" sx={{ mt: 0.5 }}>
            {memoryText.settingsHint}
          </Typography>
        </Box>
        {list.isPending ? (
          <Skeleton variant="rounded" width={58} height={38} />
        ) : (
          <Switch
            id={switchId}
            checked={list.data?.agentMemory ?? true}
            disabled={toggle.isPending || list.isError}
            slotProps={{ input: { 'aria-describedby': hintId } }}
            onChange={(_event, on) =>
              toggle.mutate(
                { on },
                {
                  onSettled: () =>
                    void queryClient.invalidateQueries({
                      queryKey: trpc.projectMemory.pathKey(),
                    }),
                },
              )
            }
          />
        )}
      </Box>
      {toggle.isError ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {callErrorText(toggle.error)}
        </Alert>
      ) : null}
      <Typography component="h3" sx={{ mt: 3, mb: 1.5, fontSize: 15, fontWeight: 600 }}>
        {memoryText.accountTitle}
      </Typography>
      <MemoryPanel projectId={null} offNotice={false} />
    </Box>
  )
}
