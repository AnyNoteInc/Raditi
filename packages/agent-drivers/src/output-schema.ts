import { agentOutputLimits, turnResultSchema } from '@repo/domain'
import { z } from 'zod'

type JsonSchema = Record<string, unknown>

/**
 * A final message longer than one `message` event is cut and no longer parses (jsonl.ts), so
 * the schema's own limits are not the whole contract: the model is told the total size too.
 */
export const RESULT_SIZE_NOTE =
  `The whole JSON object must not exceed ${agentOutputLimits.messageText} characters. ` +
  'When many files changed, list only the most important paths in files_changed.'

/**
 * The result contract of a CLI that has no output-schema flag: the text goes into the agent's
 * instructions, and the final message is validated after the turn (turnResultSchema). The first
 * line is the rule, the second the JSON Schema itself.
 */
export const RESULT_CONTRACT =
  'End the turn with one JSON object, without markdown fences, matching this JSON Schema. ' +
  'The client_message must be in Russian and address the client respectfully. ' +
  `${RESULT_SIZE_NOTE}\n` +
  JSON.stringify(z.toJSONSchema(turnResultSchema, { target: 'draft-7' }))

const unsupported = (path: string, what: string): Error =>
  new Error(`Cannot build a strict output schema: ${what} at ${path}`)

function range(min: unknown, max: unknown, unit?: string): string | undefined {
  const of = unit === undefined ? '' : ` ${unit}`
  if (typeof min === 'number' && typeof max === 'number') return `${min} to ${max}${of}`
  if (typeof max === 'number') return `At most ${max}${of}`
  if (typeof min === 'number') return `At least ${min}${of}`
  return undefined
}

/** Only the listed keywords and a description may be present: nothing else has a strict form. */
function keywords(node: JsonSchema, allowed: readonly string[], path: string): void {
  const extra = Object.keys(node).find((key) => key !== 'description' && !allowed.includes(key))
  if (extra !== undefined) throw unsupported(path, `keyword ${extra}`)
}

/** The schema's own description, then what the subset cannot enforce, one per line. */
function describe(source: JsonSchema, ...notes: (string | undefined)[]): JsonSchema {
  const own = typeof source.description === 'string' ? source.description : undefined
  const text = [own, ...notes].filter((part) => part !== undefined && part !== '').join('\n')
  return text === '' ? {} : { description: text }
}

function convert(node: unknown, path: string): JsonSchema {
  if (node === null || typeof node !== 'object' || Array.isArray(node))
    throw unsupported(path, 'a non-object schema')
  const source = node as JsonSchema
  switch (source.type) {
    case 'object': {
      keywords(source, ['type', 'properties', 'required', 'additionalProperties'], path)
      const properties = (source.properties ?? {}) as Record<string, unknown>
      const names = Object.keys(properties)
      const required = Array.isArray(source.required) ? source.required : []
      if (source.additionalProperties !== false) throw unsupported(path, 'an open object')
      const optional = names.find((name) => !required.includes(name))
      if (optional !== undefined) throw unsupported(`${path}.${optional}`, 'an optional property')
      return {
        type: 'object',
        ...describe(source),
        properties: Object.fromEntries(
          names.map((name) => [name, convert(properties[name], `${path}.${name}`)]),
        ),
        required: names,
        additionalProperties: false,
      }
    }
    case 'array':
      keywords(source, ['type', 'items', 'minItems', 'maxItems'], path)
      return {
        type: 'array',
        ...describe(source, range(source.minItems, source.maxItems, 'items')),
        items: convert(source.items, `${path}[]`),
      }
    case 'string':
      keywords(source, ['type', 'enum', 'minLength', 'maxLength'], path)
      return {
        type: 'string',
        ...(source.enum === undefined ? {} : { enum: source.enum }),
        ...describe(source, range(source.minLength, source.maxLength, 'characters')),
      }
    case 'integer':
    case 'number': {
      keywords(source, ['type', 'minimum', 'maximum'], path)
      // zod states the safe-integer range of every int: not a limit worth telling the model.
      const stated = (bound: unknown) =>
        typeof bound === 'number' && Math.abs(bound) < Number.MAX_SAFE_INTEGER ? bound : undefined
      return {
        type: source.type,
        ...describe(source, range(stated(source.minimum), stated(source.maximum))),
      }
    }
    case 'boolean':
      keywords(source, ['type'], path)
      return { type: 'boolean', ...describe(source) }
    default:
      throw unsupported(path, 'an unsupported type')
  }
}

/**
 * JSON Schema of a zod schema narrowed to the strict Structured Outputs subset, which the Codex
 * CLI requests for `--output-schema` (`strict: true`): the root is an object, every property is
 * required, objects are closed, and only type, properties, required, additionalProperties,
 * items, enum and description appear. Length and count limits become descriptions; the zod
 * schema stays the source of truth and validates the result after the turn. A construct with
 * no strict equivalent throws here instead of failing every request at the provider.
 */
export function strictOutputSchema(schema: z.ZodType, note?: string): JsonSchema {
  const { $schema: _dialect, ...root } = z.toJSONSchema(schema, { target: 'draft-7' })
  if (root.type !== 'object') throw unsupported('$', 'a non-object root')
  return { ...convert(root, '$'), ...describe(root, note) }
}
