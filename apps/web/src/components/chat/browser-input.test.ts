import { BROWSER_TEXT_INPUT_MAX_CHARS } from '@repo/domain/browser/stream-messages'
import { encodeBrowserFrame, decodeBrowserFrame } from '@repo/domain/browser/stream-codec'
import { describe, expect, it, vi } from 'vitest'

import { createFramePainter, type PaintContext } from './browser-canvas'
import {
  ClickCounter,
  isApplePlatform,
  isPasteShortcut,
  keyEventOf,
  mouseButtonOf,
  textEventsOf,
  viewportPointOf,
  wheelDelta,
  type KeyLike,
} from './browser-input'

const VIEWPORT = { width: 1280, height: 800 }
/** A canvas without a document: the painter only sets its size; the context is given apart. */
const fakeCanvas = () => ({ width: 0, height: 0 }) as HTMLCanvasElement

const key = (patch: Partial<KeyLike>): KeyLike => ({
  key: 'a',
  code: 'KeyA',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...patch,
})

describe('points of the panel', () => {
  // A panel 1000 × 800 shows the 1280 × 800 window as 1000 × 625, with 87.5 px margins above
  // and below (87 and 88 in whole pixels).
  const painter = () => {
    const drawn = createFramePainter(fakeCanvas(), { context: null })
    drawn.resize(1000, 800, 2)
    return drawn
  }
  const bounds = { left: 100, top: 50 }

  it('turns a point of the picture into a point of the window, margins included', () => {
    const rect = painter().rect(VIEWPORT)
    expect(rect).toEqual({ x: 0, y: 87, width: 1000, height: 625, scale: 0.78125 })
    // The top-left corner of the picture.
    expect(viewportPointOf({ clientX: 100, clientY: 137 }, bounds, rect, VIEWPORT)).toEqual({
      x: 0,
      y: 0,
    })
    // Its middle.
    expect(viewportPointOf({ clientX: 600, clientY: 449.5 }, bounds, rect, VIEWPORT)).toEqual({
      x: 640,
      y: 400,
    })
    // The last pixel stays inside the window.
    expect(viewportPointOf({ clientX: 1099.9, clientY: 761.9 }, bounds, rect, VIEWPORT)).toEqual({
      x: 1279,
      y: 799,
    })
  })

  it('sends nothing for a point on a margin or outside the picture', () => {
    const rect = painter().rect(VIEWPORT)
    expect(viewportPointOf({ clientX: 600, clientY: 100 }, bounds, rect, VIEWPORT)).toBeNull()
    expect(viewportPointOf({ clientX: 600, clientY: 790 }, bounds, rect, VIEWPORT)).toBeNull()
    expect(viewportPointOf({ clientX: 50, clientY: 400 }, bounds, rect, VIEWPORT)).toBeNull()
  })

  it('names the buttons of a mouse and counts clicks in a row', () => {
    expect([0, 1, 2, 3].map(mouseButtonOf)).toEqual(['left', 'middle', 'right', null])
    const clicks = new ClickCounter()
    expect(clicks.next({ x: 10, y: 10 }, 'left', 0)).toBe(1)
    expect(clicks.next({ x: 12, y: 11 }, 'left', 200)).toBe(2)
    expect(clicks.next({ x: 12, y: 11 }, 'left', 400)).toBe(3)
    expect(clicks.next({ x: 12, y: 11 }, 'left', 600)).toBe(3)
    expect(clicks.next({ x: 12, y: 11 }, 'left', 2000)).toBe(1)
    expect(clicks.next({ x: 40, y: 11 }, 'left', 2100)).toBe(1)
    expect(clicks.next({ x: 40, y: 11 }, 'right', 2200)).toBe(1)
  })

  it('turns a wheel of the panel into pixels of the window', () => {
    expect(wheelDelta({ deltaX: 0, deltaY: 100, deltaMode: 0 }, VIEWPORT, 0.5)).toEqual({
      dx: 0,
      dy: 200,
    })
    expect(wheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, VIEWPORT, 0.5)).toEqual({
      dx: 0,
      dy: 48,
    })
    expect(wheelDelta({ deltaX: 0, deltaY: 1e9, deltaMode: 0 }, VIEWPORT, 1).dy).toBe(10_000)
  })
})

