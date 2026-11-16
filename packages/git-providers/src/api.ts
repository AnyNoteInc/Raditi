import { gitAccessDenied, gitHostRefused, gitProviderFailed, type GitAuth } from '@repo/domain'

import type { GitHttpResponse, GitSession, GitSendLimits } from './transport.ts'

// JSON over the transport, shared by the adapters.

/** `https://localhost:<port>` only: the fakes of a stand stand in for gitlab.com or api.github.com. */
export function parseEndpointOverride(value: string | undefined): URL | null {
  if (value === undefined || value === '') return null
  if (!/^https:\/\/localhost:[1-9][0-9]{0,4}$/.test(value)) throw gitHostRefused()
  return new URL(value)
}

export function authHeaders(auth: GitAuth): Record<string, string> {
  return auth.kind === 'bearer' ? { authorization: `Bearer ${auth.token}` } : {}
}

export interface JsonCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: URL
  auth: GitAuth
  body?: unknown
  headers?: Record<string, string>
  limits?: Partial<GitSendLimits>
}

export async function call(session: GitSession, input: JsonCall): Promise<GitHttpResponse> {
  return session.request(
    {
      method: input.method,
      url: input.url,
      headers: {
        accept: 'application/json',
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...input.headers,
        ...authHeaders(input.auth),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    },
    input.limits,
  )
}

/** The JSON of a 2xx answer; 401 and 403 are a refused access, the rest a failure. */
export function jsonOf(response: GitHttpResponse): unknown {
  if (response.status === 401 || response.status === 403) throw gitAccessDenied()
  if (response.status < 200 || response.status >= 300)
    throw gitProviderFailed('unexpected answer', response.status)
  if (response.body.length === 0) return null
  try {
    return JSON.parse(response.body.toString('utf8'))
  } catch {
    throw gitProviderFailed('the answer is not JSON', response.status)
  }
}

/** An id the adapter puts into a path: digits only, so it never changes the path. */
export function numericId(value: string | number, what: string): string {
  const text = String(value)
  if (!/^[1-9][0-9]{0,19}$/.test(text)) throw gitProviderFailed(`not a ${what} id`)
  return text
}

export function dateOf(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export const shaPattern = /^[0-9a-f]{40}$/
