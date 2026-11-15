import { terminalTaskStatuses } from '@repo/domain/tasks/task-status'

import type { AppIconName } from '@/components/application/app-icon'

import { agentBrowserStatus, sessionLive } from './browser-pane-model'
import { browserText, toolText } from './chat-texts'
import type { BrowserHead } from './chat-types'
import type { FeedHeadState } from './feed-state'

// The tools of a dialog (docs/plan/59-dialog-tools-panel.md, И1–И20 and the owner's answers of
// 30.10.2026, §9): what «+» offers the dialog,
// what its tiles say, and which tools stand open beside the dialog as tabs. Pure: the menu and the
// panel draw what these functions say, and the dialog sends the presses of the client and the
// launch of the browser to `toolsReducer`. Nothing here is kept between two showings of a dialog:
// each one starts with the panel closed (И1).

// A chat has no project (docs/plan/83-remove-projects.md): no preview, no changes, no files of a
// working copy — the browser of the chat and the documents of the agent are its tools.
export const dialogTools = ['browser', 'documents'] as const
export type DialogTool = (typeof dialogTools)[number]
/**
 * Who opened a tool (И9): «+» and «Взять управление». The launch of the browser is no opener: it
 * is an action of its own (`launch`), with rules of its own.
 */
export const toolOpeners = ['menu', 'take'] as const
export type ToolOpener = (typeof toolOpeners)[number]

