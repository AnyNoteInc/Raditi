import { agentOutputLimits, turnResultSchema } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { extractJsonResult } from './jsonl.ts'
import {
  RESULT_CONTRACT,
  RESULT_EXAMPLE,
  RESULT_SIZE_NOTE,
  strictOutputSchema,
} from './output-schema.ts'

type Json = Record<string, unknown>

/**
 * The strict Structured Outputs subset, as conservative as the published rules allow: the root
 * is an object, every object lists all of its properties as required and forbids extra ones,
 * and nothing but these keywords appears. Length and count limits are not part of the subset.
 */
const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'description',
])
const TYPES = new Set(['object', 'array', 'string', 'boolean', 'number', 'integer'])

function violations(node: unknown, path = '$', depth = 1): string[] {
  if (node === null || typeof node !== 'object' || Array.isArray(node))
    return [`${path}: not a schema`]
  const schema = node as Json
  const found = Object.keys(schema)
    .filter((key) => !KEYWORDS.has(key))
    .map((key) => `${path}: unsupported keyword ${key}`)
  if (typeof schema.type !== 'string' || !TYPES.has(schema.type))
    found.push(`${path}: unsupported type`)
  if (depth > 5) found.push(`${path}: nested too deep`)
  if (schema.type === 'object') {
    const properties = (schema.properties ?? {}) as Json
    if (schema.additionalProperties !== false) found.push(`${path}: additionalProperties`)
    if (JSON.stringify(schema.required) !== JSON.stringify(Object.keys(properties)))
      found.push(`${path}: every property must be required`)
    for (const [key, value] of Object.entries(properties))
      found.push(...violations(value, `${path}.${key}`, depth + 1))
  }
  if (schema.type === 'array') found.push(...violations(schema.items, `${path}[]`, depth + 1))
  return found
}

/** Structural acceptance by the subset: what the provider would constrain the model to. */
function accepts(schema: Json, value: unknown): boolean {
  if (schema.enum) return (schema.enum as unknown[]).includes(value)
  if (schema.type === 'string') return typeof value === 'string'
  if (schema.type === 'boolean') return typeof value === 'boolean'
  if (schema.type === 'array')
    return Array.isArray(value) && value.every((item) => accepts(schema.items as Json, item))
  if (schema.type !== 'object' || value === null || typeof value !== 'object') return false
  const properties = schema.properties as Record<string, Json>
  const keys = Object.keys(value)
  return (
    keys.length === Object.keys(properties).length &&
    keys.every((key) => properties[key] && accepts(properties[key], (value as Json)[key]))
  )
}

