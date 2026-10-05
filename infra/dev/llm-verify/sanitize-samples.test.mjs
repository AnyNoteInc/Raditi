import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ALLOWED_HEADERS,
  checkSanitized,
  createSanitizer,
  findIdentifiers,
  findLeaks,
} from './sanitize-samples.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'sanitize-samples.mjs')
const research = join(here, '..', '..', '..', 'docs', 'research', '2026-10-opencode-glm')
const tmp = mkdtempSync(join(tmpdir(), 'raditi-oc-sanitize-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

// Everything below is synthetic and only shaped like the real thing; none of it was ever a
// credential or an identifier of a real request.
const PLAN_KEY = `${'a1b2c3d4'.repeat(4)}.Zx9Qw8Er7Ty6Ui5O`
const LOG_ID = '20990101000000abcdef0123456789'
const OTHER_LOG_ID = '209901010000019876543210fedcba'
const REQUEST_ID = '11111111-2222-4333-8444-555555555555'
const TRACE_ID = 'aaaabbbbccccddddeeeeffff00001111'
const SESSION_ID = 'ses_abcdef012345SyntheticSes01'
const CALL_ID = 'call_abcdef0123456789abcdef01'
const PROJECT_ID = 'abcdef0123456789abcdef0123456789abcdef01'
const JWT = `eyJ${'hbGciOiJIUzI1NiJ9'}.eyJ${'zdWIiOiJzeW50aGV0aWMifQ'}.c2lnbmF0dXJlLXN5bnRoZXRpYw`
// The first line of a PEM key block, put together from parts: written out, two such lines of
// this file read to a secret scanner as one key block with the code between them for a key.
const pemHeader = (kind = '') => `-----BEGIN ${kind}PRIVATE KEY-----`

const chunk = (id, created, delta, extra = {}) =>
  `data: ${JSON.stringify({ id, created, object: 'chat.completion.chunk', model: 'glm-5.3', choices: [{ index: 0, delta, ...extra }] })}\n\n`

function exchange() {
  return {
    at: '2030-01-01T00:00:00.000Z',
    scenario: '31-run-a-default',
    request: {
      method: 'POST',
      path: '/zai-coding/chat/completions',
      clientCredentials: { authorization: 'Bearer <dummy llm token>' },
      headers: {
        authorization: 'Bearer <dummy llm token>',
        'content-type': 'application/json',
        'user-agent': 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
        'x-session-affinity': SESSION_ID,
        host: '10.0.0.2:8080',
      },
      body: {
        model: 'glm-5.3',
        messages: [
          { role: 'user', content: 'Reply with the single word: ok' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: CALL_ID, type: 'function', function: { name: 'bash' } }],
          },
          { role: 'tool', tool_call_id: CALL_ID, content: `session ${SESSION_ID}` },
        ],
      },
      forwardedHeaderNames: ['accept', 'authorization'],
    },
    response: {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream;charset=UTF-8',
        'retry-after': '7',
        date: 'Tue, 01 Jan 2030 00:00:00 GMT',
        'ga-traceid': TRACE_ID,
        'set-cookie': 'acw_tc=0a1b2c3d4e5f60718293a4b5c6d7e8f9;path=/;HttpOnly;Max-Age=1800',
        'x-log-id': LOG_ID,
        'x-request-id': REQUEST_ID,
      },
      stream: { toolCalls: [{ id: CALL_ID, name: 'bash', arguments: '{}' }] },
      sse:
        chunk(LOG_ID, 1893456000, { role: 'assistant', reasoning_content: 'The' }) +
        chunk(LOG_ID, 1893456000, {
          tool_calls: [{ id: CALL_ID, index: 0, type: 'function', function: { name: 'bash' } }],
        }) +
        chunk(LOG_ID, 1893456000, { role: 'assistant', content: '' }, { finish_reason: 'stop' }) +
        'data: [DONE]\n\n',
    },
  }
}

const walk = (value, visit, key) => {
  visit(value, key)
  if (Array.isArray(value)) for (const item of value) walk(item, visit)
  else if (value && typeof value === 'object')
    for (const [name, item] of Object.entries(value)) walk(item, visit, name)
}

test('the allowlist is the one of the pivot plan', () => {
  assert.deepEqual([...ALLOWED_HEADERS], ['content-type', 'retry-after'])
})

test('headers outside the allowlist lose their values at any depth; names stay as a list', () => {
  const out = createSanitizer().json(exchange())
  assert.deepEqual(out.request.headers, { 'content-type': 'application/json' })
  assert.deepEqual(out.response.headers, {
    'content-type': 'text/event-stream;charset=UTF-8',
    'retry-after': '7',
  })
  assert.deepEqual(out.request.removedHeaderNames, [
    'authorization',
    'host',
    'user-agent',
    'x-session-affinity',
  ])
  assert.deepEqual(out.response.removedHeaderNames, [
    'date',
    'ga-traceid',
    'set-cookie',
    'x-log-id',
    'x-request-id',
  ])
  walk(out, (value, key) => {
    if (key === 'headers')
      for (const name of Object.keys(value)) assert.ok(ALLOWED_HEADERS.includes(name), name)
  })
  const text = JSON.stringify(out)
  for (const gone of ['10.0.0.2', 'ai-sdk', 'acw_tc', 'GMT', TRACE_ID, REQUEST_ID])
    assert.ok(!text.includes(gone), gone)
})

