import { describe, expect, it } from 'vitest'

import { createGiteaRepositoryProvisioner } from './gitea-repository-provisioner.ts'
import { fakeGitea, type GiteaRoute } from './testing/fake-gitea.ts'
import { giteaRecorded, type RecordedResponse } from './testing/gitea-recorded.ts'

const BASE = 'https://gitea.example.test'
const TOKEN = 'synthetic-provisioner-token'
/** The repository of the recorded answers. */
const SITE = 'site-0b6f6d1e-5f0f-4c53-9d0a-7c2f4d3e2a10'
const CREATE = '/api/v1/orgs/sites/repos'
const LOOKUP = `/api/v1/repos/sites/${SITE}`
const created = giteaRecorded.organizationRepositoryCreated
const taken = giteaRecorded.organizationRepositoryExists
/** GET of the repository by its creator: Gitea 1.27.3 answered the body of the 201. */
const found: RecordedResponse = { status: 200, body: created.body }
const info = {
  ref: { provider: 'gitea', owner: 'sites', name: SITE },
  defaultBranch: 'main',
  cloneUrl: `${BASE}/sites/${SITE}.git`,
  private: true,
}
const failed = { code: 'GIT_PROVIDER_FAILED', httpStatus: 502 }
/** A refusal no retry cures, with the word of ours that says why. */
const refused = (reason: string) => ({ ...failed, details: { reason } })
/** Gitea gave no usable answer: nothing says that a retry is in vain. */
const unanswered = { ...failed, details: undefined }

/** The recorded repository with one field of the answer changed. */
const changed = (response: RecordedResponse, from: string, to: string): RecordedResponse => {
  if (response.body.split(from).length !== 2) throw new Error(`Expected one ${from} in the body`)
  return { status: response.status, body: response.body.replace(from, to) }
}
const answers =
  (creation: RecordedResponse | Error, lookup?: RecordedResponse): GiteaRoute =>
  (call) =>
    call.method === 'POST' ? creation : (lookup ?? new Error('No lookup was expected'))

function setup(route: GiteaRoute, config: { baseUrl?: string; organization?: string } = {}) {
  const gitea = fakeGitea(BASE, route)
  const provisioner = createGiteaRepositoryProvisioner(
    { baseUrl: BASE, token: TOKEN, organization: 'sites', ...config },
    { fetch: gitea.fetch },
  )
  return { ...gitea, provisioner }
}

/**
 * Every text an error could reach a log with. The frames of the stack quote the path of the
 * checkout, which may hold any word: a check for words leaves them out.
 */
const texts = (error: unknown, frames = true) => {
  const { message, stack = '', cause } = error as Error
  const trace = frames ? stack : stack.replace(/^\s+at .*$/gm, '')
  return [String(error), message, trace, JSON.stringify(error), String(cause)]
}

