import { describe, expect, it } from 'vitest'

import { createGiteaClient } from './gitea-client.ts'
import { basic, fakeGitea, type GiteaRoute } from './testing/fake-gitea.ts'
import { giteaRecorded, RECORDED_TOKEN } from './testing/gitea-recorded.ts'

const BASE = 'https://gitea.example.test'
const BOT_TOKEN = 'synthetic-bot-token'
const client = (route: GiteaRoute, base = BASE) => {
  const gitea = fakeGitea(base, route)
  return {
    ...gitea,
    client: createGiteaClient({ baseUrl: base, token: BOT_TOKEN }, { fetch: gitea.fetch }),
  }
}
const failed = { code: 'GIT_PROVIDER_FAILED', httpStatus: 502 }

describe('Gitea REST client on responses recorded from Gitea 1.27.3', () => {
  it('reads a repository with the bot token in the header and follows no redirect', async () => {
    const { client: api, calls } = client(() => giteaRecorded.repository)
    await expect(api.getRepository('sites', 'demo')).resolves.toEqual({
      id: 1,
      owner: 'sites',
      name: 'demo',
      defaultBranch: 'main',
      private: true,
    })
    expect(calls).toEqual([
      {
        method: 'GET',
        path: '/api/v1/repos/sites/demo',
        authorization: `token ${BOT_TOKEN}`,
        body: undefined,
        redirect: 'manual',
        hasTimeout: true,
      },
    ])
  })

  it('reports a missing repository as null', async () => {
    const { client: api } = client(() => giteaRecorded.repositoryMissing)
    await expect(api.getRepository('sites', 'missing')).resolves.toBeNull()
  })

  it.each([
    ['a renamed repository (301)', giteaRecorded.repositoryMoved],
    ['a refused bot token (401)', giteaRecorded.repositoryBadToken],
    ['a server error', { status: 500, body: '{"message":"boom"}' }],
    ['a body that is not JSON', { status: 200, body: '<html>' }],
    ['a body of another shape', { status: 200, body: '{"name":"demo"}' }],
    ['a name that cannot be a repository', { status: 200, body: '{"name":"a/b"}' }],
  ])('fails on %s without leaking the token or the body', async (_, response) => {
    const { client: api } = client(() => response)
    const error = await api.getRepository('sites', 'demo').catch((e: unknown) => e)
    expect(error).toMatchObject(failed)
    expect(String((error as Error).message)).not.toContain(BOT_TOKEN)
    expect(String((error as Error).message)).not.toContain('boom')
  })

  it('hides a network failure and a timeout behind the same error', async () => {
    const secret = new Error(`connect ECONNREFUSED with ${BOT_TOKEN}`)
    const { client: api } = client(() => secret)
    const error = await api.getRepository('sites', 'demo').catch((e: unknown) => e)
    expect(error).toMatchObject(failed)
    expect((error as Error).message).toBe('Gitea request failed')
    expect((error as Error).cause).toBeUndefined()
  })

  it('refuses a response over the size limit', async () => {
    const { client: api } = client(() => ({ status: 200, body: `[${' '.repeat(1024 * 1024)}]` }))
    await expect(api.listTokens('raditi-bot', 1)).rejects.toMatchObject(failed)
  })

  it.each([
    ['sites/../admin', 'demo'],
    ['sites', '..'],
    ['sites', 'demo.git/info'],
    ['', 'demo'],
    ['sites', 'd'.repeat(101)],
  ])('refuses the repository reference %s/%s before any request', async (owner, name) => {
    const { client: api, calls } = client(() => giteaRecorded.repository)
    await expect(api.getRepository(owner, name)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(calls).toEqual([])
  })

  it('reads the login of the bot from its own token', async () => {
    const { client: api, calls } = client(() => giteaRecorded.currentToken)
    await expect(api.tokenOwner()).resolves.toBe('raditi-bot')
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/api/v1/token',
      authorization: `token ${BOT_TOKEN}`,
    })
  })

  it('creates a token over Basic with the bot token as the password', async () => {
    const { client: api, calls } = client(() => ({
      status: 201,
      body: giteaRecorded.tokenCreated.body.replace('__TOKEN__', RECORDED_TOKEN),
    }))
    await expect(
      api.createToken('raditi-bot', 'raditi-git-r-1791100000-0123456789abcdef', [
        'read:repository',
      ]),
    ).resolves.toEqual({
      id: 2,
      name: 'raditi-git-r-1791100000-0123456789abcdef',
      scopes: ['read:repository'],
      token: RECORDED_TOKEN,
    })
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/v1/users/raditi-bot/tokens',
        authorization: basic('raditi-bot', BOT_TOKEN),
        body: {
          name: 'raditi-git-r-1791100000-0123456789abcdef',
          scopes: ['read:repository'],
        },
        redirect: 'manual',
        hasTimeout: true,
      },
    ])
  })

  it.each([
    ['a scope broader than the bot token', giteaRecorded.tokenScopeTooBroad],
    ['token-header authentication', giteaRecorded.tokenHeaderAuthRefused],
    ['an answer without the token value', giteaRecorded.tokenCreated],
  ])('fails when Gitea refuses %s', async (_, response) => {
    const { client: api } = client(() => response)
    await expect(api.createToken('raditi-bot', 'raditi-git-w-1-00', ['all'])).rejects.toMatchObject(
      failed,
    )
  })

  it('lists one page of the tokens of the bot', async () => {
    const { client: api, calls } = client(() => giteaRecorded.tokenList)
    await expect(api.listTokens('raditi-bot', 3)).resolves.toEqual([
      { id: 1, name: 'raditi-core' },
      { id: 2, name: 'raditi-git-r-1791100000-0123456789abcdef' },
    ])
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/api/v1/users/raditi-bot/tokens?page=3&limit=50',
      authorization: basic('raditi-bot', BOT_TOKEN),
    })
  })

  it('deletes a token by its id; a token already gone counts as deleted', async () => {
    const answers = [giteaRecorded.tokenDeleted, giteaRecorded.tokenAlreadyDeleted]
    const { client: api, calls } = client(() => answers.shift()!)
    await expect(api.deleteToken('raditi-bot', 2)).resolves.toBeUndefined()
    await expect(api.deleteToken('raditi-bot', 2)).resolves.toBeUndefined()
    expect(calls.map((call) => [call.method, call.path, call.authorization])).toEqual([
      ['DELETE', '/api/v1/users/raditi-bot/tokens/2', basic('raditi-bot', BOT_TOKEN)],
      ['DELETE', '/api/v1/users/raditi-bot/tokens/2', basic('raditi-bot', BOT_TOKEN)],
    ])
  })

  it.each([
    ['a server error', { status: 500, body: '' }],
    // A bot token that lost its scope or its account: the grant is still alive.
    ['a refused bot token (401)', giteaRecorded.tokenHeaderAuthRefused],
    ['a forbidden call (403)', giteaRecorded.tokenScopeTooBroad],
    ['a redirect', giteaRecorded.repositoryMoved],
    ['a success without the deletion status', { status: 200, body: '{}' }],
  ])('fails a deletion Gitea did not confirm: %s', async (_, response) => {
    const { client: api } = client(() => response)
    await expect(api.deleteToken('raditi-bot', 2)).rejects.toMatchObject(failed)
  })

  it('keeps a path prefix of the configured address', async () => {
    const { client: api, calls } = client(
      () => giteaRecorded.repositoryMissing,
      'https://host.example.test/gitea',
    )
    await api.getRepository('sites', 'demo')
    expect(calls[0]?.path).toBe('/api/v1/repos/sites/demo')
  })

  it.each([
    ['http://gitea.example.test', BOT_TOKEN],
    ['https://user:password@gitea.example.test', BOT_TOKEN],
    ['https://gitea.example.test/?token=1', BOT_TOKEN],
    ['https://gitea.example.test', ''],
    ['https://gitea.example.test', 'two words'],
    ['https://gitea.example.test', 'line\nbreak'],
  ])('refuses the address %s or an unusable token', (baseUrl, token) => {
    expect(() => createGiteaClient({ baseUrl, token })).toThrow(
      expect.objectContaining({ code: 'GIT_PROVIDER_NOT_CONFIGURED' }),
    )
  })
})

