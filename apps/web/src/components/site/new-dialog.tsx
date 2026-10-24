'use client'

import { taskModeLabel } from '@repo/domain/tasks/client-feed-labels'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'
import { callErrorText } from '@/components/chat/call-error'
import { composerText, taskWayText } from '@/components/chat/chat-texts'
import type { SiteCapabilities } from '@/components/chat/chat-types'
import { Composer, offScreen } from '@/components/chat/composer'
import { dialogListKey } from '@/components/chat/dialog-list'
import { useAttachments } from '@/components/chat/use-attachments'
import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC } from '@/trpc/client'

import { siteHref } from './site-nav'

const CHAT_OFF = 'new-dialog-chat-off'
const WAY_NOTE = 'new-dialog-way-note'

/** How the agent works on the site: in its admin pages through the browser, or on a copy. */
export type TaskWay = 'browser' | 'repository'

/** What a new dialog offers on a site, by the capabilities the server gave (docs/plan/57, Б9). */
export interface NewDialogWays {
  /** The ways the client may choose between; one — nothing to choose. */
  ways: readonly TaskWay[]
  /** The way chosen before the client chooses: the one the server would take. */
  initial: TaskWay | null
  /** Why nothing can be started; null — a dialog can be started. */
  blocked: string | null
}

export function newDialogWays(capabilities: SiteCapabilities): NewDialogWays {
  const repository = capabilities.repository === 'ready'
  const browser = capabilities.browser === 'ready'
  const ways: TaskWay[] = [
    ...(browser ? ['browser' as const] : []),
    ...(repository ? ['repository' as const] : []),
  ]
  if (ways.length === 0) {
    const blocked =
      capabilities.browser === 'insecure' ? taskWayText.insecure : composerText.notConnected
    return { ways, initial: null, blocked }
  }
  // The server's own default: the copy of the site where it is ready (`defaultRequirements`).
  return { ways, initial: repository ? 'repository' : 'browser', blocked: null }
}

const wayIcon: Readonly<Record<TaskWay, AppIconName>> = { browser: 'globe', repository: 'changes' }

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

/** «В браузере | Через копию сайта»: shown only where the site offers both. */
function Ways({ value, onChange }: { value: TaskWay; onChange: (way: TaskWay) => void }) {
  return (
    <Box
      role="radiogroup"
      aria-label={taskWayText.label}
      aria-describedby={WAY_NOTE}
      sx={{
        display: 'flex',
        p: '3px',
        border: 1,
        borderColor: 'divider',
        borderRadius: '999px',
        bgcolor: 'background.paper',
      }}
    >
      {(['browser', 'repository'] as const).map((way) => {
        const checked = value === way
        return (
          <Box
            key={way}
            component="label"
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.75,
              minHeight: 44,
              px: 2,
              borderRadius: '999px',
              fontSize: 14,
              fontWeight: checked ? 600 : 400,
              color: checked ? 'background.paper' : 'text.secondary',
              bgcolor: checked ? 'text.primary' : 'transparent',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
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
              name="way"
              value={way}
              checked={checked}
              onChange={() => onChange(way)}
              sx={offScreen}
            />
            <AppIcon name={wayIcon[way]} size={16} />
            {taskWayText[way]}
          </Box>
        )
      })}
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
 * is shown and cannot be chosen yet. A site that offers both ways asks how the agent should work
 * — in the browser or on a copy of the site (docs/plan/57-browser-tasks.md, Б9); a site that
 * takes no tasks says so on the field. Beside the list at the root of the section the heading of
 * the page is the list's, so the screen takes the level below.
 */
export function NewDialog({
  siteId,
  capabilities,
  heading = 'h1',
}: {
  siteId: string
  /** What the site can be worked on with now (`project.get`). */
  capabilities: SiteCapabilities
  heading?: 'h1' | 'h2'
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const offer = newDialogWays(capabilities)
  const [chosen, setChosen] = useState<TaskWay | null>(null)
  const way = chosen !== null && offer.ways.includes(chosen) ? chosen : offer.initial
  const browser = way === 'browser'
  // Files go with a task in the browser: the agent hands them to the site's own pages (Б26).
  const attachments = useAttachments(siteId)
  // One id per dialog being started: a repeat after a lost answer lands on the same one.
  const taskId = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const create = useMutation(trpc.task.create.mutationOptions())

  async function start(text: string, attachmentIds: readonly string[]): Promise<boolean> {
    taskId.current ??= uuidv7()
    setError(null)
    try {
      const created = await create.mutateAsync({
        siteId,
        taskId: taskId.current,
        text,
        // A site that offers the browser is told the way chosen; a site with the copy alone
        // is left to the server's default, as before there was a choice.
        ...(capabilities.browser === 'ready' && way !== null
          ? { requirements: { repository: way === 'repository', browser: way === 'browser' } }
          : {}),
        ...(browser && attachmentIds.length > 0 ? { attachments: [...attachmentIds] } : {}),
      })
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
          disabledReason={offer.blocked}
          error={error}
          busy={create.isPending}
          onSend={start}
          attachments={browser ? attachments : undefined}
          noSecrets={browser ? taskWayText.noSecrets : undefined}
          modes={
            <>
              <Modes />
              {offer.ways.length > 1 && way !== null ? (
                <Ways value={way} onChange={setChosen} />
              ) : null}
            </>
          }
        />
        {offer.ways.length > 1 && way !== null ? (
          <Typography
            id={WAY_NOTE}
            variant="body2"
            color="text.secondary"
            sx={{ textAlign: 'center', maxWidth: 640, alignSelf: 'center' }}
          >
            {way === 'browser' ? taskWayText.browserNote : taskWayText.repositoryNote}
          </Typography>
        ) : browser ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ textAlign: 'center', maxWidth: 640, alignSelf: 'center' }}
          >
            {taskWayText.browserOnly}
          </Typography>
        ) : null}
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
