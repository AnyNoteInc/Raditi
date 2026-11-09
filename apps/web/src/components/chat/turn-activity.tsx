'use client'

import { fontFamilies } from '@repo/ui/theme/tokens'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'

import { useChatThinking } from './chat-details'
import { CommandBlock } from './command-block'
import { activityText } from './chat-texts'
import type { ActivityEvent } from './chat-types'
import { useTurnActivity, type ActivityState } from './use-turn-activity'

// «Ход работы» (owner's decision of 26.10.2026): everything the agent wrote, ran and changed in a
// turn, in the order it came. What the agent wrote is set as text — never markup; commands,
// names of tools and paths in the monospace face, as the agent gave them. What the model thought
// is set apart from what the agent said: it is raw and often English, and no answer of the agent.
// A live turn shows it as it comes, with what the agent is writing now (owner's request of
// 09.11.2026); a finished one only for a viewer who asked (`/thinking`, docs/plan/61, К32).

const thought = {
  m: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: 'text.secondary',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
} as const

const said = {
  m: 0,
  fontSize: 14,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
} as const

const mono = {
  fontFamily: fontFamilies.mono,
  fontSize: 13,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
} as const

/** A line of an event: its sign, its label, what it was about and how it ended. */
function Label({
  icon,
  text,
  subject,
  outcome,
  failed = false,
}: {
  icon: AppIconName
  text: string
  /** The agent's own name of it: a tool, a path. */
  subject?: string
  outcome?: string | null
  failed?: boolean
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '2px 8px',
        color: 'text.secondary',
        fontSize: 13,
        minWidth: 0,
        '& > svg': { flex: 'none' },
      }}
    >
      <AppIcon name={icon} size={14} />
      <span>{text}</span>
      {subject === undefined ? null : (
        <Box component="code" sx={{ ...mono, color: 'text.primary' }}>
          {subject}
        </Box>
      )}
      {outcome ? (
        <Box component="span" sx={{ color: failed ? 'error.main' : 'text.secondary' }}>
          · {outcome}
        </Box>
      ) : null}
    </Box>
  )
}

function ActivityLine({ event }: { event: ActivityEvent }) {
  switch (event.type) {
    case 'message':
      return <Typography sx={said}>{event.text}</Typography>
    case 'reasoning':
      return (
        <Box sx={{ display: 'grid', gap: 0.5, minWidth: 0 }}>
          <Label icon="brain" text={activityText.reasoning} />
          <Typography sx={thought}>{event.text}</Typography>
        </Box>
      )
    case 'draft':
      if (event.kind === 'text') return <Typography sx={said}>{event.text}</Typography>
      return (
        <Box sx={{ display: 'grid', gap: 0.5, minWidth: 0 }} aria-live="polite">
          <Label
            icon={event.kind === 'reasoning' ? 'brain' : 'chat'}
            text={event.kind === 'reasoning' ? activityText.thinkingNow : activityText.answering}
          />
          <Typography sx={event.kind === 'reasoning' ? thought : said}>{event.text}</Typography>
        </Box>
      )
    case 'command':
      return <CommandBlock event={event} />
    case 'tool_call':
      return (
        <Label
          icon={event.ok ? 'check' : 'warning'}
          text={activityText.tool}
          subject={event.tool}
          outcome={activityText.toolDone(event.ok)}
          failed={!event.ok}
        />
      )
    case 'file_change':
      return <Label icon="file" text={activityText.file[event.change]} subject={event.path} />
    case 'question':
      return (
        <Box sx={{ display: 'grid', gap: 0.5 }}>
          <Label icon="chat" text={activityText.question} />
          <Typography
            sx={{
              m: 0,
              fontSize: 14,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {event.text}
          </Typography>
          {event.options.length > 0 ? (
            <Box component="ul" sx={{ m: 0, pl: 2.5, fontSize: 14 }}>
              {event.options.map((option, index) => (
                <li key={index}>{option}</li>
              ))}
            </Box>
          ) : null}
        </Box>
      )
  }
}

/**
 * The events of a turn. While the turn is `live` they stand in the feed itself, one after another,
 * and the feed follows them as a chat does (owner's request of 09.11.2026: «когда идет вывод
 * выводи не в области, а в области вывода», the way Claude and Codex show it). A finished turn
 * keeps them in a block of bounded height that scrolls, under «Агент работал …».
 */
export function TurnActivityView({
  state,
  live,
  thinking = false,
}: {
  state: ActivityState
  live: boolean
  /** The viewer's choice: what the model thought stands among the events. */
  thinking?: boolean
}) {
  // A draft of a turn that has ended is what it was writing when it stopped: its finished
  // events say the rest.
  const shown = state.events.filter(
    (event) => (thinking || event.type !== 'reasoning') && (live || event.type !== 'draft'),
  )
  const count = shown.length
  let status: string | null = null
  if (!state.read) status = state.failed ? activityText.failed : activityText.loading
  else if (state.failed) status = activityText.failed
  else if (state.more) status = activityText.more
  else if (count === 0) status = activityText.empty
  const lines = (
    <>
      {shown.map((event) => (
        <ActivityLine key={event.id} event={event} />
      ))}
      {status ? (
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>{status}</Typography>
      ) : null}
    </>
  )
  if (live)
    return (
      <Box
        role="region"
        aria-label={activityText.title}
        data-activity="live"
        sx={{ display: 'grid', alignContent: 'start', gap: 1.25, color: 'text.primary' }}
      >
        {lines}
      </Box>
    )
  return (
    <Box
      role="region"
      aria-label={activityText.title}
      // The block scrolls: it can be reached and scrolled from the keyboard.
      tabIndex={0}
      sx={{
        maxHeight: { xs: 320, md: 420 },
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        display: 'grid',
        alignContent: 'start',
        gap: 1.25,
        px: 1.5,
        py: 1.25,
        border: 1,
        borderColor: 'divider',
        borderRadius: '12px',
        color: 'text.primary',
        '&:focus-visible': { outline: '2px solid', outlineColor: 'text.primary', outlineOffset: 2 },
      }}
    >
      {lines}
    </Box>
  )
}

/** «Ход работы» of one turn of a dialog, read from the server. */
export function TurnActivity({
  taskId,
  turn,
  live,
}: {
  taskId: string
  turn: number
  live: boolean
}) {
  const state = useTurnActivity(taskId, turn, live)
  const { thinking } = useChatThinking()
  return <TurnActivityView state={state} live={live} thinking={live || thinking} />
}
