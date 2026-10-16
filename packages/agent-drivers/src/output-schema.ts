import { agentOutputLimits, turnResultSchema, type TurnResult } from '@repo/domain'
import { z } from 'zod'

/**
 * A final message longer than one `message` event is cut and no longer parses (jsonl.ts), so
 * the schema's own limits are not the whole contract: the model is told the total size too.
 */
export const RESULT_SIZE_NOTE =
  `The whole JSON object must not exceed ${agentOutputLimits.messageText} characters. ` +
  'When many files changed, list only the most important paths in files_changed.'

const resultJsonSchema = z.toJSONSchema(turnResultSchema, { target: 'draft-7' })

/**
 * The filled result the contract shows, parsed by the schema when the module loads: the text can
 * never show the model an object the platform would refuse. Its lists are empty on purpose: the
 * real model left a list out whenever it had nothing to put into it.
 */
export const RESULT_EXAMPLE: TurnResult = turnResultSchema.parse({
  summary: 'Изменения не потребовались',
  change_type: 'none',
  client_message: 'Здравствуйте! Менять на сайте ничего не пришлось.',
  files_changed: [],
  questions: [],
  needs_approval: false,
  risk: 'low',
} satisfies TurnResult)

/**
 * The result contract of a CLI that has no output-schema flag: the text goes into the agent's
 * instructions, and the final message is validated after the turn (turnResultSchema). It is
 * written for a model that follows instructions loosely: the real GLM put a sentence before the
 * object or after it, and dropped a key whose list was empty (docs/plan/46-turn-result-glm.md).
 * By lines: the rule, the keys of the schema, the language and the sizes, the example, and last
 * the JSON Schema itself. The sizes of the two texts are said in words too: the rule sends what
 * the model wants to tell the client into client_message, and a longer text there loses the
 * result as a missing key does.
 */
export const RESULT_CONTRACT = [
  'End the turn with one JSON object and nothing else: your last message is that object. ' +
    'Its first character is { and its last character is }. ' +
    'Put no sentence, heading or markdown fence before it and nothing after it: a program reads ' +
    'the message, and text around the object or a missing key can lose the result of the turn. ' +
    'What you want to tell the client goes into client_message.',
  `Every key is required, also when there is nothing to report: ${(resultJsonSchema.required ?? []).join(', ')}. ` +
    'Write "files_changed": [] when you changed no file and "questions": [] when you have no ' +
    'question for the client.',
  'The client_message must be in Russian and address the client respectfully. ' +
    `Keep summary within ${agentOutputLimits.summary} characters and client_message within ${agentOutputLimits.clientMessage}. ` +
    RESULT_SIZE_NOTE,
  'Example of a turn that changed nothing:',
  JSON.stringify(RESULT_EXAMPLE),
  'JSON Schema of the object:',
  JSON.stringify(resultJsonSchema),
].join('\n')
