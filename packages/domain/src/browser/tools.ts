import { z } from 'zod'

import { DomainError } from '../errors.ts'
import {
  browserCheckpointKinds,
  browserCheckpointStates,
  browserObjectIdSchema,
  browserVerifiedObjectSchema,
} from './checkpoint.ts'
import {
  browserAgentChooserSchema,
  browserAgentDialogSchema,
  browserObservationIdSchema,
  browserObservationLimits,
  browserObservationSchema,
  browserObservedCheckpointSchema,
  browserRefSchema,
} from './observation.ts'
import {
  browserHelpReasons,
  browserPageIdSchema,
  browserScreenshotLimits,
  browserSessionLimits,
  browserTabSchema,
} from './session.ts'
import { BROWSER_CHOOSER_MAX_FILES, isBrowserKey, isBrowserTypedText } from './stream-messages.ts'

/**
 * The agent's browser tools (docs/plan/57-browser-tasks.md, Б20, §3.7): the MCP family `web`,
 * named to the model `raditi_web_*`. The agent reads a page as text (`web_observe`) and acts on an
 * element by a reference of the latest observation; it never gets Playwright, CDP, scripts,
 * cookies or pixels. The `apps/mcp` role checks the arguments with these schemas and passes the
 * action on to the worker (`browserActionSchema`); the worker answers with a result of the tool or
 * one of the fixed codes, whose text names no address and no value of a field.
 */
export const browserToolNames = [
  'web_open',
  'web_observe',
  'web_click',
  'web_fill',
  'web_type',
  'web_press',
  'web_scroll',
  'web_tab',
  'web_upload',
  'web_dialog',
  'web_wait',
  'web_help',
  'web_verify',
  'web_screenshot',
] as const
export type BrowserToolName = (typeof browserToolNames)[number]

/** An answer of a tool to the agent, as JSON in UTF-8, is at most this large. */
export const BROWSER_TOOL_RESPONSE_MAX_BYTES = 64 * 1024
export const browserToolLimits = Object.freeze({
  textChars: 10_000,
  /** `web_wait` waits at most this long; the call stays within its budget. */
  waitMs: 15_000,
  scrollPixels: 10_000,
  /** Lines of text `web_wait` may wait for. */
  waitTextChars: 200,
  /** Objects `web_verify` reports. */
  verifyObjects: 32,
})

