import { z } from 'zod'

import { browserInputRefusals } from './control.ts'
import {
  BROWSER_MAX_VIEWPORT,
  browserCloseReasons,
  browserEventIdSchema,
  browserPageIdSchema,
  browserSessionLimits,
  browserSessionStateSchema,
  browserU32Schema,
  browserViewportSchema,
  isBrowserViewport,
  type BrowserViewport,
} from './session.ts'

/**
 * Text messages of the stream (docs/plan/57-browser-tasks.md, §3.6): JSON with a type in `t`,
 * between the cabinet and the gateway and, `hello` aside, on between the gateway and the worker.
 * Frames go as binary messages (stream-codec.ts). Whoever reads a message from the other side
 * parses it with these functions and drops what they return null for.
 */

/** A message as JSON text is at most this long; anything longer is dropped unread. */
export const BROWSER_MESSAGE_MAX_CHARS = 64 * 1024
/** Text of one `text` event (a paste, a finished composition). */
export const BROWSER_TEXT_INPUT_MAX_CHARS = 10_000
/** Files given to one chooser, as `web_upload` takes them. */
export const BROWSER_CHOOSER_MAX_FILES = 10

/** 32 random bytes in base64url; the database keeps only the SHA-256 of it (Б12). */
export const browserStreamTicketSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

// ---------------------------------------------------------------------------------------------
// Input events
// ---------------------------------------------------------------------------------------------

/**
 * `KeyboardEvent.key` values of keys that print nothing, as Playwright's keyboard names them.
 * A key outside this list must be one printable character; a composition (IME) or a paste
 * arrives as a `text` event instead.
 */
export const browserNamedKeys = [
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
  'ContextMenu',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
] as const
export type BrowserNamedKey = (typeof browserNamedKeys)[number]

export const browserModifiers = ['Alt', 'Control', 'Meta', 'Shift'] as const
export type BrowserModifier = (typeof browserModifiers)[number]

const namedKeys: ReadonlySet<string> = new Set(browserNamedKeys)
/** Control and format characters, separators other than the space, unpaired surrogates. */
const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u

/** A key of a `key` event: a named key of the list or exactly one printable character. */
export function isBrowserKey(key: string): boolean {
  if (namedKeys.has(key)) return true
  const characters = [...key]
  return characters.length === 1 && !NOT_PRINTABLE.test(key)
}

/** Control characters an editor takes from typed or pasted text: tab and line breaks. */
const TYPED_CONTROLS: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d])

/** Typed text: no control character but a tab or a line break, no unpaired surrogate. */
export function isBrowserTypedText(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 && !TYPED_CONTROLS.has(code)) return false
    if ((code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)) return false
  }
  return true
}

const coordinate = (max: number) => z.number().finite().min(0).max(max)
const x = coordinate(BROWSER_MAX_VIEWPORT.width)
const y = coordinate(BROWSER_MAX_VIEWPORT.height)
const delta = z.number().finite().min(-10_000).max(10_000)

export const browserMouseButtons = ['left', 'middle', 'right', 'none'] as const
export type BrowserMouseButton = (typeof browserMouseButtons)[number]

const mouseEvent = z
  .strictObject({
    kind: z.literal('mouse'),
    type: z.enum(['move', 'down', 'up']),
    x,
    y,
    /** `none` only with `move`: no button is pressed. */
    button: z.enum(browserMouseButtons),
    clickCount: z.number().int().min(0).max(3),
  })
  .refine((event) => (event.button === 'none') === (event.type === 'move'), {
    message: 'expected a button with down and up, none with move',
  })

const wheelEvent = z.strictObject({ kind: z.literal('wheel'), x, y, dx: delta, dy: delta })

const keyEvent = z.strictObject({
  kind: z.literal('key'),
  type: z.enum(['down', 'up']),
  key: z.string().min(1).max(16).refine(isBrowserKey, 'expected a named key or one character'),
  /** `KeyboardEvent.code`; empty where the device does not tell. */
  code: z.string().regex(/^[A-Za-z0-9]{0,32}$/),
  modifiers: z
    .array(z.enum(browserModifiers))
    .max(browserModifiers.length)
    .refine((list) => new Set(list).size === list.length, 'each modifier once'),
})

const textEvent = z.strictObject({
  kind: z.literal('text'),
  text: z
    .string()
    .min(1)
    .max(BROWSER_TEXT_INPUT_MAX_CHARS)
    .refine(isBrowserTypedText, 'expected text without control characters'),
})

export const browserInputEventSchema = z.discriminatedUnion('kind', [
  mouseEvent,
  wheelEvent,
  keyEvent,
  textEvent,
])
export type BrowserInputEvent = z.infer<typeof browserInputEventSchema>

/** Whether a point of an event lies inside the window it is aimed at; keys and text have none. */
export function isBrowserInputInViewport(
  event: BrowserInputEvent,
  viewport: BrowserViewport,
): boolean {
  if (event.kind !== 'mouse' && event.kind !== 'wheel') return true
  return event.x < viewport.width && event.y < viewport.height
}

// ---------------------------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------------------------

const attachmentIds = z
  .array(z.uuid())
  .max(BROWSER_CHOOSER_MAX_FILES)
  .refine((ids) => new Set(ids).size === ids.length, 'each attachment once')