describe('keys and text', () => {
  it('sends keys that print nothing as keys, with their modifiers', () => {
    for (const name of [
      'Enter',
      'Backspace',
      'Delete',
      'Tab',
      'Escape',
      'ArrowLeft',
      'Home',
      'End',
      'PageDown',
    ])
      expect(keyEventOf(key({ key: name, code: name }), 'down')).toEqual({
        kind: 'key',
        type: 'down',
        key: name,
        code: name,
        modifiers: [],
      })
    expect(
      keyEventOf(key({ key: 'ArrowRight', code: 'ArrowRight', shiftKey: true }), 'up'),
    ).toEqual({
      kind: 'key',
      type: 'up',
      key: 'ArrowRight',
      code: 'ArrowRight',
      modifiers: ['Shift'],
    })
  })

  it('sends shortcuts with Ctrl or ⌘ as keys', () => {
    expect(keyEventOf(key({ key: 'a', ctrlKey: true }), 'down')).toMatchObject({
      key: 'a',
      modifiers: ['Control'],
    })
    expect(keyEventOf(key({ key: 'z', code: 'KeyZ', metaKey: true }), 'down')).toMatchObject({
      key: 'z',
      modifiers: ['Meta'],
    })
    expect(keyEventOf(key({ key: 's', code: 'KeyS', ctrlKey: true }), 'down')).toMatchObject({
      key: 's',
    })
    expect(keyEventOf(key({ key: 'c', code: 'KeyC', ctrlKey: true }), 'down')).toMatchObject({
      key: 'c',
    })
  })

  it('takes the Latin key of a shortcut on a Russian layout, and sends none it cannot name', () => {
    // Ctrl+V on the Russian layout is 'м': still a paste, its text comes with the paste event.
    const paste = key({ key: 'м', code: 'KeyV', ctrlKey: true })
    expect(isPasteShortcut(paste)).toBe(true)
    expect(keyEventOf(paste, 'down')).toBeNull()
    expect(keyEventOf(key({ key: 'ф', code: 'KeyA', ctrlKey: true }), 'down')).toEqual({
      kind: 'key',
      type: 'down',
      key: 'a',
      code: 'KeyA',
      modifiers: ['Control'],
    })
    expect(keyEventOf(key({ key: 'я', code: 'KeyZ', metaKey: true }), 'down')).toMatchObject({
      key: 'z',
      modifiers: ['Meta'],
    })
    expect(keyEventOf(key({ key: '№', code: 'Digit3', ctrlKey: true }), 'down')).toMatchObject({
      key: '3',
    })
    // No Latin letter or digit under it: nothing the cloud browser would choke on.
    expect(keyEventOf(key({ key: 'ё', code: 'Backquote', ctrlKey: true }), 'down')).toBeNull()
    // A Latin layout keeps its own key: Dvorak's Ctrl+Z is on the key of a Latin 'Slash'.
    expect(keyEventOf(key({ key: 'z', code: 'Slash', ctrlKey: true }), 'down')).toMatchObject({
      key: 'z',
    })
  })

  it('leaves a character of AltGr to the text, even where Chrome calls it Ctrl+Alt', () => {
    expect(
      keyEventOf(key({ key: '₽', code: 'Digit8', ctrlKey: true, altKey: true }), 'down'),
    ).toBeNull()
    expect(keyEventOf(key({ key: '@', code: 'KeyQ', altGraph: true }), 'down')).toBeNull()
    // Ctrl+Alt with a key that prints nothing is still a key.
    expect(
      keyEventOf(key({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true }), 'down'),
    ).toMatchObject({ key: 'ArrowLeft', modifiers: ['Alt', 'Control'] })
  })

  it('sends a ⌘ character shortcut as Ctrl on a Mac', () => {
    expect(keyEventOf(key({ key: 'z', code: 'KeyZ', metaKey: true }), 'down', true)).toMatchObject({
      key: 'z',
      modifiers: ['Control'],
    })
    expect(
      keyEventOf(key({ key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true }), 'down', true),
    ).toMatchObject({ modifiers: ['Control', 'Shift'] })
    // ⌘← is not Ctrl+←: it stays Meta.
    expect(
      keyEventOf(key({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true }), 'down', true),
    ).toMatchObject({ modifiers: ['Meta'] })
    expect(keyEventOf(key({ key: 'z', code: 'KeyZ', metaKey: true }), 'down')).toMatchObject({
      modifiers: ['Meta'],
    })
    expect(isApplePlatform({ platform: 'MacIntel' })).toBe(true)
    expect(isApplePlatform({ platform: 'iPhone' })).toBe(true)
    expect(isApplePlatform({ userAgentData: { platform: 'macOS' } })).toBe(true)
    expect(isApplePlatform({ platform: 'Linux x86_64' })).toBe(false)
    expect(isApplePlatform({ userAgentData: { platform: 'Windows' }, platform: 'Win32' })).toBe(
      false,
    )
  })

  it('sends Space as a key: it presses a focused checkbox or button', () => {
    expect(keyEventOf(key({ key: ' ', code: 'Space' }), 'down')).toEqual({
      kind: 'key',
      type: 'down',
      key: ' ',
      code: 'Space',
      modifiers: [],
    })
    expect(keyEventOf(key({ key: ' ', code: 'Space', shiftKey: true }), 'up')).toMatchObject({
      key: ' ',
      modifiers: ['Shift'],
    })
  })

  it('leaves typed characters, a paste, a composition and a lone modifier to other events', () => {
    expect(keyEventOf(key({ key: 'а', code: 'KeyF' }), 'down')).toBeNull()
    expect(keyEventOf(key({ key: 'A', shiftKey: true }), 'down')).toBeNull()
    expect(keyEventOf(key({ key: 'v', code: 'KeyV', ctrlKey: true }), 'down')).toBeNull()
    expect(keyEventOf(key({ key: 'v', code: 'KeyV', metaKey: true }), 'down')).toBeNull()
    expect(keyEventOf(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), 'down')).toBeNull()
    expect(keyEventOf(key({ key: 'Process', code: 'KeyA' }), 'down')).toBeNull()
    expect(keyEventOf(key({ key: 'Enter', isComposing: true }), 'down')).toBeNull()
    // Safari's Enter that ends a composition comes after it, as a key the input method took.
    expect(keyEventOf(key({ key: 'Enter', code: 'Enter', keyCode: 229 }), 'down')).toBeNull()
  })

  it('sends Russian text as it was typed, without control characters', () => {
    expect(textEventsOf('Открыли летнюю веранду')).toEqual([
      { kind: 'text', text: 'Открыли летнюю веранду' },
    ])
    expect(textEventsOf('строка\r\nвторая\u0007')).toEqual([
      { kind: 'text', text: 'строка\nвторая' },
    ])
    expect(textEventsOf('')).toEqual([])
  })

  it('cuts a long paste into parts the stream takes, never inside a pair of surrogates', () => {
    const text = `${'я'.repeat(BROWSER_TEXT_INPUT_MAX_CHARS - 1)}😀конец`
    const events = textEventsOf(text)
    expect(events).toHaveLength(2)
    expect(events.map((event) => (event.kind === 'text' ? event.text : '')).join('')).toBe(text)
    for (const event of events)
      if (event.kind === 'text')
        expect(event.text.length).toBeLessThanOrEqual(BROWSER_TEXT_INPUT_MAX_CHARS)
  })
})

