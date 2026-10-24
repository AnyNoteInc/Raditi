import { describe, expect, it } from 'vitest'

import {
  BROWSER_DEFAULT_VIEWPORT,
  BROWSER_MAX_VIEWPORT,
  browserCloseReasons,
  browserControllers,
  browserHelpReasons,
  browserPlatformQuestionReasons,
  browserSessionStateSchema,
  browserSessionStatuses,
  browserSessionTimings,
  browserSettingBounds,
  browserStreamDefaults,
  browserViewports,
  browserViewportSchema,
  isBrowserSessionLive,
  isBrowserViewport,
  type BrowserSessionState,
} from './session.ts'

const state: BrowserSessionState = {
  session: '0196abcd-0000-7000-8000-000000000001',
  status: 'ready',
  controller: 'agent',
  controlEpoch: 0,
  manualReady: false,
  holder: null,
  pageId: 1,
  viewportVersion: 1,
  viewport: { width: 1280, height: 800 },
  url: 'https://news.example.ru/wp-admin/',
  title: 'Консоль ‹ Новости — WordPress',
  tabs: [{ pageId: 1, url: 'https://news.example.ru/wp-admin/', title: 'Консоль' }],
}

describe('browser session', () => {
  it('names its states, controllers and reasons as the plan does', () => {
    expect(browserSessionStatuses).toEqual(['starting', 'ready', 'closed', 'failed', 'lost'])
    expect(browserControllers).toEqual(['agent', 'user'])
    expect(browserHelpReasons).toEqual(['login', 'captcha', 'confirm', 'other'])
    expect(browserPlatformQuestionReasons).toEqual(['control', 'unconfirmed'])
    expect(browserCloseReasons).toContain('idle')
    expect(browserCloseReasons).toContain('expired')
    expect(new Set(browserCloseReasons).size).toBe(browserCloseReasons.length)
  })

  it('is live while it starts or is ready', () => {
    expect(browserSessionStatuses.filter(isBrowserSessionLive)).toEqual(['starting', 'ready'])
  })

  it('keeps the times and limits of the plan', () => {
    expect(browserSessionTimings).toEqual({
      idleMinutes: 30,
      maxHours: 4,
      ticketSeconds: 60,
      recheckSeconds: 15,
      agentActionTimeoutMs: 10_000,
      toolCallBudgetMs: 50_000,
    })
    expect(browserStreamDefaults).toEqual({
      maxFps: 12,
      quality: 70,
      window: 2,
      maxBufferedBytes: 1_048_576,
      pingMs: 10_000,
      clientSilenceMs: 25_000,
    })
    // A tool call fits OpenCode's 60 s for an MCP request, an action fits in a call.
    expect(browserSessionTimings.toolCallBudgetMs).toBeLessThan(60_000)
    expect(browserSessionTimings.agentActionTimeoutMs).toBeLessThan(
      browserSessionTimings.toolCallBudgetMs,
    )
    // The gateway pings before a viewer gives up on silence.
    expect(browserStreamDefaults.pingMs).toBeLessThan(browserStreamDefaults.clientSilenceMs)
    for (const [name, value] of Object.entries({
      idleMinutes: browserSessionTimings.idleMinutes,
      maxHours: browserSessionTimings.maxHours,
      maxFps: browserStreamDefaults.maxFps,
      window: browserStreamDefaults.window,
    })) {
      const bounds = browserSettingBounds[name as keyof typeof browserSettingBounds]
      expect(value, name).toBeGreaterThanOrEqual(bounds.min)
      expect(value, name).toBeLessThanOrEqual(bounds.max)
    }
  })

  it('offers a few window sizes, the default first, and refuses the rest', () => {
    expect(BROWSER_DEFAULT_VIEWPORT).toEqual({ width: 1280, height: 800 })
    expect(browserViewports[0]).toBe(BROWSER_DEFAULT_VIEWPORT)
    expect(browserViewports).toEqual([
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
      { width: 1024, height: 768 },
      { width: 390, height: 844 },
    ])
    expect(BROWSER_MAX_VIEWPORT).toEqual({ width: 1440, height: 900 })
    for (const size of browserViewports) expect(browserViewportSchema.parse(size)).toEqual(size)
    for (const size of [
      { width: 1280, height: 801 },
      { width: 800, height: 1280 },
      { width: 0, height: 0 },
      { width: 1280.5, height: 800 },
      { width: 3840, height: 2160 },
    ]) {
      expect(isBrowserViewport(size)).toBe(false)
      expect(browserViewportSchema.safeParse(size).success).toBe(false)
    }
    expect(browserViewportSchema.safeParse({ width: 1280, height: 800, scale: 2 }).success).toBe(
      false,
    )
  })

  it('reads the state a worker reports', () => {
    expect(browserSessionStateSchema.parse(state)).toEqual(state)
    const waiting: BrowserSessionState = {
      ...state,
      controller: 'user',
      controlEpoch: 3,
      manualReady: true,
      holder: '0196abcd-0000-7000-8000-000000000009',
      dialog: { id: 'd1', kind: 'beforeunload', message: '' },
      chooser: { id: 'c1', multiple: true, accept: ['image/*', '.pdf'] },
      help: { reason: 'login', message: 'Войдите в админку сайта, пожалуйста.' },
    }
    expect(browserSessionStateSchema.parse(waiting)).toEqual(waiting)
    // Before the first page: no page, no address.
    const starting = { ...state, status: 'starting', pageId: null, url: '', title: '', tabs: [] }
    expect(browserSessionStateSchema.parse(starting)).toEqual(starting)
  })

  it('refuses a state it does not know or cannot bound', () => {
    for (const bad of [
      { ...state, status: 'paused' },
      { ...state, controller: 'both' },
      { ...state, controlEpoch: -1 },
      { ...state, controlEpoch: 2 ** 32 },
      { ...state, viewportVersion: 0 },
      { ...state, pageId: 0 },
      { ...state, holder: 'tab-1' },
      { ...state, viewport: { width: 1920, height: 1080 } },
      { ...state, url: `https://news.example.ru/${'a'.repeat(2048)}` },
      {
        ...state,
        tabs: Array.from({ length: 9 }, (_, index) => ({ ...state.tabs[0], pageId: index + 1 })),
      },
      { ...state, dialog: { id: 'd 1', kind: 'alert', message: '' } },
      { ...state, dialog: { id: 'd1', kind: 'print', message: '' } },
      { ...state, chooser: { id: 'c1', multiple: false, accept: ['image/*\n'] } },
      { ...state, help: { reason: 'payment', message: 'x' } },
      { ...state, help: { reason: 'other', message: '' } },
      { ...state, help: { reason: 'other', message: 'x'.repeat(501) } },
      { ...state, cookies: 'wordpress_logged_in=…' },
    ])
      expect(
        browserSessionStateSchema.safeParse(bad).success,
        JSON.stringify(bad).slice(0, 80),
      ).toBe(false)
  })
})