/** The key of a snapshot of a task's browser in the inbox bucket. */
export const browserTaskScreenshotKey = (taskId: string, screenshotId: string): string => {
  const ids = z.uuid()
  if (!ids.safeParse(taskId).success || !ids.safeParse(screenshotId).success)
    throw new DomainError('BAD_REQUEST', 'A snapshot key is built from two ids', 400)
  return `screenshots/${taskId.toLowerCase()}/${screenshotId.toLowerCase()}.jpg`
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

/** Modifiers of a key combination, as Playwright's `keyboard.press` takes them. */
const COMBO = /^((?:(?:Alt|Control|ControlOrMeta|Meta|Shift)\+)*)(.+)$/

/** `Enter`, `Control+A`, `Shift+Tab`, `Control++`: modifiers each once, then a key of the list. */
export function isBrowserKeyCombo(text: string): boolean {
  const match = COMBO.exec(text)
  if (!match) return false
  const modifiers = (match[1] ?? '').split('+').filter(Boolean)
  return new Set(modifiers).size === modifiers.length && isBrowserKey(match[2] ?? '')
}

const text = z
  .string()
  .max(browserToolLimits.textChars)
  .refine(isBrowserTypedText, 'expected text without control characters')
const address = z.string().min(1).max(browserSessionLimits.urlChars)
const attachmentIds = z
  .array(z.uuid())
  .min(1)
  .max(BROWSER_CHOOSER_MAX_FILES)
  .refine((ids) => new Set(ids).size === ids.length, 'each attachment once')

/** An element of an observation, or none: the two come together. */
const target = {
  observation: browserObservationIdSchema.optional(),
  ref: browserRefSchema.optional(),
}
const together = (args: { observation?: string; ref?: string }) =>
  (args.observation === undefined) === (args.ref === undefined)
const togetherMessage = { message: 'expected an observation and a reference together' }

const shapes = {
  web_open: { url: address },
  web_observe: {
    maxChars: z
      .number()
      .int()
      .min(browserObservationLimits.minChars)
      .max(browserObservationLimits.maxChars)
      .optional(),
    /** Only the subtree of this element of the latest observation. */
    ref: browserRefSchema.optional(),
  },
  web_click: {
    observation: browserObservationIdSchema,
    ref: browserRefSchema,
    button: z.enum(['left', 'right', 'middle']).optional(),
    double: z.boolean().optional(),
  },
  /** Replaces the field's value. */
  web_fill: { observation: browserObservationIdSchema, ref: browserRefSchema, text },
  /** Inserts text where the focus is (the block editor's paragraphs). */
  web_type: { text: text.min(1) },
  web_press: {
    key: z.string().min(1).max(64).refine(isBrowserKeyCombo, 'expected a key or a combination'),
    ...target,
  },
  web_scroll: {
    direction: z.enum(['up', 'down', 'left', 'right']),
    /** Pixels; the worker scrolls a screen when absent. */
    amount: z.number().int().min(1).max(browserToolLimits.scrollPixels).optional(),
    ...target,
  },
  web_tab: {
    action: z.enum(['list', 'select', 'close']),
    pageId: browserPageIdSchema.optional(),
  },
  /**
   * Attachments of the task into the file input of a reference, or — with none — into the file
   * chooser that waits (`chooser` of the observation, Б27).
   */
  web_upload: { ...target, attachmentIds },
  web_dialog: {
    accept: z.boolean(),
    text: z.string().max(browserSessionLimits.dialogChars).optional(),
  },
  web_wait: {
    ms: z.number().int().min(1).max(browserToolLimits.waitMs),
    until: z.enum(['load', 'networkidle']).optional(),
    text: z.string().min(1).max(browserToolLimits.waitTextChars).optional(),
  },
  /** Asks the client to act in the browser; the agent then ends its turn. */
  web_help: {
    reason: z.enum(browserHelpReasons),
    message: z.string().min(1).max(browserSessionLimits.helpChars),
  },
  web_verify: { expect: z.enum(['publish', 'draft', 'any']).optional() },
  /** A snapshot of the shown page for the client: attached to the dialog, never to the model. */
  web_screenshot: {},
} as const

const tabTarget = (args: { action: string; pageId?: number }) =>
  (args.action === 'list') === (args.pageId === undefined)
const tabMessage = { message: 'expected a page with select and close, none with list' }

export const browserToolArgumentSchemas = {
  web_open: z.strictObject(shapes.web_open),
  web_observe: z.strictObject(shapes.web_observe),
  web_click: z.strictObject(shapes.web_click),
  web_fill: z.strictObject(shapes.web_fill),
  web_type: z.strictObject(shapes.web_type),
  web_press: z.strictObject(shapes.web_press).refine(together, togetherMessage),
  web_scroll: z.strictObject(shapes.web_scroll).refine(together, togetherMessage),
  web_tab: z.strictObject(shapes.web_tab).refine(tabTarget, tabMessage),
  web_upload: z.strictObject(shapes.web_upload).refine(together, togetherMessage),
  web_dialog: z.strictObject(shapes.web_dialog),
  web_wait: z.strictObject(shapes.web_wait),
  web_help: z.strictObject(shapes.web_help),
  web_verify: z.strictObject(shapes.web_verify),
  web_screenshot: z.strictObject(shapes.web_screenshot),
} as const satisfies Record<BrowserToolName, z.ZodType>
export type BrowserToolArguments<T extends BrowserToolName> = z.infer<
  (typeof browserToolArgumentSchemas)[T]
>

/** One action of the agent as `apps/mcp` sends it to the worker: the tool and its arguments. */
export const browserActionSchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('web_open'), ...shapes.web_open }),
  z.strictObject({ tool: z.literal('web_observe'), ...shapes.web_observe }),
  z.strictObject({ tool: z.literal('web_click'), ...shapes.web_click }),
  z.strictObject({ tool: z.literal('web_fill'), ...shapes.web_fill }),
  z.strictObject({ tool: z.literal('web_type'), ...shapes.web_type }),
  z
    .strictObject({ tool: z.literal('web_press'), ...shapes.web_press })
    .refine(together, togetherMessage),
  z
    .strictObject({ tool: z.literal('web_scroll'), ...shapes.web_scroll })
    .refine(together, togetherMessage),
  z.strictObject({ tool: z.literal('web_tab'), ...shapes.web_tab }).refine(tabTarget, tabMessage),
  z
    .strictObject({ tool: z.literal('web_upload'), ...shapes.web_upload })
    .refine(together, togetherMessage),
  z.strictObject({ tool: z.literal('web_dialog'), ...shapes.web_dialog }),
  z.strictObject({ tool: z.literal('web_wait'), ...shapes.web_wait }),
  z.strictObject({ tool: z.literal('web_help'), ...shapes.web_help }),
  z.strictObject({ tool: z.literal('web_verify'), ...shapes.web_verify }),
  z.strictObject({ tool: z.literal('web_screenshot'), ...shapes.web_screenshot }),
])
export type BrowserAction = z.infer<typeof browserActionSchema>

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/** Where an action left the browser, and what now waits for the agent. */
const outcome = {
  page: browserTabSchema,
  dialog: browserAgentDialogSchema.optional(),
  chooser: browserAgentChooserSchema.optional(),
  checkpoint: browserObservedCheckpointSchema.optional(),
}

