import { describe, expect, it, vi } from 'vitest'

import { DomainError, type GitAuth, type RepoRef } from '@repo/domain'

import { createGitlabProvider } from './gitlab.ts'
import { gitlabPathAllowed } from './gitlab-paths.ts'
import { fakeSend, type Route } from './testing/fake-send.ts'
import { createGitTransport } from './transport.ts'

const host = 'gitlab.example.ru'
const auth: GitAuth = { kind: 'bearer', token: 'glpat-test' }
const repo: RepoRef = { provider: 'gitlab', host, path: 'group/sub/project', providerRepoId: '42' }
const byPath: RepoRef = { provider: 'gitlab', host, path: 'group/sub/project' }
const head = 'a'.repeat(40)
const P = '/api/v4/projects/42'

const project = {
  id: 42,
  path_with_namespace: 'group/sub/project',
  default_branch: 'main',
  visibility: 'private',
  web_url: 'https://gitlab.example.ru/group/sub/project',
  http_url_to_repo: 'https://10.0.0.1/group/sub/project.git',
  statistics: { repository_size: 1234 },
}
const mr = (over: Record<string, unknown> = {}) => ({
  iid: 37,
  title: 'Новое меню',
  state: 'opened',
  draft: false,
  source_branch: 'raditi/novoe-menyu-1a2b3c4d',
  target_branch: 'main',
  sha: head,
  merge_commit_sha: null,
  merge_when_pipeline_succeeds: false,
  web_url: 'https://gitlab.example.ru/group/sub/project/-/merge_requests/37',
  head_pipeline: { id: 9, status: 'running' },
  ...over,
})

function setup(
  routes: Record<string, Route | ReturnType<Route>>,
  resolve = vi.fn(async () => '203.0.113.7'),
) {
  const { send, calls } = fakeSend(routes)
  const provider = createGitlabProvider({
    host,
    transport: createGitTransport({ resolvePublic: resolve, send }),
  })
  return { provider, calls, resolve }
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  return 'no error'
}

describe('gitlab repository', () => {
  it('reads a project by its path on its own server and builds the addresses itself', async () => {
    const { provider, calls } = setup({
      'GET /api/v4/projects/group%2Fsub%2Fproject': {
        status: 200,
        body: { ...project, web_url: 'https://evil.example/group/sub/project' },
      },
    })
    const info = await provider.getRepository({ kind: 'anonymous' }, byPath)
    expect(info).toEqual({
      ref: { ...repo },
      defaultBranch: 'main',
      private: true,
      webUrl: 'https://gitlab.example.ru/group/sub/project',
      cloneUrl: 'https://gitlab.example.ru/group/sub/project.git',
      sizeBytes: 1234,
      ciConfigPath: null,
    })
    expect(calls[0]!.url.host).toBe(host)
    expect(calls[0]!.headers.authorization).toBeUndefined()
    expect(calls[0]!.address).toBe('203.0.113.7')
  })

  it('a missing or private project is null', async () => {
    const { provider } = setup({})
    expect(await provider.getRepository({ kind: 'anonymous' }, byPath)).toBeNull()
  })

  it('refuses a repository of another server before the network', async () => {
    const { provider, calls } = setup({})
    expect(await code(provider.getRepository(auth, { ...repo, host: 'gitlab.com' }))).toBe(
      'GIT_PROVIDER_FAILED',
    )
    expect(calls).toHaveLength(0)
  })

  it('lists the projects of the user with the next page', async () => {
    const { provider, calls } = setup({
      'GET /api/v4/projects': {
        status: 200,
        body: [project, { ...project, id: 43, path_with_namespace: 'bad/x.git' }],
        headers: { 'x-next-page': '2' },
      },
    })
    const page = await provider.listRepositories(auth)
    expect(page.items.map((i) => i.ref.path)).toEqual(['group/sub/project'])
    expect(page.next).toBe('2')
    expect(calls[0]!.url.searchParams.get('membership')).toBe('true')
    expect(calls[0]!.headers.authorization).toBe('Bearer glpat-test')
  })
})