test('which credential a request carried survives as a structure, never as a bearer string', () => {
  const out = createSanitizer().json(exchange())
  assert.deepEqual(out.request.credentials, [
    { header: 'authorization', scheme: 'bearer', value: '<dummy llm token>' },
  ])
  assert.equal(out.request.clientCredentials, undefined)
  assert.doesNotMatch(JSON.stringify(out), /bearer\s/i)

  const real = createSanitizer().json({
    request: { headers: { Authorization: `Bearer ${PLAN_KEY}`, 'X-Api-Key': PLAN_KEY } },
  })
  assert.deepEqual(real.request.credentials, [
    { header: 'authorization', scheme: 'bearer', value: '<removed>' },
    { header: 'x-api-key', value: '<removed>' },
  ])
  assert.ok(!JSON.stringify(real).includes(PLAN_KEY.slice(0, 12)))

  const already = createSanitizer().json({ request: { headers: { authorization: '<removed>' } } })
  assert.deepEqual(already.request.credentials, [{ header: 'authorization', value: '<removed>' }])
})

test('key-like and bearer strings are removed from bodies, streams and plain text', () => {
  const sanitizer = createSanitizer()
  const out = sanitizer.json({
    request: { body: { api_key: PLAN_KEY, note: `key ${PLAN_KEY} here`, token: 'short' } },
    response: {
      body: `{"error":"Authorization: Bearer ${PLAN_KEY} rejected"}`,
      sse: `data: {"echo":"${JWT}"}\n\n`,
      cookie: 'acw_tc=0a1b2c3d4e5f60718293a4b5c6d7e8f9',
    },
  })
  const text = JSON.stringify(out)
  assert.ok(!text.includes(PLAN_KEY))
  assert.ok(!text.includes(PLAN_KEY.split('.')[0]))
  assert.ok(!text.includes(JWT))
  assert.ok(!text.includes('0a1b2c3d4e5f6071'))
  assert.equal(out.request.body.api_key, '<removed>')
  assert.equal(out.request.body.token, '<removed>')
  assert.equal(out.request.body.note, 'key <removed> here')
  assert.deepEqual(findLeaks(text), [])

  const plain = sanitizer.text(
    [
      `PLAN_API_KEY=${PLAN_KEY}`,
      `curl -H "Authorization: Bearer sk-${'x1'.repeat(14)}"`,
      pemHeader(),
      'the Bearer authentication scheme and "Bearer invalid-key" stay',
    ].join('\n'),
  )
  assert.deepEqual(findLeaks(plain), [])
  assert.equal(plain.split('\n').length, 4)
  assert.match(plain, /Bearer authentication scheme and "Bearer invalid-key" stay/)
})

test('findLeaks names the rule and never quotes the secret', () => {
  const found = findLeaks(
    `a ${PLAN_KEY} b\nAuthorization: Bearer ${'q7'.repeat(12)}\n${JWT}\nsk-${'x1'.repeat(14)}\n` +
      `password = "${'Zq4'.repeat(9)}"\nacw_tc=0a1b2c3d4e5f60718293a4b5c6d7e8f9\n` +
      `${pemHeader('OPENSSH ')}\nmail someone@owner-mail.dev\n`,
  )
  assert.deepEqual([...new Set(found.map((item) => item.rule))].sort(), [
    'assigned-secret',
    'bearer',
    'cookie',
    'email',
    'jwt',
    'plan-key',
    'private-key',
    'sk-key',
  ])
  for (const item of found) {
    assert.equal(typeof item.line, 'number')
    for (const secret of [PLAN_KEY, JWT, 'q7'.repeat(12), 'Zq4'.repeat(9)])
      assert.ok(!item.excerpt.includes(secret.slice(0, 10)), item.rule)
  }
  // Placeholders, integrity hashes and the stand's dummy tokens are not secrets.
  assert.deepEqual(
    findLeaks(
      'Authorization: Bearer <dummy llm token>\nBearer ${realKey()}\nauthorization: "<removed>"\n' +
        `"integrity": "sha512-${'Ab9+'.repeat(21)}Ab=="\nacw_tc=<removed>\n` +
        'RADITI_LLM_KEY=raditi-glm-dummy-llm-token-000000000000\n' +
        // Reserved domains (RFC 2606) name nobody; a package at a version is not an address.
        'git config user.email stand@example.invalid; opencode-ai@1.18.34; a@example.com\n' +
        `sha256 ${'415487fc'.repeat(8)}\n"max_tokens": 32000, "prompt_tokens": 7105\n`,
    ),
    [],
  )
})

