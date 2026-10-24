/**
 * A frame of the stream (docs/plan/57-browser-tasks.md, §3.6): one binary WebSocket message, a
 * 48-byte header then the JPEG of `page.screencast`. Big-endian (network order), `DataView` and
 * `Uint8Array` only: the cabinet decodes it in the browser, the worker encodes it in Node, the
 * gateway passes it through.
 *
 * ```
 *  0 magic 0x52 'R'  u8      16 controlEpoch     u32
 *  1 version 1       u8      20 width            u16
 *  2 kind 1 (JPEG)   u8      22 height           u16
 *  3 flags           u8      24 timestamp (ms)   f64
 *  4 frameSeq        u32     32 sessionId        16 bytes (the UUID's bytes)
 *  8 pageId          u32     48 JPEG
 * 12 viewportVersion u32
 * ```
 */
export const BROWSER_FRAME_MAGIC = 0x52
export const BROWSER_FRAME_VERSION = 1
export const browserFrameKinds = Object.freeze({ jpeg: 1 })
export const BROWSER_FRAME_HEADER_BYTES = 48
/** A whole message, header included; a larger frame is dropped, not sent. */
export const BROWSER_FRAME_MAX_BYTES = 4 * 1024 * 1024

export interface BrowserFrameHeader {
  /** Reserved; 0 in version 1, any value read back as it is. */
  flags: number
  frameSeq: number
  pageId: number
  viewportVersion: number
  controlEpoch: number
  /** Of the image in pixels: the window it shows, possibly scaled down. */
  width: number
  height: number
  /** When Chromium painted it, milliseconds since the epoch. */
  timestamp: number
  sessionId: string
}

export interface BrowserFrame {
  header: BrowserFrameHeader
  /** A view into the message, not a copy. */
  jpeg: Uint8Array
}

const offsets = Object.freeze({
  magic: 0,
  version: 1,
  kind: 2,
  flags: 3,
  frameSeq: 4,
  pageId: 8,
  viewportVersion: 12,
  controlEpoch: 16,
  width: 20,
  height: 22,
  timestamp: 24,
  sessionId: 32,
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The start of every JPEG: SOI then the first marker. */
const JPEG_START = [0xff, 0xd8, 0xff]

const isU8 = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xff
const isU16 = (value: number) => Number.isInteger(value) && value >= 1 && value <= 0xffff
const isU32 = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
const isJpeg = (bytes: Uint8Array) =>
  bytes.length > JPEG_START.length && JPEG_START.every((byte, index) => bytes[index] === byte)

/** The 16 bytes of a UUID in the order it is written; null for anything that is not one. */
export function uuidToBytes(uuid: string): Uint8Array | null {
  if (!UUID.test(uuid)) return null
  const hex = uuid.replaceAll('-', '')
  const bytes = new Uint8Array(16)
  for (let index = 0; index < 16; index++)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return bytes
}

/** The lower-case spelling of 16 bytes as a UUID; null unless there are exactly 16. */
export function bytesToUuid(bytes: Uint8Array): string | null {
  if (bytes.length !== 16) return null
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function headerProblem(header: BrowserFrameHeader): string | null {
  if (!isU8(header.flags)) return 'flags'
  for (const key of ['frameSeq', 'pageId', 'viewportVersion', 'controlEpoch'] as const)
    if (!isU32(header[key])) return key
  if (!isU16(header.width) || !isU16(header.height)) return 'size'
  if (!Number.isFinite(header.timestamp)) return 'timestamp'
  return null
}

/** One message: the header, then the JPEG. Throws on a header or an image it cannot carry. */
export function encodeBrowserFrame(header: BrowserFrameHeader, jpeg: Uint8Array): Uint8Array {
  const problem = headerProblem(header)
  if (problem !== null) throw new RangeError(`Invalid browser frame: ${problem}`)
  const session = uuidToBytes(header.sessionId)
  if (session === null) throw new RangeError('Invalid browser frame: sessionId')
  if (!isJpeg(jpeg)) throw new RangeError('Invalid browser frame: not a JPEG')
  if (BROWSER_FRAME_HEADER_BYTES + jpeg.length > BROWSER_FRAME_MAX_BYTES)
    throw new RangeError('Invalid browser frame: too large')
  const message = new Uint8Array(BROWSER_FRAME_HEADER_BYTES + jpeg.length)
  const view = new DataView(message.buffer)
  view.setUint8(offsets.magic, BROWSER_FRAME_MAGIC)
  view.setUint8(offsets.version, BROWSER_FRAME_VERSION)
  view.setUint8(offsets.kind, browserFrameKinds.jpeg)
  view.setUint8(offsets.flags, header.flags)
  view.setUint32(offsets.frameSeq, header.frameSeq)
  view.setUint32(offsets.pageId, header.pageId)
  view.setUint32(offsets.viewportVersion, header.viewportVersion)
  view.setUint32(offsets.controlEpoch, header.controlEpoch)
  view.setUint16(offsets.width, header.width)
  view.setUint16(offsets.height, header.height)
  view.setFloat64(offsets.timestamp, header.timestamp)
  message.set(session, offsets.sessionId)
  message.set(jpeg, BROWSER_FRAME_HEADER_BYTES)
  return message
}

/**
 * A frame from a binary message, or null for anything else: another magic, version or kind, a
 * short or oversized message, a zero size, an image that is not a JPEG. Never throws. Takes a
 * view at any offset (a Node `Buffer` from a pool) as well as an `ArrayBuffer`.
 */
export function decodeBrowserFrame(data: Uint8Array | ArrayBuffer): BrowserFrame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.length <= BROWSER_FRAME_HEADER_BYTES || bytes.length > BROWSER_FRAME_MAX_BYTES)
    return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    view.getUint8(offsets.magic) !== BROWSER_FRAME_MAGIC ||
    view.getUint8(offsets.version) !== BROWSER_FRAME_VERSION ||
    view.getUint8(offsets.kind) !== browserFrameKinds.jpeg
  )
    return null
  const sessionId = bytesToUuid(bytes.subarray(offsets.sessionId, offsets.sessionId + 16))
  if (sessionId === null) return null
  const header: BrowserFrameHeader = {
    flags: view.getUint8(offsets.flags),
    frameSeq: view.getUint32(offsets.frameSeq),
    pageId: view.getUint32(offsets.pageId),
    viewportVersion: view.getUint32(offsets.viewportVersion),
    controlEpoch: view.getUint32(offsets.controlEpoch),
    width: view.getUint16(offsets.width),
    height: view.getUint16(offsets.height),
    timestamp: view.getFloat64(offsets.timestamp),
    sessionId,
  }
  const jpeg = bytes.subarray(BROWSER_FRAME_HEADER_BYTES)
  if (headerProblem(header) !== null || !isJpeg(jpeg)) return null
  return { header, jpeg }
}
