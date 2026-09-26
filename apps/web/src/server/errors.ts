/**
 * One line without secrets. Connections to `localhost` fail with an AggregateError whose own
 * message is empty, so the inner errors and the code are spelled out.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const inner =
    error instanceof AggregateError ? [...new Set(error.errors.map(describeError))].join('; ') : ''
  let text = [error.message.replace(/\s+/g, ' ').trim(), inner].filter(Boolean).join(': ')
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && !text.includes(code)) text = text ? `${text} (${code})` : code
  return text || error.name
}