test('identifiers get stable placeholders of the same shape; references still match', () => {
  const sanitizer = createSanitizer()
  const first = sanitizer.json(exchange())
  const second = sanitizer.json({
    response: {
      body: `{"id":"${LOG_ID}","request_id":"${LOG_ID}","created":1893459600,"other":"${OTHER_LOG_ID}"}`,
      parsed: { id: OTHER_LOG_ID, created: 1893459600, object: 'chat.completion' },
    },
    session: { id: SESSION_ID, projectID: PROJECT_ID, time: { created: 1900000000123 } },
    trace: `ga-traceid: ${TRACE_ID}; x-request-id ${REQUEST_ID}`,
  })
  const text = JSON.stringify([first, second])
  for (const raw of [
    LOG_ID,
    OTHER_LOG_ID,
    REQUEST_ID,
    TRACE_ID,
    SESSION_ID,
    CALL_ID,
    PROJECT_ID,
    '1893456000',
    '1893459600',
  ])
    assert.ok(!text.includes(raw), raw)

  const chunks = first.response.sse
    .split('\n\n')
    .filter((block) => block.startsWith('data: {'))
    .map((block) => JSON.parse(block.slice(6)))
  assert.equal(chunks.length, 3)
  const logId = chunks[0].id
  assert.match(logId, /^20260101000000[0-9a-f]{16}$/)
  assert.ok(chunks.every((item) => item.id === logId && item.created === 1767225600))
  assert.ok(first.response.sse.endsWith('data: [DONE]\n\n'))

  // The same raw value maps to the same placeholder in another file of the pass.
  const body = JSON.parse(second.response.body)
  assert.equal(body.id, logId)
  assert.equal(body.request_id, logId)
  assert.equal(body.created, 1767225600)
  assert.notEqual(body.other, logId)
  assert.equal(second.response.parsed.id, body.other)
  assert.equal(second.response.parsed.created, 1767225600)

  // A tool call id keeps linking the call, its result and the stream that produced it.
  const callId = first.request.body.messages[1].tool_calls[0].id
  assert.match(callId, /^call_[0-9a-f]{24}$/)
  assert.equal(first.request.body.messages[2].tool_call_id, callId)
  assert.equal(first.response.stream.toolCalls[0].id, callId)
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].id, callId)

  const session = second.session.id
  assert.match(session, /^ses_0{12}\d{14}$/)
  assert.equal(first.request.body.messages[2].content, `session ${session}`)
  assert.match(second.session.projectID, /^0{32}[0-9a-f]{8}$/)
  // Milliseconds of the CLI's own clock are not a provider identifier.
  assert.equal(second.session.time.created, 1900000000123)
  assert.deepEqual(findIdentifiers(text), [])
})

test('plain text keeps its lines; a second pass changes nothing', () => {
  const stdout = [
    '### session list',
    `    "id": "${SESSION_ID}",`,
    '    "updated": 1900000000456,',
    `    "projectId": "${PROJECT_ID}",`,
    `    "project_id": "${PROJECT_ID}",`,
    `Exporting session: ${SESSION_ID}`,
    `    "model": "{\\"id\\":\\"glm-5.3\\",\\"created\\":1893456000}",`,
    'made in /Users/someone/Projects/raditi and /private/tmp/claude-501/-Users-someone/abc/scratchpad/glm',
    '',
  ].join('\n')
  const sanitizer = createSanitizer()
  const out = sanitizer.text(stdout)
  assert.equal(out.split('\n').length, stdout.split('\n').length)
  assert.ok(!out.includes(SESSION_ID) && !out.includes(PROJECT_ID) && !out.includes('someone'))
  assert.match(out, /"updated": 1900000000456/)
  assert.match(out, /\\"created\\":1767225600/)
  assert.match(out, /made in <repo> and <scratchpad>\/glm/)
  assert.deepEqual(findIdentifiers(out), [])
  assert.equal(createSanitizer().text(out), out)

  const json = createSanitizer().json(exchange())
  assert.deepEqual(createSanitizer().json(json), json)
})

test('the report says what was dropped and replaced', () => {
  const sanitizer = createSanitizer()
  sanitizer.json(exchange())
  sanitizer.text(`Authorization: Bearer ${PLAN_KEY}`)
  const report = sanitizer.report()
  assert.equal(report.headersDropped['x-log-id'], 1)
  assert.equal(report.headersDropped.authorization, 1)
  assert.equal(report.headersKept['content-type'], 2)
  assert.equal(report.identifiers['log-id'].distinct, 1)
  assert.equal(report.identifiers['tool-call-id'].distinct, 1)
  assert.ok(report.identifiers['log-id'].replaced >= 3)
  assert.equal(report.secrets.bearer, 1)
  assert.ok(!JSON.stringify(report).includes(PLAN_KEY.slice(0, 10)))
})

test('checkSanitized refuses what the sanitiser would have changed', () => {
  const clean = `${JSON.stringify(createSanitizer().json(exchange()), null, 2)}\n`
  assert.deepEqual(checkSanitized(clean, { json: true }), [])
  const rules = (text, options) => checkSanitized(text, options).map((item) => item.rule)
  assert.deepEqual(
    rules(JSON.stringify({ response: { headers: { 'content-type': 'a', date: 'b' } } }), {
      json: true,
    }),
    ['header'],
  )
  assert.deepEqual(
    rules(JSON.stringify({ request: { authorization: 'Bearer abc' } }), { json: true }),
    ['credential-field'],
  )
  assert.deepEqual(rules(`{"id":"${LOG_ID}"}`, { json: true }), ['log-id'])
  assert.deepEqual(rules(`x ${SESSION_ID}`), ['opencode-id'])
  assert.deepEqual(rules(`x ${CALL_ID}`), ['tool-call-id'])
  assert.deepEqual(rules(`x ${REQUEST_ID}`), ['uuid'])
  assert.deepEqual(rules('"created":1893456000'), ['created'])
  assert.deepEqual(rules(`"projectId": "${PROJECT_ID}"`), ['project-id'])
  // A commit of a public repository is a reference, not an identifier of the probe.
  assert.deepEqual(
    rules(`upstream source at commit \`${PROJECT_ID}\` and commit ${PROJECT_ID}`),
    [],
  )
  assert.equal(createSanitizer().text(`at commit \`${PROJECT_ID}\``), `at commit \`${PROJECT_ID}\``)
  assert.deepEqual(rules(`Bearer ${PLAN_KEY}`), ['bearer'])
  assert.deepEqual(rules('in /Users/someone/x'), ['local-path'])
  assert.deepEqual(rules('{ not json', { json: true }), ['json'])
})

