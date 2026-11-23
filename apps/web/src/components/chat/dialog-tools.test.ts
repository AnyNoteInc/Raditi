import { taskStatuses, terminalTaskStatuses } from '@repo/domain/tasks/task-status'
import { describe, expect, it } from 'vitest'

import {
  artifactTool,
  browserMark,
  chatHasBrowser,
  closedTools,
  dialogEnded,
  fileTool,
  MAX_ITEM_TABS,
  movesFocus,
  tabsLayout,
  toolKindOf,
  toolOpeners,
  toolPanelId,
  toolsDot,
  toolsReducer,
  toolsShown,
  toolTabId,
  toolTilesOf,
  type DialogTool,
  type ToolsAction,
  type ToolsState,
} from './dialog-tools'
import { browserAnswer, feedAnswer } from './testing'

const closed = { open: false }
const A = '019f1a21-1800-7f00-8abc-000000000001'
const DOC = artifactTool('doc-1')
const FILE = fileTool('audit.md')
const all: DialogTool[] = ['browser', DOC, FILE]

/** The state after the actions, from a closed panel. */
const after = (...actions: ToolsAction[]): ToolsState => actions.reduce(toolsReducer, closedTools)

const open = (tool: DialogTool): ToolsAction => ({ type: 'open', tool, by: 'menu' })
const close = (tool: DialogTool): ToolsAction => ({ type: 'close', tool })
const closeAll: ToolsAction = { type: 'closeAll' }
const back: ToolsAction = { type: 'back' }
const launch: ToolsAction = { type: 'launch' }

describe('the tools a dialog has (И6)', () => {
  it('offers a chat with a browser the browser, ended or not', () => {
    expect(chatHasBrowser(browserAnswer())).toBe(true)
    expect(chatHasBrowser(browserAnswer({ status: 'done' }))).toBe(true)
    expect(toolTilesOf(browserAnswer(), closedTools).map((tile) => tile.tool)).toEqual(['browser'])
  })

  it('offers a chat with neither nothing at all', () => {
    const neither = { requirements: { repository: false, browser: false } }
    expect(toolTilesOf(feedAnswer({ task: neither }), closedTools)).toEqual([])
    expect(toolTilesOf(feedAnswer({ task: neither, status: 'done' }), closedTools)).toEqual([])
  })
})

