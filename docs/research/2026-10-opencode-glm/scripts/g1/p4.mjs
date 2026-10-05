// Point 4 of G1 — refusal forms: what the CLI does with each answer the gateway could give instead of a
// completion. One run per form; the fake gives the same answer to every request (at most CAP, then 401),
// so the number of requests, the pauses between them and the exit code are the CLI's own.
import {
  AGENTS_MARKER,
  MODEL,
  chunks,
  config,
  newTokens,
  pool,
  resultStep,
  save,
  sha256,
  summariseRecords,
  toolStep,
} from './lib.mjs'

const CAP = 12
const refusal = (code, message, extra = {}) => ({
  error: { type: 'invalid_request_error', code, message, ...extra },
})
const http = (status, body, headers) => ({ kind: 'http', status, body, headers })
const sse = (events, end = 'end') => ({ kind: 'sse', events, end })
const partial = (finish) =>
  chunks({ reasoning: 'Thinking.', text: 'Partial answer of the stand. ', finish })
const errorEvent = refusal('raditi_budget', 'The budget of this turn is spent.')

/** name → the step every request of the run gets; `first` are ordinary steps answered before it. */
export const FORMS = {
  // Final refusals of decision 6.
  'http-400-policy': {
    step: http(
      400,
      refusal('raditi_policy', 'The request is not allowed by the policy of this turn.'),
    ),
  },
  'http-400-field': {
    step: http(
      400,
      refusal('raditi_policy', 'The request is not allowed by the policy of this turn.', {
        field: 'messages[].content',
      }),
    ),
  },
  // Control: the role's present body names the index, and 502 is one of the CLI's retry patterns.
  'http-400-field-index': {
    step: http(
      400,
      refusal('raditi_policy', 'The request is not allowed by the policy of this turn.', {
        field: 'messages[502].content',
      }),
    ),
  },
  'http-402': {
    step: http(402, refusal('raditi_account', 'The account of this turn cannot be used.')),
  },
  'http-403-budget': {
    step: http(403, refusal('raditi_budget', 'The budget of this turn is spent.')),
  },
  // Brief refusal of decision 6 and its control without the header.
  'http-503-retry-after': {
    step: http(
      503,
      { error: { type: 'api_error', code: 'raditi_busy', message: 'The gateway is busy.' } },
      { 'retry-after': '3' },
    ),
  },
  'http-503-plain': {
    step: http(503, {
      error: { type: 'api_error', code: 'raditi_busy', message: 'The gateway is busy.' },
    }),
  },
  // Control: a refusal whose text matches a context overflow pattern of the CLI.
  'http-400-overflow-words': {
    step: http(400, refusal('raditi_policy', 'The request has too many tokens for this turn.')),
  },
  // Inside a started stream.
  'sse-error-first': { step: sse([errorEvent]) },
  'sse-error-done': { step: sse([errorEvent, '[DONE]']) },
  'sse-error-after-text': {
    step: sse([
      ...chunks({ text: 'Partial answer of the stand. ', finish: null, done: false }),
      errorEvent,
    ]),
  },
  // Control: the same event with a text the CLI's retry patterns know.
  'sse-error-retry-words': {
    step: sse([refusal('raditi_busy', 'The service is overloaded, try again later.')]),
  },
  'sse-finish-content_filter': { step: sse(partial('content_filter')) },
  'sse-finish-sensitive': { step: sse(partial('sensitive')) },
  'sse-finish-sensitive-empty': { step: sse(chunks({ finish: 'sensitive' })) },
  'sse-finish-network_error': { step: sse(partial('network_error')) },
  'sse-finish-model_context_window_exceeded': {
    step: sse(partial('model_context_window_exceeded')),
  },
  'sse-finish-length': { step: sse(partial('length')) },
  'sse-done-only': { step: sse(['[DONE]']) },
  'sse-no-finish': { step: sse(chunks({ text: 'Partial answer of the stand. ', finish: null })) },
  'sse-no-finish-no-done': {
    step: sse(chunks({ text: 'Partial answer of the stand. ', finish: null, done: false })),
  },
  'sse-empty': { step: sse([]) },
  'sse-cut': {
    step: sse(
      chunks({ text: 'Partial answer of the stand. ', finish: null, done: false }),
      'destroy',
    ),
  },
  // The same two candidates for "the turn ends in one request", after a completed tool step.
  'mid-http-403': {
    first: [
      toolStep([
        { name: 'bash', arguments: { command: 'echo step-one', description: 'first step' } },
      ]),
    ],
    step: http(403, refusal('raditi_budget', 'The budget of this turn is spent.')),
  },
  'mid-sse-error': {
    first: [
      toolStep([
        { name: 'bash', arguments: { command: 'echo step-one', description: 'first step' } },
      ]),
    ],
    step: sse([errorEvent]),
  },
  // Control: an ordinary turn through the same path.
  'control-ok': { step: resultStep() },
}

async function form(stand, name, { first = [], step }) {
  const run = `p4-${name}`
  const tokens = newTokens()
  await stand.scenario(run, {
    llmKeySha256: sha256(tokens.llm),
    mcpTokenSha256: sha256(tokens.mcp),
    cap: CAP + first.length,
    steps: [...first, { ...step, repeat: 'forever' }],
  })
  const cli = await stand.cli(run)
  await cli.stage({
    configText: JSON.stringify(config(run), null, 2),
    agentsMd: `${AGENTS_MARKER}\n`,
    secrets: tokens,
  })
  const turn = await cli.turn({ prompt: 'Client request: say ok', needles: tokens, timeoutS: 200 })
  const records = await stand.records(run)
  save(stand, run, 'records.json', records)
  await cli.remove()
  const requests = summariseRecords(records)
  const refused = requests.llmRequests - first.length
  return {
    form: name,
    requests: requests.llmRequests,
    ofTheForm: Math.min(refused, CAP),
    capped: requests.capped,
    gapsS: requests.gapsMs
      .slice(first.length ? first.length - 1 : 0)
      .map((gap) => Math.round(gap / 100) / 10),
    exit: turn.exit,
    timedOut: turn.wrapper.timedOut ?? false,
    wallS: Math.round(turn.wallMs / 100) / 10,
    events: turn.eventCounts,
    stepReasons: turn.steps.map((item) => item.reason),
    texts: turn.texts.map((text) => text.slice(0, 80)),
    errors: turn.errors.map((error) => ({
      name: error?.name,
      message: String(error?.data?.message ?? '').slice(0, 200),
      statusCode: error?.data?.statusCode,
      isRetryable: error?.data?.isRetryable,
      hasResponseBody: error?.data?.responseBody !== undefined,
      metadata: error?.data?.metadata,
    })),
    stderr: turn.stderrHead.slice(0, 300),
    logErrors: turn.logErrors.slice(0, 3),
    sessionMessages: turn.left?.db?.messages?.[0]?.n,
    dbWalBytes: turn.left?.files.find((file) => file.path.endsWith('opencode.db-wal'))?.size,
    hits: [...turn.outputHits, ...(turn.left?.hits ?? [])],
    model: MODEL,
  }
}

export async function p4(stand) {
  const only = process.env.SPIKE_FORMS?.split(',')
  const names = Object.keys(FORMS).filter((name) => !only || only.includes(name))
  const results = await pool(
    names.map((name) => () => form(stand, name, FORMS[name])),
    Number(process.env.SPIKE_PARALLEL ?? 3),
  )
  return { cap: CAP, forms: results }
}