// ---- what the review of G0 tried against the sanitiser ---------------------------------------

/** A secret of no known shape: only the place it stands in gives it away. */
const OPAQUE = 'p4ssw0rdQ7p4ssw0rdQ7p4ssw0rdQ7'
const rulesOf = (text, options) => checkSanitized(text, options).map((item) => item.rule)

test('a JSON record is cleaned as strictly as the same text: names of secrets, property names, lists', () => {
  const out = createSanitizer().json({
    env: { RADITI_MCP_TOKEN: OPAQUE, PLAN_API_KEY: OPAQUE, DB_PASSWORD: OPAQUE, PATH: '/usr/bin' },
    thinking: { signature: 'abc123abc123abc123abc123' },
    sessions: { [SESSION_ID]: { title: 'x' } },
    keys: { [PLAN_KEY]: true },
    cookie: [`sid=${OPAQUE}`],
    'set-cookie': ['a=1; Path=/', `sid=${OPAQUE}`],
    authorization: [`Token ${OPAQUE}`],
    usage: { prompt_tokens: 7105, max_tokens: 32000, token: 5 },
    _meta: { progressToken: 2 },
  })
  const text = JSON.stringify(out, null, 2)
  for (const raw of [OPAQUE, SESSION_ID, PLAN_KEY.slice(0, 20), 'abc123abc123'])
    assert.ok(!text.includes(raw), raw)
  assert.deepEqual(out.env, {
    RADITI_MCP_TOKEN: '<removed>',
    PLAN_API_KEY: '<removed>',
    DB_PASSWORD: '<removed>',
    PATH: '/usr/bin',
  })
  assert.equal(out.thinking.signature, '<removed>')
  assert.deepEqual(Object.keys(out.sessions), ['ses_00000000000000000000000001'])
  assert.deepEqual(Object.keys(out.keys), ['<removed>'])
  assert.equal(out.cookie, '<removed>')
  assert.equal(out['set-cookie'], '<removed>')
  assert.equal(out.authorization, '<removed>')
  // Counters are not secrets, whatever their name ends with.
  assert.deepEqual(out.usage, { prompt_tokens: 7105, max_tokens: 32000, token: 5 })
  assert.deepEqual(out._meta, { progressToken: 2 })
  assert.deepEqual(checkSanitized(text, { json: true }), [])

  assert.ok(rulesOf(JSON.stringify({ cookie: [`sid=${OPAQUE}`] }), { json: true }).length > 0)
  assert.ok(rulesOf(JSON.stringify({ env: { DB_PASSWORD: OPAQUE } }), { json: true }).length > 0)
  assert.ok(rulesOf(JSON.stringify({ [SESSION_ID]: 1 }), { json: true }).length > 0)
})

test('headers under other names and in other forms go through the allowlist; an unknown form is refused', () => {
  const out = createSanitizer().json({
    request: {
      rawHeaders: [
        'Authorization',
        `Bearer ${OPAQUE}`,
        'X-Api-Key',
        OPAQUE,
        'Content-Type',
        'application/json',
      ],
    },
    response: {
      headers: [
        ['x-log-id', 'zz-unknown-shape-771'],
        ['set-cookie', 'sid=Zz91kq0Pq8Xw7Lm3; Path=/'],
        ['Content-Type', 'text/plain'],
        ['retry-after', '3'],
      ],
    },
    upstream: { responseHeaders: { 'cf-ray': '8f1a2b3c4d5e6f70-SIN', 'Retry-After': '9' } },
    // A value where a header name should be: it is neither kept nor listed.
    odd: { headers: { [OPAQUE]: 'x', [PLAN_KEY]: 'y', [`x-${LOG_ID}`]: 'z', vary: 'accept' } },
  })
  assert.deepEqual(out.request.rawHeaders, { 'content-type': 'application/json' })
  assert.deepEqual(out.request.removedHeaderNames, ['authorization', 'x-api-key'])
  assert.deepEqual(out.request.credentials, [
    { header: 'authorization', scheme: 'bearer', value: '<removed>' },
    { header: 'x-api-key', value: '<removed>' },
  ])
  assert.deepEqual(out.response.headers, { 'content-type': 'text/plain', 'retry-after': '3' })
  assert.deepEqual(out.response.removedHeaderNames, ['set-cookie', 'x-log-id'])
  assert.deepEqual(out.upstream.responseHeaders, { 'retry-after': '9' })
  assert.deepEqual(out.upstream.removedHeaderNames, ['cf-ray'])
  assert.deepEqual(out.odd, { headers: {}, removedHeaderNames: ['vary'] })
  const text = JSON.stringify(out)
  for (const raw of [OPAQUE, 'Zz91kq0P', 'zz-unknown', '8f1a2b3c', PLAN_KEY.slice(0, 20), LOG_ID])
    assert.ok(!text.includes(raw), raw)
  assert.deepEqual(checkSanitized(text, { json: true }), [])

  // A form nobody taught the sanitiser is refused, and the refusal quotes nothing.
  for (const odd of [`x-log-id: ${LOG_ID}`, ['a', 'b', 'c'], [['a', 'b', 'c']], 7])
    assert.throws(
      () => createSanitizer().json({ response: { headers: odd } }),
      (error) => /headers/.test(error.message) && !error.message.includes(LOG_ID),
    )
  assert.deepEqual(createSanitizer().json({ headers: null }), { headers: null })

  assert.deepEqual(rulesOf(JSON.stringify({ responseHeaders: { date: 'x' } }), { json: true }), [
    'header',
  ])
  assert.deepEqual(rulesOf(JSON.stringify({ headers: [['content-type', 'a']] }), { json: true }), [
    'header',
  ])
})