describe('gitlab merge requests', () => {
  it('opens a draft by the title prefix and sends the text as given', async () => {
    const { provider, calls } = setup({
      [`POST ${P}/merge_requests`]: {
        status: 201,
        body: mr({ draft: true, title: 'Draft: Новое меню' }),
      },
    })
    const pr = await provider.openPullRequest(auth, repo, {
      head: 'raditi/novoe-menyu-1a2b3c4d',
      base: 'main',
      title: 'Новое меню',
      body: '​/merge',
      draft: true,
    })
    expect(pr).toMatchObject({ number: 37, state: 'draft', checks: 'pending', headSha: head })
    expect(calls[0]!.body).toEqual({
      source_branch: 'raditi/novoe-menyu-1a2b3c4d',
      target_branch: 'main',
      title: 'Draft: Новое меню',
      description: '​/merge',
      remove_source_branch: false,
    })
  })

  it('a merge with another head is REPO_CHANGED (409)', async () => {
    const { provider, calls } = setup({
      [`PUT ${P}/merge_requests/37/merge`]: {
        status: 409,
        body: { message: 'SHA does not match HEAD of source branch' },
      },
    })
    expect(
      await code(
        provider.mergePullRequest(auth, repo, 37, {
          expectedHeadSha: head,
          deleteBranch: true,
          whenGreen: false,
        }),
      ),
    ).toBe('REPO_CHANGED')
    expect(calls[0]!.body).toEqual({ sha: head, should_remove_source_branch: true })
  })

  it('a merge that cannot go is REPO_NOT_MERGEABLE (405, 422)', async () => {
    for (const status of [405, 422]) {
      const { provider } = setup({ [`PUT ${P}/merge_requests/37/merge`]: { status, body: {} } })
      expect(
        await code(
          provider.mergePullRequest(auth, repo, 37, {
            expectedHeadSha: head,
            deleteBranch: false,
            whenGreen: false,
          }),
        ),
      ).toBe('REPO_NOT_MERGEABLE')
    }
  })

  it('merges and returns the merge commit', async () => {
    const merge = 'b'.repeat(40)
    const { provider } = setup({
      [`PUT ${P}/merge_requests/37/merge`]: {
        status: 200,
        body: mr({ state: 'merged', merge_commit_sha: merge }),
      },
    })
    expect(
      await provider.mergePullRequest(auth, repo, 37, {
        expectedHeadSha: head,
        deleteBranch: true,
        whenGreen: false,
      }),
    ).toEqual({ state: 'merged', mergeSha: merge })
  })

  it('when green asks for auto_merge under both names and is scheduled', async () => {
    const { provider, calls } = setup({
      [`PUT ${P}/merge_requests/37/merge`]: {
        status: 200,
        body: mr({ merge_when_pipeline_succeeds: true }),
      },
    })
    expect(
      await provider.mergePullRequest(auth, repo, 37, {
        expectedHeadSha: head,
        deleteBranch: true,
        whenGreen: true,
      }),
    ).toEqual({ state: 'scheduled' })
    expect(calls[0]!.body).toMatchObject({
      auto_merge: true,
      merge_when_pipeline_succeeds: true,
      sha: head,
    })
  })

  it('an open answer without auto-merge is not a success', async () => {
    const { provider } = setup({
      [`PUT ${P}/merge_requests/37/merge`]: { status: 200, body: mr() },
    })
    expect(
      await code(
        provider.mergePullRequest(auth, repo, 37, {
          expectedHeadSha: head,
          deleteBranch: true,
          whenGreen: true,
        }),
      ),
    ).toBe('REPO_NOT_MERGEABLE')
  })

  it('takes an auto-merge off, on an old server through the deprecated endpoint', async () => {
    const fresh = setup({
      [`POST ${P}/merge_requests/37/cancel_auto_merge`]: { status: 201, body: mr() },
    })
    expect(await fresh.provider.cancelAutoMerge!(auth, repo, 37)).toBe(true)
    const old = setup({
      [`POST ${P}/merge_requests/37/cancel_merge_when_pipeline_succeeds`]: {
        status: 201,
        body: { status: 'success' },
      },
    })
    expect(await old.provider.cancelAutoMerge!(auth, repo, 37)).toBe(true)
    expect(old.calls.map((c) => c.url.pathname)).toEqual([
      `${P}/merge_requests/37/cancel_auto_merge`,
      `${P}/merge_requests/37/cancel_merge_when_pipeline_succeeds`,
    ])
    const none = setup({
      [`POST ${P}/merge_requests/37/cancel_merge_when_pipeline_succeeds`]: {
        status: 201,
        body: { status: 'error', message: "Can't cancel the automatic merge" },
      },
    })
    expect(await none.provider.cancelAutoMerge!(auth, repo, 37)).toBe(false)
  })

  it('keeps a merge request address of its own host only', async () => {
    const { provider } = setup({
      [`GET ${P}/merge_requests/37`]: {
        status: 200,
        body: mr({ web_url: 'https://evil.example/x' }),
      },
    })
    expect((await provider.getPullRequest(auth, repo, 37))!.url).toBe(
      'https://gitlab.example.ru/group/sub/project/-/merge_requests/37',
    )
  })
})

