import type { AppRouter } from '@repo/trpc'
import type { inferRouterOutputs } from '@trpc/server'

// What the procedures of a dialog send, as the screens receive them: a moment is a Date
// (superjson), except `at` of a feed row and the times of the head, which are ISO strings.
type Outputs = inferRouterOutputs<AppRouter>

/** One answer of `task.feed`: the head of the dialog and its rows after the cursor. */
export type DialogFeed = Outputs['task']['feed']
export type FeedHead = DialogFeed['task']
/** The server's verdict on one command of the chat. */
export type CommandVerdict = DialogFeed['commands'][number]
export type FeedRow = DialogFeed['events'][number]

/** One answer of `task.activity`: the agent's events of a turn after the cursor. */
export type TurnActivityPage = Outputs['task']['activity']
export type ActivityEvent = TurnActivityPage['events'][number]

export type DialogListPage = Outputs['task']['list']
export type DialogListItem = DialogListPage['items'][number]

/**
 * The task a chat is a run of (docs/plan/82-scheduled-tasks.md, Зп43): `id` null — the task was
 * deleted, its name stays without a link.
 */
/** A chat as `task.get` reads it. */
export type ChatInfo = Outputs['task']['get']
export type ChatScheduleLabel = NonNullable<Outputs['task']['get']['schedule']>
/** A scheduled task of the client as `schedule.list` gives it: the cards of the feed read it. */
export type ScheduledTaskItem = Outputs['schedule']['list']['schedules'][number]

/** A file sent with the messages of a task, as `attachment.list` names it. */
export type TaskAttachment = Outputs['attachment']['list'][number]
/** The cloud browser of a task in the head of its feed (docs/plan/57, Б12–Б18). */
export type BrowserHead = NonNullable<DialogFeed['browser']>
