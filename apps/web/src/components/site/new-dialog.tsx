'use client'

import type { ReasoningEffort } from '@repo/domain'
import { taskModeLabel } from '@repo/domain/tasks/client-feed-labels'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { callErrorText } from '@/components/chat/call-error'
import { composerText, taskWayText } from '@/components/chat/chat-texts'
import type { SiteCapabilities } from '@/components/chat/chat-types'
import { Composer, offScreen } from '@/components/chat/composer'
import { riseIn } from '@/components/chat/chat-motion'
import { EffortMenu } from '@/components/chat/effort-menu'
import { dialogListKey } from '@/components/chat/dialog-list'
import { useAttachments } from '@/components/chat/use-attachments'
import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC } from '@/trpc/client'

import { siteHref } from './site-nav'

const CHAT_OFF = 'new-dialog-chat-off'
const WORK_OFF = 'new-dialog-work-off'
const WAY_NOTE = 'new-dialog-way-note'

type TaskMode = 'chat' | 'work'

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

/** One choice of a switch of pills: a native radio inside its label. */
interface PillOption<T extends string> {
  value: T
  label: string
  /** Set on a choice that cannot be made: the id of the phrase that says why. */
  describedBy?: string
}

/** A switch of pills: «Чат | Работа». */
function Pills<T extends string>({
  name,
  label,
  options,
  value,
  onChange,
  describedBy,
}: {
  name: string
  label: string
  options: readonly PillOption<T>[]
  value: T
  onChange: (value: T) => void
  describedBy?: string
}) {
  return (
    <Box
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      sx={{ display: 'flex', gap: '2px' }}
    >
      {options.map((option) => {
        const checked = option.value === value
        const off = option.describedBy !== undefined
        return (
          <Box
            key={option.value}
            component="label"
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.75,
              // The pressing area of 44px on every width (DESIGN.md).
              minHeight: 44,
              px: 1.5,
              borderRadius: '999px',
              fontSize: 14,
              fontWeight: checked ? 500 : 400,
              color: checked ? 'text.primary' : 'text.secondary',
              // The choice made stands out by a soft fill of its own, not by a shadow.
              bgcolor: checked ? 'action.selected' : 'transparent',
              opacity: off ? 0.6 : 1,
              cursor: off ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
              transition:
                'background-color var(--raditi-motion-base) var(--raditi-ease-out), color var(--raditi-motion-fast) var(--raditi-ease-out)',
              '&:hover': off
                ? undefined
                : { color: 'text.primary', bgcolor: checked ? 'action.selected' : 'action.hover' },
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
              name={name}
              value={option.value}
              checked={checked}
              disabled={off}
              aria-describedby={option.describedBy}
              onChange={() => onChange(option.value)}
              sx={offScreen}
            />
            {/* The clock, not the colour, says that the choice cannot be made now. */}
            {off && <AppIcon name="clock" size={16} />}
            {option.label}
          </Box>
        )
      })}
    </Box>
  )
}

/** The mode of a dialog is the way the agent works: «Чат» — without the files, «Работа» — on them. */
const modeOfWay = { browser: 'chat', repository: 'work' } as const satisfies Record<
  TaskWay,
  TaskMode
>
const wayOfMode = { chat: 'browser', work: 'repository' } as const satisfies Record<
  TaskMode,
  TaskWay
>

/**
 * The screen a dialog starts from (docs/plan/53-chat-preview-release.md, R9). The first words
 * start a dialog: the browser invents the id of the dialog, so a repeat of the same request after
 * a lost answer finds the same dialog, and the screen moves to it. The mode is the way the agent
 * works (owner's request of 26.10.2026): «Работа» on a copy of the site from `main`, «Чат» without
 * the files — in the cloud browser (docs/plan/57-browser-tasks.md, Б9); a mode the site does not
 * offer cannot be chosen, and why is read aloud. Files go with the first words in either mode.
 * «Размышление» picks how hard the model thinks
 * (`low`, `high`, `max`) — the same menu changes it later in the dialog. A site that takes no tasks says so on the field. Beside the list at the
 * root of the section the heading of the page is the list's, so the screen takes the level below.
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
  const [effort, setEffort] = useState<ReasoningEffort>('high')
  // Files go with a dialog in either mode: in «Чат» the agent hands them to the site's own pages
  // (Б26), in «Работа» they are put into its copy of the site (spec §8, «Подготовка»).
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
        ...(attachmentIds.length > 0 ? { attachments: [...attachmentIds] } : {}),
        effort,
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
      <Box
        sx={{
          width: '100%',
          maxWidth: 780,
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          // The one entrance of the screen: the field comes up as the page opens.
          ...riseIn,
        }}
      >
        <Typography
          component={heading}
          sx={{
            fontSize: { xs: 24, sm: 28 },
            fontWeight: 500,
            letterSpacing: '-0.01em',
            lineHeight: 1.25,
            textAlign: 'center',
          }}
        >
          Новый диалог
        </Typography>

        <Composer
          placeholder={composerText.newPlaceholder}
          disabledReason={offer.blocked}
          error={error}
          busy={create.isPending}
          onSend={start}
          attachments={attachments}
          noSecrets={browser ? taskWayText.noSecrets : undefined}
          modes={
            <>
              <Pills
                name="mode"
                label={composerText.modes}
                value={modeOfWay[way ?? 'repository']}
                onChange={(mode) => setChosen(wayOfMode[mode])}
                {...(way === null ? {} : { describedBy: WAY_NOTE })}
                options={[
                  {
                    value: 'chat',
                    label: taskModeLabel.chat,
                    ...(offer.ways.includes('browser') ? {} : { describedBy: CHAT_OFF }),
                  },
                  {
                    value: 'work',
                    label: taskModeLabel.work,
                    ...(offer.ways.includes('repository') ? {} : { describedBy: WORK_OFF }),
                  },
                ]}
              />
              <EffortMenu value={effort} onChange={setEffort} />
            </>
          }
        />
        {/* The one reason a client can fix themselves — the address is not https — is shown: the
            field would be closed with nothing to say why. */}
        {offer.blocked === taskWayText.insecure ? (
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
            {offer.blocked}
          </Typography>
        ) : null}
        {/* Not shown (owner's request of 26.10.2026: no standing words under the field): what the
            mode means is read aloud with it, and the clock on a mode says it cannot be chosen. */}
        {way !== null ? (
          <Box id={WAY_NOTE} sx={offScreen}>
            {way === 'repository'
              ? taskWayText.repositoryNote
              : offer.ways.includes('repository')
                ? taskWayText.browserNote
                : taskWayText.browserOnly}
          </Box>
        ) : null}
        <Box id={CHAT_OFF} sx={offScreen}>
          {composerText.chatOff}
        </Box>
        <Box id={WORK_OFF} sx={offScreen}>
          {composerText.workOff}
        </Box>
      </Box>
    </Box>
  )
}
