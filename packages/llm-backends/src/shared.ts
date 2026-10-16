import {
  llmGatewayUnavailable,
  parseLlmJson,
  type EgressHttp,
  type EgressRequest,
  type EgressResponse,
  type JsonObject,
} from '@repo/domain'

// Control responses contain credentials or usage metadata, never model output.
export const maxControlResponseBytes = 64 * 1024
const encoder = new TextEncoder()

export const encodeJson = (value: unknown): Uint8Array<ArrayBuffer> =>
  encoder.encode(JSON.stringify(value))

/** Invalid replies stay opaque: JSON parser errors may otherwise contain token bytes. */
export function decodeControlJson(body: Uint8Array): JsonObject | null {
  if (body.byteLength > maxControlResponseBytes) return null
  try {
    return parseLlmJson(body)
  } catch {
    return null
  }
}

/**
 * The injected egress transport bounds bytes while reading and never follows redirects.
 * Enforce its contract again here, with a deadline even if a transport ignores cancellation.
 * There is no retry: what a control request without an answer means is its caller's to decide.
 */
export async function controlRequest(
  http: EgressHttp,
  request: EgressRequest,
  timeoutMs = 20_000,
): Promise<EgressResponse> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000)
    throw llmGatewayUnavailable()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => http.request(request, { signal: controller.signal })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(llmGatewayUnavailable())
        }, timeoutMs)
      }),
    ])
    if (
      response.body.byteLength > maxControlResponseBytes ||
      (response.status >= 300 && response.status < 400)
    )
      throw llmGatewayUnavailable()
    return response
  } catch {
    throw llmGatewayUnavailable()
  } finally {
    clearTimeout(timer)
  }
}
