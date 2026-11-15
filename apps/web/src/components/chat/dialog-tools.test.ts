import { taskStatuses, terminalTaskStatuses } from '@repo/domain/tasks/task-status'
import { describe, expect, it } from 'vitest'

import {
  closedTools,
  dialogEnded,
  dialogTools,
  dialogToolsOf,
  movesFocus,
  toolIcons,
  toolMark,
  toolMenuNames,
  toolOpeners,
  toolPanelId,
  toolsDot,
  toolsReducer,
  toolsShown,
  toolTabId,
  toolTabNames,
  toolTilesOf,
  type DialogTool,
  type ToolsAction,
  type ToolsState,
} from './dialog-tools'
import { browserAnswer, feedAnswer } from './testing'

const closed = { open: false }

/** The state after the actions, from a closed panel. */
const after = (...actions: ToolsAction[]): ToolsState => actions.reduce(toolsReducer, closedTools)

const open = (tool: DialogTool): ToolsAction => ({ type: 'open', tool, by: 'menu' })
const close = (tool: DialogTool): ToolsAction => ({ type: 'close', tool })
const closeAll: ToolsAction = { type: 'closeAll' }
const back: ToolsAction = { type: 'back' }
const launch: ToolsAction = { type: 'launch' }

describe('the tools a dialog has (И6)', () => {
  it('offers a chat with a browser the browser, ended or not', () => {
    expect(dialogToolsOf(browserAnswer())).toEqual(['browser'])
    expect(dialogToolsOf(browserAnswer({ status: 'done' }))).toEqual(['browser'])
  })

  it('offers a chat with neither nothing at all', () => {
    const neither = { requirements: { repository: false, browser: false } }
    expect(dialogToolsOf(feedAnswer({ task: neither }))).toEqual([])
    expect(dialogToolsOf(feedAnswer({ task: neither, status: 'done' }))).toEqual([])
  })
})