describe('GiteaRepositoryProvisioner on responses recorded from Gitea 1.27.3', () => {
  it('creates the private repository and builds the clone address from the configured one', async () => {
    const { provisioner, calls } = setup(answers(created), { baseUrl: `${BASE}/` })
    await expect(provisioner.ensureRepository(SITE)).resolves.toEqual(info)
    expect(calls).toEqual([
      {
        method: 'POST',
        path: CREATE,
        authorization: `token ${TOKEN}`,
        body: { name: SITE, private: true, auto_init: false, default_branch: 'main' },
        redirect: 'manual',
        hasTimeout: true,
      },
    ])
  })

  it('confirms the repository that is already there: 409, then a lookup', async () => {
    const { provisioner, calls } = setup(answers(taken, found))
    await expect(provisioner.ensureRepository(SITE)).resolves.toEqual(info)
    expect(calls.map((call) => [call.method, call.path, call.authorization])).toEqual([
      ['POST', CREATE, `token ${TOKEN}`],
      ['GET', LOOKUP, `token ${TOKEN}`],
    ])
  })

  it('answers a repeated call as it answered the first', async () => {
    let exists = false
    const { provisioner, calls } = setup((call) => {
      if (call.method === 'GET') return exists ? found : giteaRecorded.repositoryMissing
      if (exists) return taken
      exists = true
      return created
    })
    const first = await provisioner.ensureRepository(SITE)
    await expect(provisioner.ensureRepository(SITE)).resolves.toEqual(first)
    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'GET'])
  })

  it.each([
    ['is public', changed(found, '"private":true', '"private":false')],
    ['has another owner', changed(found, '"login":"sites"', '"login":"other"')],
    ['has an owner of another spelling', changed(found, '"login":"sites"', '"login":"Sites"')],
    [
      'has another default branch',
      changed(found, '"default_branch":"main"', '"default_branch":"trunk"'),
    ],
    // Recorded: a name taken by a repository this account did not create answers 404 to it.
    ['is hidden from the account', giteaRecorded.repositoryMissing],
  ])('refuses a taken name whose repository %s', async (_, lookup) => {
    const { provisioner, calls } = setup(answers(taken, lookup))
    await expect(provisioner.ensureRepository(SITE)).rejects.toMatchObject(refused('not_ours'))
    expect(calls.map((call) => call.method)).toEqual(['POST', 'GET'])
  })

  it.each([
    ['was renamed or moved (301)', giteaRecorded.repositoryMoved],
    ['cannot be read', { status: 500, body: '{"message":"boom"}' }],
  ])('fails on a taken name whose repository %s', async (_, lookup) => {
    const { provisioner, calls } = setup(answers(taken, lookup))
    await expect(provisioner.ensureRepository(SITE)).rejects.toMatchObject(unanswered)
    expect(calls.map((call) => call.method)).toEqual(['POST', 'GET'])
  })

  it('refuses a repository Gitea keeps under another spelling of the name', async () => {
    // Recorded: the upper-case name is taken (409) and its lookup answers the lower-case one.
    const { provisioner, calls } = setup(answers(taken, found))
    await expect(provisioner.ensureRepository(SITE.toUpperCase())).rejects.toMatchObject(
      refused('not_ours'),
    )
    expect(calls.map((call) => call.path)).toEqual([
      CREATE,
      `/api/v1/repos/sites/${SITE.toUpperCase()}`,
    ])
  })

  it.each([
    ['public', changed(created, '"private":true', '"private":false')],
    ['of another owner', changed(created, '"login":"sites"', '"login":"other"')],
    ['of another name', changed(created, `"name":"${SITE}"`, '"name":"site-other"')],
    // Branch names differ by letter case: `Main` is not the branch the import pushes.
    [
      'with a default branch of another spelling',
      changed(created, '"default_branch":"main"', '"default_branch":"Main"'),
    ],
  ])('refuses a created repository that comes back %s', async (_, creation) => {
    const { provisioner, calls } = setup(answers(creation))
    await expect(provisioner.ensureRepository(SITE)).rejects.toMatchObject(refused('not_ours'))
    expect(calls).toHaveLength(1)
  })

  it('creates in the configured organization only', async () => {
    const { provisioner, calls } = setup(answers(created), { organization: 'other-sites' })
    // The recorded answer names `sites`: not the organization that was asked for.
    await expect(provisioner.ensureRepository(SITE)).rejects.toMatchObject(refused('not_ours'))
    expect(calls.map((call) => call.path)).toEqual(['/api/v1/orgs/other-sites/repos'])
  })

  it.each([
    [
      'may not create repositories (403)',
      giteaRecorded.organizationRepositoryForbidden,
      'forbidden',
    ],
    [
      'has no organization scope (403)',
      giteaRecorded.organizationRepositoryScopeMissing,
      'forbidden',
    ],
    ['is no member of the organization (404)', giteaRecorded.organizationMissing, 'not_found'],
    ['is refused (401)', giteaRecorded.repositoryBadToken, 'unauthorized'],
  ])(
    'refuses when the token %s, and names neither it nor the answer',
    async (_, creation, reason) => {
      const { provisioner, calls } = setup(answers(creation))
      const error = await provisioner.ensureRepository(SITE).catch((e: unknown) => e)
      // The reason is a word of ours for the status, the same for both answers with 403.
      expect(error).toMatchObject(refused(reason))
      for (const text of texts(error)) {
        expect(text).not.toContain(TOKEN)
        expect(text).not.toContain(BASE)
      }
      for (const text of texts(error, false))
        expect(text).not.toMatch(/allowed|scope|not found|invalid username/)
      // No lookup and no second attempt: a refusal confirms nothing.
      expect(calls.map((call) => call.method)).toEqual(['POST'])
    },
  )

  it('hides a network failure that quotes the token', async () => {
    const { provisioner } = setup(answers(new Error(`connect ECONNREFUSED with token ${TOKEN}`)))
    const error = await provisioner.ensureRepository(SITE).catch((e: unknown) => e)
    expect(error).toMatchObject(unanswered)
    expect((error as Error).message).toBe('Gitea request failed')
    for (const text of texts(error)) expect(text).not.toContain(TOKEN)
  })

  it.each([
    ['a server error', { status: 502, body: '' }],
    ['a redirect', giteaRecorded.repositoryMoved],
    ['a body of another shape', { status: 201, body: '{"name":"demo"}' }],
  ])('puts no reason on %s: a retry may pass', async (_, creation) => {
    const { provisioner, calls } = setup(answers(creation))
    await expect(provisioner.ensureRepository(SITE)).rejects.toMatchObject(unanswered)
    expect(calls.map((call) => call.method)).toEqual(['POST'])
  })

  it.each([
    [''],
    ['..'],
    ['a/b'],
    ['site 1'],
    ['site-1/../../admin'],
    ['s'.repeat(101)],
    [undefined as unknown as string],
  ])('refuses the name %j before any request', async (name) => {
    const { provisioner, calls } = setup(answers(created))
    await expect(provisioner.ensureRepository(name)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(calls).toEqual([])
  })

  it.each([
    ['http://gitea.example.test', TOKEN],
    ['https://user:password@gitea.example.test', TOKEN],
    ['https://gitea.example.test', ''],
    ['https://gitea.example.test', 'two words'],
    ['https://gitea.example.test', 'line\nbreak'],
  ])('sends nothing to %s without https and a usable token', async (baseUrl, token) => {
    const gitea = fakeGitea(BASE, answers(created))
    // Built all the same: the address fails the call, not the start of the process.
    const provisioner = createGiteaRepositoryProvisioner(
      { baseUrl, token, organization: 'sites' },
      { fetch: gitea.fetch },
    )
    await expect(provisioner.ensureRepository(SITE)).rejects.toMatchObject({
      code: 'GIT_PROVIDER_NOT_CONFIGURED',
    })
    expect(gitea.calls).toEqual([])
  })

  it.each([
    ['not a url', 'sites'],
    ['ftp://gitea.example.test', 'sites'],
    [BASE, ''],
    [BASE, 'sites/demo'],
    [BASE, '..'],
  ])('rejects the address %s with the organization %j, never quoting the token', (baseUrl, org) => {
    let thrown: unknown
    try {
      createGiteaRepositoryProvisioner({ baseUrl, token: TOKEN, organization: org })
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toMatch(/^Error: Invalid GiteaRepositoryProvisioner configuration/)
    expect(String(thrown)).not.toContain(TOKEN)
  })
})
