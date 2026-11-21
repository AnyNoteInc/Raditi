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
// working copy. Since plan 88 (Ар44) a tool beside the chat is the browser, or one artifact, or one
// file of the chat — each its own tab; «Документы» are no more. A tool is a key: `browser`,
// `artifact:<id>` or `file:<name>`, so the panel keeps its plain lists of tools.
export type DialogTool = 'browser' | `artifact:${string}` | `file:${string}`

export const artifactTool = (id: string): DialogTool => `artifact:${id}`
export const fileTool = (name: string): DialogTool => `file:${name}`

export type ToolKind =
  { kind: 'browser' } | { kind: 'artifact'; id: string } | { kind: 'file'; name: string }

/** What a key names. */
export function toolKindOf(tool: DialogTool): ToolKind {
  if (tool.startsWith('artifact:')) return { kind: 'artifact', id: tool.slice('artifact:'.length) }
  if (tool.startsWith('file:')) return { kind: 'file', name: tool.slice('file:'.length) }
  return { kind: 'browser' }
}

/** An artifact or a file: the tabs Ар44 counts. */
const isItem = (tool: DialogTool) => tool !== 'browser'

/** Open tabs of artifacts and files: at the ninth the one shown longest ago closes (Ар44). */
export const MAX_ITEM_TABS = 8

/**
 * Who opened a tool (И9): «+» and «Взять управление». The launch of the browser is no opener: it
 * is an action of its own (`launch`), with rules of its own.
 */
export const toolOpeners = ['menu', 'take'] as const
export type ToolOpener = (typeof toolOpeners)[number]

/** The icon of the browser, in the menu and on its tab; artifacts and files take theirs from data. */
export const browserIcon: AppIconName = 'globe'
export const browserName: string = toolText.tab.browser

/** A name usable in an id: what a name of a file may hold besides is put as `_`. */
const idPart = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_')

/**
 * The ids of the tab of a tool and of its panel: the stands find them (И20) —
 * `dialog-pane-tab-browser`, `dialog-pane-tab-artifact-<id>`, `dialog-pane-tab-file-<name>`.
 */
export function toolTabId(tool: DialogTool): string {
  const kind = toolKindOf(tool)
  if (kind.kind === 'artifact') return `dialog-pane-tab-artifact-${kind.id}`
  if (kind.kind === 'file') return `dialog-pane-tab-file-${idPart(kind.name)}`
  return 'dialog-pane-tab-browser'
}
export const toolPanelId = (tool: DialogTool) =>
  toolTabId(tool).replace('dialog-pane-tab-', 'dialog-pane-panel-')

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

/** The browser of the chat is one of its tools (docs/plan/61-chats-first.md, §5.11). */
export const chatHasBrowser = (head: FeedHeadState): boolean => head.task.requirements.browser

/**
 * Who drives the browser of the task, as its tile says it: «пока нет» while a dialog at work has
 * no session yet — its tab says the browser opens when the agent needs it, which may be never;
 * «нет» for a dialog that ended without one; closed for a session that holds none any more.
 */
