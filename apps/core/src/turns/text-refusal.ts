import { containsEnvValue } from '@repo/domain'
import { TURN_KEY_IN_TEXT } from '@repo/turn-keys'

/**
 * What the end of a turn reads text of documents by (docs/plan/69-pages.md, Ст19): a key of the turn
 * in it, or a value of the client's variables in any of its spellings (`envValueForms`). Built from
 * what a turn holds in memory; the values stay in the closure. An empty key refuses nothing.
 */
export function textRefusal(
  credentials: readonly string[],
  values: readonly string[],
): (text: string) => 'turn_key' | 'client_value' | null {
  const keys = credentials.filter((credential) => credential.length > 0)
  const held = [...values]
  return (text) =>
    keys.some((key) => text.includes(key))
      ? 'turn_key'
      : containsEnvValue(text, held)
        ? 'client_value'
        : null
}

/**
 * The same check for a turn whose end recovery reached (`checkpoint_recovered`,
 * `publication_recovered`; docs/plan/84-projects.md, §10): its keys are gone with the attempt that
 * held them, so any text in the form of a turn key is refused, whoever's; the values are those the
 * workspace holds now.
 */
export function recoveredTextRefusal(
  values: readonly string[],
): (text: string) => 'turn_key' | 'client_value' | null {
  const held = [...values]
  return (text) =>
    TURN_KEY_IN_TEXT.test(text) ? 'turn_key' : containsEnvValue(text, held) ? 'client_value' : null
}
