import {
  badRequest,
  estimateLlmInputTokens,
  normalizeLlmJson,
  parseLlmJson,
  type JsonObject,
  type LlmBackend,
  type LlmRoute,
} from '@repo/domain'
import { z } from 'zod'

import { encodeJson } from '../shared.ts'

/**
 * The output ceiling of one request: what the pinned CLI asks for itself. The profiles of this
 * backend reserve at least as much (packages/db/prisma/seed/data.ts, `reserveOutputTokens`).
 */
export const zaiMaxOutputTokens = 32_000
/** The levels of the plan's models; a profile of a turn names one of them. */
export const zaiReasoningEfforts = ['low', 'high', 'max'] as const

// A name the model itself wrote into an earlier tool call comes back in the history: no
// pattern, only a bound.
const functionName = z.string().min(1).max(256)
const tool = z.strictObject({
  type: z.literal('function'),
  function: z.strictObject({
    name: functionName,
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
})
const textPart = z.strictObject({ type: z.literal('text'), text: z.string() })
/**
 * A picture of `artifact_render` the helper `look` sends (docs/plan/88-artifacts.md, Ар32): a JPEG or
 * a PNG in a `data:` address, never a link the provider would fetch. Allowed only to a model that
 * sees images, by the profile of the key that sees them.
 */
const imagePart = z.strictObject({
  type: z.literal('image_url'),
  image_url: z.strictObject({
    url: z
      .string()
      .max(4 * 1024 * 1024)
      .regex(/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
})
const mixedParts = z.array(z.union([textPart, imagePart])).min(1)
const message = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('system'), content: z.string() }),
  // The SDK inside the CLI writes one text part as a string and several as a list. No images:
  // the shell of this backend has no image input.
  z.strictObject({ role: z.literal('user'), content: z.union([z.string(), mixedParts]) }),
  z.strictObject({
    role: z.literal('assistant'),
    content: z.string().nullable().optional(),
    reasoning_content: z.string().optional(),
    tool_calls: z
      .array(
        z.strictObject({
          id: z.string().min(1),
          type: z.literal('function'),
          function: z.strictObject({ name: functionName, arguments: z.string() }),
        }),
      )
      .optional(),
  }),
  z.strictObject({
    role: z.literal('tool'),
    tool_call_id: z.string().min(1),
    content: z.union([z.string(), mixedParts]),
  }),
])
/** Everything the pinned CLI sends on its one path, and nothing else. */
const requestSchema = z.strictObject({
  model: z.string().min(1),
  max_tokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  // Read and then replaced: the level of reasoning belongs to the profile of the turn.
  thinking: z
    .strictObject({
      type: z.enum(['enabled', 'disabled']).optional(),
      clear_thinking: z.boolean().optional(),
    })
    .optional(),
  reasoning_effort: z.enum(zaiReasoningEfforts).optional(),
  messages: z.array(message).min(1),
  tools: z.array(tool).optional(),
  tool_choice: z.literal('auto').optional(),
  stream: z.boolean().optional(),
  stream_options: z.strictObject({ include_usage: z.boolean().optional() }).optional(),
})

/**
 * The names a refusal may quote as the place of a violation (`error.field` of the gateway's
 * answer). Only these, never a name or a value of the request, and never an index: the CLI
 * repeats a request whose refusal holds one of its retry numbers (`messages[502].content`).
 */
export const zaiPolicyFields = [
  'model',
  'max_tokens',
  'thinking',
  'type',
  'clear_thinking',
  'reasoning_effort',
  'messages',
  'role',
  'content',
  'text',
  'reasoning_content',
  'tool_calls',
  'id',
  'function',
  'name',
  'arguments',
  'tool_call_id',
  'image_url',
  'url',
  'detail',
  'tools',
  'description',
  'parameters',
  'tool_choice',
  'stream',
  'stream_options',
  'include_usage',
] as const
const policyFields = new Set<string>(zaiPolicyFields)

function fieldOf(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return 'unknown'
  let field = ''
  let known = true
  for (const segment of issue.path) {
    if (typeof segment === 'number') field += '[]'
    else if (typeof segment === 'string' && policyFields.has(segment))
      field += field ? `.${segment}` : segment
    else {
      known = false
      break
    }
  }
  // A key the schema does not have is never named.
  if (!known || issue.code === 'unrecognized_keys') field += field ? '.unknown' : 'unknown'
  return field || 'unknown'
}

const refused = (path: string) => badRequest('Request body violates Z.ai policy', { path })

/**
 * The request policy of one route. The shared parser bounds the tree, free-form tool schemas
 * included, before any rule of the schema runs.
 */
export function createZaiBodyPolicy(
  route: LlmRoute,
  imageModels: readonly string[] = [],
): LlmBackend['normalizeBody'] {
  return (asked, bytes, ctx) => {
    if (asked.method !== route.method || asked.path !== route.path)
      throw badRequest('Unsupported backend route')
    const root = normalizeLlmJson(parseLlmJson(bytes), {
      kind: 'object',
      fields: {
        model: { kind: 'string' },
        max_tokens: { kind: 'number' },
        thinking: { kind: 'any' },
        reasoning_effort: { kind: 'string' },
        messages: { kind: 'array', items: { kind: 'any' } },
        tools: { kind: 'array', items: { kind: 'any' } },
        tool_choice: { kind: 'string' },
        stream: { kind: 'boolean' },
        stream_options: { kind: 'any' },
      },
      required: ['model', 'messages'],
    })
    const parsed = requestSchema.safeParse(root)
    if (!parsed.success) throw refused(fieldOf(parsed.error.issues[0]))
    const request = parsed.data
    if (request.model !== ctx.model) throw refused('model')
    // Pictures only to a model that sees them, and only under the key's profile that does (Ар32).
    const pictures = request.messages.some(
      (each) =>
        Array.isArray(each.content) && each.content.some((part) => part.type === 'image_url'),
    )
    if (pictures && !(ctx.images === true && imageModels.includes(request.model)))
      throw refused('messages[].content[].image_url')
    const effort = ctx.reasoningEffort
    if (effort !== null && !(zaiReasoningEfforts as readonly string[]).includes(effort))
      throw badRequest('Invalid reasoning profile')
    // Written in one fixed order, so that a second normalization changes nothing.
    const normalized: JsonObject = {
      model: request.model,
      max_tokens: Math.min(
        request.max_tokens ?? zaiMaxOutputTokens,
        zaiMaxOutputTokens,
        ctx.maxOutputTokens ?? zaiMaxOutputTokens,
      ),
      // With its own provider id the CLI sends neither field, and without them the provider
      // reasons at its highest level. `clear_thinking: false` keeps the reasoning the CLI
      // sends back with the history, as the CLI's built-in Z.ai provider asks. A profile
      // without a level leaves the provider's defaults, and no request may choose its own.
      ...(effort === null
        ? {}
        : { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: effort }),
      messages: request.messages as JsonObject[],
      ...(request.tools === undefined ? {} : { tools: request.tools as JsonObject[] }),
      ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
      stream: true,
      stream_options: { include_usage: true },
    }
    const body = encodeJson(normalized)
    return { body, estInputTokens: estimateLlmInputTokens(normalized, { encoded: body }) }
  }
}
