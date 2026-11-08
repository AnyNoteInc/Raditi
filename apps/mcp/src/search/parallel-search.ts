import { z } from 'zod'

/** Parallel Search (https://docs.parallel.ai/search/search-quickstart): the one endpoint used. */
export const PARALLEL_SEARCH_URL = 'https://api.parallel.ai/v1/search'

/** How much of the answer is read and what of it reaches the agent. */
export const webSearchBounds = {
  maxResults: 5,
  /** Asked of the service: characters of excerpts per result and in the whole answer. */
  maxCharsPerResult: 1200,
  maxCharsTotal: 5000,
  /** Read of the answer: a longer body is a failure, not a truncated result. */
  maxBodyBytes: 512 * 1024,
  title: 200,
  url: 2048,
  excerptsPerResult: 3,
  excerpt: 600,
} as const

/** How a call to the search service ended: what is logged and what the agent is told. */
export const webSearchStatuses = [
  'ok',
  'timeout',
  'rate_limited',
  'quota_exhausted',
  'failed',
] as const
export type WebSearchStatus = (typeof webSearchStatuses)[number]

export interface WebSearchResult {
  title: string | null
  url: string
  excerpts: string[]
}

export type WebSearchOutcome =
  | { status: 'ok'; results: WebSearchResult[] }
  | { status: Exclude<WebSearchStatus, 'ok'>; httpStatus?: number }

const answerSchema = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullish(),
      excerpts: z.array(z.string()).nullish(),
    }),
  ),
})

/** The service's words for an exhausted balance; a 402 says so by itself. */
const quotaWords = /quota|credit|balance|insufficient|billing|payment/i

export interface ParallelSearchOptions {
  apiKey: string
  timeoutMs: number
  fetch?: typeof globalThis.fetch
}

/**
 * One request to Parallel Search in its `fast` mode, for one search phrase. The key goes only in
 * the `x-api-key` header of this request; neither it, nor the phrase, nor the answer is logged
 * or kept. Never throws: every way it ends is a status.
 */
export async function parallelSearch(
  query: string,
  { apiKey, timeoutMs, fetch = globalThis.fetch }: ParallelSearchOptions,
): Promise<WebSearchOutcome> {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const response = await fetch(PARALLEL_SEARCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(parallelSearchRequest(query)),
      redirect: 'error',
      signal,
    })
    const body = await boundedText(response, webSearchBounds.maxBodyBytes)
    if (response.status === 200) {
      const answer = body === null ? undefined : answerSchema.safeParse(safeJson(body))
      return answer?.success
        ? { status: 'ok', results: resultsOf(answer.data.results) }
        : { status: 'failed', httpStatus: 200 }
    }
    const httpStatus = response.status
    if (
      httpStatus === 402 ||
      ((httpStatus === 429 || httpStatus === 403) && quotaWords.test(body ?? ''))
    )
      return { status: 'quota_exhausted', httpStatus }
    if (httpStatus === 429) return { status: 'rate_limited', httpStatus }
    return { status: 'failed', httpStatus }
  } catch {
    return { status: signal.aborted ? 'timeout' : 'failed' }
  }
}

/** The body of the request: the phrase alone, the mode and the bounds set here, nothing else. */
export function parallelSearchRequest(query: string) {
  return {
    search_queries: [query],
    mode: 'fast',
    max_chars_total: webSearchBounds.maxCharsTotal,
    advanced_settings: {
      max_results: webSearchBounds.maxResults,
      excerpt_settings: { max_chars_per_result: webSearchBounds.maxCharsPerResult },
    },
  }
}

/** Results with an http(s) address, cut to what the agent is given. */
function resultsOf(results: z.infer<typeof answerSchema>['results']): WebSearchResult[] {
  const kept: WebSearchResult[] = []
  for (const result of results) {
    if (kept.length >= webSearchBounds.maxResults) break
    if (result.url.length > webSearchBounds.url || !isWebAddress(result.url)) continue
    const title = visible(result.title ?? '').trim()
    kept.push({
      title: title ? cut(title, webSearchBounds.title) : null,
      url: result.url,
      excerpts: (result.excerpts ?? [])
        .map((excerpt) => visible(excerpt).trim())
        .filter(Boolean)
        .slice(0, webSearchBounds.excerptsPerResult)
        .map((excerpt) => cut(excerpt, webSearchBounds.excerpt)),
    })
  }
  return kept
}

/**
 * The text of a result without what a reader of the page never sees: tag characters (U+E0000–
 * U+E007F, which spell hidden words for a model), zero-width and direction marks, and control
 * characters but the line break and the tab. What is left is what the page shows.
 */
const invisible =
  // eslint-disable-next-line no-control-regex -- control characters of a result are removed
  /[\u{E0000}-\u{E007F}\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u0000-\u0008\u000B-\u001F\u007F]/gu
const visible = (text: string) => text.replace(invisible, '')

function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch {
    return false
  }
}

const cut = (text: string, max: number) =>
  text.length <= max ? text : `${[...text].slice(0, max - 1).join('')}…`

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The body as text, or null when it is longer than `max` bytes (the rest is not read). */
async function boundedText(response: Response, max: number): Promise<string | null> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
