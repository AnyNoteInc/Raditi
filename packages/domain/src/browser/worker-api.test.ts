import { describe, expect, it } from 'vitest'

import {
  browserActionRequestSchema,
  browserActionResponseSchema,
  browserCloseRequestSchema,
  browserCloseResponseSchema,
  browserEnsureRequestSchema,
  browserEnsureResponseSchema,
  browserListResponseSchema,
  browserStreamQuerySchema,
  browserVerifyRequestSchema,
  browserVerifyResponseSchema,
  browserWorkerErrorSchema,
  browserWorkerPaths,
  browserWorkerTokenSchema,
} from './worker-api.ts'

const sessionId = '0196abcd-0000-7000-8000-000000000001'
const taskId = '0196abcd-0000-7000-8000-000000000002'
const siteId = '0196abcd-0000-7000-8000-000000000003'
const assignmentId = '0196abcd-0000-7000-8000-000000000004'

describe('API of the browser worker', () => {
  it('names its paths as §3.5 does', () => {
    expect(browserWorkerPaths.ensure).toBe('/v1/sessions/ensure')
    expect(browserWorkerPaths.list).toBe('/v1/sessions')
    expect(browserWorkerPaths.close(sessionId)).toBe(`/v1/sessions/${sessionId}/close`)
    expect(browserWorkerPaths.verify(sessionId)).toBe(`/v1/sessions/${sessionId}/verify`)
    expect(browserWorkerPaths.actions(sessionId)).toBe(`/v1/sessions/${sessionId}/actions`)
    expect(browserWorkerPaths.stream(sessionId)).toBe(`/v1/sessions/${sessionId}/stream`)
    // An id never leaves its segment.
    expect(browserWorkerPaths.close('../x?y')).toBe('/v1/sessions/..%2Fx%3Fy/close')
  })

  it('reads ensure, its answer and close', () => {
    const ensure = { sessionId, taskId, siteId, takeControl: true }
    expect(browserEnsureRequestSchema.parse(ensure)).toEqual(ensure)
    for (const bad of [
      { ...ensure, takeControl: undefined },
      { ...ensure, taskId: 'task' },
      // Where the browser goes is the site's address in the database, never the caller's word.
      { ...ensure, siteUrl: 'https://news.example.ru' },
      { ...ensure, allowedHosts: ['evil.example.com'] },
      // The notes reach the agent in the prompt of its turn; the worker has no use for them.
      { ...ensure, agentNotes: 'Вход по адресу /login' },
    ])
      expect(
        browserEnsureRequestSchema.safeParse(bad).success,
        JSON.stringify(bad).slice(0, 80),
      ).toBe(false)
    expect(
      browserEnsureResponseSchema.parse({
        session: sessionId,
        status: 'starting',
        controller: 'agent',
        controlEpoch: 0,
        manualReady: false,
        holder: null,
        pageId: null,
        viewportVersion: 1,
        viewport: { width: 1280, height: 800 },
        url: '',
        title: '',
        tabs: [],
      }).status,
    ).toBe('starting')
    expect(browserCloseRequestSchema.parse({ reason: 'task_cancelled' })).toEqual({
      reason: 'task_cancelled',
    })
    expect(browserCloseRequestSchema.safeParse({ reason: 'bored' }).success).toBe(false)
    expect(browserCloseResponseSchema.parse({ sessionId, status: 'closed' }).status).toBe('closed')
  })

  it('reads verify and list', () => {
    expect(browserVerifyRequestSchema.parse({})).toEqual({})
    expect(browserVerifyRequestSchema.safeParse({ taskId }).success).toBe(false)
    const verify = {
      checkpoints: [
        { kind: 'post', objectId: '12', state: 'missing' },
        { kind: 'post', objectId: '13', state: 'unverified' },
      ],
    }
    expect(browserVerifyResponseSchema.parse(verify)).toEqual(verify)
    const list = { sessions: [{ sessionId, taskId, status: 'ready' }] }
    expect(browserListResponseSchema.parse(list)).toEqual(list)
    expect(
      browserListResponseSchema.safeParse({
        sessions: [{ sessionId, taskId, status: 'ready', endpoint: 'ws://127.0.0.1:1/x' }],
      }).success,
    ).toBe(false)
  })

  it('reads an action of the agent and its answer or code', () => {
    const request = {
      taskId,
      assignmentId,
      action: { tool: 'web_click', observation: 'o4', ref: 'e31' },
    }
    expect(browserActionRequestSchema.parse(request)).toEqual(request)
    expect(
      browserActionRequestSchema.safeParse({
        ...request,
        action: { tool: 'web_click', ref: 'e31' },
      }).success,
    ).toBe(false)
    expect(browserActionRequestSchema.safeParse({ taskId, action: request.action }).success).toBe(
      false,
    )
    const ok = {
      ok: true,
      result: {
        tool: 'web_click',
        page: { pageId: 1, url: 'https://news.example.ru/wp-admin/', title: 'Консоль' },
      },
    }
    expect(browserActionResponseSchema.parse(ok)).toEqual(ok)
    expect(
      browserActionResponseSchema.parse({ ok: false, code: 'BROWSER_USER_IN_CONTROL' }),
    ).toEqual({
      ok: false,
      code: 'BROWSER_USER_IN_CONTROL',
    })
    for (const bad of [
      { ok: false, code: 'BROWSER_PREVIEW_NOT_READY' },
      { ok: false, code: 'BROWSER_TIMEOUT', message: 'page https://… did not load' },
      { ok: true, result: { page: ok.result.page } },
      { ok: true },
    ])
      expect(browserActionResponseSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })

  it('reads who watches a stream, and a refusal of the worker', () => {
    const query = { viewer: sessionId, user: taskId }
    expect(browserStreamQuerySchema.parse(query)).toEqual(query)
    expect(browserStreamQuerySchema.safeParse({ viewer: sessionId }).success).toBe(false)
    expect(browserStreamQuerySchema.safeParse({ ...query, ticket: 'x' }).success).toBe(false)
    expect(browserWorkerErrorSchema.parse({ code: 'BROWSER_SESSION_UNAVAILABLE' })).toBeDefined()
    expect(
      browserWorkerErrorSchema.safeParse({ code: 'denied: ws://127.0.0.1:9/secret' }).success,
    ).toBe(false)
  })

  it('reads the worker token by one rule: 32 to 4096 visible ASCII characters', () => {
    for (const token of ['x'.repeat(32), `${'a'.repeat(40)}+/=_-`, 'y'.repeat(4096)])
      expect(browserWorkerTokenSchema.safeParse(token).success).toBe(true)
    for (const token of [
      'x'.repeat(31),
      'y'.repeat(4097),
      `${'x'.repeat(40)} y`,
      `${'x'.repeat(40)}é`,
    ]) {
      const parsed = browserWorkerTokenSchema.safeParse(token)
      expect(parsed.success).toBe(false)
      // The refusal names the rule, never the value.
      expect(JSON.stringify(parsed.error?.issues)).not.toContain(token)
    }
  })
})
