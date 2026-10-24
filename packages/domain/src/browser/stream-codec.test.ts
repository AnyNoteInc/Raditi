import { describe, expect, it } from 'vitest'

import {
  BROWSER_FRAME_HEADER_BYTES,
  BROWSER_FRAME_MAX_BYTES,
  bytesToUuid,
  decodeBrowserFrame,
  encodeBrowserFrame,
  uuidToBytes,
  type BrowserFrameHeader,
} from './stream-codec.ts'

const sessionId = '0196abcd-ef01-7234-8567-89abcdef0123'
const header: BrowserFrameHeader = {
  flags: 0,
  frameSeq: 4_000_000_001,
  pageId: 3,
  viewportVersion: 2,
  controlEpoch: 7,
  width: 1280,
  height: 800,
  timestamp: 1_792_000_000_123.5,
  sessionId,
}
/** SOI, an APP0 marker and a few bytes: enough of a JPEG for the codec. */
const jpeg = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
])

describe('UUID bytes', () => {
  it('writes a UUID as its 16 bytes in order and reads them back in lower case', () => {
    const bytes = uuidToBytes(sessionId.toUpperCase())
    expect(Array.from(bytes ?? [])).toEqual([
      0x01, 0x96, 0xab, 0xcd, 0xef, 0x01, 0x72, 0x34, 0x85, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01,
      0x23,
    ])
    expect(bytesToUuid(bytes ?? new Uint8Array())).toBe(sessionId)
  })

  it('refuses what is not a UUID or not 16 bytes', () => {
    for (const text of [
      '',
      'session',
      `${sessionId}0`,
      sessionId.replaceAll('-', ''),
      `{${sessionId}}`,
    ])
      expect(uuidToBytes(text), text).toBeNull()
    expect(bytesToUuid(new Uint8Array(15))).toBeNull()
    expect(bytesToUuid(new Uint8Array(17))).toBeNull()
  })
})

describe('browser frames', () => {
  it('lays the header out as §3.6 says: 48 bytes, big-endian, then the JPEG', () => {
    const message = encodeBrowserFrame(header, jpeg)
    expect(message.length).toBe(BROWSER_FRAME_HEADER_BYTES + jpeg.length)
    const view = new DataView(message.buffer)
    expect(view.getUint8(0)).toBe(0x52)
    expect(view.getUint8(1)).toBe(1)
    expect(view.getUint8(2)).toBe(1)
    expect(view.getUint8(3)).toBe(0)
    expect(view.getUint32(4)).toBe(header.frameSeq)
    expect(view.getUint32(8)).toBe(3)
    expect(view.getUint32(12)).toBe(2)
    expect(view.getUint32(16)).toBe(7)
    expect(view.getUint16(20)).toBe(1280)
    expect(view.getUint16(22)).toBe(800)
    expect(view.getFloat64(24)).toBe(header.timestamp)
    expect(bytesToUuid(message.subarray(32, 48))).toBe(sessionId)
    expect(Array.from(message.subarray(48))).toEqual(Array.from(jpeg))
  })

  it('reads back what it wrote, from a view at any offset or an ArrayBuffer', () => {
    const message = encodeBrowserFrame({ ...header, flags: 0x80 }, jpeg)
    const decoded = decodeBrowserFrame(message)
    expect(decoded?.header).toEqual({ ...header, flags: 0x80 })
    expect(Array.from(decoded?.jpeg ?? [])).toEqual(Array.from(jpeg))

    // A Node Buffer from a pool is a view into a larger buffer.
    const pool = new Uint8Array(message.length + 13)
    pool.set(message, 13)
    const shifted = decodeBrowserFrame(pool.subarray(13))
    expect(shifted?.header).toEqual({ ...header, flags: 0x80 })
    expect(shifted?.jpeg.byteOffset).toBe(13 + BROWSER_FRAME_HEADER_BYTES)

    expect(decodeBrowserFrame(message.slice().buffer)?.header.sessionId).toBe(sessionId)
  })

  it('keeps the edges of every field', () => {
    for (const edge of [
      { frameSeq: 0, pageId: 0, viewportVersion: 0, controlEpoch: 0, width: 1, height: 1 },
      {
        frameSeq: 0xffff_ffff,
        pageId: 0xffff_ffff,
        viewportVersion: 0xffff_ffff,
        controlEpoch: 0xffff_ffff,
        width: 0xffff,
        height: 0xffff,
        flags: 0xff,
        timestamp: 0,
      },
    ]) {
      const value = { ...header, ...edge }
      expect(decodeBrowserFrame(encodeBrowserFrame(value, jpeg))?.header).toEqual(value)
    }
  })

  it('refuses to write a header or an image it cannot carry', () => {
    for (const [field, value] of [
      ['flags', 256],
      ['frameSeq', -1],
      ['frameSeq', 2 ** 32],
      ['pageId', 1.5],
      ['viewportVersion', Number.NaN],
      ['controlEpoch', 2 ** 32],
      ['width', 0],
      ['height', 65_536],
      ['timestamp', Number.POSITIVE_INFINITY],
      ['sessionId', 'not-a-uuid'],
    ] as const)
      expect(() => encodeBrowserFrame({ ...header, [field]: value }, jpeg), field).toThrow(
        RangeError,
      )
    expect(() => encodeBrowserFrame(header, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(
      'not a JPEG',
    )
    expect(() => encodeBrowserFrame(header, new Uint8Array())).toThrow('not a JPEG')
    const huge = new Uint8Array(BROWSER_FRAME_MAX_BYTES)
    huge.set([0xff, 0xd8, 0xff])
    expect(() => encodeBrowserFrame(header, huge)).toThrow('too large')
  })

  it('returns null for anything that is not a frame of this version, and never throws', () => {
    const message = encodeBrowserFrame(header, jpeg)
    const changed = (offset: number, byte: number) => {
      const copy = message.slice()
      copy[offset] = byte
      return copy
    }
    for (const [name, bytes] of [
      ['empty', new Uint8Array()],
      ['header only', message.subarray(0, BROWSER_FRAME_HEADER_BYTES)],
      ['short', message.subarray(0, 20)],
      ['magic', changed(0, 0x53)],
      ['version', changed(1, 2)],
      ['kind', changed(2, 2)],
      [
        'zero width',
        (() => {
          const copy = message.slice()
          new DataView(copy.buffer).setUint16(20, 0)
          return copy
        })(),
      ],
      ['not a JPEG', changed(48, 0x00)],
      ['text', new TextEncoder().encode(JSON.stringify({ t: 'state' }).padEnd(80, ' '))],
    ] as const)
      expect(decodeBrowserFrame(bytes), name).toBeNull()
    const huge = new Uint8Array(BROWSER_FRAME_MAX_BYTES + 1)
    huge.set(message)
    expect(decodeBrowserFrame(huge)).toBeNull()
    const nan = message.slice()
    new DataView(nan.buffer).setFloat64(24, Number.NaN)
    expect(decodeBrowserFrame(nan)).toBeNull()
  })
})