describe('Gitea REST client: a new repository of an organization (recorded from Gitea 1.27.3)', () => {
  const SITE = 'site-0b6f6d1e-5f0f-4c53-9d0a-7c2f4d3e2a10'
  const created = giteaRecorded.organizationRepositoryCreated

  it('asks for a private repository without a first commit and with the default branch main', async () => {
    const { client: api, calls } = client(() => created)
    await expect(api.createOrganizationRepository('sites', SITE)).resolves.toEqual({
      id: 3,
      owner: 'sites',
      name: SITE,
      defaultBranch: 'main',
      private: true,
    })
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/v1/orgs/sites/repos',
        authorization: `token ${BOT_TOKEN}`,
        body: { name: SITE, private: true, auto_init: false, default_branch: 'main' },
        redirect: 'manual',
        hasTimeout: true,
      },
    ])
  })

  it('reports a name the organization already has as null', async () => {
    const { client: api, calls } = client(() => giteaRecorded.organizationRepositoryExists)
    await expect(api.createOrganizationRepository('sites', SITE)).resolves.toBeNull()
    expect(calls).toHaveLength(1)
  })

  // The third column: the reason of a refusal no retry cures. None — Gitea gave no usable answer.
  it.each([
    [
      'an account that may not create there (403)',
      giteaRecorded.organizationRepositoryForbidden,
      { reason: 'forbidden' },
    ],
    [
      'a token without the scope (403)',
      giteaRecorded.organizationRepositoryScopeMissing,
      { reason: 'forbidden' },
    ],
    [
      'a missing or hidden organization (404)',
      giteaRecorded.organizationMissing,
      { reason: 'not_found' },
    ],
    ['a refused token (401)', giteaRecorded.repositoryBadToken, { reason: 'unauthorized' }],
    ['a redirect', giteaRecorded.repositoryMoved, undefined],
    ['a server error', { status: 500, body: '{"message":"boom"}' }, undefined],
    ['a refusal of another kind (422)', { status: 422, body: '{"message":"boom"}' }, undefined],
    ['a success without the creation status', { status: 200, body: created.body }, undefined],
    ['a body that is not JSON', { status: 201, body: '<html>' }, undefined],
    ['a body of another shape', { status: 201, body: '{"name":"demo"}' }, undefined],
  ])('fails on %s without leaking the token or the body', async (_, response, details) => {
    const { client: api, calls } = client(() => response)
    const error = await api.createOrganizationRepository('sites', SITE).catch((e: unknown) => e)
    expect(error).toMatchObject({ ...failed, details })
    expect(String((error as Error).message)).not.toContain(BOT_TOKEN)
    expect(String((error as Error).message)).not.toMatch(/boom|allowed|scope|not found|invalid/)
    // One request: a refusal is neither repeated nor followed.
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['sites/../admin', SITE],
    ['', SITE],
    ['sites', '..'],
    ['sites', 'a/b'],
    ['sites', ''],
    ['sites', 's'.repeat(101)],
  ])('refuses the organization %s with the name %s before any request', async (org, name) => {
    const { client: api, calls } = client(() => created)
    await expect(api.createOrganizationRepository(org, name)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(calls).toEqual([])
  })
})