test('the summaries of an earlier pass are rebuilt, never trusted', () => {
  const out = createSanitizer().json({
    request: {
      headers: { 'content-type': 'application/json' },
      removedHeaderNames: ['accept', PLAN_KEY, OPAQUE, 'X-Log-Id', 42, `x-${LOG_ID}`],
      credentials: [
        { header: 'Authorization', scheme: 'Bearer', value: '<dummy llm token>' },
        { header: 'x-api-key', scheme: OPAQUE, value: PLAN_KEY, note: OPAQUE },
        { header: OPAQUE, value: '<removed>' },
        `Bearer ${OPAQUE}`,
      ],
    },
    // Not the sanitiser's summary at all: dropped rather than guessed at.
    other: { credentials: 'include', removedHeaderNames: 'accept' },
  })
  assert.deepEqual(out.request.removedHeaderNames, ['accept', 'x-log-id'])
  assert.deepEqual(out.request.credentials, [
    { header: 'authorization', scheme: 'bearer', value: '<dummy llm token>' },
    { header: 'x-api-key', value: '<removed>' },
  ])
  assert.deepEqual(out.other, {})
  assert.deepEqual(checkSanitized(JSON.stringify(out), { json: true }), [])

  const refused = (value) => rulesOf(JSON.stringify(value), { json: true })
  assert.deepEqual(refused({ credentials: [{ header: 'authorization', value: OPAQUE }] }), [
    'credential-field',
  ])
  assert.deepEqual(
    refused({ credentials: [{ header: 'authorization', value: '<removed>', note: 'x' }] }),
    ['credential-field'],
  )
  assert.deepEqual(refused({ credentials: 'include' }), ['credential-field'])
  assert.deepEqual(refused({ removedHeaderNames: ['accept', OPAQUE] }), ['header'])
  assert.deepEqual(refused({ removedHeaderNames: 'accept' }), ['header'])
})

test('a secret after an escaped line break, glued to a letter or percent-encoded is still removed', () => {
  const sanitizer = createSanitizer()
  // In a JSONL line and in a body kept as a string a line break is the two characters `\n`: the
  // letter must not hide the start of what follows.
  const nested = JSON.stringify({
    content: `first line\n${PLAN_KEY}\nBearer ${OPAQUE}\n${JWT}\n${LOG_ID}\tsk-${'x1'.repeat(14)}`,
  })
  for (const out of [
    sanitizer.text(nested),
    sanitizer.json({ response: { body: nested } }).response.body,
  ]) {
    for (const raw of [PLAN_KEY.slice(0, 20), OPAQUE, JWT, LOG_ID, 'x1x1x1'])
      assert.ok(!out.includes(raw), raw)
    assert.deepEqual(JSON.parse(out).content.split('\n').slice(0, 4), [
      'first line',
      '<removed>',
      'Bearer <removed>',
      '<removed>',
    ])
    assert.deepEqual(checkSanitized(out), [])
  }
  assert.deepEqual(
    findLeaks(`{"content":"a\\n${PLAN_KEY}"}`).map((item) => item.rule),
    ['plan-key'],
  )
  assert.deepEqual(rulesOf(`{"content":"a\\n${LOG_ID}"}`), ['log-id'])
  assert.equal(sanitizer.text(`x${PLAN_KEY}`), 'x<removed>')
  assert.equal(
    sanitizer.text(`authorization=Bearer%20${PLAN_KEY}`),
    'authorization=Bearer%20<removed>',
  )
  // A secret part with a dash or an underscore is still the key of the plan.
  assert.equal(sanitizer.text(`${'a1b2c3d4'.repeat(4)}.Zx9Q_w8Er-7Ty6Ui5O`), '<removed>')
  // Text that only looks escaped comes back as it was.
  const plain =
    'printf "a\\nb\\tc\\r" in C:\\new\\table, \\\\n and a lock 0000000000000000000000000000000000000001.lock'
  assert.equal(sanitizer.text(plain), plain)
})

