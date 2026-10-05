import {
  badRequest,
  estimateLlmInputTokens,
  normalizeLlmJson,
  parseLlmJson,
  type JsonObject,
  type JsonPath,
  type LlmBackend,
  type LlmRoute,
} from '@repo/domain'
import { z } from 'zod'
import { isInlineImageDataUrl } from '../data-url.ts'
import { encodeJson } from '../shared.ts'

const functionName = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.startsWith('$'))
const tool = z
  .object({
    type: z.literal('function'),
    function: z
      .object({
        name: functionName,
        description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        strict: z.boolean().optional(),
      })
      .strict(),
  })
  .strict()
const imageUrl = z.string().refine(isInlineImageDataUrl)
const content = z.union([
  z.string(),
  z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }).strict(),
      z
        .object({
          type: z.literal('image_url'),
          image_url: z.object({ url: imageUrl, id: z.string().nullable().optional() }).strict(),
        })
        .strict(),
    ]),
  ),
])
const message = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content, tools: z.array(tool).optional() }).strict(),
  z.object({ role: z.literal('user'), content }).strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: content.nullable().optional(),
      reasoning_content: z.string().optional(),
      tool_calls: z
        .array(
          z
            .object({
              id: z.string().min(1),
              type: z.literal('function'),
              function: z.object({ name: functionName, arguments: z.string() }).strict(),
              extras: z.unknown().optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict(),
  z.object({ role: z.literal('tool'), tool_call_id: z.string().min(1), content }).strict(),
])
const efforts = ['low', 'high', 'max'] as const
const requestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(message).min(1),
    thinking: z
      .object({
        type: z.enum(['enabled', 'disabled']).optional(),
        effort: z.enum(efforts).optional(),
        keep: z.unknown().optional(),
      })
      .strict()
      .optional(),
    tools: z.array(tool).optional(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
    max_completion_tokens: z.number().int().min(1).max(65_536).optional(),
    max_tokens: z.number().int().min(1).max(65_536).optional(),
    prompt_cache_key: z.string().optional(),
  })
  .strict()

export function assertKimiRoute(route: LlmRoute): void {
  if (route.method !== 'POST' || route.path !== '/kimi/v1/chat/completions')
    throw badRequest('Unsupported backend route')
}

/** The shared parser bounds every subtree, including free-form tool schemas and extras. */
export const normalizeKimiBody: LlmBackend['normalizeBody'] = (route, bytes, ctx) => {
  assertKimiRoute(route)
  const root = normalizeLlmJson(parseLlmJson(bytes), {
    kind: 'object',
    fields: {
      model: { kind: 'string' },
      messages: { kind: 'array', items: { kind: 'any' } },
      thinking: { kind: 'any' },
      tools: { kind: 'array', items: { kind: 'any' } },
      stream: { kind: 'boolean' },
      stream_options: { kind: 'any' },
      max_completion_tokens: { kind: 'number' },
      max_tokens: { kind: 'number' },
      prompt_cache_key: { kind: 'string' },
    },
    required: ['model', 'messages'],
  })
  // Kimi's 2 MiB message limit is a request failure; do not let it affect account health.
  // Checked before the schema, so no rule ever runs over a larger body.
  if (encodeJson(root.messages).byteLength > 2 * 1024 * 1024)
    throw badRequest('Kimi messages exceed the size limit')
  const parsed = requestSchema.safeParse(root)
  if (!parsed.success) throw badRequest('Request body violates Kimi policy')
  const request = parsed.data
  if (request.model !== ctx.model || !/^rdt_[0-9a-f]{32}$/.test(ctx.cacheKey))
    throw badRequest('Request does not match model profile')
  const cap =
    ctx.reasoningEffort === null
      ? -1
      : efforts.indexOf(ctx.reasoningEffort as (typeof efforts)[number])
  if (ctx.reasoningEffort !== null && cap === -1) throw badRequest('Invalid reasoning profile')
  const thinking = request.thinking
  if (
    thinking?.effort !== undefined &&
    (thinking.type === 'disabled' || efforts.indexOf(thinking.effort) > cap)
  )
    throw badRequest('Request exceeds reasoning profile')
  if (cap === -1 && thinking?.type === 'enabled')
    throw badRequest('Request exceeds reasoning profile')
  if (cap !== -1 && thinking?.type !== 'disabled')
    request.thinking = { ...thinking, type: 'enabled', effort: thinking?.effort ?? efforts[cap]! }
  request.stream = true
  request.stream_options = { include_usage: true }
  request.prompt_cache_key = ctx.cacheKey
  const imagePaths: JsonPath[] = []
  request.messages.forEach((item, messageIndex) => {
    if (!Array.isArray(item.content)) return
    item.content.forEach((part, partIndex) => {
      if (part.type === 'image_url')
        imagePaths.push(['messages', messageIndex, 'content', partIndex, 'image_url', 'url'])
    })
  })
  // Rebuild in schema order after adding defaults so a second normalization is byte-identical.
  const normalized = requestSchema.parse(request) as JsonObject
  return {
    body: encodeJson(normalized),
    estInputTokens: estimateLlmInputTokens(normalized, { imagePaths }),
  }
}