describe('strict output schema', () => {
  const schema = strictOutputSchema(turnResultSchema, RESULT_SIZE_NOTE)

  it('keeps the turn result inside the strict Structured Outputs subset', () => {
    expect(violations(schema)).toEqual([])
    expect(schema.type).toBe('object')
    expect(JSON.stringify(schema)).not.toMatch(/\$schema|minLength|maxLength|minItems|maxItems/)
  })

  it('derives every field, enum and limit from the domain zod schema', () => {
    const shape = turnResultSchema.shape
    const properties = schema.properties as Record<string, Json>
    expect(Object.keys(properties)).toEqual(Object.keys(shape))
    expect(schema.required).toEqual(Object.keys(shape))
    expect(properties.change_type).toEqual({ type: 'string', enum: shape.change_type.options })
    expect(properties.risk).toEqual({ type: 'string', enum: shape.risk.options })
    expect(properties.needs_approval).toEqual({ type: 'boolean' })
    // Limits the subset cannot enforce still reach the model, as text.
    expect(properties.summary).toEqual({
      type: 'string',
      description: `1 to ${agentOutputLimits.summary} characters`,
    })
    expect(properties.client_message).toEqual({
      type: 'string',
      description: `1 to ${agentOutputLimits.clientMessage} characters`,
    })
    expect(properties.files_changed).toEqual({
      type: 'array',
      description: `At most ${agentOutputLimits.filesChanged} items`,
      items: { type: 'string', description: `1 to ${agentOutputLimits.path} characters` },
    })
    expect(properties.questions).toEqual({
      type: 'array',
      description: `At most ${agentOutputLimits.questions} items`,
      items: { type: 'string', description: `1 to ${agentOutputLimits.question} characters` },
    })
    expect(schema.description).toBe(RESULT_SIZE_NOTE)
    expect(RESULT_SIZE_NOTE).toContain(String(agentOutputLimits.messageText))
  })

  it('accepts every result the zod schema accepts', () => {
    const result = {
      summary: 'Обновлён заголовок',
      change_type: 'code',
      client_message: 'Заголовок обновлён.',
      files_changed: ['index.html'],
      questions: ['Оставить прежний цвет?'],
      needs_approval: true,
      risk: 'medium',
    }
    expect(turnResultSchema.safeParse(result).success).toBe(true)
    expect(accepts(schema, result)).toBe(true)
    expect(accepts(schema, { ...result, extra: 1 })).toBe(false)
    expect(accepts(schema, { ...result, risk: 'none' })).toBe(false)
    const { risk: _risk, ...missing } = result
    expect(accepts(schema, missing)).toBe(false)
  })

  it.each([
    ['an optional property', z.object({ a: z.string().optional() })],
    ['an open object', z.looseObject({ a: z.string() })],
    ['a union', z.object({ a: z.union([z.string(), z.number()]) })],
    ['a nullable value', z.object({ a: z.string().nullable() })],
    ['a record', z.object({ a: z.record(z.string(), z.string()) })],
    ['a pattern', z.object({ a: z.string().regex(/^a+$/) })],
    ['a tuple', z.object({ a: z.tuple([z.string()]) })],
    ['a non-object root', z.array(z.string())],
  ])('refuses %s instead of sending a schema the provider rejects', (_name, source) => {
    expect(() => strictOutputSchema(source)).toThrow(/strict output schema/)
  })

  it('keeps the descriptions of the zod schema and states the limits after them', () => {
    const converted = strictOutputSchema(
      z
        .object({
          list: z.array(z.string().max(9).describe('A path')).max(3).describe('Changed files'),
          ok: z.boolean().describe('Flag'),
        })
        .describe('Result'),
      'Total size note',
    )
    expect(violations(converted)).toEqual([])
    expect(converted).toEqual({
      type: 'object',
      description: 'Result\nTotal size note',
      properties: {
        list: {
          type: 'array',
          description: 'Changed files\nAt most 3 items',
          items: { type: 'string', description: 'A path\nAt most 9 characters' },
        },
        ok: { type: 'boolean', description: 'Flag' },
      },
      required: ['list', 'ok'],
      additionalProperties: false,
    })
  })

  it('keeps numbers and bounded arrays without unsupported keywords', () => {
    const converted = strictOutputSchema(
      z.object({
        n: z.number().int().min(1).max(9),
        any: z.int(),
        list: z.array(z.boolean()).min(1).max(3),
      }),
    )
    expect(violations(converted)).toEqual([])
    expect(converted).toEqual({
      type: 'object',
      properties: {
        n: { type: 'integer', description: '1 to 9' },
        any: { type: 'integer' },
        list: { type: 'array', description: '1 to 3 items', items: { type: 'boolean' } },
      },
      required: ['n', 'any', 'list'],
      additionalProperties: false,
    })
  })
})