test('authorization and cookie lines of a log lose their values, whatever the scheme or the cookie', () => {
  const sanitizer = createSanitizer()
  const out = sanitizer.text(
    [
      `> Authorization: ${OPAQUE}`,
      `> authorization: token ${OPAQUE}`,
      `"proxy-authorization":"Digest ${OPAQUE}"`,
      '< set-cookie: cdn_sec_tc=abcdef0123456789abcdef; Path=/; Max-Age=1800; HttpOnly',
      '> Cookie: sid=Zz91kq0Pq8Xw7Lm3; theme=dark1',
      `HTTPS_PROXY=http://egress:${OPAQUE}@10.0.0.7:3128`,
      `{"signature":"abc123abc123abc123abc123","id":"fc_${CALL_ID}"}`,
    ].join('\n'),
  )
  assert.equal(
    out,
    [
      '> Authorization: <removed>',
      '> authorization: token <removed>',
      '"proxy-authorization":"Digest <removed>"',
      '< set-cookie: cdn_sec_tc=<removed>; Path=/; Max-Age=1800; HttpOnly',
      '> Cookie: sid=<removed>; theme=<removed>',
      'HTTPS_PROXY=http://<removed>@10.0.0.7:3128',
      '{"signature":"<removed>","id":"fc_call_000000000000000000000001"}',
    ].join('\n'),
  )
  assert.equal(createSanitizer().text(out), out)
  assert.deepEqual(checkSanitized(out), [])
  assert.deepEqual(
    [
      ...new Set(
        findLeaks(`Authorization: ${OPAQUE}\nCookie: sid=Zz91kq0Pq8Xw7Lm3`).map(
          (item) => item.rule,
        ),
      ),
    ],
    ['authorization', 'cookie-line'],
  )

  // What the notes and the scripts of the probe say about these headers stays as written.
  const prose = [
    '`x-log-id`, `set-cookie: acw_tc=…`, `vary`; set-cookie: acw_tc=<removed>;path=/',
    'authorization: `Bearer ${realKey()}` }',
    "authorization: use === 'bearer' ? `Bearer ${realKey()}` : realKey() }",
    '"Authorization": "Bearer {env:RADITI_MCP_TOKEN}"',
    'Authorization: Bearer <key>` (the bare key) and Authorization: Bearer invalid-key',
    "new Set(['authorization', 'cookie', 'set-cookie']); (cookie) => cookie.trim()",
    'the request has no cookie: none was set; "authorizationScheme": "raw"',
    'https://registry.npmjs.org/@opencode-ai/plugin and http://sandbox-gw:8080/zai/v4',
  ].join('\n')
  assert.equal(createSanitizer().text(prose), prose)
  assert.deepEqual(checkSanitized(prose), [])
})

test('the home directory of a Linux machine is a machine path too', () => {
  const out = createSanitizer().text(
    'cwd /home/someone/work/site, cache /home/runner/.cache/x; /home/name/project stays',
  )
  assert.equal(
    out,
    'cwd /home/<user>/work/site, cache /home/<user>/.cache/x; /home/name/project stays',
  )
  assert.deepEqual(rulesOf('in /home/someone/x'), ['local-path'])
  assert.deepEqual(rulesOf(out), [])
})

const run = (...args) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  })

test('copy writes nothing unless every file of the pass can be cleaned', () => {
  const from = join(tmp, 'whole-from')
  const to = join(tmp, 'whole-to')
  mkdirSync(from, { recursive: true })
  writeFileSync(join(from, 'a-good.json'), JSON.stringify(exchange()))
  writeFileSync(
    join(from, 'b-odd.json'),
    JSON.stringify({ response: { headers: `x-log-id: ${LOG_ID}` } }),
  )
  const refused = run('copy', '--from', from, '--to', to, 'a-good.json', 'b-odd.json')
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /b-odd\.json/)
  assert.ok(!`${refused.stdout}${refused.stderr}`.includes(LOG_ID))
  assert.ok(!existsSync(to), 'nothing of a refused pass is left behind')

  writeFileSync(join(from, 'c-binary.bin'), Buffer.from([1, 0, 2]))
  const binary = run('copy', '--from', from, '--to', to, 'a-good.json', 'c-binary.bin')
  assert.notEqual(binary.status, 0)
  assert.match(binary.stderr, /c-binary\.bin/)
  assert.ok(!existsSync(to))

  assert.equal(run('copy', '--from', from, '--to', to, 'a-good.json').status, 0)
  assert.ok(existsSync(join(to, 'a-good.json')))
})

