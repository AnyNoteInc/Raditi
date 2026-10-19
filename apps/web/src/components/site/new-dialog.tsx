'use client'

import { taskModeLabel } from '@repo/domain/tasks/client-feed-labels'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { callErrorText } from '@/components/chat/call-error'
import { composerText } from '@/components/chat/chat-texts'
import { Composer, offScreen } from '@/components/chat/composer'
import { dialogListKey } from '@/components/chat/dialog-list'
import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC } from '@/trpc/client'

import { siteHref } from './site-nav'

const CHAT_OFF = 'new-dialog-chat-off'

/** One word of the mode switch: a native radio inside its label. */
function Mode({
  value,
  label,
  checked = false,
  describedBy,
}: {
  value: string
  label: string
  checked?: boolean
  /** Set on a mode that cannot be chosen: the id of the phrase that says why. */
  describedBy?: string
}) {
  const off = describedBy !== undefined
  return (
    <Box
      component="label"
      sx={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        minHeight: 44,
        px: 2.25,
        borderRadius: '999px',
        fontSize: 14,
        fontWeight: checked ? 600 : 400,
        color: checked ? 'background.paper' : 'text.secondary',
        bgcolor: checked ? 'text.primary' : 'transparent',
        cursor: off ? 'not-allowed' : 'pointer',
        '&:has(input:focus-visible)': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: '3px',
        },
      }}
    >
      <Box
        component="input"
        type="radio"
        name="mode"
        value={value}
        defaultChecked={checked}
        disabled={off}
        aria-describedby={describedBy}
        sx={offScreen}
      />
      {/* The clock, not the colour, says that the mode is yet to come. */}
      {off && <AppIcon name="clock" size={16} />}
      {label}
    </Box>
  )
}

function Modes() {
  return (
    <Box
      role="radiogroup"
      aria-label={composerText.modes}
      sx={{
        display: 'flex',
        p: '3px',
        border: 1,
        borderColor: 'divider',
        borderRadius: '999px',
        bgcolor: 'background.paper',
      }}
    >
      <Mode value="chat" label={taskModeLabel.chat} describedBy={CHAT_OFF} />
      <Mode value="work" label={taskModeLabel.work} checked />
    </Box>
  )
}

/**
 * The screen a dialog starts from (docs/plan/53-chat-preview-release.md, R9). The first words
 * start a dialog in the mode «Работа»: the browser invents the id of the dialog, so a repeat of
 * the same request after a lost answer finds the same dialog, and the screen moves to it. «Чат»
 * is shown and cannot be chosen yet. A site that is not connected takes no tasks, and the
 * screen says so on the field. Beside the list at the root of the section the heading of the
 * page is the list's, so the screen takes the level below.
 */
export function NewDialog({
  siteId,
  accepting,
  heading = 'h1',
}: {
  siteId: string
  /** The site is connected: a dialog can be started. */
  accepting: boolean
  heading?: 'h1' | 'h2'
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  // One id per dialog being started: a repeat after a lost answer lands on the same one.
  const taskId = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const create = useMutation(trpc.task.create.mutationOptions())

  async function start(text: string): Promise<boolean> {
    taskId.current ??= uuidv7()
    setError(null)
    try {
      const created = await create.mutateAsync({ siteId, taskId: taskId.current, text })
      taskId.current = null
      void queryClient.invalidateQueries({ queryKey: dialogListKey(siteId) })
      // The new dialog set credits aside: the credits under the list are read again.
      void queryClient.invalidateQueries({ queryKey: trpc.billing.usage.queryKey() })
      router.push(`${siteHref(siteId, 'chat')}/${created.taskId}`)
      return true
    } catch (failure) {
      setError(callErrorText(failure))
      return false
    }
  }

  return (
    <Box
      sx={{
        flex: '1 0 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        // On a phone the field stays by the thumb; from `sm` the screen is centred.
        justifyContent: { xs: 'flex-end', sm: 'center' },
        pb: { sm: 4 },
      }}
    >
      <Box sx={{ width: '100%', maxWidth: 780, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography
          component={heading}
          sx={{ fontSize: 26, fontWeight: 600, lineHeight: 1.25, textAlign: 'center' }}
        >
          Новый диалог
        </Typography>

        <Composer
          placeholder={composerText.newPlaceholder}
          disabledReason={accepting ? null : composerText.notConnected}
          error={error}
          busy={create.isPending}
          onSend={start}
          modes={<Modes />}
        />
        <Typography
          id={CHAT_OFF}
          variant="body2"
          color="text.secondary"
          sx={{ textAlign: 'center' }}
        >
          {composerText.chatLater}
        </Typography>
      </Box>
    </Box>
  )
}
