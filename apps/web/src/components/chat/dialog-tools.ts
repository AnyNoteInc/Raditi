import { terminalTaskStatuses } from '@repo/domain/tasks/task-status'

import type { AppIconName } from '@/components/application/app-icon'

import { sessionLive } from './browser-pane-model'
import { browserText, toolText } from './chat-texts'
import type { BrowserHead, CandidateHead, PreviewHead } from './chat-types'
import type { FeedHeadState } from './feed-state'

// The tools of a dialog (docs/plan/59-dialog-tools-panel.md, И1–И20): what «+» offers the dialog,
// what its tiles say, and which tools stand open beside the dialog as tabs. Pure: the menu and the
// panel draw what these functions say, and the dialog sends the presses of the client and the
// launch of the browser to `toolsReducer`. Nothing here is kept between two showings of a dialog:
// each one starts with the panel closed (И1).

export const dialogTools = ['browser', 'preview', 'files', 'database', 'checks'] as const
export type DialogTool = (typeof dialogTools)[number]
/** The tools of the changes: what the candidate of the dialog holds. */
export type ChangesTool = Extract<DialogTool, 'files' | 'database' | 'checks'>
const changesTools: readonly ChangesTool[] = ['files', 'database', 'checks']
/** Who opened a tool (И9). */
export const toolOpeners = [
  'menu',
  'changes',
  'command',
  'card',
  'take',
  'watch',
  'launch',
] as const
export type ToolOpener = (typeof toolOpeners)[number]

/** The icon of a tool, in the menu and on its tab. */
export const toolIcons: Readonly<Record<DialogTool, AppIconName>> = Object.freeze({
  browser: 'globe',
  preview: 'eye',
  files: 'file',
  database: 'database',
  checks: 'check',
})

/** The name of a tool on its tab, and in the menu «Инструменты» (И7). */
export const toolTabNames: Readonly<Record<DialogTool, string>> = toolText.tab
export const toolMenuNames: Readonly<Record<DialogTool, string>> = toolText.item

/** The ids of the tab of a tool and of its panel: the stands of the release find them (И20). */
export const toolTabId = (tool: DialogTool) => `dialog-pane-tab-${tool}`
export const toolPanelId = (tool: DialogTool) => `dialog-pane-panel-${tool}`

/**
 * An explicit opening puts the focus on the tab of the tool (И9), unless the action keeps a place
 * of its own: «Взять управление» leaves it where the panel of the browser puts it, and the launch
 * of the browser, which nobody pressed, moves nothing.
 */
export const movesFocus = (by: ToolOpener): boolean => by !== 'take' && by !== 'launch'

/** The dialog has ended: nothing more will come to its tools. */
export const dialogEnded = (head: FeedHeadState): boolean =>
  terminalTaskStatuses.includes(head.task.status)

/** A preview the client can use: being made, ready, stopped for its age or failed. */
const usedPreviews: ReadonlySet<PreviewHead['status']> = new Set([
  'pending',
  'building',
  'ready',
  'failed',
  'expired',
])

/** The platform makes previews here (it knows their origin), and this one can be shown. */
const offersPreview = (preview: PreviewHead | null): boolean =>
  preview !== null && preview.origin !== null && usedPreviews.has(preview.status)

/**
 * The tools «+» offers the dialog, in the order of the menu (И6): what the task can have, not
 * what it holds now. A task in the browser has its browser, whatever its state, ended too; a task
 * with the repository has the preview while one can be shown, its files and checks always, and its
 * records when the server says the dialog can change the database (`databaseChanges`).
 */
export function dialogToolsOf(head: FeedHeadState): DialogTool[] {
  if (head.task.requirements.browser) return ['browser']
  return dialogTools.filter((tool) => {
    switch (tool) {
      case 'browser':
        return false
      case 'preview':
        return offersPreview(head.preview)
      case 'database':
        return head.task.databaseChanges
      case 'files':
      case 'checks':
        return true
    }
  })
}

