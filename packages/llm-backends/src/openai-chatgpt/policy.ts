import {
  badRequest,
  estimateLlmInputTokens,
  forbidden,
  normalizeLlmJson,
  parseLlmJson,
  type JsonObject,
  type JsonObjectPolicy,
  type JsonPath,
  type JsonPolicy,
  type JsonValue,
  type LlmBackend,
  type LlmRoute,
} from '@repo/domain'

import { isInlineImageDataUrl } from '../data-url.ts'

const string: JsonPolicy = { kind: 'string' }
const boolean: JsonPolicy = { kind: 'boolean' }
const any: JsonPolicy = { kind: 'any' }
const objectPolicy = (
  fields: JsonObjectPolicy['fields'],
  required: readonly string[] = [],
): JsonObjectPolicy => ({ kind: 'object', fields, required })

const topPolicy: JsonObjectPolicy = {
  ...objectPolicy(
    {
      model: string,
      store: boolean,
      stream: boolean,
      input: any,
      instructions: string,
      tools: { kind: 'array', items: any },
      tool_choice: any,
      parallel_tool_calls: boolean,
      include: { kind: 'array', items: string },
      reasoning: objectPolicy({ effort: string, summary: string, context: string }),
      text: objectPolicy({ format: any, verbosity: string }),
      prompt_cache_key: string,
    },
    ['model', 'store', 'stream', 'input'],
  ),
  strip: ['service_tier', 'client_metadata'],
}

function reject(path: string): never {
  throw badRequest('Request body violates JSON policy', {
    reason: 'value',
    path: path.slice(0, 64),
  })
}

function record(value: JsonValue | undefined, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject(path)
  return value
}

function oneOf(value: JsonValue | undefined, values: readonly string[], path: string): void {
  if (typeof value !== 'string' || !values.includes(value)) reject(path)
}

function shape(value: JsonValue, policy: JsonObjectPolicy, path: string): JsonObject {
  // Wrapping retains a schema-owned path, without exposing rejected names or values.
  return normalizeLlmJson({ [path]: value }, objectPolicy({ [path]: policy }))[path] as JsonObject
}

export function assertCodexRoute(route: LlmRoute): void {
  if (route.method !== 'POST' || route.path !== '/codex/responses')
    throw forbidden('Unsupported subscription route')
}

function normalizeParts(
  value: JsonValue | undefined,
  path: JsonPath,
  imagePaths: JsonPath[],
): JsonValue {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) reject('input.content')
  return value.map((part, index) => {
    const candidate = record(part, 'input.content')
    const type = candidate.type
    if (type === 'input_image') {
      const normalized = shape(
        candidate,
        objectPolicy({ type: string, image_url: string, detail: string }, ['type', 'image_url']),
        'content',
      )
      if (typeof normalized.image_url !== 'string' || !isInlineImageDataUrl(normalized.image_url))
        reject('input.content.image_url')
      if (normalized.detail !== undefined)
        oneOf(normalized.detail, ['auto', 'low', 'high', 'original'], 'input.content.detail')
      imagePaths.push([...path, index, 'image_url'])
      return normalized
    }
    if (type === 'refusal')
      return shape(
        candidate,
        objectPolicy({ type: string, refusal: string }, ['type', 'refusal']),
        'content',
      )
    oneOf(type, ['input_text', 'output_text', 'summary_text'], 'input.content.type')
    return shape(
      candidate,
      objectPolicy({ type: string, text: string }, ['type', 'text']),
      'content',
    )
  })
}

