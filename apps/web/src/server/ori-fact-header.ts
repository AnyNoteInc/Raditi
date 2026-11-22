import { collectOriFactKeys } from '@repo/db'

/**
 * The header by which the edge keeps the client's port for the facts of the ORI (Government Decree
 * № 1526, p. 3; docs/plan/88-artifacts.md, slice 88.16а-2). Traefik keeps this one header of the
 * response in its access line beside `ClientPort` (`--accesslog.fields.headers.names`); the
 * collector on the host reads `downstream_X-Raditi-Fact` only — never what a client sent.
 */
export const ORI_FACT_HEADER = 'X-Raditi-Fact'

/** More keys than this in one answer keep no port: no request of the cabinet writes as many. */
const MAX_KEYS = 64

/**
 * Wraps a route of web: the facts its request writes get random edge keys (never the ids), and the
 * answer names them. Without a fact the answer is untouched.
 */
export function withOriFactHeader<Rest extends unknown[]>(
  handler: (request: Request, ...rest: Rest) => Promise<Response> | Response,
): (request: Request, ...rest: Rest) => Promise<Response> {
  return async (request, ...rest) => {
    const { result, keys } = await collectOriFactKeys(async () => handler(request, ...rest))
    if (keys.length === 0) return result
    const value = keys.slice(0, MAX_KEYS).join(',')
    try {
      result.headers.set(ORI_FACT_HEADER, value)
      return result
    } catch {
      // A response with immutable headers (a redirect): the same answer, with the header.
      const headers = new Headers(result.headers)
      headers.set(ORI_FACT_HEADER, value)
      return new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers,
      })
    }
  }
}
