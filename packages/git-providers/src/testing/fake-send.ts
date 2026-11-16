import type { GitHttpRequest, GitHttpResponse, GitSend, GitSendLimits } from '../transport.ts'

// An HTTP fake for the adapters' tests: routes by method and path, records every request.

export interface Recorded {
  address: string
  method: string
  url: URL
  headers: Record<string, string>
  body: unknown
  limits: GitSendLimits
}

export type Route = (request: GitHttpRequest) => {
  status: number
  body?: unknown
  text?: string
  headers?: Record<string, string>
  truncated?: boolean
} | null

export function fakeSend(routes: Record<string, Route | ReturnType<Route>>): {
  send: GitSend
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const send: GitSend = async (address, request, limits) => {
    const key = `${request.method} ${request.url.pathname}`
    calls.push({
      address,
      method: request.method,
      url: request.url,
      headers: request.headers ?? {},
      body:
        request.body === undefined
          ? undefined
          : request.headers?.['content-type'] === 'application/json'
            ? JSON.parse(request.body)
            : Object.fromEntries(new URLSearchParams(request.body)),
      limits,
    })
    const route = routes[key]
    const answer = typeof route === 'function' ? route(request) : route
    if (answer == null)
      return { status: 404, headers: new Headers(), body: Buffer.from('{}'), truncated: false }
    const body =
      answer.text !== undefined
        ? Buffer.from(answer.text)
        : Buffer.from(answer.body === undefined ? '' : JSON.stringify(answer.body))
    const response: GitHttpResponse = {
      status: answer.status,
      headers: new Headers(answer.headers),
      body,
      truncated: answer.truncated ?? false,
    }
    return response
  }
  return { send, calls }
}