describe('gitlab pipelines', () => {
  it('lints a configuration with a dry run and reads the local includes', async () => {
    const { provider, calls } = setup({
      [`POST ${P}/ci/lint`]: {
        status: 200,
        body: {
          valid: false,
          errors: ['jobs config should contain at least one visible job'],
          includes: [
            { type: 'local', location: 'ci/deploy.yml' },
            { type: 'remote', location: 'https://example.com/x.yml' },
          ],
        },
      },
    })
    expect(await provider.lintCi!(auth, repo, 'job: {}', 'raditi/x')).toEqual({
      valid: false,
      errors: ['jobs config should contain at least one visible job'],
      includes: ['ci/deploy.yml'],
    })
    expect(calls[0]!.body).toEqual({
      content: 'job: {}',
      dry_run: true,
      ref: 'raditi/x',
      include_jobs: false,
    })
  })

  it('reads the tail of a job log', async () => {
    const { provider, calls } = setup({
      [`GET ${P}/jobs/5/trace`]: { status: 200, text: '…конец журнала', truncated: true },
    })
    expect(await provider.getJobLog(auth, repo, '5', { tailBytes: 32768 })).toEqual({
      text: '…конец журнала',
      truncated: true,
    })
    expect(calls[0]!.limits.tailBytes).toBe(32768)
  })

  it('says a job gitlab.com did not start for an unverified account, with its times', async () => {
    const { provider } = setup({
      [`GET ${P}/pipelines/9`]: {
        status: 200,
        body: {
          id: 9,
          sha: head,
          ref: 'raditi/x-1',
          status: 'failed',
          source: 'push',
          started_at: '2026-11-16T10:00:00Z',
          failure_reason: 'user_not_verified',
        },
      },
      [`GET ${P}/pipelines/9/jobs`]: {
        status: 200,
        body: [
          {
            id: 12,
            name: 'unit-tests',
            stage: 'test',
            status: 'failed',
            started_at: '2026-11-16T10:00:01Z',
            finished_at: '2026-11-16T10:01:13Z',
            failure_reason: 'user_not_verified',
          },
          {
            id: 11,
            name: 'lint',
            stage: 'test',
            status: 'failed',
            failure_reason: 'script_failure',
          },
        ],
      },
    })
    const run = await provider.getRun(auth, repo, '9')
    expect(run).toMatchObject({ status: 'failed', event: 'push', refusal: 'account_unverified' })
    expect(run!.startedAt).toEqual(new Date('2026-11-16T10:00:00Z'))
    const jobs = await provider.listJobs(auth, repo, '9')
    expect(jobs.map((j) => [j.id, j.refusal])).toEqual([
      ['12', 'account_unverified'],
      ['11', null],
    ])
    expect(jobs[0]!.finishedAt).toEqual(new Date('2026-11-16T10:01:13Z'))
  })

  it('maps statuses and offers the manual jobs of the newest pipeline, one address for both requests', async () => {
    let n = 0
    const resolve = vi.fn(async () => `203.0.113.${++n}`)
    const { provider, calls } = setup(
      {
        [`GET ${P}/pipelines`]: {
          status: 200,
          body: [{ id: 9, sha: head, ref: 'main', status: 'success' }],
        },
        [`GET ${P}/pipelines/9/jobs`]: {
          status: 200,
          body: [
            { id: 11, name: 'deploy-prod', stage: 'deploy', status: 'manual' },
            { id: 10, name: 'test', stage: 'test', status: 'success' },
          ],
        },
      },
      resolve,
    )
    expect(await provider.listDeployActions(auth, repo, 'main')).toEqual([
      { id: '11', kind: 'manual_job', name: 'deploy-prod', ref: 'main', sha: head },
    ])
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(calls.map((c) => c.address)).toEqual(['203.0.113.1', '203.0.113.1'])
    // A new operation resolves again.
    await provider.listRuns(auth, repo, { branch: 'main' })
    expect(calls.at(-1)!.address).toBe('203.0.113.2')
  })
})