describe('the marks of the tiles (И5)', () => {
  it('says «пока нет» of a browser the agent has not needed yet (plan 61, К11)', () => {
    const none = browserAnswer({ browser: null })
    expect(browserMark(none, closed)).toBe('пока нет')
    expect(browserMark(browserAnswer({ status: 'awaiting_user', browser: null }), closed)).toBe(
      'пока нет',
    )
    // The dialog ended without one: there will be none.
    expect(browserMark(browserAnswer({ status: 'done', browser: null }), closed)).toBe('нет')
  })

  it('says who drives the browser while its session holds one', () => {
    expect(browserMark(browserAnswer(), closed)).toBe('Работает агент')
    expect(browserMark(browserAnswer({ browser: { status: 'starting' } }), closed)).toBe(
      'Работает агент',
    )
    const help = { reason: 'login' as const, message: null }
    expect(browserMark(browserAnswer({ browser: { help } }), closed)).toBe('Ждём вас')
    expect(browserMark(browserAnswer({ status: 'awaiting_user', browser: { help } }), closed)).toBe(
      'Ждём вас',
    )
    expect(browserMark(browserAnswer({ browser: { controller: 'user' } }), closed)).toBe(
      'Управляете вы',
    )
    // The client took the control the agent asked for: the client drives.
    expect(browserMark(browserAnswer({ browser: { controller: 'user', help } }), closed)).toBe(
      'Управляете вы',
    )
  })

  it('never says the agent works in a browser while the chat waits for its release (К10)', () => {
    const both = { requirements: { repository: true, browser: true } }
    for (const status of ['awaiting_approval', 'deploying', 'verifying'] as const) {
      const head = browserAnswer({ task: both, status })
      expect(browserMark(head, closed)).toBe('Агент ответил')
      // The client still drives it, and a request for help still waits.
      expect(browserMark(browserAnswer({ status, browser: { controller: 'user' } }), closed)).toBe(
        'Управляете вы',
      )
      const help = { reason: 'login' as const, message: null }
      expect(browserMark(browserAnswer({ status, browser: { help } }), closed)).toBe('Ждём вас')
    }
  })

  it('says of a chat that waits what its panel says, never that the agent works (К10)', () => {
    const waits = browserAnswer({ status: 'awaiting_user' })
    expect(browserMark(waits, { ...closed, answered: true })).toBe('Агент ответил')
    expect(browserMark(waits, closed)).toBe('Ждём вас')
    expect(toolTilesOf(waits, closedTools, { answered: true })).toEqual([
      {
        tool: 'browser',
        group: 'tools',
        label: 'Браузер',
        icon: 'globe',
        open: false,
        mark: 'Агент ответил',
      },
    ])
    expect(browserMark(waits, { ...closed, answered: true, rewound: true })).toBe('Запрос отменён')
    expect(
      toolTilesOf(waits, closedTools, { answered: true, rewound: true }).map((tile) => tile.mark),
    ).toEqual(['Запрос отменён'])
    // A request for help outweighs an answer: the panel asks for the same.
    const help = { reason: 'login' as const, message: null }
    const asks = browserAnswer({ status: 'awaiting_user', browser: { help } })
    expect(browserMark(asks, { ...closed, answered: true })).toBe('Ждём вас')
  })

  it('says «пока нет» while a dialog at work has no session yet', () => {
    expect(browserMark(browserAnswer({ browser: null }), closed)).toBe('пока нет')
    expect(browserMark(browserAnswer({ status: 'awaiting_user', browser: null }), closed)).toBe(
      'пока нет',
    )
  })

  it('says «Закрыт» when the session holds no browser any more', () => {
    for (const status of ['closed', 'failed', 'lost'] as const)
      expect(browserMark(browserAnswer({ browser: { status } }), closed)).toBe('Закрыт')
    expect(
      browserMark(
        browserAnswer({
          status: 'done',
          browser: { status: 'closed', controller: 'user', closeReason: 'task_done' },
        }),
        closed,
      ),
    ).toBe('Закрыт')
  })
})

describe('the end of a dialog', () => {
  it('takes a dialog as ended by the statuses that end a task', () => {
    for (const status of taskStatuses)
      expect(dialogEnded(feedAnswer({ status }))).toBe(terminalTaskStatuses.includes(status))
  })
})

describe('the names, icons and ids of the tools', () => {
  it('keys the browser, an artifact and a file, with ids the stands find (И20, Ар44)', () => {
    expect(toolKindOf('browser')).toEqual({ kind: 'browser' })
    expect(toolKindOf(artifactTool(A))).toEqual({ kind: 'artifact', id: A })
    expect(toolKindOf(fileTool('цены 2026.html'))).toEqual({ kind: 'file', name: 'цены 2026.html' })
    expect(toolTabId('browser')).toBe('dialog-pane-tab-browser')
    expect(toolTabId(artifactTool(A))).toBe(`dialog-pane-tab-artifact-${A}`)
    expect(toolPanelId(artifactTool(A))).toBe(`dialog-pane-panel-artifact-${A}`)
    expect(toolTabId(fileTool('audit.md'))).toBe('dialog-pane-tab-file-audit_md')
  })

  it('puts the focus on the tab of a tool opened by «+», never by «Взять управление» beside the dialog', () => {
    expect(movesFocus('menu')).toBe(true)
    expect(movesFocus('take')).toBe(false)
  })

  it('puts it there for «Взять управление» too where the tool hides the dialog it was pressed in (И14)', () => {
    expect(toolOpeners.filter((by) => movesFocus(by, { covers: true }))).toEqual([...toolOpeners])
  })
})

