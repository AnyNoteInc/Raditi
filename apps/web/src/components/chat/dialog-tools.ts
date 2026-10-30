import { terminalTaskStatuses } from '@repo/domain/tasks/task-status'

import type { AppIconName } from '@/components/application/app-icon'

import { sessionLive } from './browser-pane-model'
import { browserText, toolText } from './chat-texts'
import type { BrowserHead, CandidateHead, PreviewHead } from './chat-types'
import type { FeedHeadState } from './feed-state'

// The tools of a dialog (docs/plan/59-dialog-tools-panel.md, И1–И20 and the owner's answers of
// 30.10.2026, §9): what «+» offers the dialog,
// what its tiles say, and which tools stand open beside the dialog as tabs. Pure: the menu and the
// panel draw what these functions say, and the dialog sends the presses of the client and the
// launch of the browser to `toolsReducer`. Nothing here is kept between two showings of a dialog:
// each one starts with the panel closed (И1).

export const dialogTools = ['browser', 'preview', 'files', 'database', 'checks'] as const
export type DialogTool = (typeof dialogTools)[number]
/** The tools of the changes: what the candidate of the dialog holds. */
export type ChangesTool = Extract<DialogTool, 'files' | 'database' | 'checks'>
const changesTools: readonly ChangesTool[] = ['files', 'database', 'checks']
/** A tool of the changes: its tab reads the candidate and says it has been seen (И11, И13). */
export const isChangesTool = (tool: DialogTool | null): tool is ChangesTool =>
  tool === 'files' || tool === 'database' || tool === 'checks'
/**
 * Who opened a tool (И9): «+», «Посмотреть изменения», `/preview` and «Взять управление». The
 * launch of the browser is no opener: it is an action of its own (`launch`), with rules of its own.
 */
export const toolOpeners = ['menu', 'changes', 'command', 'take'] as const
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
 * An opening puts the focus on the tab of the tool (И9), unless the action keeps a place of its
 * own: «Взять управление» leaves it where the panel of the browser puts it. An opening that
 * `covers` the dialog — below `lg` the area of a tool takes its place (И14) — hides the button that
 * was pressed there: the focus goes to the tab then too, never left behind out of sight.
 */
export const movesFocus = (
  by: ToolOpener,
  { covers = false }: { covers?: boolean } = {},
): boolean => covers || by !== 'take'

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
 * The tools «+» offers the dialog, in the order of the menu (И6): a task in the browser has its
 * browser, whatever its state, ended too; a task with the repository has the preview while one
 * can be shown, its files and checks always, and its records only once its changes hold some
 * (owner's answer of 30.10.2026: «не нужно показывать, если нет изменений в базе данных»).
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
        return candidateCount('database', head.candidate) > 0
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

/**
 * Who drives the browser of the task, as its tile says it: «пока нет» while a dialog at work has
 * no session yet — its tab says the browser opens when the agent starts; closed for a session that
 * holds none any more, or a dialog that ended without one.
 */
function browserMark(session: BrowserHead | null, ended: boolean): string {
  if (session === null) return ended ? toolText.mark.browserClosed : toolText.mark.notYet
  if (!sessionLive(session)) return toolText.mark.browserClosed
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
  if (tool === 'browser') return browserMark(head.browser, dialogEnded(head))
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
  /** The tab shown with the panel; null exactly when `open` is empty: no tool is open. */
  active: DialogTool | null
  /**
   * Below `lg` the client went back to the dialog with «К диалогу» while other tabs stayed open
   * (И14, owner's answer of 30.10.2026): the area of the tools is put away, its tabs kept behind
   * the dialog until a tool is chosen again.
   */
  away: boolean
  /**
   * The browser has opened by itself, or the client closed it or the whole panel: in this showing
   * it does not open by itself any more (И3).
   */
  launchSpent: boolean
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
  away: false,
  launchSpent: false,
  seenChanges: null,
}) as ToolsState

/** The panel, or below `lg` the area in place of the dialog, is on the screen. */
export const toolsShown = (tools: ToolsState): boolean => tools.active !== null && !tools.away