function normalizeInput(
  value: JsonValue,
  imagePaths: JsonPath[],
  encryptedContentPaths: JsonPath[],
): JsonValue {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) reject('input')
  return value.map((item, index) => {
    const candidate = { ...record(item, 'input') }
    // Responses Lite adds internal attribution to input items. It is neither model input
    // nor part of the gateway protocol, and may carry client-specific metadata.
    delete candidate.internal_chat_message_metadata_passthrough
    const type = candidate.type ?? (candidate.role !== undefined ? 'message' : undefined)
    let result: JsonObject
    switch (type) {
      case 'additional_tools':
        result = shape(
          candidate,
          objectPolicy(
            { type: string, id: string, role: string, tools: { kind: 'array', items: any } },
            ['type', 'role', 'tools'],
          ),
          'input',
        )
        oneOf(result.role, ['developer'], 'input.role')
        result.tools = (result.tools as JsonValue[]).map((tool) => normalizeTool(tool))
        break
      case 'message':
        result = shape(
          candidate,
          objectPolicy(
            { type: string, role: string, content: any, id: string, status: string, phase: string },
            ['role', 'content'],
          ),
          'input',
        )
        oneOf(result.role, ['system', 'developer', 'user', 'assistant'], 'input.role')
        result.content = normalizeParts(result.content, ['input', index, 'content'], imagePaths)
        if (result.phase !== undefined)
          oneOf(result.phase, ['commentary', 'final_answer'], 'input.phase')
        break
      case 'reasoning':
        result = shape(
          candidate,
          objectPolicy(
            {
              type: string,
              id: string,
              summary: any,
              content: any,
              encrypted_content: any,
              status: string,
            },
            ['type'],
          ),
          'input',
        )
        if (result.summary !== undefined)
          result.summary = normalizeReasoningText(result.summary, ['summary_text'])
        if (result.content != null)
          result.content = normalizeReasoningText(result.content, ['reasoning_text', 'text'])
        if (result.encrypted_content != null) {
          if (typeof result.encrypted_content !== 'string') reject('input.encrypted_content')
          encryptedContentPaths.push(['input', index, 'encrypted_content'])
        }
        break
      case 'function_call':
        result = shape(
          candidate,
          objectPolicy(
            {
              type: string,
              id: string,
              call_id: string,
              name: string,
              namespace: string,
              arguments: string,
              status: string,
            },
            ['type', 'call_id', 'name', 'arguments'],
          ),
          'input',
        )
        break
      case 'custom_tool_call':
        result = shape(
          candidate,
          objectPolicy(
            {
              type: string,
              id: string,
              call_id: string,
              name: string,
              namespace: string,
              input: string,
              status: string,
            },
            ['type', 'call_id', 'name', 'input'],
          ),
          'input',
        )
        break
      case 'function_call_output':
      case 'custom_tool_call_output':
        result = shape(
          candidate,
          objectPolicy(
            {
              type: string,
              id: string,
              call_id: string,
              name: string,
              namespace: string,
              output: any,
              status: string,
            },
            ['type', 'call_id', 'output'],
          ),
          'input',
        )
        result.output = normalizeParts(result.output, ['input', index, 'output'], imagePaths)
        break
      default:
        reject('input.type')
    }
    if (result.status !== undefined)
      oneOf(result.status, ['in_progress', 'completed', 'incomplete'], 'input.status')
    return result
  })
}

function normalizeReasoningText(value: JsonValue, allowed: readonly string[]): JsonValue {
  if (!Array.isArray(value)) reject('input.reasoning')
  return value.map((part) => {
    const result = shape(
      part,
      objectPolicy({ type: string, text: string }, ['type', 'text']),
      'reasoning',
    )
    oneOf(result.type, allowed, 'input.reasoning.type')
    return result
  })
}

function normalizeTool(value: JsonValue, namespace = false): JsonObject {
  const candidate = record(value, 'tools')
  if (candidate.type === 'function') {
    const result = shape(
      candidate,
      objectPolicy(
        { type: string, name: string, description: string, parameters: any, strict: any },
        ['type', 'name'],
      ),
      'tools',
    )
    if (result.parameters !== undefined) record(result.parameters, 'tools.parameters')
    if (result.strict !== undefined && result.strict !== null && typeof result.strict !== 'boolean')
      reject('tools.strict')
    return result
  }
  // Responses Lite groups both function and custom tools. Namespace nesting and
  // provider-hosted tool types remain forbidden.
  if (namespace && candidate.type !== 'custom') reject('tools.type')
  if (candidate.type === 'namespace') {
    const result = shape(
      candidate,
      objectPolicy(
        { type: string, name: string, description: string, tools: { kind: 'array', items: any } },
        ['type', 'name', 'tools'],
      ),
      'tools',
    )
    result.tools = (result.tools as JsonValue[]).map((tool) => normalizeTool(tool, true))
    return result
  }
  if (candidate.type === 'custom') {
    const result = shape(
      candidate,
      objectPolicy({ type: string, name: string, description: string, format: any }, [
        'type',
        'name',
      ]),
      'tools',
    )
    if (result.format !== undefined) {
      const format = record(result.format, 'tools.format')
      oneOf(format.type, ['text', 'grammar'], 'tools.format.type')
      result.format = shape(
        format,
        format.type === 'text'
          ? objectPolicy({ type: string }, ['type'])
          : objectPolicy({ type: string, syntax: string, definition: string }, [
              'type',
              'syntax',
              'definition',
            ]),
        'format',
      )
      if (format.type === 'grammar') oneOf(format.syntax, ['lark', 'regex'], 'tools.format.syntax')
    }
    return result
  }
  reject('tools.type')
}