test('the command copies only through the sanitiser, checks its output and scans without quoting', () => {
  const from = join(tmp, 'from')
  const to = join(tmp, 'to')
  mkdirSync(join(from, 'run'), { recursive: true })
  writeFileSync(join(from, 'run', '01-llm.json'), JSON.stringify(exchange(), null, 2))
  writeFileSync(join(from, 'stdout.txt'), `Exporting session: ${SESSION_ID}\n`)
  writeFileSync(join(from, 'left-behind.json'), JSON.stringify({ authorization: PLAN_KEY }))

  const copied = run('copy', '--from', from, '--to', to, 'run', 'stdout.txt')
  assert.equal(copied.status, 0, copied.stderr)
  const report = JSON.parse(copied.stdout)
  assert.deepEqual(report.files, ['run/01-llm.json', 'stdout.txt'])
  assert.equal(report.headersDropped['x-log-id'], 1)
  assert.ok(!existsSync(join(to, 'left-behind.json')))
  const written = JSON.parse(readFileSync(join(to, 'run', '01-llm.json'), 'utf8'))
  assert.deepEqual(written, createSanitizer().json(exchange()))
  assert.equal(
    readFileSync(join(to, 'stdout.txt'), 'utf8'),
    'Exporting session: ses_00000000000000000000000001\n',
  )

  assert.equal(run('check', to).status, 0)
  writeFileSync(join(to, 'raw.json'), JSON.stringify({ response: { headers: { date: 'x' } } }))
  const refused = run('check', to)
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /raw\.json.*header/)

  const scan = run('scan', from)
  assert.equal(scan.status, 1)
  assert.match(scan.stdout, /left-behind\.json/)
  assert.match(scan.stdout, /plan-key/)
  assert.ok(!`${scan.stdout}${scan.stderr}`.includes(PLAN_KEY.slice(0, 10)))
  assert.equal(run('scan', join(from, 'stdout.txt')).status, 0)

  // A config of the probe is a script, not a recorded exchange: `text:` keeps its header
  // templates and still applies the text rules.
  mkdirSync(join(from, 'cfg'))
  const config = `{ "mcp": { "headers": { "Authorization": "Bearer {env:RADITI_MCP_TOKEN}" } } }\n`
  writeFileSync(join(from, 'cfg', 'c.json'), config)
  writeFileSync(join(from, 'cfg', 'd.json'), `{ "note": "${SESSION_ID}" }\n`, { mode: 0o600 })
  writeFileSync(join(from, 'cfg', 'entry.sh'), '#!/bin/sh\n', { mode: 0o700 })
  const asText = run('copy', '--from', from, '--to', join(tmp, 'to-text'), 'text:cfg', 'run')
  assert.equal(asText.status, 0, asText.stderr)
  assert.equal(readFileSync(join(tmp, 'to-text', 'cfg', 'c.json'), 'utf8'), config)
  assert.equal(
    readFileSync(join(tmp, 'to-text', 'cfg', 'd.json'), 'utf8'),
    '{ "note": "ses_00000000000000000000000001" }\n',
  )
  assert.deepEqual(JSON.parse(asText.stdout).files, [
    'cfg/c.json',
    'cfg/d.json',
    'cfg/entry.sh',
    'run/01-llm.json',
  ])
  // Only the executable bit of a source is carried over: a record kept private is not a mode.
  const mode = (name) => statSync(join(tmp, 'to-text', 'cfg', name)).mode & 0o777
  assert.equal(mode('entry.sh'), 0o755)
  assert.equal(mode('d.json'), 0o644)

  // A destination inside the source, an entry outside it and a missing entry are refused.
  assert.notEqual(run('copy', '--from', from, '--to', join(from, 'out'), 'run').status, 0)
  assert.notEqual(run('copy', '--from', from, '--to', to, '../x').status, 0)
  assert.notEqual(run('copy', '--from', from, '--to', to, 'missing').status, 0)
})

// ---- what the gates of the G0 and G1 batch added ---------------------------------------------

/** Shaped like `mcpToken` of apps/orchestrator/src/llm/turn-key.ts; nothing ever issued it. */
const MCP_TOKEN = `mcp_${'5e7a'.repeat(16)}`

test('the MCP token of the platform is removed wherever it stands, with no name to give it away', () => {
  const sanitizer = createSanitizer()
  const plain = sanitizer.text(
    [
      `the turn got ${MCP_TOKEN} and went on`,
      `GET /mcp/${MCP_TOKEN}/tools HTTP/1.1`,
      `Authorization: Bearer ${MCP_TOKEN}`,
      `x-turn: ${MCP_TOKEN}`,
      `glued${MCP_TOKEN}9f tail`,
      `upper ${MCP_TOKEN.toUpperCase()}`,
    ].join('\n'),
  )
  assert.equal(
    plain,
    [
      'the turn got <removed> and went on',
      'GET /mcp/<removed>/tools HTTP/1.1',
      'Authorization: Bearer <removed>',
      'x-turn: <removed>',
      'glued<removed> tail',
      'upper <removed>',
    ].join('\n'),
  )
  assert.equal(createSanitizer().text(plain), plain)
  assert.deepEqual(checkSanitized(plain), [])

  // The places the review of G1 got a raw token through: a message of an event, a path, a
  // property name, a body kept as a string, the value of an allowed header, a line of the sink.
  const record = {
    event: { message: `connected with ${MCP_TOKEN}` },
    url: `http://sandbox-gw:8080/mcp/${MCP_TOKEN}`,
    [MCP_TOKEN]: true,
    responseBody: JSON.stringify({ error: `bad token ${MCP_TOKEN}` }),
    request: { headers: { 'content-type': MCP_TOKEN } },
    sink: [`first line\n${MCP_TOKEN}`],
  }
  const out = sanitizer.json(record)
  const text = JSON.stringify(out, null, 2)
  assert.ok(!text.includes('5e7a5e7a'), 'a part of the token is left')
  assert.equal(out.event.message, 'connected with <removed>')
  assert.equal(out.url, 'http://sandbox-gw:8080/mcp/<removed>')
  assert.deepEqual(out.request.headers, { 'content-type': '<removed>' })
  assert.deepEqual(checkSanitized(text, { json: true }), [])
  assert.equal(sanitizer.report().secrets['mcp-token'], 12)

  assert.deepEqual(
    findLeaks(`a\n${MCP_TOKEN}`).map(({ rule, line }) => [rule, line]),
    [['mcp-token', 2]],
  )
  assert.deepEqual([...new Set(rulesOf(JSON.stringify(record), { json: true }))], ['mcp-token'])

  // What the documents and the scripts say about the token stays as written.
  const prose = [
    'the token is `mcp_` and 64 hex digits; SHAPES = /sk-rdt-[A-Za-z0-9_-]{43}|mcp_[0-9a-f]{64}/g',
    'k.mcp_token_hash IS NOT NULL; <dummy mcp token>; raditi-glm-dummy-mcp-token-000000000000',
    `a digest is not a token: sha256 ${'415487fc'.repeat(8)}; mcp_${'5e7a'.repeat(4)} is too short`,
  ].join('\n')
  assert.equal(createSanitizer().text(prose), prose)
  assert.deepEqual(checkSanitized(prose), [])
})

