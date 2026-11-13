import { containsEnvValue } from '@repo/domain'

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