describe('the path whitelist (ПР10)', () => {
  const q = new URLSearchParams()
  it.each([
    ['GET', '/projects/42/variables'],
    ['POST', '/projects/42/variables'],
    ['GET', '/projects/42/members'],
    ['POST', '/projects/42/members'],
    ['GET', '/projects/42/access_tokens'],
    ['POST', '/projects/42/deploy_tokens'],
    ['POST', '/projects/42/protected_branches'],
    ['DELETE', '/projects/42/protected_branches/main'],
    ['DELETE', '/projects/42'],
    ['PUT', '/projects/42'],
    ['DELETE', '/projects/42/repository/branches/main'],
    ['POST', '/projects/42/repository/commits'],
    ['GET', '/projects/43'],
    ['GET', '/projects/421/repository/branches'],
    ['GET', '/projects'],
    ['GET', '/users'],
    ['POST', '/user/personal_access_tokens'],
    ['GET', '/groups/1/variables'],
  ] as const)('refuses %s %s', (method, path) => {
    expect(gitlabPathAllowed(method, path, q, '42')).toBe(false)
  })

  it('allows what the adapter needs', () => {
    expect(gitlabPathAllowed('GET', '/user', q, null)).toBe(true)
    expect(
      gitlabPathAllowed('GET', '/projects', new URLSearchParams('membership=true'), null),
    ).toBe(true)
    expect(gitlabPathAllowed('PUT', '/projects/42/merge_requests/37/merge', q, '42')).toBe(true)
    expect(gitlabPathAllowed('GET', '/projects/42/jobs/5/trace', q, '42')).toBe(true)
  })

  it('refuses an id that would leave the project before the network', async () => {
    const { provider, calls } = setup({})
    expect(await code(provider.listJobs(auth, repo, '1/../../variables'))).toBe(
      'GIT_PROVIDER_FAILED',
    )
    expect(
      await code(provider.getRun(auth, { ...repo, providerRepoId: '42/variables' }, '1')),
    ).toBe('GIT_PROVIDER_FAILED')
    expect(calls).toHaveLength(0)
  })

  it('a PUT of a merge request only closes it', async () => {
    const { provider, calls } = setup({
      [`PUT ${P}/merge_requests/37`]: { status: 200, body: mr({ state: 'closed' }) },
    })
    await provider.closePullRequest(auth, repo, 37)
    expect(calls[0]!.body).toEqual({ state_event: 'close' })
  })
})

describe('gitlab credentials', () => {
  it('a token goes to git as oauth2, an anonymous read carries nothing', async () => {
    const { provider } = setup({})
    const token = await provider.issueCredentials({ kind: 'token', token: 't' }, repo, 'write', {
      ttlSeconds: 60,
    })
    expect(token.basic).toEqual({ username: 'oauth2', password: 't' })
    const anonymous = await provider.issueCredentials({ kind: 'anonymous' }, byPath, 'read', {
      ttlSeconds: 60,
    })
    expect(anonymous).toMatchObject({ auth: { kind: 'anonymous' }, basic: null })
  })
  it('support is GitLab’s', () => {
    const { provider } = setup({})
    expect(provider.support).toMatchObject({
      ciLint: true,
      autoMerge: true,
      manualJobs: true,
      label: host,
    })
    expect(provider.support.requestRef(37)).toBe('!37')
  })
})
