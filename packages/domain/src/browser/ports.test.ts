import { describe, expect, it } from 'vitest'

import type { BrowserTaskPolicy } from '../ports/site-adapter.ts'
import type {
  BrowserSessionRuntime,
  CloudBrowserAction,
  CloudBrowserConnection,
  CloudBrowserEvent,
  CloudBrowserFactory,
  CloudBrowserSession,
} from './ports.ts'
import { BROWSER_DEFAULT_VIEWPORT, type BrowserTab } from './session.ts'

const tab: BrowserTab = { pageId: 1, url: 'https://news.example.ru/wp-admin/', title: 'Консоль' }

/** The smallest browser that satisfies the port: what an adapter has to answer. */
function fakeSession(events: CloudBrowserEvent[], connection: CloudBrowserConnection) {
  const acted: CloudBrowserAction[] = []
  const session: CloudBrowserSession = {
    tabs: () => [tab],
    shown: () => tab.pageId,
    selectTab: async () => undefined,
    closeTab: async () => undefined,
    navigate: async (url) => {
      connection.onEvent({ kind: 'navigation', pageId: 1, url })
      return { ...tab, url }
    },
    observe: async () => ({ page: tab, tree: '- button "Опубликовать" [ref=e1]' }),
    act: async (action) => {
      acted.push(action)
      return {
        page: tab,
        ...(action.tool === 'web_upload' ? { uploaded: action.files.length } : {}),
      }
    },
    focused: async () => ({ role: 'button', name: 'Опубликовать' }),
    startFrames: async () => async () => undefined,
    input: async () => undefined,
    releaseInputs: async () => undefined,
    resolveDialog: async () => undefined,
    setChooserFiles: async () => undefined,
    setViewport: async () => undefined,
    verify: async () => ({ state: 'unreadable' }),
    isConnected: () => true,
    close: async () => {
      events.push({ kind: 'closed' })
    },
  }
  return { session, acted }
}

describe('ports of the cloud browser', () => {
  it('can be implemented and driven without anything of Playwright or Docker', async () => {
    const events: CloudBrowserEvent[] = []
    let acted: CloudBrowserAction[] = []
    const factory: CloudBrowserFactory = {
      open: async (connection) => {
        const fake = fakeSession(events, connection)
        acted = fake.acted
        return fake.session
      },
    }
    const runtime: BrowserSessionRuntime = {
      start: async () => ({ endpoint: 'ws://127.0.0.1:39001/secret-path' }),
      stop: async () => undefined,
      list: async () => [],
    }
    const policy: BrowserTaskPolicy = {
      startPath: '/wp-admin/',
      extraHosts: [],
      requestDenied: () => false,
      pageDenied: () => false,
    }
    const { endpoint } = await runtime.start({
      sessionId: '0196abcd-0000-7000-8000-000000000001',
      taskId: '0196abcd-0000-7000-8000-000000000002',
      siteId: '0196abcd-0000-7000-8000-000000000003',
      allowedHosts: ['news.example.ru:443'],
      localSites: [],
      deadline: Date.now() + 60_000,
    })
    const session = await factory.open({
      endpoint,
      allowedHosts: ['news.example.ru:443'],
      localSites: [],
      startUrl: 'https://news.example.ru/wp-admin/',
      viewport: BROWSER_DEFAULT_VIEWPORT,
      policy,
      onEvent: (event) => events.push(event),
    })
    await session.navigate('https://news.example.ru/wp-admin/post.php?post=12&action=edit')
    // An upload carries the files the worker read, never ids or paths.
    const result = await session.act({
      tool: 'web_upload',
      ref: 'e40',
      files: [{ name: 'photo.jpg', mimeType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8]) }],
    })
    await session.act({ tool: 'web_click', ref: 'e1' })
    await session.close()
    expect(result.uploaded).toBe(1)
    expect(acted.map((action) => action.tool)).toEqual(['web_upload', 'web_click'])
    expect(events.map((event) => event.kind)).toEqual(['navigation', 'closed'])
  })
})
