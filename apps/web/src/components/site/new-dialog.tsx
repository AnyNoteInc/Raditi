'use client'

import type { ReasoningEffort } from '@repo/domain'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter, useSearchParams } from 'next/navigation'
import { useRef, useState } from 'react'

import { callErrorText } from '@/components/chat/call-error'
import { composerText, taskWayText } from '@/components/chat/chat-texts'
import type { SiteCapabilities } from '@/components/chat/chat-types'
import { Composer, offScreen } from '@/components/chat/composer'
import { riseIn } from '@/components/chat/chat-motion'
import { EffortMenu } from '@/components/chat/effort-menu'
import { dialogListKey } from '@/components/chat/dialog-list'
import { askedMode, ModeChoice, type DialogMode } from '@/components/chat/mode-switch'
import { useAttachments } from '@/components/chat/use-attachments'
import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC } from '@/trpc/client'

import { siteHref } from './site-nav'

const CHAT_OFF = 'new-dialog-chat-off'
const WORK_OFF = 'new-dialog-work-off'
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

/** The mode of a dialog is the way the agent works: «Чат» — without the files, «Работа» — on them. */
const modeOfWay = { browser: 'chat', repository: 'work' } as const satisfies Record<
  TaskWay,
  DialogMode
>
const wayOfMode = { chat: 'browser', work: 'repository' } as const satisfies Record<
  DialogMode,
  TaskWay
>

/**
 * The screen a dialog starts from (docs/plan/53-chat-preview-release.md, R9). The first words
 * start a dialog: the browser invents the id of the dialog, so a repeat of the same request after
 * a lost answer finds the same dialog, and the screen moves to it. The mode is the way the agent
 * works (owner's request of 26.10.2026): «Работа» on a copy of the site from `main`, «Чат» without
 * the files — in the cloud browser (docs/plan/57-browser-tasks.md, Б9); a mode the site does not
 * offer cannot be chosen, and why is read aloud. The switch of the mode stands over the screen, as
 * in a dialog that goes on, and the field has the same controls as there (owner's request of
 * 29.10.2026); the switch of a dialog opens this screen with its other mode (`?mode=`).
 * «Размышление» picks how hard the model thinks (`low`, `high`, `max`) — the same menu changes it
 * later in the dialog. A site that takes no tasks says so on the field. Beside the list at the
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
  const asked = askedMode(useSearchParams().get('mode'))
  const [chosen, setChosen] = useState<TaskWay | null>(asked === null ? null : wayOfMode[asked])
  const way = chosen !== null && offer.ways.includes(chosen) ? chosen : offer.initial
  const browser = way === 'browser'
  const [effort, setEffort] = useState<ReasoningEffort>('high')
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
        effort,
      })
      taskId.current = null
      void queryClient.invalidateQueries({ queryKey: dialogListKey(siteId) })
      // The new dialog set credits aside: the ring of the credits reads them again.
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
        gap: 3,
        pb: { sm: 4 },
      }}
    >
      {/* «Чат | Работа» over the screen, where a dialog that goes on has it too. */}
      <ModeChoice
        value={modeOfWay[way ?? 'repository']}
        onChange={(mode) => setChosen(wayOfMode[mode])}
        closed={{
          ...(offer.ways.includes('browser') ? {} : { chat: CHAT_OFF }),
          ...(offer.ways.includes('repository') ? {} : { work: WORK_OFF }),
        }}
        {...(way === null ? {} : { describedBy: WAY_NOTE })}
      />
      <Box
        sx={{
          flex: '1 0 auto',
          width: '100%',
          maxWidth: 780,
          display: 'flex',
          flexDirection: 'column',
          // On a phone the field stays by the thumb; from `sm` the screen is centred.
          justifyContent: { xs: 'flex-end', sm: 'center' },
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
          attachments={browser ? attachments : undefined}
          noSecrets={browser ? taskWayText.noSecrets : undefined}
          // The window of commands is here as in a dialog; it says that commands work there.
          commands={{
            verdicts: [],
            onRun: () => undefined,
            closedReason: composerText.commandsInDialog,
          }}
          effort={<EffortMenu value={effort} onChange={setEffort} />}
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