describe('the marks of the tiles (И5)', () => {
  it('says «пока нет» of a browser the agent has not needed yet (plan 61, К11)', () => {
    const none = browserAnswer({ browser: null })
    expect(dialogToolsOf(none)).toEqual(['browser'])
    expect(toolMark('browser', none, closed)).toBe('пока нет')
    expect(
      toolMark('browser', browserAnswer({ status: 'awaiting_user', browser: null }), closed),
    ).toBe('пока нет')
    // The dialog ended without one: there will be none.
    expect(toolMark('browser', browserAnswer({ status: 'done', browser: null }), closed)).toBe(
      'нет',
    )
  })

  it('says who drives the browser while its session holds one', () => {
    expect(toolMark('browser', browserAnswer(), closed)).toBe('Работает агент')
    expect(toolMark('browser', browserAnswer({ browser: { status: 'starting' } }), closed)).toBe(
      'Работает агент',
    )
    const help = { reason: 'login' as const, message: null }
    expect(toolMark('browser', browserAnswer({ browser: { help } }), closed)).toBe('Ждём вас')
    expect(
      toolMark('browser', browserAnswer({ status: 'awaiting_user', browser: { help } }), closed),
    ).toBe('Ждём вас')
    expect(toolMark('browser', browserAnswer({ browser: { controller: 'user' } }), closed)).toBe(
      'Управляете вы',
    )
    // The client took the control the agent asked for: the client drives.
    expect(
      toolMark('browser', browserAnswer({ browser: { controller: 'user', help } }), closed),
    ).toBe('Управляете вы')
  })

  it('never says the agent works in a browser while the chat waits for its release (К10)', () => {
    const both = { requirements: { repository: true, browser: true } }
    for (const status of ['awaiting_approval', 'deploying', 'verifying'] as const) {
      const head = browserAnswer({ task: both, status })
      expect(toolMark('browser', head, closed)).toBe('Агент ответил')
      // The client still drives it, and a request for help still waits.
      expect(
        toolMark('browser', browserAnswer({ status, browser: { controller: 'user' } }), closed),
      ).toBe('Управляете вы')
      const help = { reason: 'login' as const, message: null }
      expect(toolMark('browser', browserAnswer({ status, browser: { help } }), closed)).toBe(
        'Ждём вас',
      )
    }
  })

  it('says of a chat that waits what its panel says, never that the agent works (К10)', () => {
    const waits = browserAnswer({ status: 'awaiting_user' })
    expect(toolMark('browser', waits, { ...closed, answered: true })).toBe('Агент ответил')
    expect(toolMark('browser', waits, closed)).toBe('Ждём вас')
    expect(toolTilesOf(waits, closedTools, { answered: true })).toEqual([
      { tool: 'browser', open: false, mark: 'Агент ответил' },
    ])
    expect(toolMark('browser', waits, { ...closed, answered: true, rewound: true })).toBe(
      'Запрос отменён',
    )
    expect(toolTilesOf(waits, closedTools, { answered: true, rewound: true })).toEqual([
      { tool: 'browser', open: false, mark: 'Запрос отменён' },
    ])
    // A request for help outweighs an answer: the panel asks for the same.
    const help = { reason: 'login' as const, message: null }
    const asks = browserAnswer({ status: 'awaiting_user', browser: { help } })
    expect(toolMark('browser', asks, { ...closed, answered: true })).toBe('Ждём вас')
  })

  it('says «пока нет» while a dialog at work has no session yet', () => {
    expect(toolMark('browser', browserAnswer({ browser: null }), closed)).toBe('пока нет')
    expect(
      toolMark('browser', browserAnswer({ status: 'awaiting_user', browser: null }), closed),
    ).toBe('пока нет')
  })

  it('says «Закрыт» when the session holds no browser any more', () => {
    for (const status of ['closed', 'failed', 'lost'] as const)
      expect(toolMark('browser', browserAnswer({ browser: { status } }), closed)).toBe('Закрыт')
    expect(
      toolMark(
        'browser',
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
  it('names the two tools of a chat on their tabs and in the menu, with ids the stands find', () => {
    expect(dialogTools).toEqual(['browser', 'documents'])
    expect(toolTabNames).toMatchObject({ browser: 'Браузер', documents: 'Документы' })
    expect(toolMenuNames).toMatchObject({ browser: 'Браузер', documents: 'Документы' })
    expect(toolIcons).toEqual({ browser: 'globe', documents: 'document' })
    expect(toolTabId('browser')).toBe('dialog-pane-tab-browser')
    expect(toolPanelId('documents')).toBe('dialog-pane-panel-documents')
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
    const both = after(open('browser'), open('documents'), open('browser'))
    expect(both).toMatchObject({ open: ['browser', 'documents'], active: 'browser' })
    expect(toolsReducer(both, close('browser'))).toMatchObject({
      open: ['documents'],
      active: 'documents',
    })
    expect(toolsShown(after(open('documents'), closeAll))).toBe(false)
  })
})

describe("«К чату» below `lg` (И14, owner's answer of 30.10.2026)", () => {
  it('closes the tab on the screen and keeps the others behind the dialog', () => {
    const state = after(open('browser'), open('documents'), back)
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
    ...dialogTools.map((tool) => open(tool)),
    ...dialogTools.map((tool): ToolsAction => ({ type: 'show', tool })),
    ...dialogTools.map((tool) => close(tool)),
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

describe('the documents of the agent (docs/plan/67-agent-documents.md, Д4)', () => {
  const arrived = (opens = true): ToolsAction => ({ type: 'documentArrived', opens })

  it('are a tool of any chat once there is a document, with their number on the tile', () => {
    expect(dialogToolsOf(browserAnswer())).not.toContain('documents')
    expect(dialogToolsOf(browserAnswer(), 3)).toEqual(['browser', 'documents'])
    expect(toolMark('documents', browserAnswer(), { open: false, documents: 3 })).toBe('3')
    expect(toolIcons.documents).toBe('document')
  })

  it('join a panel on the screen beside the tool the client reads, without the focus', () => {
    const reading = after(launch)
    expect(toolsReducer(reading, arrived())).toMatchObject({
      open: ['browser', 'documents'],
      active: 'browser',
    })
  })
})
