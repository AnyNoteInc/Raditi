import type { WebSearchCredentials } from '@repo/domain'
import { z } from 'zod'

/**
 * Yandex Search API, synchronous web search (https://aistudio.yandex.ru/docs/ru/search-api/):
 * the one endpoint used. Search in Yandex, from Russia (spec §20, «Веб-поиск агента — Yandex
 * Search API, 11.11.2026»).
 */
export const YANDEX_SEARCH_URL = 'https://searchapi.api.cloud.yandex.net/v2/web/search'

/**
 * The quota of a folder by default: one synchronous search a second (concepts/limits). The mcp
 * role is one process, so the requests of all its turns are spaced here, a bit wider than that.
 */
export const YANDEX_SEARCH_INTERVAL_MS = 1100

/**
 * Hands out turns for requests at least `intervalMs` apart, in the order they ask. `wait` resolves
 * true when the turn has come, false — and takes no turn — when it would come later than `maxWaitMs`.
 */
export class RequestPacer {
  #next = 0
  readonly #intervalMs: number
  readonly #clock: { now: () => number; sleep: (ms: number) => Promise<void> }

  constructor(
    intervalMs = YANDEX_SEARCH_INTERVAL_MS,
    clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  ) {
    this.#intervalMs = intervalMs
    this.#clock = clock
  }

  async wait(maxWaitMs: number): Promise<boolean> {
    const now = this.#clock.now()
    const at = Math.max(now, this.#next)
    if (at - now > maxWaitMs) return false
    this.#next = at + this.#intervalMs
    if (at > now) await this.#clock.sleep(at - now)
    return true
  }
}

/** How much of the answer is read and what of it reaches the agent. */
export const webSearchBounds = {
  maxResults: 5,
  /** Fragments of page text asked per result (the service gives 1–5). */
  passagesPerResult: 3,
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

export interface WebSearchOptions {
  credentials: WebSearchCredentials
  timeoutMs: number
  fetch?: typeof globalThis.fetch
}

const answerSchema = z.object({ rawData: z.string() })

/** The service's words for an exhausted balance or quota; a 402 says so by itself. */
const quotaWords = /quota|balance|billing|payment|insufficient|exhausted|limit/i

/**
 * Codes of `<error>` inside a found answer (the XML of the search): 15 is "nothing found" — an
 * answer with no results, not a failure; 32 — the daily limit of the folder is used; 55 — too
 * many requests a second. Any other code is a failure.
 */
const NOTHING_FOUND = '15'
const errorStatuses: Record<string, Exclude<WebSearchStatus, 'ok'>> = {
  '32': 'quota_exhausted',
  '55': 'rate_limited',
}

/**
 * One synchronous request to Yandex Search API for one search phrase, the Russian search
 * (`SEARCH_TYPE_RU`: measured 11.11.2026, it answers English developer questions better than
 * yandex.com). The key goes only in the `Authorization` header of this request; neither it, nor
 * the phrase, nor the answer is logged or kept. Never throws: every way it ends is a status.
 */
export async function yandexSearch(
  query: string,
  { credentials, timeoutMs, fetch = globalThis.fetch }: WebSearchOptions,
): Promise<WebSearchOutcome> {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const response = await fetch(YANDEX_SEARCH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Api-Key ${credentials.apiKey}`,
      },
      body: JSON.stringify(yandexSearchRequest(query, credentials.folderId)),
      redirect: 'error',
      signal,
    })
    const body = await boundedText(response, webSearchBounds.maxBodyBytes)
    const httpStatus = response.status
    if (httpStatus === 200) {
      const answer = body === null ? undefined : answerSchema.safeParse(safeJson(body))
      if (!answer?.success) return { status: 'failed', httpStatus }
      return resultsOfXml(Buffer.from(answer.data.rawData, 'base64').toString('utf8'))
    }
    if (httpStatus === 402 || (httpStatus === 403 && quotaWords.test(body ?? '')))
      return { status: 'quota_exhausted', httpStatus }
    if (httpStatus === 429) return { status: 'rate_limited', httpStatus }
    return { status: 'failed', httpStatus }
  } catch {
    return { status: signal.aborted ? 'timeout' : 'failed' }
  }
}

/** The body of the request: the phrase alone, the folder and the bounds set here, nothing else. */
export function yandexSearchRequest(query: string, folderId: string) {
  return {
    query: { searchType: 'SEARCH_TYPE_RU', queryText: query },
    groupSpec: {
      groupMode: 'GROUP_MODE_FLAT',
      groupsOnPage: String(webSearchBounds.maxResults),
      docsInGroup: '1',
    },
    maxPassages: String(webSearchBounds.passagesPerResult),
    folderId,
    responseFormat: 'FORMAT_XML',
  }
}

/** The documents of the XML answer, or the status its `<error>` names. */
function resultsOfXml(xml: string): WebSearchOutcome {
  const error = /<error\b[^>]*\bcode="(\d+)"/.exec(xml)?.[1]
  if (error === NOTHING_FOUND) return { status: 'ok', results: [] }
  if (error !== undefined) return { status: errorStatuses[error] ?? 'failed', httpStatus: 200 }
  if (!/<yandexsearch\b/.test(xml)) return { status: 'failed', httpStatus: 200 }
  const kept: WebSearchResult[] = []
  for (const [doc] of xml.matchAll(/<doc\b[\s\S]*?<\/doc>/g)) {
    if (kept.length >= webSearchBounds.maxResults) break
    const url = originalAddress(textOf(/<url>([\s\S]*?)<\/url>/.exec(doc)?.[1] ?? ''))
    if (url.length > webSearchBounds.url || !isWebAddress(url)) continue
    const title = textOf(/<title>([\s\S]*?)<\/title>/.exec(doc)?.[1] ?? '')
    const headline = textOf(/<headline>([\s\S]*?)<\/headline>/.exec(doc)?.[1] ?? '')
    const passages = [...doc.matchAll(/<passage>([\s\S]*?)<\/passage>/g)].map(([, p]) => textOf(p!))
    kept.push({
      title: title ? cut(title, webSearchBounds.title) : null,
      url,
      excerpts: [...passages, headline]
        .filter(Boolean)
        .slice(0, webSearchBounds.excerptsPerResult)
        .map((excerpt) => cut(excerpt, webSearchBounds.excerpt)),
    })
  }
  return { status: 'ok', results: kept }
}

/**
 * The page itself instead of Yandex's machine translation of it: the search sometimes gives
 * `https://tr-page.yandex.ru/translate?…&url=<page>` for a foreign page found by a Russian phrase.
 */
function originalAddress(url: string): string {
  try {
    const parsed = new URL(url)
    const page = parsed.searchParams.get('url')
    return parsed.hostname === 'tr-page.yandex.ru' && page ? page : url
  } catch {
    return url
  }
}

/** The text of an XML element: tags (the highlighted words `<hlword>`) and entities resolved. */
const textOf = (xml: string) =>
  visible(
    xml
      .replace(/<[^>]*>/g, '')
      .replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos);/gi, (_, name: string) => entity(name)),
  )
    .replace(/ {2,}/g, ' ')
    .trim()

function entity(name: string): string {
  const lower = name.toLowerCase()
  if (lower.startsWith('#')) {
    const code = lower.startsWith('#x')
      ? parseInt(lower.slice(2), 16)
      : parseInt(lower.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  }
  return { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" }[lower] ?? ''
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
