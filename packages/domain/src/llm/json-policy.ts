import { badRequest } from '../errors.ts'

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject {
  [key: string]: JsonValue
}
export type JsonPath = readonly (string | number)[]

export const llmJsonLimits = Object.freeze({
  bytes: 16 * 1024 * 1024,
  depth: 64,
  nodes: 200_000,
  errorPath: 64,
  imageTokens: 2000,
})

export interface JsonObjectPolicy {
  kind: 'object'
  fields: Readonly<Record<string, JsonPolicy>>
  required?: readonly string[]
  strip?: readonly string[]
}
/** Provider adapters define their allowlists; domain has no provider-specific field switches. */
export type JsonPolicy =
  | JsonObjectPolicy
  | { kind: 'array'; items: JsonPolicy }
  | { kind: 'string' | 'number' | 'boolean' | 'null' }
  /** Explicit opt-in for free-form JSON, e.g. a tool's JSON Schema; structural limits still apply. */
  | { kind: 'any' }

const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])
const encoder = new TextEncoder()

function rejected(reason: string, path = 'unknown'): never {
  // Never attach parser messages, rejected values or untrusted property names.
  throw badRequest('Request body violates JSON policy', {
    reason,
    path: path.slice(0, llmJsonLimits.errorPath),
  })
}

const jsonWhitespace = (char: string | undefined) =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r'

/**
 * Bound allocation before JSON.parse builds the tree. This is a lexical limit scan, not a
 * second JSON parser: JSON.parse remains responsible for syntax, escapes and numeric grammar.
 * Strings followed by a colon are object keys, not value nodes. Brackets inside strings and
 * escaped quotes do not affect depth. For every syntactically valid JSON it counts each value.
 */
function preflightJson(text: string): void {
  let depth = 0
  let nodes = 0
  const value = (atDepth: number) => {
    nodes += 1
    if (nodes > llmJsonLimits.nodes) rejected('nodes')
    if (atDepth > llmJsonLimits.depth) rejected('depth')
  }
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (jsonWhitespace(char) || char === ',' || char === ':') {
      index += 1
    } else if (char === '{' || char === '[') {
      depth += 1
      value(depth)
      index += 1
    } else if (char === '}' || char === ']') {
      depth -= 1
      if (depth < 0) rejected('json')
      index += 1
    } else if (char === '"') {
      index += 1
      while (index < text.length && text[index] !== '"') {
        index += text[index] === '\\' ? 2 : 1
      }
      if (index >= text.length) rejected('json')
      index += 1
      let next = index
      while (jsonWhitespace(text[next])) next += 1
      if (text[next] !== ':') value(depth + 1)
    } else {
      // A number, true, false or null; malformed tokens will be rejected by JSON.parse.
      value(depth + 1)
      index += 1
      while (
        index < text.length &&
        !jsonWhitespace(text[index]) &&
        !',:[]{}"'.includes(text[index]!)
      )
        index += 1
    }
  }
  if (depth !== 0) rejected('json')
}

/** Bounds the parsed tree before recursive normalization; rejects non-JSON values and cycles. */
function assertJsonObject(value: unknown): asserts value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) rejected('object')
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 1 }]
  const seen = new WeakSet<object>()
  let nodes = 0
  while (stack.length > 0) {
    const current = stack.pop()!
    nodes += 1
    if (nodes > llmJsonLimits.nodes) rejected('nodes')
    if (current.depth > llmJsonLimits.depth) rejected('depth')
    const item: unknown = current.value
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) rejected('number')
      continue
    }
    if (typeof item !== 'object') rejected('value')
    if (seen.has(item)) rejected('cycle')
    seen.add(item)
    const array = Array.isArray(item)
    const proto: unknown = Object.getPrototypeOf(item)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      rejected('object')
    const remaining = llmJsonLimits.nodes - nodes - stack.length
    if (array && item.length > remaining) rejected('nodes')
    const keys = Reflect.ownKeys(item)
    if (keys.length - (array ? 1 : 0) > remaining) rejected('nodes')
    if (array && keys.length !== item.length + 1) rejected('value')
    for (const key of keys) {
      if (typeof key !== 'string') rejected('value')
      if (array && key === 'length') continue
      if (forbiddenKeys.has(key)) rejected('field')
      if (
        array &&
        (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length || Number(key) > 0xffff_fffe)
      )
        rejected('value')
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (!('value' in descriptor) || !descriptor.enumerable) rejected('value')
      stack.push({ value: descriptor.value, depth: current.depth + 1 })
    }
  }
}

