import type { TaskStatus } from '@repo/domain'
import { taskStatusLabel } from '@repo/domain/tasks/client-feed-labels'
import Box from '@mui/material/Box'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'

/** The sign of a status: the word is never the colour alone (feed design, допущение «л»). */
export const statusIcon: Readonly<Record<TaskStatus, AppIconName>> = Object.freeze({
  queued: 'clock',
  preparing: 'clock',
  running: 'clock',
  awaiting_user: 'chat',
  awaiting_approval: 'eye',
  deploying: 'clock',
  verifying: 'clock',
  done: 'check',
  failed: 'warning',
  rolled_back: 'changes',
  cancelled: 'stop',
})

type Tone = 'text.secondary' | 'text.primary' | 'error.main' | 'primary.main'

const statusTone: Readonly<Record<TaskStatus, Tone>> = Object.freeze({
  queued: 'text.secondary',
  preparing: 'text.secondary',
  running: 'text.secondary',
  awaiting_user: 'primary.main',
  awaiting_approval: 'primary.main',
  deploying: 'text.secondary',
  verifying: 'text.secondary',
  done: 'text.primary',
  failed: 'error.main',
  rolled_back: 'text.primary',
  cancelled: 'text.secondary',
})

/** The status of a dialog: a sign and its word. */
export function StatusMark({
  status,
  size = 'small',
}: {
  status: TaskStatus
  size?: 'small' | 'medium'
}) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        minWidth: 0,
        color: statusTone[status],
        fontSize: size === 'small' ? 13 : 14,
        fontWeight: size === 'small' ? 500 : 600,
        lineHeight: 1.3,
      }}
    >
      <AppIcon name={statusIcon[status]} size={size === 'small' ? 15 : 17} />
      {taskStatusLabel[status]}
    </Box>
  )
}
