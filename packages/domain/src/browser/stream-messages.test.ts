import { describe, expect, it } from 'vitest'

import { browserInputRefusals } from './control.ts'
import { browserCloseReasons } from './session.ts'
import {
  BROWSER_MESSAGE_MAX_CHARS,
  BROWSER_STREAM_PATH,
  browserInputEventSchema,
  browserNamedKeys,
  browserStreamCloseCode,
  browserStreamCloseCodes,
  browserStreamEndReasons,
  browserStreamRefusals,
  isBrowserInputInViewport,
  isBrowserKey,
  isBrowserTypedText,
  parseBrowserClientMessage,
  parseBrowserServerMessage,
  type BrowserClientMessage,
  type BrowserServerMessage,
} from './stream-messages.ts'

const ticket = 'A'.repeat(42) + '_'
const uuid = '0196abcd-0000-7000-8000-000000000001'
const send = (message: unknown) => parseBrowserClientMessage(JSON.stringify(message))
const input = (event: unknown) =>
  send({ t: 'input', pageId: 1, controlEpoch: 2, viewportVersion: 1, event })

describe('keys and text', () => {
  it('takes named keys and one printable character, Cyrillic and space included', () => {
    for (const key of [...browserNamedKeys, 'a', 'Z', 'ж', 'Ё', '1', ' ', '.', '€', '😀'])
      expect(isBrowserKey(key), key).toBe(true)
  })

  it('refuses composed and invisible keys, and more than one character', () => {
    for (const key of [
      '',
      'ab',
      'Dead',
      'Process',
      'Unidentified',
      'AudioVolumeUp',
      'F13',
      'enter',
      '\n',
      '\t',
      '\u0000',
      '​',
      ' ',
      '\ud800',
      'e\u0301', // e and a combining accent: two code points
    ])
      expect(isBrowserKey(key), JSON.stringify(key)).toBe(false)
  })

  it('takes typed text with tabs and line breaks, never other controls', () => {
    expect(isBrowserTypedText('Новость дня\n\tс отступом\r\n')).toBe(true)
    expect(isBrowserTypedText('😀 и текст')).toBe(true)
    for (const text of ['a\u0000b', 'a\u0007', '\u001b[31m', 'a\u007f', '\u0085', 'x\ud800y'])
      expect(isBrowserTypedText(text), JSON.stringify(text)).toBe(false)
  })
})