/** The icon of a tool, in the menu and on its tab. */
export const toolIcons: Readonly<Record<DialogTool, AppIconName>> = Object.freeze({
  browser: 'globe',
  documents: 'document',
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

/**
 * The tools «+» offers the chat, in the order of the menu (docs/plan/61-chats-first.md, §5.11): a
 * chat with a browser has it, whatever its state, ended too; the documents once there is one.
 */
export function dialogToolsOf(head: FeedHeadState, documents = 0): DialogTool[] {
  const { browser } = head.task.requirements
  return dialogTools.filter((tool) => {
    switch (tool) {
      // The pages and text documents the agent made (docs/plan/67-agent-documents.md, Д4): in a
      // chat of any kind, once there is one.
      case 'documents':
        return documents > 0
      case 'browser':
        return browser
    }
  })
}

/**
 * Who drives the browser of the task, as its tile says it: «пока нет» while a dialog at work has
 * no session yet — its tab says the browser opens when the agent needs it, which may be never;
 * «нет» for a dialog that ended without one; closed for a session that holds none any more.
 */
function browserMark(
  session: BrowserHead | null,
  head: FeedHeadState,
  rest: { answered: boolean; rewound: boolean },
): string {
  if (session === null) return dialogEnded(head) ? toolText.mark.none : toolText.mark.notYet
  if (!sessionLive(session)) return toolText.mark.browserClosed
  if (session.controller === 'user') return browserText.status.user
  const help = session.help !== null
  return browserText.status[agentBrowserStatus(head.task.status, { help, ...rest })]
}

/**
 * The mark on the right of the tile of a tool (И5): «Открыто» for an open one; the number of the
 * documents; who drives the browser, in the word of its panel (`answered`: the agent answered and
 * asked nothing; `rewound`: `/undo` left it so).
 */
export function toolMark(
  tool: DialogTool,
  head: FeedHeadState,
  {
    open,
    answered = false,
    rewound = false,
    documents = 0,
  }: { open: boolean; answered?: boolean; rewound?: boolean; documents?: number },
): string | null {
  if (open) return toolText.mark.open
  if (tool === 'documents') return String(documents)
  return browserMark(head.browser, head, { answered, rewound })
}

// ---------------------------------------------------------------------------------------------
// The panel beside the dialog
// ---------------------------------------------------------------------------------------------

export interface ToolsState {
  /** The open tools — the tabs, in the order they were opened. */
  open: readonly DialogTool[]
  /** The tab shown with the panel; null exactly when `open` is empty: no tool is open. */
  active: DialogTool | null
  /**
   * Below `lg` the client went back to the dialog with «К чату» while other tabs stayed open
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
   * The client closed «Документы» (or the whole panel) after they opened by themselves: a new
   * document does not open them again in this showing (docs/plan/67-agent-documents.md, Д4).
   */
  documentsSpent: boolean
  /** A document came while «Документы» were not on the screen and did not open: the dot on «+». */
  documentsUnseen: boolean
}

/** Every showing of a dialog starts with the panel closed (И1): nothing of it is kept elsewhere. */
export const closedTools: ToolsState = Object.freeze({
  open: [],
  active: null,
  away: false,
  launchSpent: false,
  documentsSpent: false,
  documentsUnseen: false,
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
  /** «К чату» below `lg`: the tab on the screen closes, the others stay behind the dialog. */
  | { type: 'back' }
  /**
   * The browser of the task has started while the client looks at the dialog (И2, И3): it opens by
   * itself, and with the panel on the screen it only joins the tabs (`toolsReducer`).
   */
  | { type: 'launch' }
  /**
   * A document of the agent came while the client looks at the chat (docs/plan/67, Д4): from `lg`
   * («opens») «Документы» open on it, or join the tabs of a panel on the screen beside the tool the
   * client reads; below `lg` only the dot of «+» says so.
   */
  | { type: 'documentArrived'; opens: boolean }

const withTool = (open: readonly DialogTool[], tool: DialogTool): readonly DialogTool[] =>
  open.includes(tool) ? open : [...open, tool]

/** `tool` on the screen among the tabs `open`; the same state when nothing changes. */
function shown(state: ToolsState, open: readonly DialogTool[], tool: DialogTool): ToolsState {
  const unseen = state.documentsUnseen && tool !== 'documents'
  if (
    open === state.open &&
    state.active === tool &&
    !state.away &&
    unseen === state.documentsUnseen
  )
    return state
  return { ...state, open, active: tool, away: false, documentsUnseen: unseen }
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
    documentsSpent: state.documentsSpent || tool === 'documents' || open.length === 0,
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
      return {
        ...state,
        open: [],
        active: null,
        away: false,
        launchSpent: true,
        documentsSpent: true,
      }
    case 'back': {
      if (state.active === null || state.away) return state
      const after = closed(state, state.active)
      return { ...after, away: after.active !== null }
    }
    case 'launch':
      if (state.launchSpent) return state
      // The client reads another tool: nobody pressed anything, so it stays on the screen and
      // keeps the focus, the browser a new tab beside it (docs/plan/61-chats-first.md, К10).
      if (toolsShown(state))
        return { ...state, open: withTool(state.open, 'browser'), launchSpent: true }
      return {
        ...state,
        open: withTool(state.open, 'browser'),
        active: 'browser',
        away: false,
        launchSpent: true,
      }
    case 'documentArrived': {
      if (toolsShown(state) && state.active === 'documents') return state
      if (!action.opens || state.documentsSpent)
        return state.documentsUnseen ? state : { ...state, documentsUnseen: true }
      // Another tool on the screen keeps it and the focus: the documents join beside it.
      if (toolsShown(state))
        return state.open.includes('documents')
          ? state
          : { ...state, open: withTool(state.open, 'documents') }
      return shown(state, withTool(state.open, 'documents'), 'documents')
    }
  }
}

/** A tile of the menu «Инструменты»: a tool of the dialog, whether its tab is open, its mark. */
export interface ToolTile {
  tool: DialogTool
  open: boolean
  mark: string | null
}

/** The tiles of the menu «Инструменты» (И5, И6): the tools of the dialog in their order. */
export const toolTilesOf = (
  head: FeedHeadState,
  tools: ToolsState,
  {
    answered = false,
    rewound = false,
    documents = 0,
  }: { answered?: boolean; rewound?: boolean; documents?: number } = {},
): ToolTile[] =>
  dialogToolsOf(head, documents).map((tool) => {
    const open = tools.open.includes(tool)
    return { tool, open, mark: toolMark(tool, head, { open, answered, rewound, documents }) }
  })

/** Why «+» bears its dot (И13), the most pressing first. */
export type ToolsDot = keyof typeof toolText.dot

/** The browser waits for the client: its session holds a browser, and the agent asked for help there. */
const browserWaits = (session: BrowserHead | null): boolean =>
  session !== null && sessionLive(session) && session.help !== null

/**
 * The dot on «+» while the tools are not on the screen (И13): the browser waits for the client, or
 * a document came that was not seen. The panel never opens for it.
 */
export function toolsDot(head: FeedHeadState, tools: ToolsState): ToolsDot | null {
  if (toolsShown(tools)) return null
  if (browserWaits(head.browser)) return 'browser'
  return tools.documentsUnseen ? 'documents' : null
}

/** The name of «+»: with what its dot says, when it has one. */
export const toolsLabel = (dot: ToolsDot | null): string =>
  dot === null ? toolText.label : toolText.labelWith(toolText.dot[dot])
