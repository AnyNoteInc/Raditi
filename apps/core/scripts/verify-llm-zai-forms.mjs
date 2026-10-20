// What the scenarios of the platform (verify-llm-protocol, -gateway-stream, -crashes and
// -lifecycle) take of the group they run on, as data: the forms of a raw request of the group's
// CLI and how the synthetic provider plays what a scenario asks of it. The scenarios name no
// provider, no CLI and no code of either; the Z.ai group names them here, once.
import { SYNTHETIC_ZAI_MARKER } from '../../../infra/dev/llm-verify/fake-zai.mjs'
import { opencodeUserAgent } from '../../../packages/llm-backends/src/zai-coding/backend.ts'
import {
  ZAI_BACKEND,
  ZAI_MODEL,
  ZAI_OFFERS,
  ZAI_PROFILE,
  ZAI_STAND_RATES,
} from './verify-llm-zai-setup.mjs'

const body = (text = 'Synthetic request.') => ({
  model: ZAI_MODEL,
  max_tokens: 32_000,
  messages: [{ role: 'user', content: text }],
  stream: true,
  stream_options: { include_usage: true },
})

/** A free-form schema of a tool, `levels` objects deep: more than the gateway reads of a body. */
function nestedSchema(levels) {
  let schema = { type: 'string' }
  for (let depth = 0; depth < levels; depth++)
    schema = { type: 'object', properties: { nested: schema } }
  return schema
}

/** An error object the provider sends inside a stream it has started with HTTP 200. */
const inStream = (code) => ({ scenario: 'stream_error', code })

export const zaiForms = Object.freeze({
  ids: Object.freeze({
    backend: ZAI_BACKEND,
    driver: 'opencode',
    model: ZAI_MODEL,
    profile: ZAI_PROFILE,
  }),
  /** The one route of the backend, at sandbox-gw and at the role llm alike. */
  route: ZAI_OFFERS.plan.route,
  userAgent: opencodeUserAgent,
  body,
  /** Stands in every text of the provider: it must reach neither a sandbox nor a log. */
  providerMarker: SYNTHETIC_ZAI_MARKER,
  /** Requests the role answers with 400 before any provider request: [body, headers]. */
  refusedRequests: () => [
    [body(), { 'content-type': 'text/plain' }],
    ['{"invalid":', {}],
    [{ ...body(), model: 'not-the-issued-model' }, {}],
    [{ ...body(), unexpected: true }, {}],
    // The provider's documentation names `web_search` and `retrieval` as tools of its own.
    [{ ...body(), tools: [{ type: 'web_search', web_search: { enable: true } }] }, {}],
    [
      {
        ...body(),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'https://synthetic.invalid/pixel.png' } },
            ],
          },
        ],
      },
      {},
    ],
    [
      {
        ...body(),
        tools: [
          { type: 'function', function: { name: 'synthetic', parameters: nestedSchema(70) } },
        ],
      },
      {},
    ],
  ],
  /** Paths of the provider next to the route: nobody's to ask from a sandbox. */
  closedPaths: Object.freeze(['/zai/v4/models', '/zai/monitor/usage/quota/limit']),
  /** What the body policy rewrites instead of refusing, and what the provider must then get. */
  rewritten: Object.freeze({
    change: { stream: false, stream_options: undefined },
    received: { stream: true, stream_options: { include_usage: true } },
  }),
  /**
   * What the synthetic provider counts for an answer unless a scenario names other numbers, the
   * stand rates of the profile (₽ per million tokens) and the cost of that answer at them:
   * (321 × 10 + 6 784 × 1 + 94 × 30) / 1 000 000.
   */
  usage: Object.freeze({
    inputUncachedTokens: 321,
    cacheReadTokens: 6784,
    cacheWriteTokens: 0,
    outputTokens: 94,
    reasoningTokens: 54,
  }),
  rates: ZAI_STAND_RATES,
  answerCostRub: '0.0128140000',
  /** The last frame of a finished stream, as the sandbox receives it. */
  streamEnd: 'data: [DONE]',
  answers: Object.freeze({
    text: (text) => ({ scenario: 'text', ...(text === undefined ? {} : { text }) }),
    /**
     * An answer that starts and then holds for `delayMs`; `usage` in the terms of the
     * platform's accounting (`input` is the whole prompt, the cached part included).
     */
    held: (delayMs, usage) => ({
      scenario: 'text',
      delayMs,
      ...(usage
        ? {
            usage: {
              prompt: usage.input,
              cached: usage.cacheRead,
              completion: usage.output,
              reasoning: usage.reasoning,
            },
          }
        : {}),
    }),
    // A code the adapter's table reads as short-lived (decision 9 of the pivot plan).
    shortLived: Object.freeze({ scenario: 'error', code: 1302 }),
    // A code the table reads as a risk to the account: on the chat path and, for the probe
    // that must confirm it, in the envelope of the quota path.
    accountRisk: Object.freeze({ scenario: 'error', code: 1309 }),
    accountRiskConfirmed: Object.freeze({ mode: 'envelope', code: 1309 }),
    accountHealthy: Object.freeze({ mode: 'live' }),
    // No documented answer of the provider is a 402 that the adapter reads as short-lived, and
    // only such an answer starts the platform's payment checks: the short-lived code under
    // that status is a form of this stand, not of the provider.
    paymentRequired: Object.freeze({ scenario: 'error', code: 1302, status: 402 }),
    /** The short-lived refusal inside a started stream, once; the next request is answered. */
    shortLivedInStream: (text) => ({ ...inStream(1302), failures: 1, text }),
  }),
  /**
   * Failures inside a started stream that end the turn: [name, answer of the provider, what
   * llm_keys.last_refusal then reads]. Z.ai has not been seen to refuse inside a stream; the
   * adapter reads an error object there by the same code table as a refused request.
   */
  finalStreamFailures: Object.freeze([
    ['a content refusal (1301)', inStream(1301), 'policy_flagged'],
    ['a spent window (1308)', inStream(1308), 'subscription_limit'],
    ['an account refusal (1113)', inStream(1113), 'account'],
    ['a rejected request (1261)', inStream(1261), 'request_rejected'],
    ['a model outside the plan (1211)', inStream(1211), 'profile'],
  ]),
})
