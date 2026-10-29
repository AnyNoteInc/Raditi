import type { TaskStatus } from '@repo/domain'
import { taskAnsweredLabel, taskStatusLabel } from '@repo/domain/tasks/client-feed-labels'
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

/**
 * The status of a dialog: a sign and its word. `answered` — the dialog waits for nothing, the
 * agent answered (26.10.2026): it reads «Агент ответил», in the colour of a status that asks
 * nothing.
 */
export function StatusMark({
  status,
  size = 'small',
  answered = false,
  onFill = false,
}: {
  status: TaskStatus
  size?: 'small' | 'medium'
  answered?: boolean
  /**
   * The mark stands on a fill — the open dialog of the list: the quiet tone takes the colour of
   * the text, which keeps 4.5:1 there in the dark scheme as well.
   */
  onFill?: boolean
}) {
  const idle = answered && status === 'awaiting_user'
  const tone = idle ? 'text.primary' : statusTone[status]
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        minWidth: 0,
        color: onFill && tone === 'text.secondary' ? 'text.primary' : tone,
        fontSize: size === 'small' ? 13 : 14,
        fontWeight: size === 'small' ? 500 : 600,
        lineHeight: 1.3,
      }}
    >
      <AppIcon name={statusIcon[status]} size={size === 'small' ? 15 : 17} />
      {idle ? taskAnsweredLabel : taskStatusLabel[status]}
    </Box>
  )
}