test('a finding of a secret tells the rule, the line and the length, never a character of the value', () => {
  // The findings go to the terminal and into the log of a failed test in CI.
  const secrets = {
    'plan-key': PLAN_KEY,
    jwt: JWT,
    'sk-key': `sk-rdt-${'x1'.repeat(21)}x`,
    'mcp-token': MCP_TOKEN,
    bearer: `Bearer ${'q7'.repeat(12)}`,
    'assigned-secret': `password = "${'Zq4'.repeat(9)}"`,
    authorization: `Authorization: ${OPAQUE}`,
    cookie: 'acw_tc=0a1b2c3d4e5f60718293a4b5c6d7e8f9',
    'cookie-line': 'Cookie: sid=Zz91kq0Pq8Xw7Lm3',
    'url-userinfo': `http://egress:${OPAQUE}@10.0.0.7:3128`,
    email: 'someone@owner-mail.dev',
    'private-key': pemHeader('OPENSSH '),
  }
  for (const [rule, value] of Object.entries(secrets)) {
    const found = findLeaks(`line one\nsee ${value}\n`)
    assert.deepEqual(
      found.map((item) => [item.rule, item.line]),
      [[rule, 2]],
      rule,
    )
    assert.match(found[0].excerpt, /^\d+ chars$/, rule)
  }
  // The same through `check` of a text, and for what stands where a header name should be.
  assert.deepEqual(checkSanitized(`x ${PLAN_KEY}`), [
    { rule: 'plan-key', line: 1, excerpt: `${PLAN_KEY.length} chars` },
  ])
  assert.deepEqual(checkSanitized(JSON.stringify({ headers: { [OPAQUE]: 'x' } }), { json: true }), [
    { rule: 'header', excerpt: `${OPAQUE.length} chars` },
  ])
  // An identifier names no credential: its first characters stay, so that a reader finds it.
  assert.deepEqual(findIdentifiers(`x ${SESSION_ID}`), [
    { rule: 'opencode-id', line: 1, excerpt: `ses_… (${SESSION_ID.length} chars)` },
  ])

  const dir = join(tmp, 'silent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'log.txt'), `see ${PLAN_KEY}\nand ${MCP_TOKEN}\n`)
  const findings = (output) =>
    output
      .split('\n')
      .filter((line) => line.includes('log.txt: '))
      .map((line) => line.slice(line.indexOf('log.txt: ') + 9))
  assert.deepEqual(findings(run('scan', dir).stdout), [
    `SECRET plan-key (line 1): ${PLAN_KEY.length} chars`,
    `SECRET mcp-token (line 2): ${MCP_TOKEN.length} chars`,
  ])
  assert.deepEqual(findings(run('check', dir).stderr), [
    `plan-key (line 1): ${PLAN_KEY.length} chars`,
    `mcp-token (line 2): ${MCP_TOKEN.length} chars`,
  ])
})

// The probe material of the OpenCode and Z.ai pivot in the repository: it got there only through
// this script, and this test keeps it that way. The check goes by shape and needs no key.
const files = (dir) =>
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? files(path) : [path]
    })

test('the probe samples in the repository are sanitised', () => {
  const samples = files(join(research, 'samples'))
  const names = samples.map((file) => relative(join(research, 'samples'), file))
  for (const expected of [
    '10-err-invalid-key.json',
    '14-err-unknown-path.json',
    '21-paas-chat.json',
    '23-coding-chat-stream.json',
    '31-run-a-default/01-llm-post_chat_completions.json',
    '36-run-d3-result/08-llm-post_chat_completions.json',
    '39-err-json200-short/05-llm-post_chat_completions-fault.json',
    '43-variant-max/01-llm-post_chat_completions.json',
    '45-file-secrets-fifo/05-llm-post_chat_completions-fault.json',
    '46-quota-limit-raw.json',
    '54-coding-err-bad-param-stream.json',
    '55-import/05-llm-post_chat_completions-fault.json',
    '60-quota-idle-before.json',
    '61-chat-first-after-idle.json',
    '62-quota-idle-after.json',
  ])
    assert.ok(names.includes(expected), `${expected} is missing`)

  let headers = 0
  for (const file of samples) {
    const text = readFileSync(file, 'utf8')
    assert.deepEqual(checkSanitized(text, { json: true }), [], relative(research, file))
    walk(JSON.parse(text), (value, key) => {
      if (key !== 'headers') return
      headers += 1
      for (const name of Object.keys(value))
        assert.ok(ALLOWED_HEADERS.includes(name), `${relative(research, file)}: ${name}`)
    })
  }
  assert.ok(headers > 100, 'the samples keep their header objects')
})

test('nothing else in the research directory holds a key, a bearer value or a raw identifier', () => {
  const rest = files(research).filter((file) => !file.startsWith(join(research, 'samples')))
  assert.ok(rest.some((file) => file.endsWith(join('40-session-state', 'stdout.txt'))))
  assert.ok(rest.some((file) => file.endsWith(join('strings', 'ctx-retry.txt'))))
  for (const file of rest)
    assert.deepEqual(checkSanitized(readFileSync(file, 'utf8')), [], relative(research, file))
})
