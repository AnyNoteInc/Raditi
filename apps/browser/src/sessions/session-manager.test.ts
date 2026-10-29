import { randomUUID } from 'node:crypto'

import {
  attachmentKey,
  isDomainError,
  PageBrowserError,
  type BrowserClientMessage,
  type BrowserCloseReason,
  type BrowserSessionState,
  type BrowserStreamRefusal,
  type BrowserVerifiedObject,
} from '@repo/domain'
import { getSiteAdapter } from '@repo/site-adapters'
import { afterEach, describe, expect, it } from 'vitest'

import { AttachmentFiles } from '../attachments/attachments.ts'
import { TaskScreenshots } from '../attachments/screenshots.ts'
import { SessionManager, sessionTimingDefaults } from './session-manager.ts'
import { countingMetrics, FakeBrowsers, FakeInbox, FakeStore } from '../testing/fakes.ts'
import { sessionHarness, TEST_SITE as SITE } from '../testing/harness.ts'
import type { EncodedFrame, SessionViewer } from './worker-session.ts'

const EDIT_12 = `${SITE}/wp-admin/post.php?post=12&action=edit`
const NEW_POST = `${SITE}/wp-admin/post-new.php`

const postRef = (id: string) => ({
  kind: 'post' as const,
  objectId: id,
  editUrl: `${SITE}/wp-admin/post.php?post=${id}&action=edit`,
})
const postObject = (id: string): BrowserVerifiedObject => ({
  kind: 'post',
  objectId: id,
  title: 'Новость',
  status: 'publish',
  url: `${SITE}/?p=${id}`,
  editUrl: postRef(id).editUrl,
  images: 0,
  files: 0,
  featuredImage: false,
})

class ViewerProbe implements SessionViewer {
  readonly id = randomUUID()
  readonly userId = randomUUID()
  readonly states: BrowserSessionState[] = []
  readonly frames: EncodedFrame[] = []
  readonly refusals: BrowserStreamRefusal[] = []
  ended: BrowserCloseReason | null = null

  state(state: BrowserSessionState): void {
    this.states.push(state)
  }

  frame(frame: EncodedFrame): void {
    this.frames.push(frame)
  }

  refused(reason: BrowserStreamRefusal): void {
    this.refusals.push(reason)
  }

  closed(reason: BrowserCloseReason): void {
    this.ended = reason
  }

  get last(): BrowserSessionState {
    const state = this.states.at(-1)
    if (!state) throw new Error('no state')
    return state
  }
}