function normalizeToolChoice(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    oneOf(value, ['none', 'auto', 'required'], 'tool_choice')
    return value
  }
  const result = shape(
    value,
    objectPolicy({ type: string, name: string, namespace: string }, ['type', 'name']),
    'tool_choice',
  )
  oneOf(result.type, ['function', 'custom'], 'tool_choice.type')
  return result
}

function normalizeText(value: JsonObject): void {
  if (value.verbosity !== undefined)
    oneOf(value.verbosity, ['low', 'medium', 'high'], 'text.verbosity')
  if (value.format === undefined) return
  const format = record(value.format, 'text.format')
  oneOf(format.type, ['text', 'json_schema', 'json_object'], 'text.format.type')
  value.format = shape(
    format,
    format.type === 'json_schema'
      ? objectPolicy(
          { type: string, name: string, description: string, schema: any, strict: boolean },
          ['type', 'name', 'schema'],
        )
      : objectPolicy({ type: string }, ['type']),
    'format',
  )
  if (format.type === 'json_schema') record(format.schema, 'text.format.schema')
}

/** The approved Responses subset, independent of transport and account credentials. */
export const normalizeCodexBody: LlmBackend['normalizeBody'] = (route, body, ctx) => {
  assertCodexRoute(route)
  const result = normalizeLlmJson(parseLlmJson(body), topPolicy)
  if (result.model !== ctx.model || ctx.model.length === 0) reject('model')
  if (result.store !== false) reject('store')
  if (result.stream !== true) reject('stream')
  if (!/^rdt_[a-f0-9]{32}$/.test(ctx.cacheKey)) reject('prompt_cache_key')
  result.prompt_cache_key = ctx.cacheKey
  if (Array.isArray(result.include))
    for (const include of result.include)
      if (include !== 'reasoning.encrypted_content') reject('include')

  const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  const reasoning = result.reasoning as JsonObject | undefined
  if (reasoning?.context !== undefined)
    oneOf(reasoning.context, ['auto', 'current_turn', 'all_turns'], 'reasoning.context')
  if (ctx.reasoningEffort !== null) {
    const ceiling = levels.indexOf(ctx.reasoningEffort)
    if (ceiling < 0) reject('reasoning.effort')
    const effort = reasoning?.effort ?? ctx.reasoningEffort
    if (
      typeof effort !== 'string' ||
      levels.indexOf(effort) < 0 ||
      levels.indexOf(effort) > ceiling
    )
      reject('reasoning.effort')
    result.reasoning = { ...reasoning, effort }
  } else if (reasoning?.effort !== undefined) reject('reasoning.effort')

  const imagePaths: JsonPath[] = []
  const encryptedContentPaths: JsonPath[] = []
  result.input = normalizeInput(result.input!, imagePaths, encryptedContentPaths)
  if (Array.isArray(result.tools)) result.tools = result.tools.map((tool) => normalizeTool(tool))
  if (result.tool_choice !== undefined) result.tool_choice = normalizeToolChoice(result.tool_choice)
  if (result.text !== undefined) normalizeText(result.text as JsonObject)
  return {
    body: new TextEncoder().encode(JSON.stringify(result)),
    estInputTokens: estimateLlmInputTokens(result, { imagePaths, encryptedContentPaths }),
  }
}
