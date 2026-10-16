import { agentOutputLimits, turnResultSchema } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { extractJsonResult } from './jsonl.ts'
import { RESULT_CONTRACT, RESULT_EXAMPLE, RESULT_SIZE_NOTE } from './output-schema.ts'

type Json = Record<string, unknown>

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
