import { z } from 'zod'

/**
 * The cloud browser of a task (docs/plan/57-browser-tasks.md, Б10–Б18): one Chromium context per
 * task, owned by the browser worker, watched and driven by the cabinet over the stream and by the
 * agent through the `web` tools. This module holds its states, who controls it, its limits and
 * the state the worker reports — the same object in the API of the worker and on the stream.
 */
export const browserSessionStatuses = ['starting', 'ready', 'closed', 'failed', 'lost'] as const
export type BrowserSessionStatus = (typeof browserSessionStatuses)[number]

/** A session that still holds a browser: the worker may be asked to act in it. */
export const isBrowserSessionLive = (status: BrowserSessionStatus): boolean =>
  status === 'starting' || status === 'ready'

export const browserControllers = ['agent', 'user'] as const
export type BrowserController = (typeof browserControllers)[number]

/** Why the agent asked the client to act in the browser (`web_help`, Б23). */
export const browserHelpReasons = ['login', 'captcha', 'confirm', 'other'] as const
export type BrowserHelpReason = (typeof browserHelpReasons)[number]

/**
 * Why the platform itself stops a pass with a question to the client (Б23): the client controls
 * the browser, or nothing the task saved on the site was confirmed there.
 */
export const browserPlatformQuestionReasons = ['control', 'unconfirmed'] as const
export type BrowserPlatformQuestionReason = (typeof browserPlatformQuestionReasons)[number]

/** Why a session was closed (`browser_sessions.close_reason`, `POST …/close`). */
export const browserCloseReasons = [
  /** The task ended so (Б18). */
  'task_done',
  'task_failed',
  'task_cancelled',
  /** Nobody acted or watched for `idleMinutes`. */
  'idle',
  /** `maxHours` after it started, whatever happens in it. */
  'expired',
  /** The collector found no live task for it, or the database no longer knows it. */
  'orphaned',
  /** The worker is stopping. */
  'shutdown',
  /** The browser or its container died; the client signs in again in a new one. */
  'crashed',
] as const
export type BrowserCloseReason = (typeof browserCloseReasons)[number]

/** Every time and limit of a session (Б13–Б18, §3.5, §3.6); env variables override some. */
export const browserSessionTimings = Object.freeze({
  /** `BROWSER_SESSION_IDLE_MINUTES`: no action and no viewer this long closes the session. */
  idleMinutes: 30,
  /** `BROWSER_SESSION_MAX_HOURS`: the hard deadline of a session. */
  maxHours: 4,
  /** A stream ticket lives this long and opens one connection (`browser.streamTicket`). */
  ticketSeconds: 60,
  /** The gateway checks membership and the session again at least this often. */
  recheckSeconds: 15,
  /** One action of the agent in the page; «Взять управление» waits for it at most this long. */
  agentActionTimeoutMs: 10_000,
  /** One `web_*` call end to end: OpenCode gives an MCP request 60 s. */
  toolCallBudgetMs: 50_000,
})

/** How the worker sends frames (Б13, Б14); the numbers are starting points for measurement. */
export const browserStreamDefaults = Object.freeze({
  /** `BROWSER_STREAM_MAX_FPS`: frames a viewer gets in a second at most. */
  maxFps: 12,
  /** JPEG quality of `page.screencast`. */
  quality: 70,
  /** `BROWSER_STREAM_WINDOW`: frames sent and not yet acknowledged by the viewer. */
  window: 2,
  /** No frame is sent while the socket buffers more than this. */
  maxBufferedBytes: 1024 * 1024,
  /** The gateway pings the viewer this often, frames or not. */
  pingMs: 10_000,
  /** A viewer that hears nothing this long reconnects with a new ticket. */
  clientSilenceMs: 25_000,
})

/** Bounds of the settings an operator may change; outside them the app refuses to start. */
export const browserSettingBounds = Object.freeze({
  idleMinutes: { min: 1, max: 240 },
  maxHours: { min: 1, max: 24 },
  maxFps: { min: 1, max: 30 },
  window: { min: 1, max: 8 },
})

export const browserSessionLimits = Object.freeze({
  /** Pages (tabs) of one session; the worker closes a new one past this. */
  tabs: 8,
  /** An address as the state and the tools carry it. */
  urlChars: 2048,
  titleChars: 300,
  dialogChars: 1000,
  helpChars: 500,
  /** Entries of the `accept` of a file chooser. */
  chooserAccept: 32,
})

// ---------------------------------------------------------------------------------------------
// The window of the browser: a few fixed sizes (Б29)
// ---------------------------------------------------------------------------------------------

