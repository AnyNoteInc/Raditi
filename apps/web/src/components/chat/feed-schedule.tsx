'use client'

import { runMomentText, scheduleText } from '@repo/domain/schedule'
import {
  feedScheduleChangeText,
  feedScheduleChangeTitle,
  feedScheduleLeftText,
} from '@repo/domain/tasks/client-feed-labels'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import MuiLink from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { BrowserPushControl } from '@/components/notifications/browser-push-control'
import { scheduleStateText } from '@/components/scheduled/schedule-model'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { callErrorText } from './call-error'
import { chatHref, SCHEDULED_HREF, scheduledTaskHref } from './chat-address'
import { effortText, scheduleChatText } from './chat-texts'
import type { FeedRow, ScheduledTaskItem } from './chat-types'

// The cards of the scheduled tasks the agent set up in the chat (docs/plan/82-scheduled-tasks.md,
// Зп33, Зп35, Зп36). The row says what core applied at the end of the turn; the list of the
// client's tasks (`schedule.list`) says what the task is now — whether it is still there to open
// and run, and when it runs next. A task of someone else, or one deleted since, is not in the
// list: its card keeps the words of the row, with nothing to open.

export type ScheduleChangeRow = Extract<FeedRow, { type: 'feed.schedule_change' }>
export type ScheduleLeftRow = Extract<FeedRow, { type: 'feed.schedule_left' }>

/** Instructions up to this long, on one line, stand in the card; longer ones fold (Зп35). */
export const SHORT_INSTRUCTIONS = 160

const shortInstructions = (text: string): boolean =>
  text.length <= SHORT_INSTRUCTIONS && !text.includes('\n')

/** «Размышление: низкое» — the level as the chat names it, in the middle of a line. */
const effortWord = (effort: ScheduleChangeRow['effort']): string =>
  scheduleChatText.effort(effortText[effort].toLowerCase())

/** The task of the row as the list has it now; null — not (or no longer) the client's to open. */
function useCurrentTask(scheduleId: string, wanted: boolean) {
  const trpc = useTRPC()
  const list = useQuery({ ...trpc.schedule.list.queryOptions(), enabled: wanted })
  const task = list.data?.schedules.find((each) => each.id === scheduleId) ?? null
  // A list cached before the turn ended does not name the task yet: ask once more before
  // treating it as gone (the same as a page of the feed, docs/plan/69-pages.md).
  const missing = wanted && list.isSuccess && task === null
  const [asked, setAsked] = useState(false)
  const { refetch } = list
  useEffect(() => {
    if (!missing || asked) return
    void refetch().finally(() => setAsked(true))
  }, [missing, asked, refetch])
  return task
}

/**
 * When the task runs next, or why it does not: as «Расписание» says it while the task is in the
 * list, else as the row says. A task only by hand says nothing more: its schedule says that.
 */
function stateLine(
  row: ScheduleChangeRow,
  task: ScheduledTaskItem | null,
  now: Date,
): string | null {
  if (task !== null)
    return task.enabled && task.nextRunAt === null ? null : scheduleStateText(task, now)
  if (row.action === 'paused') return scheduleChatText.paused
  if (row.nextRunAt === null) return null
  const next = new Date(row.nextRunAt)
  // A run the row named that has passed says nothing true of the next one.
  return next.getTime() > now.getTime()
    ? scheduleChatText.nextRun(runMomentText(next, row.timezone, now))
    : null
}

/** The instructions of the task, word for word; long ones under «Показать инструкцию». */
function Instructions({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const words = (
    <Typography
      id={id}
      variant="body2"
      sx={{
        m: 0,
        pl: 1.5,
        borderLeft: 2,
        borderColor: 'divider',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        color: 'text.primary',
      }}
    >
      {text}
    </Typography>
  )
  if (shortInstructions(text)) return words
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, minWidth: 0 }}>
      <Button
        size="small"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((shown) => !shown)}
        startIcon={
          <AppIcon
            name="chevron"
            size={14}
            style={{
              transform: open ? 'rotate(90deg)' : undefined,
              transition: 'transform var(--raditi-motion-base) var(--raditi-ease-out)',
            }}
          />
        }
        sx={{ alignSelf: 'flex-start', minHeight: 36, color: 'text.secondary', ml: -1 }}
      >
        {open ? scheduleChatText.hideInstructions : scheduleChatText.showInstructions}
      </Button>
      {open ? words : null}
    </Box>
  )
}

/**
 * A task the agent created, changed, paused, resumed or deleted at the end of its turn
 * (`feed.schedule_change`, Зп35): its title, its name — a link to the task while it is the
 * client's — the schedule in words, when it runs next, «Размышление» and the
 * notice of a finished run, the instructions word for word, «Открыть задачу», «Изменить» and
 * «Запустить сейчас», each named by the task to a screen reader, and the control of
 * notifications in this browser when `push` (Зп36: the newest card of the chat carries it). A
 * deleted task is one line.
 */
