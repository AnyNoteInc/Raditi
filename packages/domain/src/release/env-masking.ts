import { DomainError, isDomainError } from '../errors.ts'
import { envVarLimits } from './env-vars.ts'

/**
 * The values of a client's variables wherever text of a turn is kept
 * (docs/plan/53-chat-preview-release.md, Р13): the agent's commands may get them, but the
 * journal, the feed, the logs and the session the platform stores never hold one — each value is
 * replaced by ENV_VALUE_MASK — and what the platform publishes or writes to a site refuses them.
 * A value shorter than `envVarLimits.maskMinBytes` is neither masked nor refused, so a mask
 * never garbles ordinary words (owner's decision of 25.10.2026: a value may be one character).
 */
export const ENV_VALUE_MASK = '[скрыто]'

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength

/** A value inside a JSON string: what the text of a tool's output or a stored session holds. */
const inJsonString = (value: string): string => JSON.stringify(value).slice(1, -1)

/**
 * A value inside `$'…'` of a shell script, as the launch wrapper writes it: only the backslash
 * and the single quote are escaped, so the script never takes more than twice the value.
 */
const inShellQuotes = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")

/**
 * The spellings of each value that text of a turn may hold: the value itself, the value as a
 * JSON string holds it once and twice (a session row is JSON, and the output of a tool it keeps
 * may be JSON again), and as the shell script of the turn quotes it. Each once, longest first: a
 * value inside another is masked as part of the longer one. Other encodings (base64, URL) are
 * not looked for. A value shorter than `envVarLimits.maskMinBytes` has none.
 */
export function envValueForms(values: readonly string[]): string[] {
  const forms = values
    .filter((value) => utf8Bytes(value) >= envVarLimits.maskMinBytes)
    .flatMap((value) => {
      const once = inJsonString(value)
      return [value, once, inJsonString(once), inShellQuotes(value)]
    })
  return [...new Set(forms)].sort((left, right) => right.length - left.length)
}

/** The text with every occurrence of every value replaced by ENV_VALUE_MASK. */
export function maskEnvValues(text: string, values: readonly string[]): string {
  let masked = text
  for (const form of envValueForms(values))
    if (masked.includes(form)) masked = masked.split(form).join(ENV_VALUE_MASK)
  return masked
}

/**
 * Every string of a JSON-like value masked, the names of its fields too; numbers, booleans and
 * null stay as they are.
 */
export function maskEnvValuesDeep<T>(value: T, values: readonly string[]): T {
  if (envValueForms(values).length === 0) return value
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') return maskEnvValues(item, values)
    if (Array.isArray(item)) return item.map(walk)
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [maskEnvValues(key, values), walk(entry)]),
      )
    return item
  }
  return walk(value) as T
}

/** Whether the text holds any of the values, as it is or inside a JSON string. */
export function containsEnvValue(text: string, values: readonly string[]): boolean {
  return envValueForms(values).some((form) => text.includes(form))
}

/** The bytes of every spelling of the values (`envValueForms`): what a file must not hold. */
export const envValueBytes = (values: readonly string[]): Uint8Array[] =>
  envValueForms(values).map((form) => new TextEncoder().encode(form))

const CLIENT_VARIABLE = 'client_variable'

/**
 * The agent's change holds the value of a client's variable (Р13): nothing is published. The code
 * of a found secret, so the client reads the same words as for one (`secret_found`); the value is
 * never reported.
 */
export const envValueInChange = (): DomainError =>
  new DomainError('PUBLICATION_SECRET', 'The change holds the value of a client variable', 502, {
    reason: CLIENT_VARIABLE,
  })

/**
 * Content the platform would write to a site holds the value of a client's variable (Р13): a
 * page, a database operation of a release, a medium. The family of a turn credential in content.
 */
export const envValueInContent = (): DomainError =>
  new DomainError(
    'CONTENT_CREDENTIAL_REFUSED',
    'Published content must not hold the value of a client variable',
    400,
    { reason: CLIENT_VARIABLE },
  )

/** Whether an error is one of the two refusals of a value above. */
export function isEnvValueRefusal(error: unknown): error is DomainError {
  return (
    isDomainError(error) &&
    (error.details as { reason?: unknown } | undefined)?.reason === CLIENT_VARIABLE
  )
}

/**
 * The `host:port` a set of variables leads to — each once, sorted: the egress of a sandbox or a
 * preview is a label, and the same variables give the same one.
 */
export function egressHostsOf(variables: readonly { hosts: readonly string[] }[]): string[] {
  return [...new Set(variables.flatMap((variable) => variable.hosts))].sort()
}