/** What a tool of the changes holds: the files and media, the records of the site, the checks. */
export function candidateCount(tool: ChangesTool, candidate: CandidateHead | null): number {
  if (candidate === null) return 0
  if (tool === 'checks') {
    const { pending, passed, failed, stale } = candidate.checks
    return pending + passed + failed + stale
  }
  const counts = candidate.counts
  if (counts === null) return 0
  if (tool === 'database') return counts.records
  return counts.files.added + counts.files.modified + counts.files.deleted + counts.media
}

/** Who drives the browser of the task, as its tile says it; a session that holds none — closed. */
function browserMark(session: BrowserHead | null): string {
  if (session === null || !sessionLive(session)) return toolText.mark.browserClosed
  if (session.controller === 'user') return browserText.status.user
  if (session.help !== null) return browserText.status.waiting
  return browserText.status.agent
}

/**
 * The mark on the right of the tile of a tool (И5): «Открыто» for an open one; the number of
 * the files and media or of the records, the checks passed of all; «пока нет» while the changes
 * have nothing for it, «нет» once the dialog has ended; who drives the browser. The preview has
 * none.
 */
export function toolMark(
  tool: DialogTool,
  head: FeedHeadState,
  { open }: { open: boolean },
): string | null {
  if (open) return toolText.mark.open
  if (tool === 'preview') return null
  if (tool === 'browser') return browserMark(head.browser)
  const candidate = head.candidate
  const count = candidateCount(tool, candidate)
  if (candidate !== null && count > 0)
    return tool === 'checks' ? toolText.mark.checks(candidate.checks.passed, count) : String(count)
  return dialogEnded(head) ? toolText.mark.none : toolText.mark.notYet
}

/**
 * The tool «Посмотреть изменения» opens (И10): the first of the files, the records and the checks
 * that holds anything, among those the dialog has; the files, with what they say before the
 * changes, when none does.
 */
export function changesToolOf(head: FeedHeadState): ChangesTool {
  const offered = dialogToolsOf(head)
  return (
    changesTools.find(
      (tool) => offered.includes(tool) && candidateCount(tool, head.candidate) > 0,
    ) ?? 'files'
  )
}

/** What a tab of the changes says in place of them: a sentence and a quieter one under it. */
export interface ToolEmptyText {
  title: string
  note: string | null
}

/**
 * What a tab of the changes says while the dialog has no candidate (И6): the changes are yet to
 * come, or the dialog has ended without them. null — there is one: the tab shows what it holds.
 */
export function changesEmptyText(
  tool: ChangesTool,
  { ended, candidate }: { ended: boolean; candidate: CandidateHead | null },
): ToolEmptyText | null {
  if (candidate !== null) return null
  return (ended ? toolText.ended : toolText.empty)[tool]
}

/** The changes as the client saw them: `id:revision` of the candidate; null — none. */
export const changesMark = (candidate: CandidateHead | null): string | null =>
  candidate === null ? null : `${candidate.id}:${candidate.revision}`

// ---------------------------------------------------------------------------------------------
// The panel beside the dialog
// ---------------------------------------------------------------------------------------------

export interface ToolsState {
  /** The open tools — the tabs, in the order they were opened. */
  open: readonly DialogTool[]
  /** The tab on the screen; null exactly when `open` is empty: the panel is closed. */
  active: DialogTool | null
  /**
   * The browser has opened by itself, or the client closed it or the whole panel: in this showing
   * it does not open by itself any more (И3).
   */
  launchSpent: boolean
  /** The browser was launched on a narrow screen and the client has not opened it since (И13). */
  launchUnseen: boolean
  /**
   * `id:revision` of the candidate the client last had a tab of the changes on the screen at, in
   * this showing (И13).
   */
  seenChanges: string | null
}

