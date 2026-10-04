import { vi } from 'vitest'

import type { RecordedResponse } from './gitea-recorded.ts'

export interface GiteaCall {
  method: string
  /** Path and query below the configured base URL. */
  path: string
  authorization: string | null
  body: unknown
  redirect: RequestInit['redirect']
  hasTimeout: boolean
}

type Answer = RecordedResponse | Response | Error
export type GiteaRoute = (call: GiteaCall) => Answer | Promise<Answer>

/** A `fetch` that answers from recorded Gitea responses and keeps every call it saw. */
export function fakeGitea(base: string, route: GiteaRoute) {
  const calls: GiteaCall[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith(`${base}/`)) throw new Error('Request left the configured Gitea address')
    const call: GiteaCall = {
      method: init?.method ?? 'GET',
      path: url.slice(base.length),
      authorization: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      redirect: init?.redirect,
      hasTimeout: init?.signal instanceof AbortSignal,
    }
    calls.push(call)
    const answer = await route(call)
    if (answer instanceof Error) throw answer
    if (answer instanceof Response) return answer
    return new Response(answer.status === 204 ? null : answer.body, {
      status: answer.status,
      headers: { 'content-type': 'application/json;charset=utf-8' },
    })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

export const basic = (login: string, token: string) =>
  `Basic ${Buffer.from(`${login}:${token}`).toString('base64')}`