/** An object of the task as `web_verify` found it on the site. */
export const browserVerifiedCheckpointSchema = z.strictObject({
  kind: z.enum(browserCheckpointKinds),
  objectId: browserObjectIdSchema,
  state: z.enum(browserCheckpointStates),
  object: browserVerifiedObjectSchema.optional(),
})
export type BrowserVerifiedCheckpoint = z.infer<typeof browserVerifiedCheckpointSchema>

/** What the worker answers each tool with; `apps/mcp` masks contacts in it before the agent. */
export const browserToolResultSchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('web_open'), ...outcome }),
  z.strictObject({ tool: z.literal('web_observe'), ...browserObservationSchema.shape }),
  z.strictObject({ tool: z.literal('web_click'), ...outcome }),
  z.strictObject({ tool: z.literal('web_fill'), ...outcome }),
  z.strictObject({ tool: z.literal('web_type'), ...outcome }),
  z.strictObject({ tool: z.literal('web_press'), ...outcome }),
  z.strictObject({ tool: z.literal('web_scroll'), ...outcome }),
  z.strictObject({
    tool: z.literal('web_tab'),
    /** The page shown now; null — the last one was closed. */
    page: browserTabSchema.nullable(),
    tabs: z.array(browserTabSchema).max(browserSessionLimits.tabs),
  }),
  z.strictObject({
    tool: z.literal('web_upload'),
    ...outcome,
    uploaded: z.number().int().min(1).max(BROWSER_CHOOSER_MAX_FILES),
  }),
  z.strictObject({ tool: z.literal('web_dialog'), ...outcome }),
  /** `matched` — the text appeared (or, without one, the page reached the state) in time. */
  z.strictObject({ tool: z.literal('web_wait'), ...outcome, matched: z.boolean() }),
  z.strictObject({
    tool: z.literal('web_help'),
    requested: z.literal(true),
    reason: z.enum(browserHelpReasons),
  }),
  /** `matched` — every verified object has the status asked for (`any` by default). */
  z.strictObject({
    tool: z.literal('web_verify'),
    objects: z.array(browserVerifiedCheckpointSchema).max(browserToolLimits.verifyObjects),
    matched: z.boolean(),
  }),
  /** The snapshot is attached to the dialog as its `number`-th of the task; no pixel comes back. */
  z.strictObject({
    tool: z.literal('web_screenshot'),
    page: browserTabSchema,
    attached: z.literal(true),
    number: z.number().int().min(1).max(browserScreenshotLimits.perTask),
  }),
])
export type BrowserToolResult = z.infer<typeof browserToolResultSchema>

// ---------------------------------------------------------------------------------------------
// Fixed codes (§3.7)
// ---------------------------------------------------------------------------------------------

export const browserTaskCodeNames = [
  'BROWSER_SESSION_UNAVAILABLE',
  'BROWSER_USER_IN_CONTROL',
  'BROWSER_STALE_OBSERVATION',
  'BROWSER_ACTION_DENIED',
  'BROWSER_ADDRESS_DENIED',
  'BROWSER_TIMEOUT',
  'BROWSER_ACTION_FAILED',
  'BROWSER_CHECKPOINT_UNVERIFIED',
  'BROWSER_ATTACHMENT_UNKNOWN',
  'BROWSER_UPLOAD_REFUSED',
] as const
export type BrowserTaskCode = (typeof browserTaskCodeNames)[number]

/** The HTTP status of each code and what the agent reads: no address, no value of a field. */
export const browserTaskCodes: Readonly<
  Record<BrowserTaskCode, Readonly<{ status: number; message: string }>>
> = Object.freeze({
  BROWSER_SESSION_UNAVAILABLE: {
    status: 503,
    message: 'The browser is not available now. End the turn and tell the client.',
  },
  BROWSER_USER_IN_CONTROL: {
    status: 409,
    message: 'The client controls the browser. End the turn and wait for the client.',
  },
  BROWSER_STALE_OBSERVATION: {
    status: 409,
    message: 'The page changed. Call web_observe and use references of the new observation.',
  },
  BROWSER_ACTION_DENIED: {
    status: 403,
    message: 'This page or action is not allowed for this task.',
  },
  BROWSER_ADDRESS_DENIED: { status: 403, message: 'This address is outside the site.' },
  BROWSER_TIMEOUT: { status: 504, message: 'The page did not respond in time.' },
  BROWSER_ACTION_FAILED: {
    status: 502,
    message: 'The action could not be done on this element.',
  },
  BROWSER_CHECKPOINT_UNVERIFIED: {
    status: 409,
    message: 'A saved object is not confirmed yet. Call web_verify before you go on.',
  },
  BROWSER_ATTACHMENT_UNKNOWN: {
    status: 404,
    message: 'This is not a file attached to the task.',
  },
  BROWSER_UPLOAD_REFUSED: { status: 422, message: 'The page did not accept the file.' },
})

/** The error a refused call raises; its message is the fixed text of the code. */
export const browserTaskError = (code: BrowserTaskCode): DomainError =>
  new DomainError(code, browserTaskCodes[code].message, browserTaskCodes[code].status)
