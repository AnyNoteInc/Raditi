import { taskStatuses, terminalTaskStatuses } from '@repo/domain/tasks/task-status'
import { describe, expect, it } from 'vitest'

import type { CandidateHead, PreviewHead } from './chat-types'
import {
  candidateCount,
  changesEmptyText,
  changesMark,
  changesToolOf,
  closedTools,
  dialogEnded,
  dialogTools,
  dialogToolsOf,
  isChangesTool,
  movesFocus,
  toolIcons,
  toolMark,
  toolMenuNames,
  toolOpeners,
  toolPanelId,
  toolsDot,
  toolsLabel,
  toolsReducer,
  toolTabId,
  toolTabNames,
  toolTilesOf,
  type DialogTool,
  type ToolsAction,
  type ToolsState,
} from './dialog-tools'
import { browserAnswer, CANDIDATE_ID, candidateHead, feedAnswer } from './testing'

const ORIGIN = 'http://site-0a1b2c3d-chat-4e5f6a.localhost:8090'

function previewOf(patch: Partial<PreviewHead> = {}): PreviewHead {
  return {
    status: 'ready',
    unavailableReason: null,
    origin: ORIGIN,
    revision: 1,
    dirty: false,
    ...patch,
  }
}

const candidateOf = (patch: Partial<CandidateHead> = {}): CandidateHead => ({
  ...candidateHead,
  ...patch,
})

const noChecks = { pending: 0, passed: 0, failed: 0, stale: 0 }
/** The changes touch the records of the site alone. */
const recordsOnly = candidateOf({
  counts: { files: { added: 0, modified: 0, deleted: 0 }, media: 0, records: 3 },
  checks: noChecks,
})

const closed = { open: false }
const opened = { open: true }

/** The state after the actions, from a closed panel. */
const after = (...actions: ToolsAction[]): ToolsState => actions.reduce(toolsReducer, closedTools)

const open = (tool: DialogTool): ToolsAction => ({ type: 'open', tool, by: 'menu' })
const close = (tool: DialogTool): ToolsAction => ({ type: 'close', tool })
const closeAll: ToolsAction = { type: 'closeAll' }
const launch = (wide: boolean): ToolsAction => ({ type: 'launch', wide })