/** Parse only bounded UTF-8 JSON objects, without exposing any source text on failure. */
export function parseLlmJson(body: Uint8Array): JsonObject {
  if (body.byteLength > llmJsonLimits.bytes) rejected('bytes')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)
  } catch {
    rejected('json')
  }
  preflightJson(text)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    rejected('json')
  }
  assertJsonObject(value)
  return value
}

const childPath = (path: string, key: string) => {
  // Only schema-owned field names reach here. Unexpected names are always the literal unknown.
  const safe = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : 'unknown'
  return (path ? `${path}.${safe}` : safe).slice(0, llmJsonLimits.errorPath)
}

/** Returns a new tree; repeating the same allowlist/strip policy has no further effect. */
export function normalizeLlmJson(value: JsonObject, policy: JsonObjectPolicy): JsonObject {
  assertJsonObject(value)
  const visit = (item: JsonValue, rule: JsonPolicy, path: string): JsonValue => {
    if (rule.kind === 'any') {
      if (Array.isArray(item)) return item.map((child) => visit(child, rule, path))
      if (item !== null && typeof item === 'object') {
        return Object.fromEntries(
          Object.entries(item).map(([key, child]) => [key, visit(child, rule, path)]),
        )
      }
      return item
    }
    if (rule.kind === 'array') {
      if (!Array.isArray(item)) rejected('array', path)
      return item.map((child) => visit(child, rule.items, `${path}[]`))
    }
    if (rule.kind === 'object') {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) rejected('object', path)
      const result: JsonObject = {}
      for (const [key, child] of Object.entries(item)) {
        if (rule.strip?.includes(key)) continue
        if (!Object.hasOwn(rule.fields, key)) rejected('field', childPath(path, 'unknown'))
        result[key] = visit(child, rule.fields[key]!, childPath(path, key))
      }
      for (const key of rule.required ?? []) {
        if (!Object.hasOwn(result, key))
          rejected('required', childPath(path, Object.hasOwn(rule.fields, key) ? key : 'unknown'))
      }
      return result
    }
    if (rule.kind === 'null' ? item !== null : typeof item !== rule.kind) rejected('type', path)
    return item
  }
  return visit(value, policy, '') as JsonObject
}

export interface InputTokenEstimateOptions {
  /** Exact paths discovered by the adapter after its request policy has accepted the body. */
  encryptedContentPaths?: readonly JsonPath[]
  imagePaths?: readonly JsonPath[]
}

/**
 * Estimate the canonical normalized JSON. Only adapter-approved paths are exempt: a user's
 * ordinary text starting with data:image/... or naming encrypted_content still costs tokens.
 * Removed string payloads leave their JSON framing; each accepted image contributes 2000 tokens.
 */
export function estimateLlmInputTokens(
  value: JsonObject,
  options: InputTokenEstimateOptions = {},
): number {
  assertJsonObject(value)
  const paths = new Map<string, 'encrypted' | 'image'>()
  for (const [kind, group] of [
    ['encrypted', options.encryptedContentPaths ?? []],
    ['image', options.imagePaths ?? []],
  ] as const) {
    for (const path of group) {
      if (
        path.length === 0 ||
        path.some((part) => typeof part !== 'string' && (!Number.isSafeInteger(part) || part < 0))
      )
        rejected('estimate_path')
      if (kind === 'encrypted' && path.at(-1) !== 'encrypted_content') rejected('estimate_path')
      const key = JSON.stringify(path)
      if (paths.has(key)) rejected('estimate_path')
      paths.set(key, kind)
    }
  }
  let matched = 0
  let images = 0
  const visit = (item: JsonValue, path: JsonPath): JsonValue => {
    const kind = paths.get(JSON.stringify(path))
    if (kind) {
      if (typeof item !== 'string') rejected('estimate_path')
      if (kind === 'image') {
        if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(item)) rejected('image')
        images += 1
      }
      matched += 1
      return ''
    }
    if (Array.isArray(item)) return item.map((child, index) => visit(child, [...path, index]))
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [key, visit(child, [...path, key])]),
      )
    }
    return item
  }
  const counted = visit(value, [])
  if (matched !== paths.size) rejected('estimate_path')
  return (
    Math.ceil(encoder.encode(JSON.stringify(counted)).byteLength / 3) +
    images * llmJsonLimits.imageTokens
  )
}