function browserHolder(
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
 * The mark on the right of the tile of the browser (И5): «Открыто» for an open one, else who drives
 * it, in the word of its panel (`answered`: the agent answered and asked nothing; `rewound`:
 * `/undo` left it so).
 */
export function browserMark(
  head: FeedHeadState,
  {
    open,
    answered = false,
    rewound = false,
  }: { open: boolean; answered?: boolean; rewound?: boolean },
): string {
  if (open) return toolText.mark.open
  return browserHolder(head.browser, head, { answered, rewound })
}

// ---------------------------------------------------------------------------------------------
// The panel beside the dialog
// ---------------------------------------------------------------------------------------------

export interface ToolsState {
  /** The open tools — the tabs, in the order they were opened. */
  open: readonly DialogTool[]
  /** The tab shown with the panel; null exactly when `open` is empty: no tool is open. */
  active: DialogTool | null
  /** The open tools, the one shown last first: the ninth item closes the last of them (Ар44). */
  recent: readonly DialogTool[]
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
   * The artifacts and files that opened by themselves in this showing (Ар45): each does so once;
   * after the client closed the whole panel none does any more (`arrivalsSpent`).
   */
  arrived: readonly DialogTool[]
  arrivalsSpent: boolean
  /** Something came while the panel was not on the screen and did not open: the dot on «+». */
  unseen: boolean
}

/** Every showing of a dialog starts with the panel closed (И1): nothing of it is kept elsewhere. */
export const closedTools: ToolsState = Object.freeze({
  open: [],
  active: null,
  recent: [],
  away: false,
  launchSpent: false,
  arrived: [],
  arrivalsSpent: false,
  unseen: false,
}) as ToolsState

/** The panel, or below `lg` the area in place of the dialog, is on the screen. */
export const toolsShown = (tools: ToolsState): boolean => tools.active !== null && !tools.away

export type ToolsAction =
  /** A tool asked for: it opens as the last tab, or its tab is made active; never a second one. */
  | { type: 'open'; tool: DialogTool; by: ToolOpener }
  /** A tab chosen on the strip, or in «Ещё»: it is shown. Nobody asked for the tool to open. */
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
   * The agent made an artifact or sent a file while the client looks at the chat (Ар45): from `lg`
   * («opens») its tab opens by itself, once in the showing — or joins the tabs of a panel on the
   * screen beside the tool the client reads; below `lg` only the dot of «+» says so.
   */
  | { type: 'arrived'; tool: DialogTool; opens: boolean }

const withTool = (open: readonly DialogTool[], tool: DialogTool): readonly DialogTool[] =>
  open.includes(tool) ? open : [...open, tool]

const touched = (recent: readonly DialogTool[], tool: DialogTool): readonly DialogTool[] =>
  recent[0] === tool ? recent : [tool, ...recent.filter((other) => other !== tool)]

/** At the ninth artifact or file, the one shown longest ago closes (Ар44); never `keep`. */
function crowded(state: ToolsState, keep: DialogTool): ToolsState {
  const items = state.open.filter(isItem)
  if (items.length <= MAX_ITEM_TABS) return state
  const oldest = [...state.recent].reverse().find((tool) => isItem(tool) && tool !== keep)
  const victim = oldest ?? items.find((tool) => tool !== keep)
  if (victim === undefined) return state
  return {
    ...state,
    open: state.open.filter((tool) => tool !== victim),
    recent: state.recent.filter((tool) => tool !== victim),
  }
}

/** `tool` on the screen among the tabs `open`; the same state when nothing changes. */
function shown(state: ToolsState, open: readonly DialogTool[], tool: DialogTool): ToolsState {
  if (open === state.open && state.active === tool && !state.away && !state.unseen) return state
  return crowded(
    {
      ...state,
      open,
      active: tool,
      away: false,
      unseen: false,
      recent: touched(state.recent, tool),
    },
    tool,
  )
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
    recent: state.recent.filter((other) => other !== tool),
    away: state.away && open.length > 0,
    // The browser closed, or with the last tab the whole panel.
    launchSpent: state.launchSpent || tool === 'browser' || open.length === 0,
    arrivalsSpent: state.arrivalsSpent || open.length === 0,
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
        recent: [],
        away: false,
        launchSpent: true,
        arrivalsSpent: true,
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
        recent: touched(state.recent, 'browser'),
      }
    case 'arrived': {
      const { tool } = action
      if (toolsShown(state) && state.active === tool) return state
      const spent = state.arrivalsSpent || state.arrived.includes(tool)
      if (!action.opens || spent) return state.unseen ? state : { ...state, unseen: true }
      const arrived = [...state.arrived, tool]
      // Another tool on the screen keeps it and the focus: the new one joins beside it.
      if (toolsShown(state))
        return crowded(
          {
            ...state,
            arrived,
            open: withTool(state.open, tool),
            recent: [...state.recent.filter((other) => other !== tool), tool],
          },
          state.active ?? tool,
        )
      return shown({ ...state, arrived }, withTool(state.open, tool), tool)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The menu «+» and the strip of tabs
// ---------------------------------------------------------------------------------------------

/** Where an item of «+» stands (Ар44): the tools, the artifacts of the chat by how, its files. */
export type ToolGroup = 'tools' | 'made' | 'mentioned' | 'project' | 'files'
export const toolGroups: readonly ToolGroup[] = ['tools', 'made', 'mentioned', 'project', 'files']

/** An artifact of the chat as the menu and the tabs name it. */
export interface ChatArtifactItem {
  id: string
  title: string
  icon: AppIconName
  group: 'made' | 'mentioned' | 'project'
}

/** A file of the chat (a page or a text document of the outbox) as the menu names it. */
export interface ChatFileItem {
  name: string
  title: string
  icon: AppIconName
}

/** An item of the menu «+»: a tool of the dialog, its name, whether it is open, its mark. */
export interface ToolTile {
  tool: DialogTool
  group: ToolGroup
  label: string
  icon: AppIconName
  open: boolean
  mark: string | null
}

/**
 * The items of «+» (Ар44, board B-chat-list): the browser, the artifacts of the chat — made here,
 * mentioned in it, of its project — and its files. An open one is marked «Открыто», one open but
 * behind «Ещё» — «В «Ещё»».
 */
export function toolTilesOf(
  head: FeedHeadState,
  tools: ToolsState,
  {
    answered = false,
    rewound = false,
    artifacts = [],
    files = [],
    hidden = [],
  }: {
    answered?: boolean
    rewound?: boolean
    artifacts?: readonly ChatArtifactItem[]
    files?: readonly ChatFileItem[]
    /** The open tabs that stand in «Ещё». */
    hidden?: readonly DialogTool[]
  } = {},
): ToolTile[] {
  const markOf = (tool: DialogTool) =>
    !tools.open.includes(tool)
      ? null
      : hidden.includes(tool)
        ? toolText.mark.inMore
        : toolText.mark.open
  const tiles: ToolTile[] = []
  if (chatHasBrowser(head)) {
    const open = tools.open.includes('browser')
    tiles.push({
      tool: 'browser',
      group: 'tools',
      label: toolText.item.browser,
      icon: browserIcon,
      open,
      mark: markOf('browser') ?? browserMark(head, { open, answered, rewound }),
    })
  }
  const seen = new Set<string>()
  for (const group of ['made', 'mentioned', 'project'] as const)
    for (const artifact of artifacts.filter((each) => each.group === group)) {
      if (seen.has(artifact.id)) continue
      seen.add(artifact.id)
      const tool = artifactTool(artifact.id)
      tiles.push({
        tool,
        group,
        label: artifact.title,
        icon: artifact.icon,
        open: tools.open.includes(tool),
        mark: markOf(tool),
      })
    }
  for (const file of files) {
    const tool = fileTool(file.name)
    tiles.push({
      tool,
      group: 'files',
      label: file.title,
      icon: file.icon,
      open: tools.open.includes(tool),
      mark: markOf(tool),
    })
  }
  return tiles
}

/** Why «+» bears its dot (И13), the most pressing first. */
export type ToolsDot = keyof typeof toolText.dot

/** The browser waits for the client: its session holds a browser, and the agent asked for help there. */
const browserWaits = (session: BrowserHead | null): boolean =>
  session !== null && sessionLive(session) && session.help !== null

/**
 * The dot on «+» while the tools are not on the screen (И13): the browser waits for the client, or
 * an artifact or a file came that was not seen. The panel never opens for it.
 */
export function toolsDot(head: FeedHeadState, tools: ToolsState): ToolsDot | null {
  if (toolsShown(tools)) return null
  if (browserWaits(head.browser)) return 'browser'
  return tools.unseen ? 'results' : null
}

/** The name of «+»: with what its dot says, when it has one. */
export const toolsLabel = (dot: ToolsDot | null): string =>
  dot === null ? toolText.label : toolText.labelWith(toolText.dot[dot])

/**
 * Which open tabs stand on the strip and which in «Ещё N ▾» (Ар44): as many as `fit`, the active
 * one always among them, the others by how lately they were shown; the strip keeps the order of
 * opening. `fit` — at least 1.
 */
export function tabsLayout(
  tools: ToolsState,
  fit: number,
): { inline: DialogTool[]; more: DialogTool[] } {
  const room = Math.max(1, Math.floor(fit))
  if (tools.open.length <= room) return { inline: [...tools.open], more: [] }
  const kept = new Set<DialogTool>()
  if (tools.active !== null) kept.add(tools.active)
  for (const tool of tools.recent) {
    if (kept.size >= room) break
    if (tools.open.includes(tool)) kept.add(tool)
  }
  for (const tool of tools.open) {
    if (kept.size >= room) break
    kept.add(tool)
  }
  return {
    inline: tools.open.filter((tool) => kept.has(tool)),
    more: tools.open.filter((tool) => !kept.has(tool)),
  }
}
