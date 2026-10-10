// The content scenarios of the agent-content stand, shared by the synthetic providers: what the
// scripted model asks of the platform MCP tool `wp_rest`, whatever wire format carries the call.
// The route is not checked against the tool's own schema on purpose: `content_forbidden` names
// one the role mcp must refuse.
const CONTENT_FIELDS = ['title', 'content', 'excerpt']
const CONTACT_PLACEHOLDER = '{{contact}}'
const PRIVACY_MARKER = /\[\[raditi:(?:email|phone):[a-f0-9-]{36}\]\]/

/** `route`, `idempotencyKey` and `body` belong to the two content scenarios and to no other. */
export function contentOptions(scenario, options) {
  const invalid = () => new Error('Invalid content')
  const given = ['route', 'idempotencyKey', 'body'].filter((name) => options[name] !== undefined)
  if (scenario !== 'content_edit' && scenario !== 'content_forbidden') {
    if (given.length > 0) throw invalid()
    return
  }
  if (typeof options.route !== 'string' || !/^\/[A-Za-z0-9/_-]{1,127}$/.test(options.route))
    throw invalid()
  const edit = scenario === 'content_edit'
  // The refused call never carries a key: with a body it is a write without one.
  if (
    edit
      ? typeof options.idempotencyKey !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(options.idempotencyKey)
      : options.idempotencyKey !== undefined
  )
    throw invalid()
  if (!edit && options.body === undefined) return
  const body = options.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid()
  const fields = Object.entries(body)
  if (
    fields.length === 0 ||
    !fields.every(
      ([name, value]) =>
        CONTENT_FIELDS.includes(name) && typeof value === 'string' && value.length <= 32 * 1024,
    )
  )
    throw invalid()
}

/**
 * The `wp_rest` call of a content scenario's round, or null when the round is the final answer.
 * `content_edit`: read, write with the idempotency key, the very same write again. A body value
 * may hold `{{contact}}`: it becomes the first privacy marker the conversation carries (the read's
 * output), the way a model keeps an opaque marker in place. Nothing is invented without one.
 * `content_forbidden`: one call the role must refuse — a read of the given route, or, with a
 * body, a write without an idempotency key.
 */
export function contentCall(body, config, round) {
  if (config.scenario === 'content_forbidden') {
    if (round > 0) return null
    return config.body
      ? { method: 'POST', route: config.route, body: config.body }
      : { method: 'GET', route: config.route }
  }
  if (config.scenario !== 'content_edit' || round > 2) return null
  if (round === 0) return { method: 'GET', route: config.route }
  const marker = PRIVACY_MARKER.exec(JSON.stringify(body))?.[0]
  const fields = Object.fromEntries(
    Object.entries(config.body).map(([name, value]) => {
      if (!value.includes(CONTACT_PLACEHOLDER)) return [name, value]
      if (!marker) throw new Error('Synthetic scenario requires a privacy marker to copy')
      return [name, value.replaceAll(CONTACT_PLACEHOLDER, marker)]
    }),
  )
  return {
    method: 'POST',
    route: config.route,
    body: fields,
    idempotencyKey: config.idempotencyKey,
  }
}