describe('input events', () => {
  it('reads mouse, wheel, key and text events', () => {
    const events = [
      { kind: 'mouse', type: 'move', x: 10.5, y: 20, button: 'none', clickCount: 0 },
      { kind: 'mouse', type: 'down', x: 0, y: 0, button: 'left', clickCount: 1 },
      { kind: 'mouse', type: 'up', x: 1439, y: 899, button: 'right', clickCount: 2 },
      { kind: 'wheel', x: 100, y: 100, dx: 0, dy: -120 },
      { kind: 'key', type: 'down', key: 'Enter', code: 'Enter', modifiers: [] },
      { kind: 'key', type: 'up', key: 'ж', code: 'Semicolon', modifiers: ['Shift'] },
      { kind: 'key', type: 'down', key: 'a', code: '', modifiers: ['Control', 'Shift'] },
      { kind: 'text', text: 'Привет, мир' },
    ]
    for (const event of events) expect(browserInputEventSchema.parse(event)).toEqual(event)
  })

  it('refuses events out of bounds or of a shape it does not know', () => {
    for (const event of [
      { kind: 'mouse', type: 'move', x: 10, y: 10, button: 'left', clickCount: 0 },
      { kind: 'mouse', type: 'down', x: 10, y: 10, button: 'none', clickCount: 1 },
      { kind: 'mouse', type: 'down', x: -1, y: 10, button: 'left', clickCount: 1 },
      { kind: 'mouse', type: 'down', x: 10, y: 901, button: 'left', clickCount: 1 },
      { kind: 'mouse', type: 'down', x: 1441, y: 10, button: 'left', clickCount: 1 },
      { kind: 'mouse', type: 'down', x: Number.NaN, y: 10, button: 'left', clickCount: 1 },
      { kind: 'mouse', type: 'down', x: 10, y: 10, button: 'left', clickCount: 4 },
      { kind: 'mouse', type: 'drag', x: 10, y: 10, button: 'left', clickCount: 1 },
      { kind: 'wheel', x: 10, y: 10, dx: 0, dy: 20_000 },
      { kind: 'key', type: 'press', key: 'a', code: 'KeyA', modifiers: [] },
      { kind: 'key', type: 'down', key: 'Dead', code: 'Quote', modifiers: [] },
      { kind: 'key', type: 'down', key: 'a', code: 'Key A', modifiers: [] },
      { kind: 'key', type: 'down', key: 'a', code: 'KeyA', modifiers: ['Shift', 'Shift'] },
      { kind: 'key', type: 'down', key: 'a', code: 'KeyA', modifiers: ['Hyper'] },
      { kind: 'key', type: 'down', key: 'a', code: 'KeyA' },
      { kind: 'text', text: '' },
      { kind: 'text', text: 'x'.repeat(10_001) },
      { kind: 'text', text: 'a\u0000b' },
      { kind: 'touch', x: 1, y: 1 },
      { kind: 'text', text: 'a', extra: true },
    ])
      expect(browserInputEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(false)
  })

  it('checks a point against the window it is aimed at', () => {
    const viewport = { width: 390, height: 844 }
    const at = (x: number, y: number) =>
      browserInputEventSchema.parse({
        kind: 'mouse',
        type: 'down',
        x,
        y,
        button: 'left',
        clickCount: 1,
      })
    expect(isBrowserInputInViewport(at(389.9, 843), viewport)).toBe(true)
    expect(isBrowserInputInViewport(at(390, 10), viewport)).toBe(false)
    expect(isBrowserInputInViewport(at(10, 900), viewport)).toBe(false)
    const text = browserInputEventSchema.parse({ kind: 'text', text: 'x' })
    expect(isBrowserInputInViewport(text, viewport)).toBe(true)
  })
})

describe('messages of the stream', () => {
  it('reads every message of a viewer', () => {
    const messages: BrowserClientMessage[] = [
      { t: 'hello', ticket },
      { t: 'ack', frameSeq: 12 },
      { t: 'pong' },
      { t: 'pong', ts: 1_792_000_000_000 },
      { t: 'take' },
      { t: 'release' },
      {
        t: 'input',
        pageId: 1,
        controlEpoch: 2,
        viewportVersion: 1,
        event: { kind: 'text', text: 'Заголовок' },
      },
      { t: 'navigate', url: 'https://news.example.ru/wp-admin/post-new.php' },
      { t: 'tab', pageId: 2 },
      { t: 'dialog', id: 'd1', accept: true },
      { t: 'dialog', id: 'd2', accept: true, text: 'ответ' },
      { t: 'files', chooserId: 'c1', attachmentIds: [uuid] },
      { t: 'files', chooserId: 'c1', attachmentIds: [] },
      { t: 'viewport', width: 1440, height: 900 },
    ]
    for (const message of messages) expect(send(message)).toEqual(message)
  })

  it('drops what is not a message of a viewer, and never throws', () => {
    for (const data of [
      undefined,
      null,
      42,
      new Uint8Array([1, 2, 3]),
      '',
      '{',
      'null',
      '[]',
      JSON.stringify({ t: 'hello', ticket: 'short' }),
      JSON.stringify({ t: 'hello', ticket, viewer: uuid }),
      JSON.stringify({ t: 'ack', frameSeq: -1 }),
      JSON.stringify({ t: 'take', viewer: uuid }),
      JSON.stringify({ t: 'state' }),
      JSON.stringify({ t: 'navigate', url: '' }),
      JSON.stringify({ t: 'navigate', url: `https://x.ru/${'a'.repeat(2048)}` }),
      JSON.stringify({ t: 'tab', pageId: 0 }),
      JSON.stringify({ t: 'dialog', id: 'd1' }),
      JSON.stringify({ t: 'files', chooserId: 'c1', attachmentIds: [uuid, uuid] }),
      JSON.stringify({ t: 'files', chooserId: 'c1', attachmentIds: Array(11).fill(uuid) }),
      JSON.stringify({ t: 'viewport', width: 1920, height: 1080 }),
      JSON.stringify({ t: 'evaluate', script: 'document.cookie' }),
      JSON.stringify({
        t: 'input',
        pageId: 1,
        controlEpoch: 0,
        viewportVersion: 0,
        event: { kind: 'text', text: 'x' },
      }),
      ' '.repeat(BROWSER_MESSAGE_MAX_CHARS + 1),
    ])
      expect(parseBrowserClientMessage(data), String(data).slice(0, 60)).toBeNull()
    expect(input({ kind: 'text', text: 'x'.repeat(10_000) })).not.toBeNull()
  })

  it('keeps a text event of the largest size within the message limit', () => {
    const text = '"\\'.repeat(5_000)
    const data = JSON.stringify({
      t: 'input',
      pageId: 4_294_967_295,
      controlEpoch: 4_294_967_295,
      viewportVersion: 4_294_967_295,
      event: { kind: 'text', text },
    })
    expect(data.length).toBeLessThanOrEqual(BROWSER_MESSAGE_MAX_CHARS)
    expect(parseBrowserClientMessage(data)).not.toBeNull()
  })

  it('reads every message of the gateway and the worker', () => {
    const messages: BrowserServerMessage[] = [
      { t: 'viewer', viewer: uuid },
      {
        t: 'state',
        session: uuid,
        status: 'ready',
        controller: 'user',
        controlEpoch: 1,
        manualReady: true,
        holder: uuid,
        pageId: 1,
        viewportVersion: 1,
        viewport: { width: 1280, height: 800 },
        url: 'https://news.example.ru/wp-login.php',
        title: 'Вход',
        tabs: [{ pageId: 1, url: 'https://news.example.ru/wp-login.php', title: 'Вход' }],
        help: { reason: 'login', message: 'Войдите, пожалуйста.' },
      },
      { t: 'ping', ts: 1_792_000_000_000 },
      { t: 'refused', reason: 'not_holder' },
      { t: 'closed', reason: 'task_done' },
      { t: 'closed', reason: 'forbidden' },
    ]
    for (const message of messages)
      expect(parseBrowserServerMessage(JSON.stringify(message))).toEqual(message)
    for (const data of [
      JSON.stringify({ t: 'refused', reason: 'because' }),
      JSON.stringify({ t: 'closed', reason: 'bye' }),
      JSON.stringify({ t: 'ping' }),
      JSON.stringify({ t: 'state', session: uuid }),
      JSON.stringify({ t: 'hello', ticket }),
      JSON.stringify({ t: 'viewer', viewer: 'tab-1' }),
    ])
      expect(parseBrowserServerMessage(data), data).toBeNull()
  })

  it('refuses with every reason of the control and ends with every reason of the session', () => {
    for (const reason of browserInputRefusals) expect(browserStreamRefusals).toContain(reason)
    for (const reason of browserCloseReasons) expect(browserStreamEndReasons).toContain(reason)
    expect(new Set(browserStreamRefusals).size).toBe(browserStreamRefusals.length)
    expect(new Set(browserStreamEndReasons).size).toBe(browserStreamEndReasons.length)
  })
})

describe('the gateway of the stream', () => {
  it('opens on one path, without a query', () => {
    expect(BROWSER_STREAM_PATH).toBe('/v1/browser/stream')
    expect(new URL(BROWSER_STREAM_PATH, 'wss://raditi.ru').pathname).toBe(BROWSER_STREAM_PATH)
  })

  it('closes with a code of the private range for each reason, the same for every end of a session', () => {
    expect(browserStreamCloseCode('unauthorized')).toBe(4401)
    expect(browserStreamCloseCode('forbidden')).toBe(4403)
    expect(browserStreamCloseCode('unavailable')).toBe(4503)
    expect(browserStreamCloseCode('protocol')).toBe(4400)
    for (const reason of browserCloseReasons)
      expect(browserStreamCloseCode(reason)).toBe(browserStreamCloseCodes.ended)
    for (const code of Object.values(browserStreamCloseCodes)) {
      expect(code).toBeGreaterThanOrEqual(4000)
      expect(code).toBeLessThan(5000)
    }
  })
})