export interface BrowserViewport {
  width: number
  height: number
}

export const BROWSER_DEFAULT_VIEWPORT: Readonly<BrowserViewport> = Object.freeze({
  width: 1280,
  height: 800,
})
/** Sizes the menu offers, the default first; anything else is refused. */
export const browserViewports: readonly Readonly<BrowserViewport>[] = Object.freeze([
  BROWSER_DEFAULT_VIEWPORT,
  Object.freeze({ width: 1440, height: 900 }),
  Object.freeze({ width: 1024, height: 768 }),
  Object.freeze({ width: 390, height: 844 }),
])
/** The largest width and height of any allowed size: the bound of a coordinate of input. */
export const BROWSER_MAX_VIEWPORT: Readonly<BrowserViewport> = Object.freeze({
  width: Math.max(...browserViewports.map((size) => size.width)),
  height: Math.max(...browserViewports.map((size) => size.height)),
})

export const isBrowserViewport = (size: BrowserViewport): boolean =>
  browserViewports.some((allowed) => allowed.width === size.width && allowed.height === size.height)

export const browserViewportSchema = z
  .strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .refine(isBrowserViewport, 'expected one of the offered window sizes')

// ---------------------------------------------------------------------------------------------
// What the worker reports (`POST /v1/sessions/ensure`, the `state` message of the stream)
// ---------------------------------------------------------------------------------------------

const U32 = 0xffff_ffff
/** A counter of the frame header: an unsigned 32-bit integer. */
export const browserU32Schema = z.number().int().min(0).max(U32)
/** A page (tab) of the session, numbered by the worker from 1; it never reuses a number. */
export const browserPageIdSchema = z.number().int().min(1).max(U32)
/** A dialog or a file chooser the worker shows, by its own id. */
export const browserEventIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

const oneLine = (value: string) => !/\p{Cc}/u.test(value)
const url = z.string().max(browserSessionLimits.urlChars)
const title = z.string().max(browserSessionLimits.titleChars)

export const browserTabSchema = z.strictObject({ pageId: browserPageIdSchema, url, title })
export type BrowserTab = z.infer<typeof browserTabSchema>

export const browserDialogKinds = ['alert', 'confirm', 'prompt', 'beforeunload'] as const
export type BrowserDialogKind = (typeof browserDialogKinds)[number]

/** A JavaScript dialog of a page, waiting for an answer. */
export const browserDialogSchema = z.strictObject({
  id: browserEventIdSchema,
  kind: z.enum(browserDialogKinds),
  message: z.string().max(browserSessionLimits.dialogChars),
  /** The default text of a `prompt`. */
  defaultValue: z.string().max(browserSessionLimits.dialogChars).optional(),
})
export type BrowserDialog = z.infer<typeof browserDialogSchema>

/** A file chooser a page opened, waiting for files of the task (Б27). */
export const browserChooserSchema = z.strictObject({
  id: browserEventIdSchema,
  multiple: z.boolean(),
  /** The `accept` of the input as the page wrote it: `image/*`, `.pdf`. */
  accept: z
    .array(z.string().min(1).max(128).refine(oneLine, 'expected one line'))
    .max(browserSessionLimits.chooserAccept),
})
export type BrowserChooser = z.infer<typeof browserChooserSchema>

/** What the agent asked the client to do (`web_help`). */
export const browserHelpSchema = z.strictObject({
  reason: z.enum(browserHelpReasons),
  message: z.string().min(1).max(browserSessionLimits.helpChars),
})
export type BrowserHelp = z.infer<typeof browserHelpSchema>

/**
 * The state of a session as its worker holds it. `holder` is the viewer (a tab of the cabinet)
 * whose input is taken while the client controls; `manualReady` — the agent's last action has
 * settled and that input is let through (Б15). `pageId` is null before the first page opens.
 */
export const browserSessionStateSchema = z.strictObject({
  session: z.uuid(),
  status: z.enum(browserSessionStatuses),
  controller: z.enum(browserControllers),
  controlEpoch: browserU32Schema,
  manualReady: z.boolean(),
  holder: z.uuid().nullable(),
  pageId: browserPageIdSchema.nullable(),
  viewportVersion: browserU32Schema.min(1),
  viewport: browserViewportSchema,
  url,
  title,
  tabs: z.array(browserTabSchema).max(browserSessionLimits.tabs),
  dialog: browserDialogSchema.optional(),
  chooser: browserChooserSchema.optional(),
  help: browserHelpSchema.optional(),
})
export type BrowserSessionState = z.infer<typeof browserSessionStateSchema>