describe('the tabs of the open tools', () => {
  it('opens a tool once, as the last tab, and closes to the tab beside it', () => {
    const both = after(open('browser'), open(DOC), open('browser'))
    expect(both).toMatchObject({ open: ['browser', DOC], active: 'browser' })
    expect(toolsReducer(both, close('browser'))).toMatchObject({ open: [DOC], active: DOC })
    expect(toolsShown(after(open(DOC), closeAll))).toBe(false)
  })

  it('keeps at most eight artifacts and files: the ninth closes the one shown longest ago (Ар44)', () => {
    const items = Array.from({ length: MAX_ITEM_TABS }, (_, index) => artifactTool(`a${index}`))
    // The first one shown again: the second is now the one shown longest ago.
    const full = after(open('browser'), ...items.map(open), { type: 'show', tool: items[0]! })
    expect(full.open).toHaveLength(MAX_ITEM_TABS + 1)
    const ninth = toolsReducer(full, open(fileTool('ninth.md')))
    expect(ninth.open).toHaveLength(MAX_ITEM_TABS + 1)
    expect(ninth.open).not.toContain(items[1])
    expect(ninth.open).toContain('browser')
    expect(ninth.active).toBe(fileTool('ninth.md'))
  })

  it('stands the active tab and the lately shown on the strip, the rest in «Ещё» (Ар44)', () => {
    const tabs = ['browser', artifactTool('a'), artifactTool('b'), fileTool('c.md')] as const
    const state = after(...tabs.map(open), { type: 'show', tool: tabs[1] })
    expect(tabsLayout(state, 10)).toEqual({ inline: [...tabs], more: [] })
    expect(tabsLayout(state, 2)).toEqual({
      inline: [tabs[1], tabs[3]],
      more: [tabs[0], tabs[2]],
    })
    expect(tabsLayout(state, 0).inline).toEqual([tabs[1]])
  })
})

describe("«К чату» below `lg` (И14, owner's answer of 30.10.2026)", () => {
  it('closes the tab on the screen and keeps the others behind the dialog', () => {
    const state = after(open('browser'), open(DOC), back)
    expect(state).toMatchObject({ open: ['browser'], active: 'browser', away: true })
    expect(toolsShown(state)).toBe(false)
  })
})

describe('the launch of the browser (И2, И3)', () => {
  it('opens nothing after the client closed the browser', () => {
    const state = after(open('browser'), close('browser'))
    expect(state.launchSpent).toBe(true)
    expect(toolsReducer(state, launch)).toBe(state)
    // The browser it opened itself, closed: not again.
    const again = after(launch, close('browser'))
    expect(toolsReducer(again, launch)).toBe(again)
  })

  it('shows the browser the client opened before it was ready, and spends the launch on it', () => {
    const early = after(open('browser'))
    const launched = toolsReducer(early, launch)
    expect(launched.open).toEqual(['browser'])
    expect(launched.active).toBe('browser')
    expect(launched.launchSpent).toBe(true)
  })
})

describe('the dot on «+» (И13)', () => {
  const help = { reason: 'login' as const, message: null }

  it('marks a browser that waits for the client, while its session holds one', () => {
    expect(toolsDot(browserAnswer({ browser: { help } }), closedTools)).toBe('browser')
    expect(toolsDot(browserAnswer(), closedTools)).toBeNull()
    expect(
      toolsDot(
        browserAnswer({ browser: { help, status: 'closed', closeReason: 'idle' } }),
        closedTools,
      ),
    ).toBeNull()
    expect(toolsDot(browserAnswer({ browser: { help } }), after(open('browser')))).toBeNull()
  })
})