export const browserClientMessageSchema = z.discriminatedUnion('t', [
  /** The first message, to the gateway only; it never reaches the worker. */
  z.strictObject({ t: z.literal('hello'), ticket: browserStreamTicketSchema }),
  /** The viewer drew this frame; the ones before it are done too. */
  z.strictObject({ t: z.literal('ack'), frameSeq: browserU32Schema }),
  z.strictObject({ t: z.literal('pong'), ts: z.number().finite().optional() }),
  /** «Взять управление». */
  z.strictObject({ t: z.literal('take') }),
  /** «Продолжить работу агента» while a turn runs. */
  z.strictObject({ t: z.literal('release') }),
  z.strictObject({
    t: z.literal('input'),
    pageId: browserPageIdSchema,
    controlEpoch: browserU32Schema,
    viewportVersion: browserU32Schema.min(1),
    event: browserInputEventSchema,
  }),
  z.strictObject({
    t: z.literal('navigate'),
    url: z.string().min(1).max(browserSessionLimits.urlChars),
  }),
  /** Show this tab. */
  z.strictObject({ t: z.literal('tab'), pageId: browserPageIdSchema }),
  z.strictObject({
    t: z.literal('dialog'),
    id: browserEventIdSchema,
    accept: z.boolean(),
    text: z.string().max(browserSessionLimits.dialogChars).optional(),
  }),
  /** Attachments of the task for a file chooser of the page; none — the chooser is cancelled. */
  z.strictObject({ t: z.literal('files'), chooserId: browserEventIdSchema, attachmentIds }),
  z
    .strictObject({ t: z.literal('viewport'), ...browserViewportSchema.shape })
    .refine(isBrowserViewport, 'expected one of the offered window sizes'),
])
export type BrowserClientMessage = z.infer<typeof browserClientMessageSchema>

// ---------------------------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------------------------

/** Why the worker or the gateway refused one message; the connection stays. */
export const browserStreamRefusals = [
  ...browserInputRefusals,
  /** The message did not parse or is not allowed at this point. */
  'bad_message',
  /** A point outside the window. */
  'outside_viewport',
  /** The page may not go there (`navigate`). */
  'address_denied',
  /** No such tab, dialog, file chooser or attachment of the task. */
  'page_unknown',
  'dialog_unknown',
  'chooser_unknown',
  'attachment_unknown',
  /** Too many messages; the viewer sends fewer. */
  'busy',
] as const
export type BrowserStreamRefusal = (typeof browserStreamRefusals)[number]

/**
 * Why the connection ends: the session closed (its own reasons), or the gateway ended it — a bad
 * ticket or Origin, membership lost at a recheck, the worker or session gone, broken protocol.
 */
export const browserStreamEndReasons = [
  ...browserCloseReasons,
  'unauthorized',
  'forbidden',
  'unavailable',
  'protocol',
] as const
export type BrowserStreamEndReason = (typeof browserStreamEndReasons)[number]

/**
 * The one path of the stream gateway (apps/preview, Б12): `BROWSER_STREAM_PUBLIC_URL` of the
 * cabinet ends in it, and the gateway refuses any other path, and any query.
 */
export const BROWSER_STREAM_PATH = '/v1/browser/stream'

/**
 * WebSocket close codes of the stream gateway (Б12, §3.6), in the private range 4000–4999.
 * Whenever the viewer can still read it, `closed { reason }` goes first; the code says the same
 * to a client that sees only the close.
 */
export const browserStreamCloseCodes = Object.freeze({
  /** The session itself ended (the task ended, idle, expired, the browser crashed). */
  ended: 4000,
  /** The connection broke the protocol. */
  protocol: 4400,
  /** No `hello` in time, or a ticket that is unknown, spent or expired: ask for a new one. */
  unauthorized: 4401,
  /**
   * The user may not watch this session: refused right after `hello`, or revoked at a recheck —
   * membership, the session or the site is gone.
   */
  forbidden: 4403,
  /** The worker is gone, would not open the stream, or the gateway stops: reconnect later. */
  unavailable: 4503,
})

/** The close code of an end reason; every reason of a session's own end is `ended`. */
export function browserStreamCloseCode(reason: BrowserStreamEndReason): number {
  switch (reason) {
    case 'unauthorized':
      return browserStreamCloseCodes.unauthorized
    case 'forbidden':
      return browserStreamCloseCodes.forbidden
    case 'unavailable':
      return browserStreamCloseCodes.unavailable
    case 'protocol':
      return browserStreamCloseCodes.protocol
    default:
      return browserStreamCloseCodes.ended
  }
}

export const browserServerMessageSchema = z.discriminatedUnion('t', [
  /**
   * The gateway's first message once the worker's stream is open: the viewer id of this
   * connection. The tab holds control while `state.holder` equals it (Б15). Every connection gets
   * a new one, so a tab that reconnects while it held control takes it again with `take`.
   */
  z.strictObject({ t: z.literal('viewer'), viewer: z.uuid() }),
  z.strictObject({ t: z.literal('state'), ...browserSessionStateSchema.shape }),
  z.strictObject({ t: z.literal('ping'), ts: z.number().finite() }),
  z.strictObject({ t: z.literal('refused'), reason: z.enum(browserStreamRefusals) }),
  z.strictObject({ t: z.literal('closed'), reason: z.enum(browserStreamEndReasons) }),
])
export type BrowserServerMessage = z.infer<typeof browserServerMessageSchema>

function parseJson(data: unknown): unknown {
  if (typeof data !== 'string' || data.length > BROWSER_MESSAGE_MAX_CHARS) return undefined
  try {
    return JSON.parse(data) as unknown
  } catch {
    return undefined
  }
}

/** A message of a viewer from its JSON text; null for anything else. Never throws. */
export function parseBrowserClientMessage(data: unknown): BrowserClientMessage | null {
  const parsed = browserClientMessageSchema.safeParse(parseJson(data))
  return parsed.success ? parsed.data : null
}

/** A message of the gateway or the worker from its JSON text; null for anything else. */
export function parseBrowserServerMessage(data: unknown): BrowserServerMessage | null {
  const parsed = browserServerMessageSchema.safeParse(parseJson(data))
  return parsed.success ? parsed.data : null
}