/** Lets the chains of a session (writes, input, actions) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    if (isDomainError(error)) return error.code
    throw error
  }
  throw new Error('expected a refusal')
}

const managers: SessionManager[] = []

function setup(settings: Parameters<typeof sessionHarness>[0] = {}) {
  const harness = sessionHarness(settings)
  managers.push(harness.manager)
  return harness
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown()
})

describe('SessionManager.ensure', () => {
  it('starts the containers for the site’s hosts and opens the stack’s start page once', async () => {
    const { runtime, browsers, store, manager, ensured } = setup()
    const { row, state, browser } = await ensured()
    expect(runtime.started).toEqual([
      expect.objectContaining({
        sessionId: row.id,
        taskId: row.taskId,
        siteId: row.siteId,
        allowedHosts: ['news-site.ru:443', 'www.news-site.ru:443'],
        localSites: [],
      }),
    ])
    // Б31: the list of posts, never the dashboard with its commenters' names.
    expect(browser.connection.startUrl).toBe(`${SITE}/wp-admin/edit.php`)
    expect(store.sessions.get(row.id)?.status).toBe('ready')
    expect(state).toMatchObject({
      session: row.id,
      status: 'ready',
      controller: 'agent',
      controlEpoch: 0,
      pageId: 1,
      viewportVersion: 1,
      viewport: { width: 1280, height: 800 },
      url: `${SITE}/wp-admin/edit.php`,
    })
    // The same session again: nothing new is started.
    const again = await manager.ensure({
      sessionId: row.id,
      taskId: row.taskId,
      siteId: row.siteId,
      takeControl: false,
    })
    expect(again.session).toBe(row.id)
    // The same ids spelled in capitals are the same session, never one an earlier process held.
    await manager.ensure({
      sessionId: row.id.toUpperCase(),
      taskId: row.taskId.toUpperCase(),
      siteId: row.siteId.toUpperCase(),
      takeControl: false,
    })
    expect(store.sessions.get(row.id)?.status).toBe('ready')
    expect(runtime.started).toHaveLength(1)
    expect(browsers.opened).toHaveLength(1)
    expect(manager.list().sessions).toEqual([
      { sessionId: row.id, taskId: row.taskId, status: 'ready' },
    ])
  })

  it('refuses a session it cannot hold, and loses one an earlier process started', async () => {
    const { store, runtime, manager } = setup({ maxSessions: 1 })
    const ensure = (row: ReturnType<FakeStore['open']>, overrides = {}) =>
      manager.ensure({
        sessionId: row.id,
        taskId: row.taskId,
        siteId: row.siteId,
        takeControl: true,
        ...overrides,
      })
    const unknown = { ...store.open(), id: randomUUID() }
    expect(await codeOf(ensure(unknown))).toBe('NOT_FOUND')
    const other = store.open()
    expect(await codeOf(ensure(other, { taskId: randomUUID() }))).toBe('NOT_FOUND')
    // A plain-http site that is not a local site of the stand is out of the browser's reach.
    expect(await codeOf(ensure(store.open({ siteUrl: 'http://news-site.ru' })))).toBe('CONFLICT')

    // Started by a worker before this one: its sign-in is gone with it (Б18).
    const held = store.open({ readyAt: new Date() })
    expect(await codeOf(ensure(held))).toBe('BROWSER_SESSION_UNAVAILABLE')
    expect(store.sessions.get(held.id)).toMatchObject({ status: 'lost', closeReason: 'crashed' })
    expect(runtime.stopped).toContain(held.id)

    await ensure(other)
    expect(await codeOf(ensure(store.open()))).toBe('BROWSER_SESSION_UNAVAILABLE')
  })

  it('takes where the browser goes from the site’s row, never from the caller', async () => {
    const { runtime, browsers, store, manager } = setup()
    const row = store.open({ siteUrl: 'https://www.shop-site.ru/blog' })
    // A caller that sends another address (the API's strict schema refuses it before this).
    const request = {
      sessionId: row.id,
      taskId: row.taskId,
      siteId: row.siteId,
      siteUrl: 'https://evil.example.com',
      takeControl: true,
    } as Parameters<SessionManager['ensure']>[0]
    await manager.ensure(request)
    expect(runtime.started).toEqual([
      expect.objectContaining({ allowedHosts: ['www.shop-site.ru:443', 'shop-site.ru:443'] }),
    ])
    // The stack's start page below the folder of the site's own address.
    expect(browsers.last.connection.startUrl).toBe(
      'https://www.shop-site.ru/blog/wp-admin/edit.php',
    )
    expect(JSON.stringify(runtime.started)).not.toContain('evil.example.com')
    // A site the database does not know has no session, whatever the caller says it is.
    const unknown = store.open()
    store.sites.delete(unknown.siteId)
    expect(
      await codeOf(
        manager.ensure({
          sessionId: unknown.id,
          taskId: unknown.taskId,
          siteId: unknown.siteId,
          takeControl: true,
        }),
      ),
    ).toBe('NOT_FOUND')
  })

  it('marks a session that could not start failed and leaves nothing behind', async () => {
    const { store, runtime, browsers, manager } = setup()
    browsers.failOpen = true
    const row = store.open()
    const code = await codeOf(
      manager.ensure({
        sessionId: row.id,
        taskId: row.taskId,
        siteId: row.siteId,
        takeControl: true,
      }),
    )
    expect(code).toBe('BROWSER_SESSION_UNAVAILABLE')
    expect(store.sessions.get(row.id)).toMatchObject({ status: 'failed', closeReason: 'crashed' })
    expect(runtime.stopped).toEqual([row.id])
    expect(manager.session(row.id)).toBeNull()
  })

  it('answers every session unavailable while its images are not configured', async () => {
    const store = new FakeStore()
    const manager = new SessionManager({
      runtime: null,
      browsers: new FakeBrowsers(),
      store,
      files: new AttachmentFiles(store, new FakeInbox()),
      screenshots: new TaskScreenshots(store, new FakeInbox()),
      adapters: getSiteAdapter,
      metrics: countingMetrics().metrics,
      now: Date.now,
      warn: () => undefined,
      settings: {
        ...sessionTimingDefaults,
        idleMinutes: 30,
        maxHours: 4,
        maxSessions: 4,
        extraHosts: [],
        localSites: [],
        stream: { maxFps: 12, quality: 70 },
      },
    })
    const row = store.open()
    expect(manager.configured).toBe(false)
    expect(
      await codeOf(
        manager.ensure({
          sessionId: row.id,
          taskId: row.taskId,
          siteId: row.siteId,
          takeControl: true,
        }),
      ),
    ).toBe('BROWSER_SESSION_UNAVAILABLE')
  })
})

describe('control of the browser', () => {
  it('moves the epoch on every hand-over and refuses the agent while the client controls', async () => {
    const { store, manager, ensured, act } = setup()
    const { row, session, browser } = await ensured()
    const viewer = new ViewerProbe()
    expect(session.attach(viewer)).toBe(true)

    session.message(viewer, { t: 'take' })
    expect(viewer.last).toMatchObject({
      controller: 'user',
      controlEpoch: 1,
      holder: viewer.id,
      manualReady: true,
    })
    // Б15: the agent's tools are refused while the client controls; it never sees the page.
    expect(await codeOf(act(row, { tool: 'web_observe' }))).toBe('BROWSER_USER_IN_CONTROL')

    // Input of the holder for the page and size it saw, and the epoch it saw.
    const input = (controlEpoch: number): BrowserClientMessage => ({
      t: 'input',
      pageId: 1,
      controlEpoch,
      viewportVersion: 1,
      event: { kind: 'text', text: 'Пароль123' },
    })
    session.message(viewer, input(1))
    await settle()
    expect(browser.inputs).toEqual([{ kind: 'text', text: 'Пароль123' }])
    // Another tab cannot type into the holder's control.
    const other = new ViewerProbe()
    session.attach(other)
    session.message(other, input(1))
    session.message(viewer, input(0))
    await settle()
    expect(other.refusals).toEqual(['not_holder'])
    expect(viewer.refusals).toEqual(['stale_epoch'])
    expect(browser.inputs).toHaveLength(1)

    // «Продолжить работу агента» while a turn runs; then a new turn takes control back.
    session.message(viewer, { t: 'release' })
    expect(viewer.last).toMatchObject({ controller: 'agent', controlEpoch: 2, holder: null })
    session.message(other, { t: 'take' })
    await manager.ensure({
      sessionId: row.id,
      taskId: row.taskId,
      siteId: row.siteId,
      takeControl: true,
    })
    expect(viewer.last).toMatchObject({ controller: 'agent', controlEpoch: 4 })
    await settle()
    expect(store.controls).toEqual([
      { controller: 'user', controlEpoch: 1 },
      { controller: 'agent', controlEpoch: 2 },
      { controller: 'user', controlEpoch: 3 },
      { controller: 'agent', controlEpoch: 4 },
    ])
    // Nothing the client typed reached the database.
    expect(JSON.stringify([...store.sessions.values(), store.controls])).not.toContain('Пароль123')
  })

  it('tells the browser who holds it on every hand-over: the policy judges for them (Б37)', async () => {
    const { manager, ensured } = setup()
    const { row, session, browser } = await ensured()
    const viewer = new ViewerProbe()
    session.attach(viewer)
    session.message(viewer, { t: 'take' })
    session.message(viewer, { t: 'release' })
    session.message(viewer, { t: 'take' })
    await manager.ensure({
      sessionId: row.id,
      taskId: row.taskId,
      siteId: row.siteId,
      takeControl: true,
    })
    // The start tells the browser first: the agent holds a new session.
    expect(browser.controllers).toEqual(['agent', 'user', 'agent', 'user', 'agent'])
  })

  it('lets the client act only once the agent’s running action has settled, or timed out', async () => {
    const { ensured, act } = setup({ agentActionTimeoutMs: 60 })
    const { row, session, browser } = await ensured()
    const viewer = new ViewerProbe()
    session.attach(viewer)
    let finish = () => {}
    browser.onAct = () => new Promise((resolve) => (finish = () => resolve(undefined)))
    await act(row, { tool: 'web_observe' })
    const running = act(row, { tool: 'web_type', text: 'текст' })
    await settle()
    session.message(viewer, { t: 'take' })
    expect(viewer.last).toMatchObject({ controller: 'user', manualReady: false })
    session.message(viewer, {
      t: 'input',
      pageId: 1,
      controlEpoch: 1,
      viewportVersion: 1,
      event: { kind: 'key', type: 'down', key: 'a', code: 'KeyA', modifiers: [] },
    })
    await settle()
    expect(viewer.refusals).toEqual(['not_ready'])
    finish()
    await running
    expect(viewer.last).toMatchObject({ manualReady: true })

    // An action that hangs holds the client back no longer than the agent's action timeout.
    session.message(viewer, { t: 'release' })
    browser.onAct = () => new Promise(() => {})
    void act(row, { tool: 'web_type', text: 'ещё' }).catch(() => undefined)
    await settle()
    session.message(viewer, { t: 'take' })
    expect(viewer.last.manualReady).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(viewer.last.manualReady).toBe(true)
  })

  it('drops the agent’s observation on every hand-over: what the client changed is read anew', async () => {
    const { manager, ensured, act } = setup()
    const { row, session, browser } = await ensured()
    const viewer = new ViewerProbe()
    session.attach(viewer)
    const fill = (observation: string) =>
      act(row, { tool: 'web_fill', observation, ref: 'e6', text: 'Старый заголовок' })
    await act(row, { tool: 'web_observe' })
    // The client corrects the title by hand, without leaving the page, and gives the browser back.
    session.message(viewer, { t: 'take' })
    session.message(viewer, {
      t: 'input',
      pageId: 1,
      controlEpoch: 1,
      viewportVersion: 1,
      event: { kind: 'text', text: 'Исправленный заголовок' },
    })
    await settle()
    session.message(viewer, { t: 'release' })
    expect(await codeOf(fill('o1'))).toBe('BROWSER_STALE_OBSERVATION')
    // Б16: a new turn after a pause takes the browser back the same way.
    await act(row, { tool: 'web_observe' })
    session.message(viewer, { t: 'take' })
    await manager.ensure({
      sessionId: row.id,
      taskId: row.taskId,
      siteId: row.siteId,
      takeControl: true,
    })
    expect(await codeOf(fill('o2'))).toBe('BROWSER_STALE_OBSERVATION')
    // A tree read while the client took the browser is answered, and its references are stale.
    let finish = () => {}
    browser.onObserve = () => new Promise((resolve) => (finish = () => resolve(undefined)))
    const reading = act(row, { tool: 'web_observe' })
    await settle()
    session.message(viewer, { t: 'take' })
    session.message(viewer, { t: 'release' })
    finish()
    expect(await reading).toMatchObject({ observation: 'o3' })
    browser.onObserve = async () => undefined
    expect(await codeOf(fill('o3'))).toBe('BROWSER_STALE_OBSERVATION')
    // Read again: the new tree is the one to act on.
    expect(await act(row, { tool: 'web_observe' })).toMatchObject({ observation: 'o4' })
    expect(await fill('o4')).toMatchObject({ tool: 'web_fill' })
    expect(browser.acted.filter((action) => action.tool === 'web_fill')).toHaveLength(1)
  })

  it('lets go of held keys only after the input already on its way has reached the page', async () => {
    const { ensured } = setup()
    const { session, browser } = await ensured()
    const holder = new ViewerProbe()
    const other = new ViewerProbe()
    session.attach(holder)
    session.attach(other)
    session.message(holder, { t: 'take' })
    // A capital letter: Shift is down, the letter is on its way.
    let finish = () => {}
    browser.onInput = () => new Promise((resolve) => (finish = () => resolve(undefined)))
    session.message(holder, {
      t: 'input',
      pageId: 1,
      controlEpoch: 1,
      viewportVersion: 1,
      event: { kind: 'key', type: 'down', key: 'A', code: 'KeyA', modifiers: ['Shift'] },
    })
    await settle()
    // Another tab takes over: what the first one held is let go — after its key, not before.
    session.message(other, { t: 'take' })
    await settle()
    expect(browser.order).toEqual([])
    finish()
    await settle()
    expect(browser.order).toEqual(['input', 'release'])
    // The chain goes on: the new holder's input reaches the page.
    browser.onInput = async () => undefined
    session.message(other, {
      t: 'input',
      pageId: 1,
      controlEpoch: 2,
      viewportVersion: 1,
      event: { kind: 'text', text: 'б' },
    })
    await settle()
    expect(browser.order).toEqual(['input', 'release', 'input'])
  })

  it('lets go of what a viewer held when it leaves, and keeps the pause', async () => {
    const { ensured } = setup()
    const { session, browser } = await ensured()
    const viewer = new ViewerProbe()
    session.attach(viewer)
    session.message(viewer, { t: 'take' })
    const released = browser.released
    session.detach(viewer.id)
    await settle()
    expect(browser.released).toBe(released + 1)
    expect(session.state()).toMatchObject({ controller: 'user', holder: viewer.id })
  })
})

describe('the agent’s actions', () => {
  it('acts on references of the latest observation only', async () => {
    const { ensured, act } = setup()
    const { row, browser } = await ensured()
    const first = await act(row, { tool: 'web_observe' })
    expect(first).toMatchObject({ tool: 'web_observe', observation: 'o1', controller: 'agent' })
    const second = await act(row, { tool: 'web_observe' })
    expect(second).toMatchObject({ observation: 'o2' })
    const click = (observation: string, ref: string) =>
      act(row, { tool: 'web_click', observation, ref })
    expect(await codeOf(click('o1', 'e7'))).toBe('BROWSER_STALE_OBSERVATION')
    // A reference the tree never had.
    expect(await codeOf(click('o2', 'e99'))).toBe('BROWSER_STALE_OBSERVATION')
    expect(await click('o2', 'e7')).toMatchObject({ tool: 'web_click', page: { pageId: 1 } })
    // The page navigated: the tree it was read from is gone.
    browser.go(`${SITE}/wp-admin/edit.php?paged=2`)
    expect(await codeOf(click('o2', 'e7'))).toBe('BROWSER_STALE_OBSERVATION')
    expect(browser.acted).toHaveLength(1)
    // The worker numbers the observations; the adapter never sees one.
    expect(browser.acted[0]).toEqual({ tool: 'web_click', ref: 'e7' })
  })

  it('gives the agent addresses without their secrets, and keeps them whole for itself', async () => {
    const { store, ensured, act } = setup()
    const { row, browser } = await ensured()
    const raw = `${EDIT_12}&_wpnonce=0a1b2c#top`
    browser.go(raw)
    browser.emit({
      kind: 'tabs',
      tabs: [
        { pageId: 1, url: raw, title: 'Новость' },
        { pageId: 2, url: `${SITE}/wp-login.php?action=rp&key=AbC123&login=admin`, title: '' },
      ],
      shown: 1,
    })
    browser.tree = [
      '- button "Опубликовать" [ref=e5]',
      '- link "В корзину" [ref=e7]:',
      '  - /url: post.php?post=12&action=trash&_wpnonce=0a1b2c',
    ].join('\n')
    await settle()
    const observed = await act(row, { tool: 'web_observe' })
    expect(observed).toMatchObject({
      page: { url: `${EDIT_12}&_wpnonce=[hidden]#[hidden]` },
      tabs: [
        { url: `${EDIT_12}&_wpnonce=[hidden]#[hidden]` },
        { url: `${SITE}/wp-login.php?action=rp&key=[hidden]&login=admin` },
      ],
      // The worker reads the object from the whole address.
      checkpoint: { kind: 'post', objectId: '12', state: 'seen' },
    })
    expect(observed).toHaveProperty(
      'tree',
      expect.stringContaining('- /url: post.php?post=12&action=trash&_wpnonce=[hidden]'),
    )
    expect(JSON.stringify(observed)).not.toContain('0a1b2c')
    expect(JSON.stringify(observed)).not.toContain('AbC123')
    // A reference of the redacted tree is the page's own: the worker acts on it.
    expect(await act(row, { tool: 'web_click', observation: 'o1', ref: 'e7' })).toMatchObject({
      page: { url: `${EDIT_12}&_wpnonce=[hidden]#[hidden]` },
    })

    // A check: the agent reads the object's addresses redacted, the task keeps them as found.
    await act(row, { tool: 'web_click', observation: 'o1', ref: 'e5' })
    const object = { ...postObject('12'), url: `${SITE}/?p=12&preview=true&preview_nonce=f00d` }
    browser.reading = async () => ({ state: 'verified', object })
    const verified = await act(row, { tool: 'web_verify' })
    expect(verified).toMatchObject({
      objects: [
        { object: { url: `${SITE}/?p=12&preview=true&preview_nonce=[hidden]`, editUrl: EDIT_12 } },
      ],
    })
    expect([...store.checkpointRows.values()][0]).toMatchObject({ verified: object })
  })

  it('refuses addresses outside the site and marks the session written by clicks and input', async () => {
    const { store, ensured, act, counts } = setup()
    const { row } = await ensured()
    expect(await codeOf(act(row, { tool: 'web_open', url: 'https://evil.example.org/' }))).toBe(
      'BROWSER_ADDRESS_DENIED',
    )
    expect(await codeOf(act(row, { tool: 'web_open', url: 'http://news-site.ru/' }))).toBe(
      'BROWSER_ADDRESS_DENIED',
    )
    await act(row, { tool: 'web_open', url: `${SITE}/wp-admin/edit.php?post_type=page` })
    await settle()
    expect(store.wrote).toBe(0)
    await act(row, { tool: 'web_type', text: 'Новость дня' })
    await act(row, { tool: 'web_type', text: 'и ещё' })
    await settle()
    expect(store.wrote).toBe(1)
    expect(counts.actions).toEqual([
      'web_open:BROWSER_ADDRESS_DENIED',
      'web_open:BROWSER_ADDRESS_DENIED',
      'web_open:ok',
      'web_type:ok',
      'web_type:ok',
    ])
  })

  it('keeps a saved object unconfirmed until a check reads it, and allows no new one meanwhile', async () => {
    const { store, ensured, act } = setup()
    const { row, browser } = await ensured()
    browser.go(EDIT_12)
    await settle()
    const rows = () => [...store.checkpointRows.values()]
    expect(rows()).toEqual([
      expect.objectContaining({ state: 'seen', ref: expect.objectContaining({ objectId: '12' }) }),
    ])
    const observed = await act(row, { tool: 'web_observe' })
    expect(observed).toMatchObject({ checkpoint: { kind: 'post', objectId: '12', state: 'seen' } })

    // «Опубликовать» is a commit of the stack (SiteAdapter.browserCommitAction).
    const published = await act(row, { tool: 'web_click', observation: 'o1', ref: 'e5' })
    expect(published).toMatchObject({ checkpoint: { objectId: '12', state: 'unverified' } })
    await settle()
    expect(rows()[0]?.state).toBe('unverified')
    await act(row, { tool: 'web_observe' })
    expect(await codeOf(act(row, { tool: 'web_click', observation: 'o2', ref: 'e5' }))).toBe(
      'BROWSER_CHECKPOINT_UNVERIFIED',
    )
    expect(await codeOf(act(row, { tool: 'web_open', url: NEW_POST }))).toBe(
      'BROWSER_CHECKPOINT_UNVERIFIED',
    )
    // The object itself may be opened again; a click that commits nothing goes through.
    await act(row, { tool: 'web_open', url: EDIT_12 })
    await act(row, { tool: 'web_observe' })
    await act(row, { tool: 'web_click', observation: 'o3', ref: 'e7' })

    const object: BrowserVerifiedObject = {
      kind: 'post',
      objectId: '12',
      title: 'Новость',
      status: 'publish',
      url: `${SITE}/?p=12`,
      editUrl: EDIT_12,
      images: 2,
      files: 1,
      featuredImage: true,
    }
    browser.reading = async () => ({ state: 'verified', object })
    const verified = await act(row, { tool: 'web_verify', expect: 'publish' })
    expect(verified).toEqual({
      tool: 'web_verify',
      objects: [{ kind: 'post', objectId: '12', state: 'verified', object }],
      matched: true,
    })
    expect(rows()[0]).toMatchObject({ state: 'verified', verified: object })
    // Confirmed: a new object may be started.
    await act(row, { tool: 'web_open', url: NEW_POST })
  })

  it('leaves an object as it was known when the site does not answer the check in time', async () => {
    const { manager, ensured, act } = setup({ verifyBudgetMs: 50 })
    const { row, browser } = await ensured()
    browser.go(EDIT_12)
    await act(row, { tool: 'web_observe' })
    await act(row, { tool: 'web_click', observation: 'o1', ref: 'e5' })
    browser.reading = () => new Promise(() => {})
    const started = Date.now()
    expect(await manager.verify(row.id)).toEqual({
      checkpoints: [{ kind: 'post', objectId: '12', state: 'unverified' }],
    })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('records the object a save on a new post gave as unconfirmed, and refuses another save first', async () => {
    const { store, ensured, act } = setup()
    const { row, browser } = await ensured()
    browser.go(NEW_POST)
    await act(row, { tool: 'web_observe' })
    // The click times out: the save may or may not have happened.
    browser.onAct = async () => {
      throw new Error('Timeout 10000ms exceeded')
    }
    expect(await codeOf(act(row, { tool: 'web_click', observation: 'o1', ref: 'e5' }))).toBe(
      'BROWSER_ACTION_FAILED',
    )
    browser.onAct = async () => undefined
    await act(row, { tool: 'web_observe' })
    expect(await codeOf(act(row, { tool: 'web_click', observation: 'o2', ref: 'e5' }))).toBe(
      'BROWSER_CHECKPOINT_UNVERIFIED',
    )
    // The editor moved to the address of the object it saved.
    browser.go(`${SITE}/wp-admin/post.php?post=13&action=edit`)
    await settle()
    expect([...store.checkpointRows.values()]).toEqual([
      expect.objectContaining({
        state: 'unverified',
        ref: expect.objectContaining({ objectId: '13' }),
      }),
    ])
  })

  it('holds a save of a new post through a check that finds no object yet, until its address names one', async () => {
    const { store, ensured, act } = setup()
    const { row, browser } = await ensured()
    browser.go(NEW_POST)
    await act(row, { tool: 'web_observe' })
    // «Опубликовать» answers before the slow site does: the editor is still on post-new.php.
    await act(row, { tool: 'web_click', observation: 'o1', ref: 'e5' })
    // A link to a part of the same page (a tab of a box) leaves no editor.
    browser.go(`${NEW_POST}#category-pop`)
    expect(await act(row, { tool: 'web_verify' })).toEqual({
      tool: 'web_verify',
      objects: [],
      matched: false,
    })
    // Nothing is confirmed, and nothing new may start: the save may still land.
    expect(await codeOf(act(row, { tool: 'web_open', url: NEW_POST }))).toBe(
      'BROWSER_CHECKPOINT_UNVERIFIED',
    )
    // The editor that saved may press again: the pre-publish panel's own «Опубликовать».
    await act(row, { tool: 'web_observe' })
    await act(row, { tool: 'web_click', observation: 'o2', ref: 'e5' })
    expect(await codeOf(act(row, { tool: 'web_open', url: NEW_POST }))).toBe(
      'BROWSER_CHECKPOINT_UNVERIFIED',
    )
    // The save lands: the address names what it made, unconfirmed until a read.
    browser.go(`${SITE}/wp-admin/post.php?post=13&action=edit`)
    await settle()
    expect([...store.checkpointRows.values()]).toEqual([
      expect.objectContaining({
        state: 'unverified',
        ref: expect.objectContaining({ objectId: '13' }),
      }),
    ])
    browser.reading = async () => ({ state: 'verified', object: postObject('13') })
    expect(await act(row, { tool: 'web_verify', expect: 'publish' })).toMatchObject({
      objects: [{ objectId: '13', state: 'verified' }],
      matched: true,
    })
    await act(row, { tool: 'web_open', url: NEW_POST })
  })

  it('keeps the hold of a save whose page left the editor, until the client takes the browser', async () => {
    const { store, ensured, act } = setup()
    const { row, session, browser } = await ensured()
    browser.go(NEW_POST)
    await act(row, { tool: 'web_observe' })
    await act(row, { tool: 'web_click', observation: 'o1', ref: 'e5' })
    // A link to the list: the save may still make a post the page will never show.
    browser.go(`${SITE}/wp-admin/edit.php`)
    await act(row, { tool: 'web_verify' })
    // An editor the page opens from there is not what the save made.
    browser.go(EDIT_12)
    await act(row, { tool: 'web_observe' })
    expect(await codeOf(act(row, { tool: 'web_click', observation: 'o2', ref: 'e5' }))).toBe(
      'BROWSER_CHECKPOINT_UNVERIFIED',
    )
    expect(await codeOf(act(row, { tool: 'web_open', url: NEW_POST }))).toBe(
      'BROWSER_CHECKPOINT_UNVERIFIED',
    )
    await settle()
    expect([...store.checkpointRows.values()]).toEqual([
      expect.objectContaining({ state: 'seen', ref: expect.objectContaining({ objectId: '12' }) }),
    ])
    // The client takes the browser and gives it back: the hold was theirs to resolve.
    const viewer = new ViewerProbe()
    session.attach(viewer)
    session.message(viewer, { t: 'take' })
    session.message(viewer, { t: 'release' })
    await act(row, { tool: 'web_observe' })
    expect(await act(row, { tool: 'web_click', observation: 'o3', ref: 'e5' })).toMatchObject({
      checkpoint: { objectId: '12', state: 'unverified' },
    })
  })

  it('takes the same address opened again for a new editor, not for the one that saved', async () => {
    const { ensured, act } = setup()
    const { row, browser } = await ensured()
    browser.go(NEW_POST)
    await act(row, { tool: 'web_observe' })
    await act(row, { tool: 'web_click', observation: 'o1', ref: 'e5' })
    // «Добавить запись» of the menu: another editor, another post, at the same address.
    browser.go(NEW_POST)
    await act(row, { tool: 'web_verify' })
    await act(row, { tool: 'web_observe' })
    expect(await codeOf(act(row, { tool: 'web_click', observation: 'o2', ref: 'e5' }))).toBe(
      'BROWSER_CHECKPOINT_UNVERIFIED',
    )
  })

  it('still records what a save the client took over made, without holding the agent', async () => {
    const { store, ensured, act } = setup()
    const { row, session, browser } = await ensured()
    browser.go(NEW_POST)
    await act(row, { tool: 'web_observe' })
    await act(row, { tool: 'web_click', observation: 'o1', ref: 'e5' })
    const viewer = new ViewerProbe()
    session.attach(viewer)
    session.message(viewer, { t: 'take' })
    session.message(viewer, { t: 'release' })
    await act(row, { tool: 'web_open', url: NEW_POST })
    // The save lands after all: what it made is the task's, unconfirmed.
    browser.go(`${SITE}/wp-admin/post.php?post=13&action=edit`)
    await settle()
    expect([...store.checkpointRows.values()]).toEqual([
      expect.objectContaining({
        state: 'unverified',
        ref: expect.objectContaining({ objectId: '13' }),
      }),
    ])
  })

  it('takes the save shortcut for a save, with a reference or without', async () => {
    const { ensured, act } = setup()
    const { row, browser } = await ensured()
    browser.go(EDIT_12)
    await act(row, { tool: 'web_observe' })
    // Control+B makes text bold; it saves nothing.
    expect(await act(row, { tool: 'web_press', key: 'Control+b' })).toMatchObject({
      checkpoint: { objectId: '12', state: 'seen' },
    })
    expect(await act(row, { tool: 'web_press', key: 'ControlOrMeta+s' })).toMatchObject({
      checkpoint: { objectId: '12', state: 'unverified' },
    })
    expect(
      await codeOf(
        act(row, { tool: 'web_press', observation: 'o1', ref: 'e6', key: 'Shift+Meta+S' }),
      ),
    ).toBe('BROWSER_CHECKPOINT_UNVERIFIED')
    expect(browser.acted.map((action) => action.tool === 'web_press' && action.key)).toEqual([
      'Control+b',
      'ControlOrMeta+s',
    ])
  })

  it('takes Enter or a space with no reference for a press of what has the focus', async () => {
    const { store, ensured, act } = setup()
    const { row, browser } = await ensured()
    browser.go(EDIT_12)
    await act(row, { tool: 'web_observe' })
    // A new line in the title: nothing is saved.
    browser.onFocused = async () => ({ role: 'textbox', name: 'Добавить заголовок' })
    expect(await act(row, { tool: 'web_press', key: 'Enter' })).toMatchObject({
      checkpoint: { objectId: '12', state: 'seen' },
    })
    // Tab reaches «Опубликовать» after the latest tree; Enter on it publishes, as a click would.
    browser.onFocused = async () => ({ role: 'button', name: 'Опубликовать' })
    await act(row, { tool: 'web_press', key: 'Tab' })
    expect(await act(row, { tool: 'web_press', key: 'Enter' })).toMatchObject({
      checkpoint: { objectId: '12', state: 'unverified' },
    })
    await settle()
    expect([...store.checkpointRows.values()]).toEqual([
      expect.objectContaining({
        state: 'unverified',
        ref: expect.objectContaining({ objectId: '12' }),
      }),
    ])
    // Pressed again by a space or with Shift: a second click on it, refused until a check (Б22).
    for (const key of [' ', 'Shift+Enter'])
      expect(await codeOf(act(row, { tool: 'web_press', key }))).toBe(
        'BROWSER_CHECKPOINT_UNVERIFIED',
      )
    // A focus the browser cannot read presses nothing.
    browser.onFocused = async () => {
      throw new PageBrowserError('timeout')
    }
    expect(await codeOf(act(row, { tool: 'web_press', key: 'Enter' }))).toBe('BROWSER_TIMEOUT')
    expect(browser.acted.map((action) => action.tool === 'web_press' && action.key)).toEqual([
      'Enter',
      'Tab',
      'Enter',
    ])
    // Tab presses nothing: the focus is read only for a key that does.
    expect(browser.focusReads).toBe(5)
  })

  it('refuses a save of more objects than a task may change (CLAUDE.md rule 4)', async () => {
    const { store, manager, browsers, act } = setup()
    // An earlier session of the task saved 19 posts.
    const row = store.open()
    for (let id = 1; id <= 19; id++)
      await store.upsertCheckpoint({
        taskId: row.taskId,
        sessionId: randomUUID(),
        ref: postRef(String(id)),
        state: 'verified',
        verified: postObject(String(id)),
      })
    await manager.ensure({
      sessionId: row.id,
      taskId: row.taskId,
      siteId: row.siteId,
      takeControl: true,
    })
    const browser = browsers.last
    const editor = async (id: string) => {
      browser.go(postRef(id).editUrl)
      const observed = await act(row, { tool: 'web_observe' })
      return observed.tool === 'web_observe' ? observed.observation : ''
    }
    browser.reading = async (plan) => {
      const id = /\/(\d+)&context=edit/.exec(plan.steps.at(-1)?.path ?? '')?.[1] ?? '0'
      return { state: 'verified', object: postObject(id) }
    }
    // The 20th object of the task is saved and confirmed.
    await act(row, { tool: 'web_click', observation: await editor('20'), ref: 'e5' })
    expect(await act(row, { tool: 'web_verify' })).toMatchObject({ matched: true })
    // A 21st is not: by its button, by Enter on it, by the save shortcut.
    const o21 = await editor('21')
    expect(await codeOf(act(row, { tool: 'web_click', observation: o21, ref: 'e5' }))).toBe(
      'BROWSER_ACTION_DENIED',
    )
    expect(
      await codeOf(act(row, { tool: 'web_press', observation: o21, ref: 'e5', key: 'Enter' })),
    ).toBe('BROWSER_ACTION_DENIED')
    expect(await codeOf(act(row, { tool: 'web_press', key: 'Control+s' }))).toBe(
      'BROWSER_ACTION_DENIED',
    )
    // Nor by Enter on the button the agent reached with Tab, no reference named.
    browser.onFocused = async () => ({ role: 'button', name: 'Опубликовать' })
    expect(await codeOf(act(row, { tool: 'web_press', key: 'Enter' }))).toBe(
      'BROWSER_ACTION_DENIED',
    )
    browser.onFocused = async () => null
    // A click that saves nothing still goes through.
    await act(row, { tool: 'web_click', observation: o21, ref: 'e7' })
    // Nor a new post.
    browser.go(NEW_POST)
    const fresh = await act(row, { tool: 'web_observe' })
    expect(
      await codeOf(
        act(row, {
          tool: 'web_click',
          observation: fresh.tool === 'web_observe' ? fresh.observation : '',
          ref: 'e5',
        }),
      ),
    ).toBe('BROWSER_ACTION_DENIED')
    // An object the task already changed may be saved again.
    expect(
      await act(row, { tool: 'web_click', observation: await editor('5'), ref: 'e5' }),
    ).toMatchObject({ checkpoint: { objectId: '5', state: 'unverified' } })
    expect(browser.acted.filter((action) => action.tool === 'web_click')).toEqual([
      { tool: 'web_click', ref: 'e5' },
      { tool: 'web_click', ref: 'e7' },
      { tool: 'web_click', ref: 'e5' },
    ])
  })

  it('uploads only attachments bound to the session’s task, read from the inbox', async () => {
    const { store, inbox, ensured, act } = setup()
    const { row, browser } = await ensured()
    const workspaceId = randomUUID()
    const attach = (taskId: string, bytes: Uint8Array, key?: string) => {
      const id = randomUUID()
      const s3Key = key ?? attachmentKey(workspaceId, id)
      store.attachments.set(id, {
        id,
        taskId,
        workspaceId,
        siteId: row.siteId,
        s3Key,
        fileName: 'фото.jpg',
        contentType: 'image/jpeg',
        sizeBytes: bytes.byteLength,
      })
      inbox.objects.set(s3Key, bytes)
      return id
    }
    const own = attach(row.taskId, new Uint8Array([1, 2, 3]))
    const foreign = attach(randomUUID(), new Uint8Array([4]))
    const misplaced = attach(row.taskId, new Uint8Array([5]), `inbox/${randomUUID()}/other`)
    await act(row, { tool: 'web_observe' })
    for (const id of [foreign, misplaced, randomUUID()])
      expect(
        await codeOf(
          act(row, { tool: 'web_upload', observation: 'o1', ref: 'e6', attachmentIds: [own, id] }),
        ),
      ).toBe('BROWSER_ATTACHMENT_UNKNOWN')
    // Nothing of another task was read; no id but the task's was looked up in the inbox.
    expect(inbox.read).toEqual([])
    const uploaded = await act(row, {
      tool: 'web_upload',
      observation: 'o1',
      ref: 'e6',
      attachmentIds: [own],
    })
    expect(uploaded).toMatchObject({ tool: 'web_upload', uploaded: 1 })
    expect(browser.acted.at(-1)).toEqual({
      tool: 'web_upload',
      ref: 'e6',
      files: [{ name: 'фото.jpg', mimeType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) }],
    })
    // A stored object of another size than recorded is not the file that was sent.
    inbox.objects.set(attachmentKey(workspaceId, own), new Uint8Array([1, 2, 3, 4]))
    expect(
      await codeOf(
        act(row, { tool: 'web_upload', observation: 'o1', ref: 'e6', attachmentIds: [own] }),
      ),
    ).toBe('BROWSER_ATTACHMENT_UNKNOWN')
  })

  it('records the agent’s request for help, which the next turn clears', async () => {
    const { store, manager, ensured, act } = setup()
    const { row, session } = await ensured()
    const viewer = new ViewerProbe()
    session.attach(viewer)
    expect(
      await act(row, { tool: 'web_help', reason: 'login', message: 'Войдите в админку' }),
    ).toEqual({ tool: 'web_help', requested: true, reason: 'login' })
    expect(store.helps).toEqual([{ reason: 'login', message: 'Войдите в админку' }])
    expect(viewer.last.help).toEqual({ reason: 'login', message: 'Войдите в админку' })
    await manager.ensure({
      sessionId: row.id,
      taskId: row.taskId,
      siteId: row.siteId,
      takeControl: true,
    })
    await settle()
    expect(viewer.last.help).toBeUndefined()
    expect(store.cleared).toBe(1)
  })

  it('refuses an action of another task', async () => {
    const { manager, ensured } = setup()
    const { row } = await ensured()
    expect(
      await codeOf(
        manager.act(row.id, {
          taskId: randomUUID(),
          assignmentId: randomUUID(),
          action: { tool: 'web_observe' },
        }),
      ),
    ).toBe('BROWSER_SESSION_UNAVAILABLE')
  })
})

describe('the saved sign-in (Б36)', () => {
  const saved = { login: 'admin', password: 'Пароль-сайта-2026' }

  it('fills the stack’s form at the start and before each action of the agent', async () => {
    const { store, warnings, ensured, act } = setup()
    const { row, browser } = await ensured(saved)
    await settle()
    // The start page of a signed-out session is the form: signed in before the agent acts.
    expect(browser.signIns).toEqual([saved])
    await act(row, { tool: 'web_observe' })
    // A session that expired on the site meanwhile is signed in again before the action.
    expect(browser.signIns).toEqual([saved, saved])
    // A request for help is the client's: no sign-in before it.
    await act(row, { tool: 'web_help', reason: 'login', message: 'Войдите в админку' })
    expect(browser.signIns).toHaveLength(2)
    expect(warnings).toEqual([])
    expect(JSON.stringify([...store.sessions.values(), store.helps])).not.toContain(saved.password)
  })

  it('sends a refused sign-in no more, until core gives another one; none forgets it', async () => {
    const { manager, warnings, ensured, act } = setup()
    const { row, browser } = await ensured(saved)
    await settle()
    browser.onSignIn = async () => 'refused'
    await act(row, { tool: 'web_observe' })
    expect(warnings).toEqual(['browser_sign_in_refused'])
    await act(row, { tool: 'web_observe' })
    expect(browser.signIns).toHaveLength(2)

    const changed = { ...saved, password: 'Новый-пароль-2026' }
    const ensure = (signIn?: typeof saved) =>
      manager.ensure({
        sessionId: row.id,
        taskId: row.taskId,
        siteId: row.siteId,
        takeControl: true,
        ...(signIn ? { signIn } : {}),
      })
    await ensure(changed)
    await act(row, { tool: 'web_observe' })
    expect(browser.signIns.at(-1)).toEqual(changed)
    expect(browser.signIns).toHaveLength(3)

    await ensure()
    await act(row, { tool: 'web_observe' })
    expect(browser.signIns).toHaveLength(3)
  })

  it('takes a failure of the browser for a refusal: the agent’s action goes on', async () => {
    const { warnings, ensured, act } = setup()
    const { row, browser } = await ensured(saved)
    await settle()
    browser.onSignIn = async () => {
      throw new PageBrowserError('timeout')
    }
    expect(await act(row, { tool: 'web_observe' })).toMatchObject({ tool: 'web_observe' })
    expect(warnings).toEqual(['browser_sign_in_failed'])
    await act(row, { tool: 'web_observe' })
    expect(browser.signIns).toHaveLength(2)
  })

  it('leaves the form to the client while the client controls the browser', async () => {
    const { ensured, act } = setup()
    const { row, session, browser } = await ensured(saved)
    await settle()
    const viewer = new ViewerProbe()
    session.attach(viewer)
    session.message(viewer, { t: 'take' })
    expect(await codeOf(act(row, { tool: 'web_observe' }))).toBe('BROWSER_USER_IN_CONTROL')
    expect(browser.signIns).toHaveLength(1)
  })
})

describe('the end of a session', () => {
  it('closes idle and expired sessions; a watched one is not idle', async () => {
    const { store, runtime, manager, clock, ensured } = setup()
    const idle = await ensured()
    const watched = await ensured()
    watched.session.attach(new ViewerProbe())
    clock.skew += 31 * 60_000
    await manager.sweep()
    expect(store.sessions.get(idle.row.id)).toMatchObject({ status: 'closed', closeReason: 'idle' })
    expect(manager.session(watched.row.id)).not.toBeNull()
    clock.skew += 5 * 3_600_000
    await manager.sweep()
    expect(store.sessions.get(watched.row.id)).toMatchObject({
      status: 'closed',
      closeReason: 'expired',
    })
    expect(runtime.stopped.sort()).toEqual([idle.row.id, watched.row.id].sort())
  })

  it('answers an ensure of a session still ending once its row is closed, not before', async () => {
    const { store, runtime, manager, clock, ensured } = setup()
    const { row } = await ensured()
    // Removing the containers takes a while.
    let removed = () => {}
    runtime.stopGate = new Promise((resolve) => (removed = () => resolve(undefined)))
    clock.skew += 31 * 60_000
    const sweeping = manager.sweep()
    const ensuring = manager
      .ensure({
        sessionId: row.id,
        taskId: row.taskId,
        siteId: row.siteId,
        takeControl: true,
      })
      .then(
        () => 'ensured',
        // What core reads next: its replace-once branch needs the row closed (Б18).
        (error: unknown) =>
          `${isDomainError(error) ? error.code : 'error'}:${store.sessions.get(row.id)?.status}`,
      )
    await settle()
    expect(store.sessions.get(row.id)?.status).toBe('ready')
    removed()
    expect(await ensuring).toBe('CONFLICT:closed')
    await sweeping
    expect(store.sessions.get(row.id)).toMatchObject({ status: 'closed', closeReason: 'idle' })
  })

  it('closes everything of a session once: viewers, context, containers, the row', async () => {
    const { store, runtime, manager, ensured } = setup()
    const { row, session, browser } = await ensured()
    const viewer = new ViewerProbe()
    session.attach(viewer)
    expect(await manager.close(row.id, 'task_done')).toEqual({
      sessionId: row.id,
      status: 'closed',
    })
    expect(viewer.ended).toBe('task_done')
    expect(browser.closed).toBe(true)
    expect(runtime.held.has(row.id)).toBe(false)
    expect(store.sessions.get(row.id)).toMatchObject({ status: 'closed', closeReason: 'task_done' })
    expect(manager.session(row.id)).toBeNull()
    expect(manager.list().sessions).toEqual([])
    // A second close is no error; a session this worker never held is closed in the database.
    expect(await manager.close(row.id, 'task_done')).toEqual({
      sessionId: row.id,
      status: 'closed',
    })
    const elsewhere = store.open()
    expect(await manager.close(elsewhere.id, 'orphaned')).toEqual({
      sessionId: elsewhere.id,
      status: 'closed',
    })
    expect(await codeOf(manager.close(randomUUID(), 'orphaned'))).toBe('NOT_FOUND')
  })

  it('loses a session whose browser is gone, and every session when the worker stops', async () => {
    const { store, manager, ensured } = setup()
    const crashed = await ensured()
    crashed.browser.disconnect()
    await settle()
    expect(store.sessions.get(crashed.row.id)).toMatchObject({
      status: 'lost',
      closeReason: 'crashed',
    })
    const live = await ensured()
    await manager.shutdown()
    expect(store.sessions.get(live.row.id)).toMatchObject({
      status: 'lost',
      closeReason: 'shutdown',
    })
    expect(live.browser.closed).toBe(true)
  })

  it('removes the containers an earlier process left', async () => {
    const { runtime, manager, ensured } = setup()
    const { row } = await ensured()
    runtime.held.add('left-by-earlier-process')
    await manager.removeLeftovers()
    expect(runtime.stopped).toEqual(['left-by-earlier-process'])
    expect(runtime.held.has(row.id)).toBe(true)
  })
})

describe('frames', () => {
  it('runs the screencast while someone watches, and hands each frame to every viewer', async () => {
    const { ensured } = setup()
    const { session, browser } = await ensured()
    expect(browser.streaming).toBe(false)
    const first = new ViewerProbe()
    session.attach(first)
    await settle()
    expect(browser.frameStarts).toEqual([{ size: { width: 1280, height: 800 }, quality: 70 }])
    await browser.frame()
    const second = new ViewerProbe()
    session.attach(second)
    // The newcomer gets the last frame at once.
    expect(first.frames).toHaveLength(1)
    expect(second.frames).toEqual(first.frames)
    expect(first.frames[0]).toMatchObject({ seq: 1, pageId: 1, viewportVersion: 1 })
    session.detach(first.id)
    session.detach(second.id)
    await settle()
    expect(browser.streaming).toBe(false)
  })

  it('starts the screencast again at the new size when the holder changes the window', async () => {
    const { ensured } = setup()
    const { session, browser } = await ensured()
    const viewer = new ViewerProbe()
    session.attach(viewer)
    session.message(viewer, { t: 'take' })
    session.message(viewer, { t: 'viewport', width: 1440, height: 900 })
    await settle()
    expect(browser.viewports).toEqual([{ width: 1440, height: 900 }])
    expect(viewer.last).toMatchObject({
      viewportVersion: 2,
      viewport: { width: 1440, height: 900 },
    })
    expect(browser.frameStarts.at(-1)).toEqual({ size: { width: 1440, height: 900 }, quality: 70 })
    // Input measured on the old size is refused.
    session.message(viewer, {
      t: 'input',
      pageId: 1,
      controlEpoch: 1,
      viewportVersion: 1,
      event: { kind: 'mouse', type: 'move', x: 10, y: 10, button: 'none', clickCount: 0 },
    })
    await settle()
    expect(viewer.refusals).toEqual(['stale_viewport'])
  })
})

describe('a snapshot for the client (web_screenshot)', () => {
  it('stores a JPEG of the shown page under its task and answers only its number', async () => {
    const { store, inbox, ensured, act } = setup()
    const { row, browser } = await ensured()
    const first = await act(row, { tool: 'web_screenshot' })
    expect(first).toEqual({
      tool: 'web_screenshot',
      page: expect.any(Object),
      attached: true,
      number: 1,
    })
    // Б20: no byte, no address of the image in the answer the agent reads.
    expect(JSON.stringify(first)).not.toMatch(/screenshots\/|jpeg|base64/)
    expect(browser.screenshots).toEqual([{ qualities: [80, 60, 40], maxBytes: 1024 * 1024 }])
    const [key, written] = [...inbox.written.entries()][0]!
    expect(key).toMatch(new RegExp(`^screenshots/${row.taskId}/[0-9a-f-]{36}\\.jpg$`))
    expect(written.contentType).toBe('image/jpeg')
    expect(store.screenshotRows).toEqual([
      expect.objectContaining({ taskId: row.taskId, sessionId: row.id, number: 1, width: 1280 }),
    ])
    expect(key).toContain(store.screenshotRows[0]!.screenshotId)
    expect(await act(row, { tool: 'web_screenshot' })).toMatchObject({ number: 2 })
    // Not a change of the site: no checkpoint, no first write of the session.
    expect(store.checkpointRows.size).toBe(0)
    expect(store.wrote).toBe(0)
  })

  it('is refused while the client controls the browser, and when the client takes it meanwhile', async () => {
    const { store, inbox, ensured, act } = setup()
    const { row, session, browser } = await ensured()
    const viewer = new ViewerProbe()
    session.attach(viewer)
    session.message(viewer, { t: 'take' })
    expect(await codeOf(act(row, { tool: 'web_screenshot' }))).toBe('BROWSER_USER_IN_CONTROL')
    expect(browser.screenshots).toEqual([])
    session.message(viewer, { t: 'release' })
    await settle()

    // The client takes the browser while the snapshot is being taken: it is not kept.
    browser.onScreenshot = async () => {
      session.message(viewer, { t: 'take' })
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(await codeOf(act(row, { tool: 'web_screenshot' }))).toBe('BROWSER_USER_IN_CONTROL')
    expect(inbox.written.size).toBe(0)
    expect(store.screenshotRows).toEqual([])
  })

  it('keeps at most fifty snapshots of a task', async () => {
    const { store, inbox, ensured, act } = setup()
    const { row } = await ensured()
    for (let index = 0; index < 50; index += 1)
      store.screenshotRows.push({
        taskId: row.taskId,
        sessionId: row.id,
        screenshotId: randomUUID(),
        width: 1,
        height: 1,
        number: index + 1,
      })
    expect(await codeOf(act(row, { tool: 'web_screenshot' }))).toBe('BROWSER_ACTION_DENIED')
    expect(inbox.written.size).toBe(0)
  })
})