describe('the tools a dialog has (И6)', () => {
  it('lists them in the order of the menu, and names every opener of И9', () => {
    expect(dialogTools).toEqual(['browser', 'preview', 'files', 'database', 'checks'])
    expect(toolOpeners).toEqual(['menu', 'changes', 'command', 'card', 'take', 'watch', 'launch'])
  })

  it('offers a task in the browser its browser alone, whatever the state of its session, ended too', () => {
    expect(dialogToolsOf(browserAnswer())).toEqual(['browser'])
    // Before the first pass opened a session, and after it closed.
    expect(dialogToolsOf(browserAnswer({ browser: null }))).toEqual(['browser'])
    expect(
      dialogToolsOf(browserAnswer({ browser: { status: 'closed', closeReason: 'idle' } })),
    ).toEqual(['browser'])
    expect(
      dialogToolsOf(
        browserAnswer({ status: 'done', browser: { status: 'closed', closeReason: 'task_done' } }),
      ),
    ).toEqual(['browser'])
    expect(dialogToolsOf(browserAnswer({ status: 'cancelled', browser: null }))).toEqual([
      'browser',
    ])
    // What a head of the repository would offer is not the browser's: the requirements decide.
    expect(
      dialogToolsOf(
        browserAnswer({
          preview: previewOf(),
          candidate: candidateHead,
          task: { databaseChanges: true },
        }),
      ),
    ).toEqual(['browser'])
  })

  it('offers a task with the repository its files and checks always, before the changes too', () => {
    expect(dialogToolsOf(feedAnswer())).toEqual(['files', 'checks'])
    expect(dialogToolsOf(feedAnswer({ status: 'running' }))).toEqual(['files', 'checks'])
    expect(dialogToolsOf(feedAnswer({ status: 'done' }))).toEqual(['files', 'checks'])
    expect(dialogToolsOf(feedAnswer({ candidate: candidateHead }))).toEqual(['files', 'checks'])
  })

  it('offers the preview while one can be shown: made, ready, stopped or failed', () => {
    for (const status of ['pending', 'building', 'ready', 'failed', 'expired'] as const)
      expect(dialogToolsOf(feedAnswer({ preview: previewOf({ status }) }))).toEqual([
        'preview',
        'files',
        'checks',
      ])
  })

  it('offers no preview where the platform makes none, where it cannot be shown or is gone', () => {
    // No preview of the dialog at all.
    expect(dialogToolsOf(feedAnswer({ preview: null }))).toEqual(['files', 'checks'])
    // The platform has no address of previews (`PREVIEW_BASE_DOMAIN` is empty).
    expect(dialogToolsOf(feedAnswer({ preview: previewOf({ origin: null }) }))).toEqual([
      'files',
      'checks',
    ])
    expect(
      dialogToolsOf(
        feedAnswer({
          preview: previewOf({ status: 'unavailable', unavailableReason: 'no_database' }),
        }),
      ),
    ).toEqual(['files', 'checks'])
    expect(
      dialogToolsOf(feedAnswer({ status: 'done', preview: previewOf({ status: 'destroyed' }) })),
    ).toEqual(['files', 'checks'])
  })

  it('offers the records only when the server says the dialog can change the database', () => {
    expect(dialogToolsOf(feedAnswer({ task: { databaseChanges: true } }))).toEqual([
      'files',
      'database',
      'checks',
    ])
    expect(
      dialogToolsOf(feedAnswer({ preview: previewOf(), task: { databaseChanges: true } })),
    ).toEqual(['preview', 'files', 'database', 'checks'])
    // The records of a candidate are the server's to weigh: without its word, no tool.
    expect(dialogToolsOf(feedAnswer({ candidate: recordsOnly }))).toEqual(['files', 'checks'])
  })
})

