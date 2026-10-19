import type { RepoRef } from '@repo/domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGiteaProvider } from './gitea.ts'
import { basic, fakeGitea, type GiteaCall, type GiteaRoute } from './testing/fake-gitea.ts'
import { giteaRecorded, type RecordedResponse } from './testing/gitea-recorded.ts'

const BASE = 'https://gitea.example.test'
const BOT_TOKEN = 'synthetic-bot-token'
const NOW = Date.parse('2026-10-04T06:00:00.000Z')
const ref: RepoRef = { provider: 'gitea', owner: 'sites', name: 'demo' }
const TOKENS = '/api/v1/users/raditi-bot/tokens'

/** The token endpoints of Gitea 1.27.3 over an in-memory list; shapes as recorded. */
function giteaWithTokens(existing: string[] = []) {
  const tokens = new Map<number, { name: string; scopes: string[] }>(
    existing.map((name, index) => [index + 1, { name, scopes: ['read:repository'] }]),
  )
  let nextId = 100
  const overrides: ((call: GiteaCall) => RecordedResponse | Error | undefined)[] = []
  const route: GiteaRoute = (call) => {
    for (const override of overrides) {
      const answer = override(call)
      if (answer) return answer
    }
    if (call.method === 'GET' && call.path === '/api/v1/token') return giteaRecorded.currentToken
    if (call.method === 'GET' && call.path.startsWith(`${TOKENS}?`)) {
      const query = new URLSearchParams(call.path.slice(TOKENS.length + 1))
      const limit = Number(query.get('limit'))
      const start = (Number(query.get('page')) - 1) * limit
      const page = [...tokens].slice(start, start + limit)
      return {
        status: 200,
        body: JSON.stringify(page.map(([id, token]) => ({ id, ...token, sha1: '' }))),
      }
    }
    if (call.method === 'POST' && call.path === TOKENS) {
      const body = call.body as { name: string; scopes: string[] }
      const id = nextId++
      tokens.set(id, body)
      return {
        status: 201,
        body: JSON.stringify({ id, ...body, sha1: `${id}`.padStart(40, 'a') }),
      }
    }
    if (call.method === 'DELETE' && call.path.startsWith(`${TOKENS}/`)) {
      return tokens.delete(Number(call.path.slice(TOKENS.length + 1)))
        ? giteaRecorded.tokenDeleted
        : giteaRecorded.tokenAlreadyDeleted
    }
    return new Error(`Unexpected request ${call.method} ${call.path}`)
  }
  const gitea = fakeGitea(BASE, route)
  const provider = createGiteaProvider({ baseUrl: BASE, token: BOT_TOKEN }, { fetch: gitea.fetch })
  const sent = (method: string) => gitea.calls.filter((call) => call.method === method)
  return { ...gitea, provider, tokens, overrides, sent }
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('GiteaProvider.getRepository', () => {
  it('maps the repository and builds the clone address from the configured one', async () => {
    const gitea = fakeGitea(BASE, () => giteaRecorded.repository)
    const provider = createGiteaProvider(
      { baseUrl: `${BASE}/`, token: BOT_TOKEN },
      { fetch: gitea.fetch },
    )
    await expect(provider.getRepository(ref)).resolves.toEqual({
      ref,
      defaultBranch: 'main',
      // Not the clone_url of the answer: Gitea derives that one from the request's Host header.
      cloneUrl: 'https://gitea.example.test/sites/demo.git',
      private: true,
    })
  })

  it('reports the names Gitea answered with, so the caller can refuse another repository', async () => {
    const gitea = fakeGitea(BASE, () => giteaRecorded.repository)
    const provider = createGiteaProvider(
      { baseUrl: BASE, token: BOT_TOKEN },
      { fetch: gitea.fetch },
    )
    const info = await provider.getRepository({ provider: 'gitea', owner: 'Sites', name: 'DEMO' })
    expect(info?.ref).toEqual(ref)
  })

  it('answers null for a missing repository and refuses a reference of another provider', async () => {
    const gitea = fakeGitea(BASE, () => giteaRecorded.repositoryMissing)
    const provider = createGiteaProvider(
      { baseUrl: BASE, token: BOT_TOKEN },
      { fetch: gitea.fetch },
    )
    await expect(provider.getRepository(ref)).resolves.toBeNull()
    await expect(provider.getRepository({ ...ref, provider: 'github' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(gitea.calls).toHaveLength(1)
  })
})

describe('GiteaProvider.issueCredentials', () => {
  it('issues a read grant and deletes its token exactly when the grant expires', async () => {
    const gitea = giteaWithTokens()
    const grant = await gitea.provider.issueCredentials(ref, 'read', 120)

    const [created] = gitea.sent('POST')
    expect(created).toMatchObject({ path: TOKENS, authorization: basic('raditi-bot', BOT_TOKEN) })
    const body = created!.body as { name: string; scopes: string[] }
    expect(body.scopes).toEqual(['read:repository'])
    // The expiry is part of the name: a later process can tell an expired token from a live one.
    expect(body.name).toMatch(new RegExp(`^raditi-git-r-${(NOW + 120_000) / 1000}-[0-9a-f]{16}$`))
    expect(grant).toEqual({
      username: 'raditi-bot',
      token: '100'.padStart(40, 'a'),
      expiresAt: new Date(NOW + 120_000),
    })

    await vi.advanceTimersByTimeAsync(119_999)
    expect(gitea.sent('DELETE')).toEqual([])
    expect(gitea.tokens.has(100)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(gitea.sent('DELETE').map((call) => call.path)).toEqual([`${TOKENS}/100`])
    expect(gitea.tokens.has(100)).toBe(false)
  })

  it('issues a write grant with the write scope only', async () => {
    const gitea = giteaWithTokens()
    await gitea.provider.issueCredentials(ref, 'write', 5)
    const body = gitea.sent('POST')[0]!.body as { name: string; scopes: string[] }
    expect(body.scopes).toEqual(['write:repository'])
    expect(body.name).toMatch(/^raditi-git-w-\d+-[0-9a-f]{16}$/)
  })

  it('keeps trying to delete an expired token Gitea did not confirm', async () => {
    const gitea = giteaWithTokens()
    let failures = 2
    gitea.overrides.push((call) =>
      call.method === 'DELETE' && failures-- > 0 ? { status: 500, body: '' } : undefined,
    )
    await gitea.provider.issueCredentials(ref, 'read', 60)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(gitea.tokens.has(100)).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(gitea.tokens.has(100)).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(gitea.tokens.has(100)).toBe(false)
    expect(gitea.sent('DELETE')).toHaveLength(3)
  })

  it('sweeps the expired grants of earlier processes before the first one it issues', async () => {
    const past = NOW / 1000 - 1
    const future = NOW / 1000 + 60
    const gitea = giteaWithTokens([
      'raditi-core',
      `raditi-git-r-${past}-0123456789abcdef`,
      `raditi-git-w-${future}-0123456789abcdef`,
      `raditi-git-w-${past}-fedcba9876543210`,
      // Not ours: another format, another prefix.
      `raditi-git-w-${past}`,
      `other-git-r-${past}-0123456789abcdef`,
    ])
    await gitea.provider.issueCredentials(ref, 'read', 120)

    expect(gitea.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api/v1/token',
      `GET ${TOKENS}?page=1&limit=50`,
      `GET ${TOKENS}?page=2&limit=50`,
      `DELETE ${TOKENS}/2`,
      `DELETE ${TOKENS}/4`,
      `POST ${TOKENS}`,
    ])
    expect([...gitea.tokens.keys()]).toEqual([1, 3, 5, 6, 100])

    // Within the sweep interval nothing is listed again; after it, once more.
    await gitea.provider.issueCredentials(ref, 'write', 120)
    expect(gitea.sent('GET')).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await gitea.provider.issueCredentials(ref, 'read', 120)
    expect(gitea.sent('GET').map((call) => call.path)).toEqual([
      '/api/v1/token',
      `${TOKENS}?page=1&limit=50`,
      `${TOKENS}?page=2&limit=50`,
      `${TOKENS}?page=1&limit=50`,
      `${TOKENS}?page=2&limit=50`,
    ])
  })

  it('reads every page of a long token list', async () => {
    const past = NOW / 1000 - 1
    const gitea = giteaWithTokens(
      Array.from(
        { length: 120 },
        (_, index) => `raditi-git-r-${past}-${String(index).padStart(16, '0')}`,
      ),
    )
    await gitea.provider.issueCredentials(ref, 'read', 120)
    expect(gitea.sent('GET').map((call) => call.path)).toEqual([
      '/api/v1/token',
      `${TOKENS}?page=1&limit=50`,
      `${TOKENS}?page=2&limit=50`,
      `${TOKENS}?page=3&limit=50`,
      `${TOKENS}?page=4&limit=50`,
    ])
    expect([...gitea.tokens.keys()]).toEqual([100])
  })

  it('issues nothing while the token list is longer than a sweep reads', async () => {
    const past = NOW / 1000 - 1
    // 40 full pages and one token more: the sweep cannot know what the rest of the list holds.
    const gitea = giteaWithTokens(
      Array.from(
        { length: 2001 },
        (_, index) => `raditi-git-r-${past}-${String(index).padStart(16, '0')}`,
      ),
    )
    await expect(gitea.provider.issueCredentials(ref, 'read', 120)).rejects.toMatchObject({
      code: 'GIT_PROVIDER_FAILED',
    })
    expect(gitea.sent('POST')).toEqual([])
    // What it did see is deleted, so the next grant finds a list it can read to the end.
    expect(gitea.tokens.size).toBe(1)
    await gitea.provider.issueCredentials(ref, 'read', 120)
    expect([...gitea.tokens.keys()]).toEqual([100])
  })

  it('issues nothing while expired grants cannot be swept, and sweeps again next time', async () => {
    const gitea = giteaWithTokens([`raditi-git-w-${NOW / 1000 - 1}-0123456789abcdef`])
    let broken = true
    gitea.overrides.push((call) =>
      broken && call.method === 'DELETE' ? { status: 500, body: '' } : undefined,
    )
    await expect(gitea.provider.issueCredentials(ref, 'read', 120)).rejects.toMatchObject({
      code: 'GIT_PROVIDER_FAILED',
    })
    expect(gitea.sent('POST')).toEqual([])

    broken = false
    await gitea.provider.issueCredentials(ref, 'read', 120)
    expect([...gitea.tokens.keys()]).toEqual([100])
  })

  it('runs one sweep for grants requested at the same time', async () => {
    const gitea = giteaWithTokens()
    await Promise.all([
      gitea.provider.issueCredentials(ref, 'read', 120),
      gitea.provider.issueCredentials(ref, 'write', 120),
    ])
    expect(gitea.sent('GET').map((call) => call.path)).toEqual([
      '/api/v1/token',
      `${TOKENS}?page=1&limit=50`,
    ])
    expect(gitea.sent('POST')).toHaveLength(2)
  })

  it('refuses and deletes a token whose scope is not the one it asked for', async () => {
    const gitea = giteaWithTokens()
    gitea.overrides.push((call) => {
      if (call.method !== 'POST') return undefined
      gitea.tokens.set(7, { name: (call.body as { name: string }).name, scopes: ['all'] })
      return {
        status: 201,
        body: JSON.stringify({
          id: 7,
          ...(call.body as object),
          scopes: ['all'],
          sha1: 'b'.repeat(40),
        }),
      }
    })
    await expect(gitea.provider.issueCredentials(ref, 'read', 120)).rejects.toMatchObject({
      code: 'GIT_PROVIDER_FAILED',
    })
    expect(gitea.tokens.has(7)).toBe(false)

    // Gitea does not confirm the deletion: the grant is still refused, the token is retried.
    let failures = 1
    gitea.tokens.clear()
    gitea.overrides.push((call) =>
      call.method === 'DELETE' && failures-- > 0 ? { status: 500, body: '' } : undefined,
    )
    await expect(gitea.provider.issueCredentials(ref, 'read', 120)).rejects.toMatchObject({
      code: 'GIT_PROVIDER_FAILED',
    })
    expect(gitea.tokens.has(7)).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(gitea.tokens.has(7)).toBe(false)
  })

  it.each([4, 901, 1.5, Number.NaN, '120' as unknown as number])(
    'refuses the lifetime %s before any request',
    async (ttl) => {
      const gitea = giteaWithTokens()
      await expect(gitea.provider.issueCredentials(ref, 'read', ttl)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
      expect(gitea.calls).toEqual([])
    },
  )

  it('refuses an unknown access and a reference of another provider', async () => {
    const gitea = giteaWithTokens()
    await expect(
      gitea.provider.issueCredentials(ref, 'admin' as 'write', 120),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      gitea.provider.issueCredentials({ ...ref, provider: 'gitlab' }, 'read', 120),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      gitea.provider.issueCredentials({ ...ref, name: '../x' }, 'read', 120),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(gitea.calls).toEqual([])
  })

  it('asks for the login of the bot again after a failed lookup', async () => {
    const gitea = giteaWithTokens()
    let broken = true
    gitea.overrides.push((call) =>
      broken && call.path === '/api/v1/token' ? giteaRecorded.repositoryBadToken : undefined,
    )
    await expect(gitea.provider.issueCredentials(ref, 'read', 120)).rejects.toMatchObject({
      code: 'GIT_PROVIDER_FAILED',
    })
    broken = false
    await expect(gitea.provider.issueCredentials(ref, 'read', 120)).resolves.toMatchObject({
      username: 'raditi-bot',
    })
  })
})

describe('GiteaProvider.sweepCredentials', () => {
  it('sweeps what earlier processes left before any grant is asked for', async () => {
    const past = NOW / 1000 - 1
    const gitea = giteaWithTokens([
      'raditi-core',
      `raditi-git-r-${past}-0123456789abcdef`,
      `raditi-git-w-${past}-fedcba9876543210`,
      `other-git-r-${past}-0123456789abcdef`,
    ])
    await gitea.provider.sweepCredentials()

    expect(gitea.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api/v1/token',
      `GET ${TOKENS}?page=1&limit=50`,
      `GET ${TOKENS}?page=2&limit=50`,
      `DELETE ${TOKENS}/2`,
      `DELETE ${TOKENS}/3`,
    ])
    expect([...gitea.tokens.keys()]).toEqual([1, 4])

    // The first grant after it does not list the tokens again.
    await gitea.provider.issueCredentials(ref, 'read', 120)
    expect(gitea.sent('GET')).toHaveLength(3)
  })

  it('deletes at its term a live grant of a process that is gone', async () => {
    const gitea = giteaWithTokens([
      `raditi-git-w-${NOW / 1000 + 60}-0123456789abcdef`,
      // Longer than any grant this adapter issues: not its own, left for a later sweep.
      `raditi-git-w-${NOW / 1000 + 901}-0123456789abcdef`,
    ])
    await gitea.provider.sweepCredentials()
    expect(gitea.sent('DELETE')).toEqual([])

    await vi.advanceTimersByTimeAsync(59_999)
    expect(gitea.tokens.has(1)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(gitea.tokens.has(1)).toBe(false)
    await vi.advanceTimersByTimeAsync(900_000)
    expect(gitea.sent('DELETE').map((call) => call.path)).toEqual([`${TOKENS}/1`])
    expect(gitea.tokens.has(2)).toBe(true)
  })

  it('reports a sweep Gitea did not complete and sweeps again before the next grant', async () => {
    const gitea = giteaWithTokens([`raditi-git-w-${NOW / 1000 - 1}-0123456789abcdef`])
    let broken = true
    gitea.overrides.push((call) =>
      broken && call.method === 'DELETE' ? { status: 500, body: '' } : undefined,
    )
    await expect(gitea.provider.sweepCredentials()).rejects.toMatchObject({
      code: 'GIT_PROVIDER_FAILED',
    })
    broken = false
    await gitea.provider.issueCredentials(ref, 'read', 120)
    expect([...gitea.tokens.keys()]).toEqual([100])
  })
})

describe('GiteaProvider.revokeCredentials', () => {
  it('deletes every token this process issued, before its term, and no other', async () => {
    const gitea = giteaWithTokens([
      'raditi-core',
      // A live grant of another replica: its own process deletes it.
      `raditi-git-w-${NOW / 1000 + 300}-0123456789abcdef`,
    ])
    await gitea.provider.issueCredentials(ref, 'read', 120)
    await gitea.provider.issueCredentials(ref, 'write', 120)
    await vi.advanceTimersByTimeAsync(10_000)
    expect([...gitea.tokens.keys()]).toEqual([1, 2, 100, 101])

    await gitea.provider.revokeCredentials()
    expect(
      gitea
        .sent('DELETE')
        .map((call) => call.path)
        .sort(),
    ).toEqual([`${TOKENS}/100`, `${TOKENS}/101`])
    expect([...gitea.tokens.keys()]).toEqual([1, 2])

    // Their timers are gone with them; the other replica's grant still ends at its term.
    await vi.advanceTimersByTimeAsync(110_000)
    expect(gitea.sent('DELETE')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(gitea.sent('DELETE').map((call) => call.path)).toContain(`${TOKENS}/2`)
  })

  it('leaves out a grant that already expired and was deleted', async () => {
    const gitea = giteaWithTokens()
    await gitea.provider.issueCredentials(ref, 'read', 5)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(gitea.sent('DELETE')).toHaveLength(1)
    await gitea.provider.revokeCredentials()
    expect(gitea.sent('DELETE')).toHaveLength(1)
  })

  it('reports a deletion Gitea did not confirm and still deletes the token at its term', async () => {
    const gitea = giteaWithTokens()
    await gitea.provider.issueCredentials(ref, 'read', 120)
    await gitea.provider.issueCredentials(ref, 'write', 120)
    let failures = 1
    gitea.overrides.push((call) =>
      call.method === 'DELETE' && call.path === `${TOKENS}/100` && failures-- > 0
        ? { status: 500, body: '' }
        : undefined,
    )
    await expect(gitea.provider.revokeCredentials()).rejects.toMatchObject({
      code: 'GIT_PROVIDER_FAILED',
    })
    expect([...gitea.tokens.keys()]).toEqual([100])

    await vi.advanceTimersByTimeAsync(120_000)
    expect([...gitea.tokens.keys()]).toEqual([])
  })

  it('asks Gitea nothing while this process issued nothing', async () => {
    const gitea = giteaWithTokens([`raditi-git-w-${NOW / 1000 + 300}-0123456789abcdef`])
    await gitea.provider.revokeCredentials()
    await gitea.provider.sweepCredentials()
    await gitea.provider.revokeCredentials()
    expect(gitea.sent('DELETE')).toEqual([])
  })
})

describe('GiteaProvider without a usable API address', () => {
  it.each([
    ['plain http', { baseUrl: 'http://localhost:3300', token: BOT_TOKEN }],
    ['no bot token', { baseUrl: BASE, token: '' }],
  ])('still parses webhooks with %s, and refuses to call the API', async (_, config) => {
    const gitea = fakeGitea(config.baseUrl, () => giteaRecorded.repository)
    const provider = createGiteaProvider(config, { fetch: gitea.fetch })
    expect(provider.parseWebhook(new Headers(), '{}', 'secret')).toBeNull()
    await expect(provider.getRepository(ref)).rejects.toMatchObject({
      code: 'GIT_PROVIDER_NOT_CONFIGURED',
    })
    await expect(provider.issueCredentials(ref, 'read', 120)).rejects.toMatchObject({
      code: 'GIT_PROVIDER_NOT_CONFIGURED',
    })
    await expect(provider.sweepCredentials()).rejects.toMatchObject({
      code: 'GIT_PROVIDER_NOT_CONFIGURED',
    })
    // Nothing was issued, so there is nothing to revoke.
    await expect(provider.revokeCredentials()).resolves.toBeUndefined()
    expect(gitea.calls).toEqual([])
  })

  it('leaves pull requests and Actions variables to P8', async () => {
    const provider = createGiteaProvider({ baseUrl: BASE, token: BOT_TOKEN })
    for (const call of [
      () => provider.openPullRequest(ref, { head: 'a', base: 'b', title: 't', body: '' }),
      () => provider.getPullRequest(ref, 1),
      () => provider.mergePullRequest(ref, 1, 'a'.repeat(40)),
      () => provider.closePullRequest(ref, 1),
      () => provider.setActionsVariable(ref, 'N', 'v'),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
  })
})
