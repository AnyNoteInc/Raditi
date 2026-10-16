/**
 * How the pinned OpenCode CLI decides to repeat a request, or to compact the context, instead
 * of ending the turn. Transcribed from its executable: the extracts lie next to this file
 * (`opencode-1.18.34/ctx-retry.txt`, `75-g1-binary/overflow.text.json`) and `fixtures.test.ts`
 * keeps the transcription equal to them. A new CLI version means new extracts and a new
 * transcription (docs/plan/40-opencode-spike.md, sections 4 and 5).
 */
export const opencodeCliVersion = '1.18.34'

/** `Rd` of the extract: a match in the message or in the response body means a retry. */
export const retryPatterns: readonly RegExp[] = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

/** An error that is no HTTP answer (an `error` object inside a stream) is also retried on these. */
export const streamRetryWords: readonly string[] = ['too_many_requests', 'exhausted', 'unavailable']

/** `b$` of the extract: a match means a context overflow, answered by a compaction request. */
export const overflowPatterns: readonly RegExp[] = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
]

/** `X$` of the extract: with one of these the text is no overflow. */
export const overflowExceptions: readonly RegExp[] = [
  /^(throttling error|service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
]

export const overflowWithoutBody = /^4(00|13)\s*(status code)?\s*\(no body\)/i
export const overflowStatus = 413
export const overflowCode = 'context_length_exceeded'

const matchesRetry = (text: string) => retryPatterns.some((pattern) => pattern.test(text))

/** Function `ga` of the extract for an HTTP answer: does the CLI send the request again? */
export function cliRetriesHttp(answer: { status: number; message: string; body: string }): boolean {
  // `isRetryable` of the SDK: 408, 409, 429 and every status from 500.
  const retryable = [408, 409, 429].includes(answer.status) || answer.status >= 500
  return retryable || matchesRetry(answer.message) || matchesRetry(answer.body)
}

/**
 * The same function for an `error` object inside a started stream: the CLI reports it as an
 * UnknownError whose message is the JSON of that object.
 */
export function cliRetriesStreamError(error: unknown): boolean {
  const message = JSON.stringify(error)
  const lower = message.toLowerCase()
  return streamRetryWords.some((word) => lower.includes(word)) || matchesRetry(message)
}

/** Does the CLI take the answer for a context overflow and ask for a compaction? */
export function cliReadsOverflow(answer: {
  status: number
  message: string
  body: string
  code?: string
}): boolean {
  const overflow = (text: string) =>
    !overflowExceptions.some((pattern) => pattern.test(text)) &&
    (overflowPatterns.some((pattern) => pattern.test(text)) || overflowWithoutBody.test(text))
  return (
    answer.status === overflowStatus ||
    answer.code === overflowCode ||
    overflow(answer.message) ||
    // The CLI may append the body to the message it tests.
    overflow(`${answer.message}: ${answer.body}`)
  )
}