export type ToolsAction =
  /** A tool asked for: it opens as the last tab, or its tab is made active; never a second one. */
  | { type: 'open'; tool: DialogTool; by: ToolOpener }
  /** A tab chosen on the strip: it is shown. Nobody asked for the tool, so none opens by it. */
  | { type: 'show'; tool: DialogTool }
  /** The cross of a tab: the tab beside it, on the right, else on the left, is made active. */
  | { type: 'close'; tool: DialogTool }
  /** «Скрыть панель»: every tab at once. */
  | { type: 'closeAll' }
  /** «К диалогу» below `lg`: the tab on the screen closes, the others stay behind the dialog. */
  | { type: 'back' }
  /** The browser of the task has started while the client looks at the dialog (И2, И3). */
  | { type: 'launch' }
  /** A tab of the changes is on the screen at these changes (`changesMark`). */
  | { type: 'seen'; changes: string }

const withTool = (open: readonly DialogTool[], tool: DialogTool): readonly DialogTool[] =>
  open.includes(tool) ? open : [...open, tool]

/** `tool` on the screen among the tabs `open`; the same state when nothing changes. */
function shown(state: ToolsState, open: readonly DialogTool[], tool: DialogTool): ToolsState {
  if (open === state.open && state.active === tool && !state.away) return state
  return { ...state, open, active: tool, away: false }
}

/** `tool` closed: the tab beside it, on the right, else on the left, is the active one. */
function closed(state: ToolsState, tool: DialogTool): ToolsState {
  const at = state.open.indexOf(tool)
  const open = state.open.filter((other) => other !== tool)
  const active = state.active === tool ? (open[at] ?? open[at - 1] ?? null) : state.active
  return {
    ...state,
    open,
    active,
    away: state.away && open.length > 0,
    // The browser closed, or with the last tab the whole panel.
    launchSpent: state.launchSpent || tool === 'browser' || open.length === 0,
  }
}

/**
 * The tools beside a dialog. Knows nothing of the focus, the network or the width of the screen:
 * a launch opens the browser once on any width (И3, owner's answer of 30.10.2026), and any closing
 * of the browser or of the panel by the client spends it. Closing what is not open changes
 * nothing, nor does choosing a tab that is not there.
 */
export function toolsReducer(state: ToolsState, action: ToolsAction): ToolsState {
  switch (action.type) {
    case 'open':
      return shown(state, withTool(state.open, action.tool), action.tool)
    case 'show':
      return state.open.includes(action.tool) ? shown(state, state.open, action.tool) : state
    case 'close':
      return state.open.includes(action.tool) ? closed(state, action.tool) : state
    case 'closeAll':
      if (state.open.length === 0) return state
      return { ...state, open: [], active: null, away: false, launchSpent: true }
    case 'back': {
      if (state.active === null || state.away) return state
      const after = closed(state, state.active)
      return { ...after, away: after.active !== null }
    }
    case 'launch':
      if (state.launchSpent) return state
      return {
        ...state,
        open: withTool(state.open, 'browser'),
        active: 'browser',
        away: false,
        launchSpent: true,
      }
    case 'seen':
      if (state.seenChanges === action.changes) return state
      return { ...state, seenChanges: action.changes }
  }
}

/** A tile of the menu «Инструменты»: a tool of the dialog, whether its tab is open, its mark. */
export interface ToolTile {
  tool: DialogTool
  open: boolean
  mark: string | null
}

/** The tiles of the menu «Инструменты» (И5, И6): the tools of the dialog in their order. */
export const toolTilesOf = (head: FeedHeadState, tools: ToolsState): ToolTile[] =>
  dialogToolsOf(head).map((tool) => {
    const open = tools.open.includes(tool)
    return { tool, open, mark: toolMark(tool, head, { open }) }
  })

/** Why «+» bears its dot (И13), the most pressing first. */
export type ToolsDot = keyof typeof toolText.dot

/** The browser waits for the client: its session holds a browser, and the agent asked for help there. */
const browserWaits = (session: BrowserHead | null): boolean =>
  session !== null && sessionLive(session) && session.help !== null

/**
 * The dot on «+» while the tools are not on the screen (И13): the browser waits for the client, or
 * the changes are of a revision the client has not had on the screen in this showing — the one
 * there at the start too. The panel never opens for it.
 */
export function toolsDot(head: FeedHeadState, tools: ToolsState): ToolsDot | null {
  if (toolsShown(tools)) return null
  if (browserWaits(head.browser)) return 'browser'
  const changes = changesMark(head.candidate)
  return changes !== null && changes !== tools.seenChanges ? 'changes' : null
}

/** The name of «+»: with what its dot says, when it has one. */
export const toolsLabel = (dot: ToolsDot | null): string =>
  dot === null ? toolText.label : toolText.labelWith(toolText.dot[dot])