describe('result contract for a CLI without an output-schema flag', () => {
  const jsonSchema = z.toJSONSchema(turnResultSchema, { target: 'draft-7' }) as Json
  const required = jsonSchema.required as string[]
  const lines = RESULT_CONTRACT.split('\n')
  /** The text goes to the model with every request of every turn. */
  const MAX_CONTRACT_CHARS = 2000

  it('opens with the rule and ends with the JSON Schema of the turn result', () => {
    expect(RESULT_CONTRACT.startsWith('End the turn with one JSON object and nothing else')).toBe(
      true,
    )
    expect(RESULT_CONTRACT).toContain('client_message must be in Russian')
    expect(RESULT_CONTRACT).toContain(RESULT_SIZE_NOTE)
    const schema = JSON.parse(lines.at(-1)!) as Json
    expect(schema).toEqual(jsonSchema)
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(Object.keys(turnResultSchema.shape))
  })

  it('says that the last message is the object alone, with nothing before or after it', () => {
    // What the real model wrote around a valid object: a sentence before it, a sentence after it
    // (docs/plan/46-turn-result-glm.md).
    expect(lines[0]).toContain('your last message is that object')
    expect(lines[0]).toContain('Its first character is { and its last character is }')
    expect(lines[0]).toContain(
      'no sentence, heading or markdown fence before it and nothing after it',
    )
    expect(lines[0]).toContain('goes into client_message')
  })

  it('names every required key and how a list with nothing in it is written', () => {
    expect(required.length).toBeGreaterThan(0)
    const keys = lines.find((line) => line.startsWith('Every key is required'))
    expect(keys).toContain(`: ${required.join(', ')}.`)
    // The real model left a list out whenever it had nothing to put into it.
    const properties = jsonSchema.properties as Record<string, Json>
    const lists = required.filter((name) => properties[name]!.type === 'array')
    expect(lists.length).toBeGreaterThan(0)
    for (const name of lists) expect(keys).toContain(`"${name}": []`)
  })

  it('names the limits of summary and client_message in words, as the schema counts them', () => {
    // The model did not follow `required` of the schema line, and `maxLength` stands in that
    // same line: a text for the client longer than its limit would lose the result of the turn.
    const properties = jsonSchema.properties as Record<string, Json>
    const { maxLength: summary } = properties.summary!
    const { maxLength: clientMessage } = properties.client_message!
    expect([summary, clientMessage]).toEqual([
      agentOutputLimits.summary,
      agentOutputLimits.clientMessage,
    ])
    const sizes = lines.find((line) => line.includes(RESULT_SIZE_NOTE))
    expect(sizes).toContain(
      `Keep summary within ${String(summary)} characters and client_message within ${String(clientMessage)}.`,
    )
    // The Codex schema says the same in the descriptions of the two keys.
    const strict = strictOutputSchema(turnResultSchema).properties as Record<string, Json>
    expect(strict.summary!.description).toBe(`1 to ${String(summary)} characters`)
    expect(strict.client_message!.description).toBe(`1 to ${String(clientMessage)} characters`)
  })

  it('shows one filled example that is itself a result', () => {
    expect(turnResultSchema.safeParse(RESULT_EXAMPLE).success).toBe(true)
    expect(lines.filter((line) => line === JSON.stringify(RESULT_EXAMPLE))).toHaveLength(1)
    expect(Object.keys(RESULT_EXAMPLE)).toEqual(required)
    // The case the model got wrong: the lists of the example are empty and written all the same.
    expect(Object.values(RESULT_EXAMPLE).filter(Array.isArray)).toEqual([[], []])
    // The line as it stands is what the drivers' own reading takes.
    expect(extractJsonResult([], JSON.stringify(RESULT_EXAMPLE))).toEqual(RESULT_EXAMPLE)
  })

  it('stays small', () => {
    expect(RESULT_CONTRACT.length).toBeLessThanOrEqual(MAX_CONTRACT_CHARS)
  })

  it('holds no reference a CLI configuration would substitute', () => {
    // OpenCode replaces {env:NAME} and {file:path} in the raw text of its configuration, and the
    // contract is part of that text.
    expect(RESULT_CONTRACT).not.toMatch(/\{(?:env|file):/)
  })
})
