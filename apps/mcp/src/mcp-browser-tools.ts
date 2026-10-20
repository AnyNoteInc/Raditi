import { z } from 'zod'

import { isOneLine } from './content-snapshots.ts'

/**
 * Arguments of the agent's browser tools on the preview of its dialog (docs/plan/53-chat-preview-
 * release.md, Р21). Every tool input is a JSON object schema (strict MCP clients refuse a tool
 * list with one that is not); combinations are refinements, so tools/list shows flat objects.
 * Nothing here names a site, a preview or an origin: the scope of the turn does.
 */

const selector = z
  .string()
  .min(1)
  .max(1024)
  .refine(isOneLine)
  .describe('A Playwright selector: CSS, text=…, role=…')
const role = z
  .string()
  .regex(/^[a-z]{2,32}$/)
  .describe('An ARIA role: button, link, textbox, checkbox…')
const accessibleName = z.string().min(1).max(256).refine(isOneLine)
const state = z.enum(['visible', 'hidden', 'attached', 'detached'])
const text = z.string().min(1).max(1000)

export const browserNavigateArgumentsSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(2048)
    .refine(isOneLine)
    .describe('A path of the preview (/about/?x=1), or an address on the preview origin'),
})

export const browserClickArgumentsSchema = z
  .strictObject({
    selector: selector.optional(),
    role: role.optional(),
    name: accessibleName.optional().describe('With role: the accessible name of the element'),
  })
  .superRefine((value, context) => {
    if ((value.selector === undefined) === (value.role === undefined))
      context.addIssue({ code: 'custom', message: 'Give a selector or a role' })
    else if (value.name !== undefined && value.role === undefined)
      context.addIssue({ code: 'custom', message: 'A name goes with a role' })
  })

export const browserFillArgumentsSchema = z.strictObject({
  selector,
  value: z
    .string()
    .max(10_000)
    .describe('Text to type; contact markers of this task are filled in as the contacts'),
})

export const browserExpectArgumentsSchema = z
  .strictObject({
    selector,
    state: state.optional().describe('Expected state; visible when neither is given'),
    text: text.optional().describe('Text the element must contain'),
  })
  .superRefine((value, context) => {
    if (value.state !== undefined && value.text !== undefined)
      context.addIssue({ code: 'custom', message: 'Give a state or a text' })
  })

export const browserNoArgumentsSchema = z.strictObject({})

/** One declarative check: a page and what it must show. Executed by the platform, not code. */
export const browserCheckSchema = z
  .strictObject({
    path: browserNavigateArgumentsSchema.shape.path,
    status: z.number().int().min(100).max(599).optional().describe('Expected HTTP status'),
    selector: selector.optional(),
    state: state.optional(),
    text: text.optional(),
  })
  .superRefine((value, context) => {
    if ((value.state !== undefined || value.text !== undefined) && value.selector === undefined)
      context.addIssue({ code: 'custom', message: 'A state or a text goes with a selector' })
    if (value.state !== undefined && value.text !== undefined)
      context.addIssue({ code: 'custom', message: 'Give a state or a text' })
  })

export const browserRunChecksArgumentsSchema = z.strictObject({
  checks: z.array(browserCheckSchema).min(1).max(10),
})

export type BrowserNavigateArguments = z.infer<typeof browserNavigateArgumentsSchema>
export type BrowserClickArguments = z.infer<typeof browserClickArgumentsSchema>
export type BrowserFillArguments = z.infer<typeof browserFillArgumentsSchema>
export type BrowserExpectArguments = z.infer<typeof browserExpectArgumentsSchema>
export type BrowserCheck = z.infer<typeof browserCheckSchema>
export type BrowserRunChecksArguments = z.infer<typeof browserRunChecksArgumentsSchema>