export function FeedScheduleChange({
  row,
  now,
  push = false,
  onEdit,
}: {
  row: ScheduleChangeRow
  now: Date
  /** «Включить в этом браузере» under the card while notifications are off here (Зп36). */
  push?: boolean
  /** «Изменить»: the window of the task; absent — the card offers none. */
  onEdit?: (task: ScheduledTaskItem) => void
}) {
  const deleted = row.action === 'deleted'
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const task = useCurrentTask(row.scheduleId, !deleted)
  const run = useMutation(trpc.schedule.runNow.mutationOptions())
  const [refused, setRefused] = useState<string | null>(null)

  if (deleted)
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, color: 'text.secondary' }}>
        <Box sx={{ display: 'flex' }} aria-hidden>
          <AppIcon name="timer" size={16} />
        </Box>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {nbsp(feedScheduleChangeText(row))}
        </Typography>
      </Box>
    )

  const state = stateLine(row, task, now)
  const details = [
    effortWord(row.effort),
    row.notify ? scheduleChatText.notifyOn : scheduleChatText.notifyOff,
  ]

  return (
    <Box
      component="article"
      aria-label={scheduleChatText.card(row.name)}
      sx={{
        alignSelf: 'stretch',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
        px: { xs: 2, sm: 2.5 },
        py: 1.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: '18px',
        bgcolor: 'background.paper',
        minWidth: 0,
      }}
    >
      <Box sx={{ display: 'flex', color: 'text.secondary', flexShrink: 0, pt: 0.25 }} aria-hidden>
        <AppIcon name="timer" size={20} />
      </Box>
      <Box
        sx={{ minWidth: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: 0.75 }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography
            component="h2"
            variant="body2"
            sx={{ m: 0, color: 'text.secondary', fontWeight: 400 }}
          >
            {feedScheduleChangeTitle[row.action]}
          </Typography>
          <Typography
            component="p"
            sx={{ m: 0, fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.35 }}
          >
            {task !== null ? (
              <MuiLink
                component={Link}
                href={scheduledTaskHref(row.scheduleId)}
                color="inherit"
                underline="hover"
              >
                {row.name}
              </MuiLink>
            ) : (
              row.name
            )}
          </Typography>
        </Box>
        {row.triggers !== null ? (
          <Typography variant="body2" sx={{ color: 'text.primary', overflowWrap: 'anywhere' }}>
            {nbsp(scheduleText(row.triggers, row.timezone))}
          </Typography>
        ) : null}
        {state !== null ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {nbsp(state)}
          </Typography>
        ) : null}
        <Typography variant="body2" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
          {nbsp(details.join(' · '))}
        </Typography>
        <Instructions text={row.instructions} />
        {task !== null ? (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 0.5 }}>
            <Button
              variant="outlined"
              size="small"
              component={Link}
              href={scheduledTaskHref(row.scheduleId)}
              aria-label={scheduleChatText.openTaskLabel(row.name)}
              sx={{ minHeight: 40 }}
            >
              {scheduleChatText.openTask}
            </Button>
            {onEdit ? (
              <Button
                variant="outlined"
                size="small"
                onClick={() => onEdit(task)}
                aria-label={scheduleChatText.editLabel(row.name)}
                startIcon={<AppIcon name="pencil" size={16} />}
                sx={{ minHeight: 40 }}
              >
                {scheduleChatText.edit}
              </Button>
            ) : null}
            <Button
              variant="outlined"
              size="small"
              aria-label={scheduleChatText.runNowLabel(row.name)}
              disabled={run.isPending}
              onClick={() => {
                setRefused(null)
                run.mutate(
                  { scheduleId: row.scheduleId },
                  {
                    onSuccess: ({ taskId }) => {
                      void queryClient.invalidateQueries({
                        queryKey: trpc.schedule.list.queryKey(),
                      })
                      router.push(chatHref(taskId))
                    },
                    onError: (error) => setRefused(callErrorText(error)),
                  },
                )
              }}
              sx={{ minHeight: 40 }}
            >
              {scheduleChatText.runNow}
            </Button>
          </Box>
        ) : null}
        {refused !== null ? (
          <Typography variant="body2" role="alert" sx={{ color: 'error.main' }}>
            {refused}
          </Typography>
        ) : null}
        {push ? <BrowserPushControl sx={{ mt: 0.5 }} /> : null}
      </Box>
    </Box>
  )
}

/**
 * A change of a task the agent reserved that did not come true (`feed.schedule_left`, Зп35):
 * «Задачу не удалось сохранить: <причина>» and «Настроить вручную» — the window of a new task over
 * the chat, or, where the chat has none to open, «Расписание».
 */
export function FeedScheduleLeft({
  row,
  onSetUp,
}: {
  row: ScheduleLeftRow
  /** Opens the window of a new task; absent — the button leads to «Расписание». */
  onSetUp?: () => void
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 1.5,
        color: 'text.secondary',
      }}
    >
      <Box sx={{ display: 'flex' }} aria-hidden>
        <AppIcon name="timer" size={16} />
      </Box>
      <Typography variant="body2" sx={{ flex: '1 1 240px', overflowWrap: 'anywhere' }}>
        {nbsp(`${feedScheduleLeftText(row)}.`)}
      </Typography>
      {onSetUp ? (
        <Button size="small" variant="outlined" onClick={onSetUp} sx={{ minHeight: 40 }}>
          {scheduleChatText.setUpByHand}
        </Button>
      ) : (
        <Button
          size="small"
          variant="outlined"
          component={Link}
          href={SCHEDULED_HREF}
          sx={{ minHeight: 40 }}
        >
          {scheduleChatText.setUpByHand}
        </Button>
      )}
    </Box>
  )
}
