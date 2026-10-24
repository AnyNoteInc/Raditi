import type { AppRouter } from '@repo/trpc'
import type { inferRouterOutputs } from '@trpc/server'

// What the procedures of a dialog send, as the screens receive them: a moment is a Date
// (superjson), except `at` of a feed row and the times of the head, which are ISO strings.
type Outputs = inferRouterOutputs<AppRouter>

/** One answer of `task.feed`: the head of the dialog and its rows after the cursor. */
export type DialogFeed = Outputs['task']['feed']
export type FeedHead = DialogFeed['task']
/** The preview of the dialog as its panel shows it. */
export type PreviewHead = NonNullable<DialogFeed['preview']>
/** The candidate the dialog waits with. */
export type CandidateHead = NonNullable<DialogFeed['candidate']>
/** The latest release of the dialog. */
export type ReleaseHead = NonNullable<DialogFeed['release']>
/** «Отменить выпуск»: the installed release of the dialog, its deadline and its latest undo. */
export type UndoHead = NonNullable<DialogFeed['undo']>
/** The server's verdict on one command of the chat. */
export type CommandVerdict = DialogFeed['commands'][number]
export type FeedRow = DialogFeed['events'][number]

export type DialogListPage = Outputs['task']['list']
export type DialogListItem = DialogListPage['items'][number]

/** The changes of a dialog for the panel beside it. */
export type CandidateView = NonNullable<Outputs['candidate']['get']>
export type FileDiffView = Outputs['candidate']['fileDiff']

export type PreparedRelease = Outputs['release']['prepare']
/** The plan of «Отменить выпуск» as the window shows it. */
export type UndoPlanAnswer = Outputs['release']['undoPlan']
export type ReadyUndoPlan = Extract<UndoPlanAnswer, { state: 'ready' }>
export type ReleaseChoice = PreparedRelease['choices'][number]

/** A variable of a site as its settings show it: never the value. */
export type SiteEnvVar = Outputs['siteEnv']['list']['variables'][number]

/** What a site can be worked on with now, as the server decides it (docs/plan/57, Б9). */
export type SiteCapabilities = Outputs['project']['get']['capabilities']
/** A file sent with the messages of a task, as `attachment.list` names it. */
export type TaskAttachment = Outputs['attachment']['list'][number]
/** The cloud browser of a task in the head of its feed (docs/plan/57, Б12–Б18). */
export type BrowserHead = NonNullable<DialogFeed['browser']>