describe('the marks of the tiles (И5)', () => {
  const ready = feedAnswer({
    status: 'awaiting_approval',
    preview: previewOf(),
    candidate: candidateHead,
    task: { databaseChanges: true },
  })

  it('counts the files with the media, the records, and the checks passed of all', () => {
    // One file added and two changed, a medium besides; three records; two checks, both passed.
    expect(toolMark('files', ready, closed)).toBe('4')
    expect(toolMark('database', ready, closed)).toBe('3')
    expect(toolMark('checks', ready, closed)).toBe('2 из 2')
    const checks = { pending: 1, passed: 1, failed: 1, stale: 1 }
    expect(toolMark('checks', feedAnswer({ candidate: candidateOf({ checks }) }), closed)).toBe(
      '1 из 4',
    )
    expect(
      toolMark(
        'checks',
        feedAnswer({ candidate: candidateOf({ checks: { ...noChecks, pending: 2 } }) }),
        closed,
      ),
    ).toBe('0 из 2')
  })

  it('gives the preview no mark', () => {
    expect(toolMark('preview', ready, closed)).toBeNull()
    expect(
      toolMark('preview', feedAnswer({ preview: previewOf({ status: 'building' }) }), closed),
    ).toBeNull()
  })

  it('says «пока нет» while the changes have nothing for a tool', () => {
    const working = feedAnswer({ status: 'running', task: { databaseChanges: true } })
    for (const tool of ['files', 'database', 'checks'] as const)
      expect(toolMark(tool, working, closed)).toBe('пока нет')
    // The changes are there, but not of every kind: the agent may still make the rest.
    const waiting = feedAnswer({ status: 'awaiting_approval', candidate: recordsOnly })
    expect(toolMark('files', waiting, closed)).toBe('пока нет')
    expect(toolMark('checks', waiting, closed)).toBe('пока нет')
    expect(toolMark('database', waiting, closed)).toBe('3')
    // Changes the platform could not count: their checks still are.
    const uncounted = feedAnswer({ candidate: candidateOf({ counts: null }) })
    expect(toolMark('files', uncounted, closed)).toBe('пока нет')
    expect(toolMark('database', uncounted, closed)).toBe('пока нет')
    expect(toolMark('checks', uncounted, closed)).toBe('2 из 2')
  })

  it('says «нет» once the dialog has ended without them', () => {
    for (const status of terminalTaskStatuses) {
      const ended = feedAnswer({ status, task: { databaseChanges: true } })
      for (const tool of ['files', 'database', 'checks'] as const)
        expect(toolMark(tool, ended, closed)).toBe('нет')
    }
    // A dialog stopped with its changes: what they hold is counted, the rest will not come.
    const cancelled = feedAnswer({
      status: 'cancelled',
      candidate: recordsOnly,
      task: { databaseChanges: true },
    })
    expect(toolMark('database', cancelled, closed)).toBe('3')
    expect(toolMark('files', cancelled, closed)).toBe('нет')
  })

  it('says «Открыто» for an open tool, whatever it holds', () => {
    for (const tool of ['preview', 'files', 'database', 'checks'] as const)
      expect(toolMark(tool, ready, opened)).toBe('Открыто')
    expect(toolMark('files', feedAnswer(), opened)).toBe('Открыто')
    expect(toolMark('browser', browserAnswer(), opened)).toBe('Открыто')
    expect(toolMark('browser', browserAnswer({ browser: null }), opened)).toBe('Открыто')
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

  it('says «пока нет» while a dialog at work has no session yet', () => {
    expect(toolMark('browser', browserAnswer({ browser: null }), closed)).toBe('пока нет')
    expect(
      toolMark('browser', browserAnswer({ status: 'awaiting_user', browser: null }), closed),
    ).toBe('пока нет')
  })

  it('says «Закрыт» when the session holds no browser any more, or the dialog ended without one', () => {
    expect(toolMark('browser', browserAnswer({ status: 'done', browser: null }), closed)).toBe(
      'Закрыт',
    )
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

  it('lays the tiles of the menu in its order, the open tools marked «Открыто»', () => {
    const tools = after(open('checks'), open('preview'))
    expect(toolTilesOf(ready, tools)).toEqual([
      { tool: 'preview', open: true, mark: 'Открыто' },
      { tool: 'files', open: false, mark: '4' },
      { tool: 'database', open: false, mark: '3' },
      { tool: 'checks', open: true, mark: 'Открыто' },
    ])
    expect(toolTilesOf(browserAnswer({ browser: null }), closedTools)).toEqual([
      { tool: 'browser', open: false, mark: 'пока нет' },
    ])
  })

  it('counts what a tool of the changes holds', () => {
    expect(candidateCount('files', null)).toBe(0)
    expect(candidateCount('files', candidateHead)).toBe(4)
    expect(candidateCount('database', candidateHead)).toBe(3)
    expect(candidateCount('checks', candidateHead)).toBe(2)
    const media = candidateOf({
      counts: { files: { added: 0, modified: 0, deleted: 1 }, media: 2, records: 0 },
    })
    expect(candidateCount('files', media)).toBe(3)
    expect(candidateCount('database', candidateOf({ counts: null }))).toBe(0)
  })
})

describe('«Посмотреть изменения» (И10)', () => {
  it('opens the first of the files, the records and the checks that holds anything', () => {
    expect(
      changesToolOf(feedAnswer({ candidate: candidateHead, task: { databaseChanges: true } })),
    ).toBe('files')
    // Only a medium is new: it is among the files.
    const media = candidateOf({
      counts: { files: { added: 0, modified: 0, deleted: 0 }, media: 1, records: 2 },
    })
    expect(changesToolOf(feedAnswer({ candidate: media, task: { databaseChanges: true } }))).toBe(
      'files',
    )
    expect(
      changesToolOf(feedAnswer({ candidate: recordsOnly, task: { databaseChanges: true } })),
    ).toBe('database')
    const checksOnly = candidateOf({
      counts: { files: { added: 0, modified: 0, deleted: 0 }, media: 0, records: 0 },
      checks: { ...noChecks, failed: 1 },
    })
    expect(changesToolOf(feedAnswer({ candidate: checksOnly }))).toBe('checks')
  })

  it('opens no tool the menu does not offer', () => {
    // The records without the server's word: the checks, else the files.
    expect(
      changesToolOf(
        feedAnswer({
          candidate: candidateOf({ ...recordsOnly, checks: { ...noChecks, passed: 1 } }),
        }),
      ),
    ).toBe('checks')
    expect(changesToolOf(feedAnswer({ candidate: recordsOnly }))).toBe('files')
  })

  it('opens the files, with what they say before the changes, when nothing holds anything', () => {
    expect(changesToolOf(feedAnswer())).toBe('files')
    expect(changesToolOf(feedAnswer({ status: 'done', task: { databaseChanges: true } }))).toBe(
      'files',
    )
    expect(
      changesToolOf(feedAnswer({ candidate: candidateOf({ counts: null, checks: noChecks }) })),
    ).toBe('files')
  })
})

describe('the empty tabs of the changes (И6)', () => {
  it('says the changes are yet to come', () => {
    const working = { ended: false, candidate: null }
    expect(changesEmptyText('files', working)).toEqual({
      title: 'Изменений пока нет.',
      note: 'Они появятся здесь, когда агент закончит работу.',
    })
    expect(changesEmptyText('database', working)).toEqual({
      title: 'Изменений в базе данных пока нет.',
      note: null,
    })
    expect(changesEmptyText('checks', working)).toEqual({ title: 'Проверок пока нет.', note: null })
  })

  it('says a dialog that has ended has none, and where the released versions are', () => {
    const ended = { ended: true, candidate: null }
    expect(changesEmptyText('files', ended)).toEqual({
      title: 'Диалог закрыт: изменений для показа здесь нет.',
      note: 'Выпущенные версии — в разделе «Изменения».',
    })
    expect(changesEmptyText('database', ended)).toEqual({
      title: 'Диалог закрыт: изменений в базе данных нет.',
      note: null,
    })
    expect(changesEmptyText('checks', ended)).toEqual({
      title: 'Диалог закрыт: проверок нет.',
      note: null,
    })
  })

  it('says nothing in place of the changes once they are there', () => {
    for (const ended of [false, true])
      for (const tool of ['files', 'database', 'checks'] as const)
        expect(changesEmptyText(tool, { ended, candidate: candidateHead })).toBeNull()
  })

  it('takes a dialog as ended by the statuses that end a task', () => {
    for (const status of taskStatuses)
      expect(dialogEnded(feedAnswer({ status }))).toBe(terminalTaskStatuses.includes(status))
  })
})

describe('the names, icons and ids of the tools', () => {
  it('names the files with their changes in the menu, and shortly on their tab (И7)', () => {
    expect(toolMenuNames).toEqual({
      browser: 'Браузер',
      preview: 'Предпросмотр',
      files: 'Файлы и изменения',
      database: 'База данных',
      checks: 'Проверки',
    })
    expect(toolTabNames).toEqual({ ...toolMenuNames, files: 'Файлы' })
    expect(Object.keys(toolIcons)).toEqual([...dialogTools])
  })

  it('keeps the ids of the tabs and panels the stands find, the browser among them (И20)', () => {
    expect(dialogTools.map(toolTabId)).toEqual([
      'dialog-pane-tab-browser',
      'dialog-pane-tab-preview',
      'dialog-pane-tab-files',
      'dialog-pane-tab-database',
      'dialog-pane-tab-checks',
    ])
    expect(toolPanelId('preview')).toBe('dialog-pane-panel-preview')
    expect(toolPanelId('browser')).toBe('dialog-pane-panel-browser')
  })

  it('puts the focus on the tab after an explicit opening, but for «Взять управление» and the launch (И9)', () => {
    expect(toolOpeners.filter((by) => movesFocus(by))).toEqual([
      'menu',
      'changes',
      'command',
      'card',
      'watch',
    ])
  })

  it('puts it there for «Взять управление» too where the tool hides the dialog it was pressed in (И14)', () => {
    expect(toolOpeners.filter((by) => movesFocus(by, { covers: true }))).toEqual([
      'menu',
      'changes',
      'command',
      'card',
      'take',
      'watch',
    ])
  })

  it('tells the tools of the changes from the browser and the preview', () => {
    expect(dialogTools.filter(isChangesTool)).toEqual(['files', 'database', 'checks'])
    expect(isChangesTool(null)).toBe(false)
  })
})

describe('the tabs of the open tools', () => {
  it('starts every showing of a dialog with the panel closed (И1)', () => {
    expect(closedTools).toEqual({
      open: [],
      active: null,
      launchSpent: false,
      launchUnseen: false,
      seenChanges: null,
    })
    expect(Object.isFrozen(closedTools)).toBe(true)
  })

  it('opens a tool as the last tab and shows it', () => {
    const files = after(open('files'))
    expect(files.open).toEqual(['files'])
    expect(files.active).toBe('files')
    const both = toolsReducer(files, { type: 'open', tool: 'preview', by: 'command' })
    expect(both.open).toEqual(['files', 'preview'])
    expect(both.active).toBe('preview')
  })

  it('shows a tool chosen again without a second tab', () => {
    const state = after(open('preview'), open('files'), open('checks'))
    const again = toolsReducer(state, { type: 'open', tool: 'files', by: 'changes' })
    expect(again.open).toEqual(['preview', 'files', 'checks'])
    expect(again.active).toBe('files')
    // The tab on the screen chosen again: nothing changes.
    expect(toolsReducer(again, open('files'))).toBe(again)
  })

  it('closes the tab on the screen: the one on its right is shown, else the one on its left', () => {
    const three = after(open('preview'), open('files'), open('checks'), open('files'))
    const right = toolsReducer(three, close('files'))
    expect(right.open).toEqual(['preview', 'checks'])
    expect(right.active).toBe('checks')
    const left = toolsReducer(right, close('checks'))
    expect(left.open).toEqual(['preview'])
    expect(left.active).toBe('preview')
  })

  it('shows a tab chosen on the strip, and opens nothing by it', () => {
    const state = after(open('preview'), open('files'))
    const chosen = toolsReducer(state, { type: 'show', tool: 'preview' })
    expect(chosen.open).toEqual(['preview', 'files'])
    expect(chosen.active).toBe('preview')
    expect(toolsReducer(chosen, { type: 'show', tool: 'preview' })).toBe(chosen)
    // A tab that is not there: nothing opens, whatever the strip was asked.
    expect(toolsReducer(state, { type: 'show', tool: 'checks' })).toBe(state)
    expect(toolsReducer(closedTools, { type: 'show', tool: 'browser' })).toBe(closedTools)
  })

  it('closes the panel with its last tab', () => {
    const state = toolsReducer(after(open('files')), close('files'))
    expect(state.open).toEqual([])
    expect(state.active).toBeNull()
  })

  it('closes a tab in the background without moving the one on the screen', () => {
    const state = toolsReducer(
      after(open('preview'), open('files'), open('checks')),
      close('files'),
    )
    expect(state.open).toEqual(['preview', 'checks'])
    expect(state.active).toBe('checks')
  })

  it('closes every tab at once', () => {
    const state = toolsReducer(after(open('preview'), open('files')), closeAll)
    expect(state.open).toEqual([])
    expect(state.active).toBeNull()
  })

  it('changes nothing by closing what is not open', () => {
    const state = after(open('files'))
    expect(toolsReducer(state, close('database'))).toBe(state)
    expect(toolsReducer(closedTools, close('browser'))).toBe(closedTools)
    expect(toolsReducer(closedTools, closeAll)).toBe(closedTools)
  })

  it('remembers the changes a tab of them was on the screen at (И13)', () => {
    const mark = changesMark(candidateHead)!
    expect(mark).toBe(`${CANDIDATE_ID}:1`)
    expect(changesMark(null)).toBeNull()
    const seen = toolsReducer(after(open('files')), { type: 'seen', changes: mark })
    expect(seen.seenChanges).toBe(mark)
    expect(toolsReducer(seen, { type: 'seen', changes: mark })).toBe(seen)
    // Closing the panel keeps what was seen.
    expect(toolsReducer(seen, closeAll).seenChanges).toBe(mark)
  })
})

describe('the launch of the browser (И2, И3)', () => {
  it('opens the browser by itself once on a wide screen', () => {
    const launched = after(launch(true))
    expect(launched).toEqual({
      open: ['browser'],
      active: 'browser',
      launchSpent: true,
      launchUnseen: false,
      seenChanges: null,
    })
    expect(toolsReducer(launched, launch(true))).toBe(launched)
    expect(toolsReducer(launched, launch(false))).toBe(launched)
  })

  it('only marks «+» on a narrow screen, and once', () => {
    const launched = after(launch(false))
    expect(launched.open).toEqual([])
    expect(launched.active).toBeNull()
    expect(launched.launchSpent).toBe(true)
    expect(launched.launchUnseen).toBe(true)
    // The screen grew wide after: the launch has been spent.
    expect(toolsReducer(launched, launch(true))).toBe(launched)
  })

  it('opens nothing after the client closed the browser', () => {
    const state = after(open('browser'), close('browser'))
    expect(state.launchSpent).toBe(true)
    expect(toolsReducer(state, launch(true))).toBe(state)
    // The browser it opened itself, closed: not again.
    const again = after(launch(true), close('browser'))
    expect(toolsReducer(again, launch(true))).toBe(again)
  })

  it('opens nothing after the client closed the panel', () => {
    const hidden = after(open('browser'), closeAll)
    expect(hidden.launchSpent).toBe(true)
    expect(toolsReducer(hidden, launch(true))).toBe(hidden)
    // The last tab closed is the panel closed, whichever tool it was.
    const lastTab = after(open('files'), close('files'))
    expect(lastTab.launchSpent).toBe(true)
    expect(toolsReducer(lastTab, launch(true))).toBe(lastTab)
  })

  it('leaves the launch for the browser while the client closes another tab', () => {
    const state = after(open('preview'), open('files'), close('files'))
    expect(state.launchSpent).toBe(false)
  })

  it('shows the browser the client opened before it was ready, and spends the launch on it', () => {
    const early = after({ type: 'open', tool: 'browser', by: 'card' })
    const launched = toolsReducer(early, launch(true))
    expect(launched.open).toEqual(['browser'])
    expect(launched.active).toBe('browser')
    expect(launched.launchSpent).toBe(true)
    // On a narrow screen the browser on the screen is seen: no dot for it.
    const narrow = toolsReducer(early, launch(false))
    expect(narrow.launchSpent).toBe(true)
    expect(narrow.launchUnseen).toBe(false)
  })

  it('takes the mark of a narrow launch off once the client opens the browser', () => {
    const launched = after(launch(false))
    const watched = toolsReducer(launched, { type: 'open', tool: 'browser', by: 'watch' })
    expect(watched.launchUnseen).toBe(false)
    expect(watched.open).toEqual(['browser'])
    expect(watched.active).toBe('browser')
    // Another tool is not the browser: the mark stays.
    expect(toolsReducer(launched, open('files')).launchUnseen).toBe(true)
  })

  it('takes it off when the client chooses the tab of the browser it had in the background', () => {
    // The browser's tab was open behind another one when the task's browser started.
    const behind = after(open('browser'), open('files'), launch(false))
    expect(behind.launchUnseen).toBe(true)
    const chosen = toolsReducer(behind, { type: 'show', tool: 'browser' })
    expect(chosen.active).toBe('browser')
    expect(chosen.launchUnseen).toBe(false)
  })
})

describe('the dot on «+» (И13)', () => {
  const help = { reason: 'login' as const, message: null }
  const changes = feedAnswer({ status: 'awaiting_approval', candidate: candidateHead })

  it('marks the changes the client has not had on the screen, those there at the start too', () => {
    expect(toolsDot(changes, closedTools)).toBe('changes')
    // Never while the panel is open, whatever tab is on it.
    expect(toolsDot(changes, after(open('preview')))).toBeNull()
    const seen = after(open('files'), { type: 'seen', changes: changesMark(candidateHead)! })
    const hidden = toolsReducer(seen, closeAll)
    expect(toolsDot(changes, hidden)).toBeNull()
    // A new revision: the dot again, and the panel stays closed.
    const revised = feedAnswer({ candidate: candidateOf({ revision: 2 }) })
    expect(toolsDot(revised, hidden)).toBe('changes')
    expect(hidden.active).toBeNull()
    expect(toolsDot(feedAnswer(), closedTools)).toBeNull()
  })

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

  it('marks a browser launched on a narrow screen until the client opens it', () => {
    const launched = after(launch(false))
    expect(toolsDot(browserAnswer(), launched)).toBe('launch')
    const watched = toolsReducer(launched, { type: 'open', tool: 'browser', by: 'watch' })
    expect(toolsDot(browserAnswer(), toolsReducer(watched, closeAll))).toBeNull()
    // The browser that opened by itself on a wide screen was on the screen: no dot once closed.
    expect(toolsDot(browserAnswer(), after(launch(true), close('browser')))).toBeNull()
  })

  it('takes the mark of the launch off once the browser it marked has closed', () => {
    const launched = after(launch(false))
    expect(
      toolsDot(browserAnswer({ browser: { status: 'closed', closeReason: 'idle' } }), launched),
    ).toBeNull()
    expect(toolsDot(browserAnswer({ browser: null }), launched)).toBeNull()
    // Starting again, it is news again: the client has not seen it since.
    expect(toolsDot(browserAnswer({ browser: { status: 'starting' } }), launched)).toBe('launch')
  })

  it('says the most pressing first', () => {
    const launched = after(launch(false))
    expect(toolsDot(browserAnswer({ browser: { help }, candidate: candidateHead }), launched)).toBe(
      'browser',
    )
    expect(toolsDot(browserAnswer({ candidate: candidateHead }), launched)).toBe('launch')
  })

  it('names «+» with what its dot says', () => {
    expect(toolsLabel(null)).toBe('Инструменты')
    expect(toolsLabel('browser')).toBe('Инструменты — браузер ждёт вас')
    expect(toolsLabel('launch')).toBe('Инструменты — браузер запущен')
    expect(toolsLabel('changes')).toBe('Инструменты — есть новые изменения')
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
    launch(true),
    launch(false),
    { type: 'seen', changes: `${CANDIDATE_ID}:1` },
    { type: 'seen', changes: `${CANDIDATE_ID}:2` },
  ]

  it('keeps one tab per tool, a tab on the screen exactly while one is open, and one launch', () => {
    // Showings in which the browser opened by itself or marked «+»: the runs reach a launch.
    let launched = 0
    for (const seed of [1, 7, 42, 2026, 31_337, 99_991]) {
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
        if (before.launchSpent) expect(reduced.launchSpent).toBe(true)
        if (action.type === 'open') expect(reduced.active).toBe(action.tool)
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