/** Every showing of a dialog starts with the panel closed (И1): nothing of it is kept elsewhere. */
export const closedTools: ToolsState = Object.freeze({
  open: [],
  active: null,
  launchSpent: false,
  launchUnseen: false,
  seenChanges: null,
}) as ToolsState

export type ToolsAction =
  /** A tool asked for: it opens as the last tab, or its tab is made active; never a second one. */
  | { type: 'open'; tool: DialogTool; by: ToolOpener }
  /** The cross of a tab: the tab beside it, on the right, else on the left, is made active. */
  | { type: 'close'; tool: DialogTool }
  /** «Скрыть панель», «К диалогу». */
  | { type: 'closeAll' }
  /** The browser of the task has started while the client looks at the dialog (И2, И3). */
  | { type: 'launch'; wide: boolean }
  /** A tab of the changes is on the screen at these changes (`changesMark`). */
  | { type: 'seen'; changes: string }

const withTool = (open: readonly DialogTool[], tool: DialogTool): readonly DialogTool[] =>
  open.includes(tool) ? open : [...open, tool]

/**
 * The tools beside a dialog. Knows nothing of the focus, the network or the width of the screen,
 * but for the width at a launch: a launch opens the browser once on a wide screen and only marks
 * «+» on a narrow one (И3, И13), and any closing of the browser or of the panel by the client spends
 * it. Closing what is not open changes nothing.
 */
export function toolsReducer(state: ToolsState, action: ToolsAction): ToolsState {
  switch (action.type) {
    case 'open': {
      const open = withTool(state.open, action.tool)
      // The client sees the browser the launch marked.
      const launchUnseen = action.tool === 'browser' ? false : state.launchUnseen
      if (
        open === state.open &&
        state.active === action.tool &&
        launchUnseen === state.launchUnseen
      )
        return state
      return { ...state, open, active: action.tool, launchUnseen }
    }
    case 'close': {
      const at = state.open.indexOf(action.tool)
      if (at < 0) return state
      const open = state.open.filter((tool) => tool !== action.tool)
      const active =
        state.active === action.tool ? (open[at] ?? open[at - 1] ?? null) : state.active
      return {
        ...state,
        open,
        active,
        // The browser closed, or with the last tab the whole panel.
        launchSpent: state.launchSpent || action.tool === 'browser' || open.length === 0,
      }
    }
    case 'closeAll':
      if (state.open.length === 0) return state
      return { ...state, open: [], active: null, launchSpent: true }
    case 'launch':
      if (state.launchSpent) return state
      if (!action.wide)
        // A browser already on the screen is seen: no dot for it.
        return { ...state, launchSpent: true, launchUnseen: state.active !== 'browser' }
      return {
        ...state,
        open: withTool(state.open, 'browser'),
        active: 'browser',
        launchSpent: true,
      }
    case 'seen':
      if (state.seenChanges === action.changes) return state
      return { ...state, seenChanges: action.changes }
  }
}

/** Why «+» bears its dot (И13), the most pressing first. */
export type ToolsDot = keyof typeof toolText.dot

/** The browser waits for the client: its session holds a browser, and the agent asked for help there. */
const browserWaits = (session: BrowserHead | null): boolean =>
  session !== null && sessionLive(session) && session.help !== null

/**
 * The dot on «+» while the panel is closed (И13): the browser waits for the client, it was
 * launched on a narrow screen, or the changes are of a revision the client has not had on the
 * screen in this showing — the one there at the start too. The panel never opens for it.
 */
export function toolsDot(head: FeedHeadState, tools: ToolsState): ToolsDot | null {
  if (tools.active !== null) return null
  if (browserWaits(head.browser)) return 'browser'
  if (tools.launchUnseen) return 'launch'
  const changes = changesMark(head.candidate)
  return changes !== null && changes !== tools.seenChanges ? 'changes' : null
}

/** The name of «+»: with what its dot says, when it has one. */
export const toolsLabel = (dot: ToolsDot | null): string =>
  dot === null ? toolText.label : toolText.labelWith(toolText.dot[dot])