describe('the picture of the page', () => {
  const header = {
    flags: 0,
    frameSeq: 1,
    pageId: 1,
    viewportVersion: 1,
    controlEpoch: 0,
    width: 1280,
    height: 800,
    timestamp: 1,
    sessionId: '0199a3f2-0000-7000-8000-0000000000e1',
  }
  const frame = decodeBrowserFrame(
    encodeBrowserFrame(header, new Uint8Array([0xff, 0xd8, 0xff, 1])),
  )!

  function stand(decode: (jpeg: Uint8Array) => Promise<ImageBitmap>) {
    const canvas = fakeCanvas()
    const context = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    } satisfies PaintContext
    const painter = createFramePainter(canvas, { context, decode })
    return { canvas, context, painter }
  }

  it('draws a frame scaled to fit with margins, sharp on a dense screen', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const { canvas, context, painter } = stand(async () => bitmap)
    painter.resize(640, 600, 2)
    expect([canvas.width, canvas.height]).toEqual([1280, 1200])
    expect(await painter.paint(frame)).toBe(true)
    expect(context.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0)
    // 1280 × 800 into 640 × 600: 640 × 400, 100 px above and below.
    expect(context.drawImage).toHaveBeenLastCalledWith(bitmap, 0, 100, 640, 400)
    expect(painter.painted()).toBe(true)
    // A narrower panel draws the same image again.
    painter.resize(320, 600, 1)
    expect(context.drawImage).toHaveBeenLastCalledWith(bitmap, 0, 200, 320, 200)
  })

  it('keeps the last picture when a frame cannot be decoded', async () => {
    const first = { close: vi.fn() } as unknown as ImageBitmap
    const decode = vi.fn(async () => first)
    const { context, painter } = stand(decode)
    painter.resize(640, 400, 1)
    await painter.paint(frame)
    decode.mockRejectedValueOnce(new Error('broken JPEG'))
    expect(await painter.paint(frame)).toBe(false)
    expect(context.drawImage).toHaveBeenCalledTimes(1)
    painter.dispose()
    expect(first.close).toHaveBeenCalled()
  })
})