/** A small seeded generator: the same actions on every run. */
function generator(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('toolsReducer, whatever the client does', () => {
  const actions: ToolsAction[] = [
    ...all.map((tool) => open(tool)),
    ...all.map((tool): ToolsAction => ({ type: 'show', tool })),
    ...all.map((tool) => close(tool)),
    ...all.slice(1).map((tool): ToolsAction => ({ type: 'arrived', tool, opens: true })),
    closeAll,
    back,
    launch,
  ]

  it('keeps one tab per tool, an active tab exactly while one is open, and one launch', () => {
    // Showings in which the browser opened by itself: the runs reach a launch.
    let launched = 0
    for (const seed of [1, 7, 42, 2026, 31_337, 99_991, 3, 11, 123, 777, 4242, 65_537]) {
      const next = generator(seed)
      let state: ToolsState = closedTools
      let launches = 0
      for (let step = 0; step < 400; step += 1) {
        const action = actions[Math.floor(next() * actions.length)]!
        // A frozen state: the reducer that changed it in place would throw.
        const before = Object.freeze({ ...state, open: Object.freeze([...state.open]) })
        const reduced = toolsReducer(before, action)
        expect(new Set(reduced.open).size).toBe(reduced.open.length)
        expect(reduced.active === null).toBe(reduced.open.length === 0)
        if (reduced.active !== null) expect(reduced.open).toContain(reduced.active)
        // Put away only with tabs to keep behind the dialog.
        if (reduced.away) expect(reduced.open.length).toBeGreaterThan(0)
        if (before.launchSpent) expect(reduced.launchSpent).toBe(true)
        if (action.type === 'open') {
          expect(reduced.active).toBe(action.tool)
          expect(toolsShown(reduced)).toBe(true)
        }
        if (action.type === 'back' && toolsShown(before)) {
          expect(reduced.open).toEqual(before.open.filter((tool) => tool !== before.active))
          expect(toolsShown(reduced)).toBe(false)
        }
        if (action.type === 'show') {
          expect(reduced.open).toEqual(before.open)
          if (before.open.includes(action.tool)) expect(reduced.active).toBe(action.tool)
        }
        if (action.type === 'close') expect(reduced.open).not.toContain(action.tool)
        if (action.type === 'launch' && reduced !== before) launches += 1
        state = reduced
      }
      expect(launches).toBeLessThanOrEqual(1)
      launched += launches
    }
    expect(launched).toBeGreaterThan(0)
  })
})

describe('an artifact or a file that comes (Ар45)', () => {
  const arrived = (tool: DialogTool, opens = true): ToolsAction => ({
    type: 'arrived',
    tool,
    opens,
  })

  it('opens its tab by itself once in the showing, from `lg`', () => {
    const opened = after(arrived(DOC))
    expect(opened).toMatchObject({ open: [DOC], active: DOC })
    const closedAgain = toolsReducer(opened, close(DOC))
    expect(toolsReducer(closedAgain, arrived(DOC))).toMatchObject({ open: [], unseen: true })
    // Another one still opens by itself.
    expect(toolsReducer(after(arrived(DOC)), arrived(FILE))).toMatchObject({ open: [DOC, FILE] })
  })

  it('joins a panel on the screen beside the tool the client reads, without the focus', () => {
    expect(toolsReducer(after(launch), arrived(DOC))).toMatchObject({
      open: ['browser', DOC],
      active: 'browser',
    })
  })

  it('below `lg`, and after the client closed the panel, only puts the dot on «+»', () => {
    expect(after(arrived(DOC, false))).toMatchObject({ open: [], unseen: true })
    expect(toolsDot(browserAnswer(), after(arrived(DOC, false)))).toBe('results')
    const quiet = after(open(DOC), closeAll, arrived(FILE))
    expect(quiet).toMatchObject({ open: [], unseen: true })
  })

  it('names the artifacts of the chat by group and the files, marked when open (B-chat-list)', () => {
    const state = after(open(DOC))
    const tiles = toolTilesOf(browserAnswer(), state, {
      artifacts: [
        { id: 'doc-1', title: 'Тексты для сайта', icon: 'document', group: 'made' },
        { id: 'doc-2', title: 'Прайс', icon: 'document', group: 'project' },
      ],
      files: [{ name: 'audit.md', title: 'Аудит', icon: 'document' }],
      hidden: [DOC],
    })
    expect(tiles.map((tile) => [tile.group, tile.label, tile.mark])).toEqual([
      ['tools', 'Браузер', 'Работает агент'],
      ['made', 'Тексты для сайта', 'В «Ещё»'],
      ['project', 'Прайс', null],
      ['files', 'Аудит', null],
    ])
  })
})
