import { describe, expect, it, vi } from 'vitest'

import { ciIncludePaths, DomainError, maskCiLog, type GitAuth, type RepoRef } from '@repo/domain'

import { createGitlabProvider, gitlabLocalIncludes, gitlabTraceText } from './gitlab.ts'
import { gitlabBodyAllowed, gitlabPathAllowed } from './gitlab-paths.ts'
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

  it('opens again while GitLab does not know the branch pushed a moment ago yet', async () => {
    const answers = [
      { status: 400, body: { message: { source_branch: ['does not exist'] } } },
      { status: 201, body: mr() },
    ]
    const { send, calls } = fakeSend({ [`POST ${P}/merge_requests`]: () => answers.shift()! })
    const provider = createGitlabProvider({
      host,
      transport: createGitTransport({ resolvePublic: async () => '203.0.113.7', send }),
      settle: { tries: 3, everyMs: 1 },
    })
    const input = { head: 'raditi/x', base: 'main', title: 'Меню', body: '', draft: false }
    expect((await provider.openPullRequest(auth, repo, input)).number).toBe(37)
    expect(calls).toHaveLength(2)
    // Another refusal is the answer at once.
    const other = fakeSend({
      [`POST ${P}/merge_requests`]: {
        status: 400,
        body: { message: { title: ["can't be blank"] } },
      },
    })
    const once = createGitlabProvider({
      host,
      transport: createGitTransport({ resolvePublic: async () => '203.0.113.7', send: other.send }),
      settle: { tries: 3, everyMs: 1 },
    })
    expect(await code(once.openPullRequest(auth, repo, input))).toBe('GIT_PROVIDER_FAILED')
    expect(other.calls).toHaveLength(1)
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

describe('gitlab branches', () => {
  it('reads the head of one branch by its exact name (ПР15)', async () => {
    const { provider, calls } = setup({
      [`GET ${P}/repository/branches`]: {
        status: 200,
        body: [
          { name: 'main-old', commit: { id: 'b'.repeat(40) } },
          { name: 'main', commit: { id: head } },
        ],
      },
    })
    expect(await provider.branchHead!(auth, repo, 'main')).toBe(head)
    expect(calls[0]!.url.searchParams.get('search')).toBe('^main$')
    expect(await provider.branchHead!(auth, repo, 'release')).toBeNull()
  })

  it('a head that is not a SHA is a failure, not a head', async () => {
    const { provider } = setup({
      [`GET ${P}/repository/branches`]: {
        status: 200,
        body: [{ name: 'main', commit: { id: 'HEAD' } }],
      },
    })
    expect(await code(provider.branchHead!(auth, repo, 'main'))).toBe('GIT_PROVIDER_FAILED')
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

  it('reads the tail of a job log, without the line it starts inside', async () => {
    const { provider, calls } = setup({
      [`GET ${P}/jobs/5/trace`]: {
        status: 200,
        text: 'ца строки\n…конец журнала',
        truncated: true,
      },
    })
    expect(await provider.getJobLog(auth, repo, '5', { tailBytes: 32768 })).toEqual({
      text: '…конец журнала',
      truncated: true,
    })
    expect(calls[0]!.limits.tailBytes).toBe(32768)
  })

  // The start of a log of GitLab Runner 19.5.3 as GitLab CE 19.5.6 gives it (the live check of
  // 17.11.2026, docs/plan/84-projects.md, §10): every line prefixed, `+` continues a line.
  const runnerLog = [
    '2026-11-17T13:59:50.622449Z 00O \u001b[0KRunning with gitlab-runner 19.5.3 (33227fd4)\u001b[0;m',
    '2026-11-17T13:59:50.622482Z 00O section_start:1794923990:prepare_executor\r\u001b[0K',
    '2026-11-17T13:59:50.622485Z 00O+\u001b[0K\u001b[36;1mPreparing the "shell" executor\u001b[0;m\u001b[0;m',
    '2026-11-17T13:59:50.622551Z 00O section_end:1794923990:prepare_executor\r\u001b[0K',
    '2026-11-17T13:59:50.622666Z 00O+section_start:1794923990:step_script\r\u001b[0K',
    '2026-11-17T13:59:50.622669Z 00O+\u001b[0K\u001b[36;1mExecuting "step_script" stage of the job script\u001b[0;m\u001b[0;m',
    "2026-11-17T13:59:50.818803Z 01O \u001b[32;1m$ printf '\\033[32mgreen\\033[0m line\\n'\u001b[0;m",
    '2026-11-17T13:59:50.818806Z 01E \u001b[32mgreen\u001b[0m line',
    '2026-11-17T14:00:35.872236Z 00O \u001b[32;1mJob succeeded\u001b[0;m',
    '',
  ].join('\n')

  it('takes the prefixes of the runner off a log and joins the parts of a line', async () => {
    const { provider } = setup({ [`GET ${P}/jobs/5/trace`]: { status: 200, text: runnerLog } })
    const log = await provider.getJobLog(auth, repo, '5', { tailBytes: 32768 })
    expect(log.truncated).toBe(false)
    expect(maskCiLog(log.text, []).text).toBe(
      [
        'Running with gitlab-runner 19.5.3 (33227fd4)',
        'Preparing the "shell" executor',
        'Executing "step_script" stage of the job script',
        "$ printf '\\033[32mgreen\\033[0m line\\n'",
        'green line',
        'Job succeeded',
        '',
      ].join('\n'),
    )
  })

  it('a tail of one line is kept: there is no other to start with', () => {
    expect(gitlabTraceText('…12 %\r…87 %\r…100 %', true)).toBe('…12 %\r…87 %\r…100 %')
  })

  it('leaves a log of an older runner, without prefixes, as it is', () => {
    const old = '\u001b[0KRunning with gitlab-runner 16.11.0\u001b[0;m\n$ npm test\nok\n'
    expect(gitlabTraceText(old, false)).toBe(old)
    expect(gitlabTraceText('2026-11-17T13:59:50Z 01O+ continued\n', false)).toBe(' continued\n')
  })

  it('a listed pipeline that is over ended when it last changed; one that goes has no end', async () => {
    const { provider } = setup({
      // The list as GitLab CE 19.5.6 gives it: no `started_at`, no `finished_at`.
      [`GET ${P}/pipelines`]: {
        status: 200,
        body: [
          { id: 10, sha: head, ref: 'main', status: 'running', updated_at: '2026-11-17T14:01:00Z' },
          { id: 9, sha: head, ref: 'main', status: 'success', updated_at: '2026-11-17T14:00:00Z' },
        ],
      },
    })
    const runs = await provider.listRuns(auth, repo, { branch: 'main' })
    expect(runs.map((r) => [r.id, r.startedAt, r.finishedAt])).toEqual([
      ['10', null, null],
      ['9', null, new Date('2026-11-17T14:00:00Z')],
    ])
  })

  // A failed pipeline, and a passed one with a failed job of `allow_failure: true`: GitLab's retry
  // runs the failed jobs again and answers `running` (GitLab CE 19.5.6, 17.11.2026).
  it('a rerun of a pipeline with failed jobs is its retry, in place', async () => {
    const { provider, calls } = setup({
      [`POST ${P}/pipelines/9/retry`]: {
        status: 201,
        body: { id: 9, sha: head, ref: 'raditi/x', tag: false, status: 'running' },
      },
    })
    expect(await provider.rerunRun(auth, repo, '9')).toEqual({ runId: '9' })
    expect(calls).toHaveLength(1)
  })

  it('a retry answered in a form not known is a failure, not a press that did nothing', async () => {
    const { provider } = setup({
      [`POST ${P}/pipelines/9/retry`]: { status: 201, body: { id: 'nine' } },
    })
    expect(await code(provider.rerunRun(auth, repo, '9'))).toBe('GIT_PROVIDER_FAILED')
  })

  // GitLab CE 19.5.6 (the live check of 17.11.2026): the retry of a pipeline that passed answers
  // 201 as it was and runs nothing; a new pipeline of the branch runs its head again (ПР36).
  const passedRun = { id: 9, sha: head, ref: 'raditi/x', status: 'success' }
  const rerunRoutes = (over: Record<string, Route | ReturnType<Route>> = {}) => ({
    [`POST ${P}/pipelines/9/retry`]: { status: 201, body: passedRun },
    [`GET ${P}/repository/branches`]: {
      status: 200,
      body: [{ name: 'raditi/x', commit: { id: head } }],
    },
    [`POST ${P}/pipeline`]: {
      status: 201,
      body: { id: 14, sha: head, ref: 'raditi/x', status: 'created', source: 'api' },
    },
    ...over,
  })

  it('a rerun of a passed pipeline is a new pipeline of its branch, with its ref alone', async () => {
    const { provider, calls } = setup(rerunRoutes())
    expect(await provider.rerunRun(auth, repo, '9')).toEqual({ runId: '14', sha: head })
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      `POST ${P}/pipelines/9/retry`,
      `GET ${P}/repository/branches`,
      `POST ${P}/pipeline`,
    ])
    expect(calls[1]!.url.searchParams.get('search')).toBe('^raditi/x$')
    const created = calls[2]!
    expect(created.body).toEqual({ ref: 'raditi/x' })
    expect([...created.url.searchParams.keys()]).toEqual([])
  })

  it('a branch that moved on is REPO_CHANGED, and nothing is started', async () => {
    const { provider, calls } = setup(
      rerunRoutes({
        [`GET ${P}/repository/branches`]: {
          status: 200,
          body: [{ name: 'raditi/x', commit: { id: 'b'.repeat(40) } }],
        },
      }),
    )
    expect(await code(provider.rerunRun(auth, repo, '9'))).toBe('REPO_CHANGED')
    expect(calls.some((c) => c.url.pathname === `${P}/pipeline`)).toBe(false)
  })

  it('a pipeline of a tag or of a merge request ref is REPO_RUN_NOT_A_BRANCH', async () => {
    const { provider, calls } = setup(
      rerunRoutes({ [`GET ${P}/repository/branches`]: { status: 200, body: [] } }),
    )
    expect(await code(provider.rerunRun(auth, repo, '9'))).toBe('REPO_RUN_NOT_A_BRANCH')
    expect(calls.some((c) => c.url.pathname === `${P}/pipeline`)).toBe(false)
  })

  it('a pipeline of a tag is REPO_RUN_NOT_A_BRANCH, though a branch may share its name', async () => {
    const { provider, calls } = setup(
      rerunRoutes({
        [`POST ${P}/pipelines/9/retry`]: {
          status: 201,
          body: { ...passedRun, ref: 'raditi/x', tag: true },
        },
      }),
    )
    expect(await code(provider.rerunRun(auth, repo, '9'))).toBe('REPO_RUN_NOT_A_BRANCH')
    expect(calls).toHaveLength(1)
  })

  it.each([
    [
      'a protected branch of a Developer',
      "You do not have sufficient permission to run a pipeline on 'main'. Please select a different branch or contact your administrator for assistance.",
      'REPO_RUN_NOT_ALLOWED',
    ],
    [
      'rules that leave no job',
      'The resulting pipeline would have been empty. Review the rules configuration.',
      'REPO_RUN_NOT_STARTED',
    ],
    [
      'workflow rules that do not run',
      'The pipeline did not run. Review the workflow:rules configuration for the pipeline.',
      'REPO_RUN_NOT_STARTED',
    ],
    ['a branch gone', 'Reference not found', 'REPO_CHANGED'],
    ['words GitLab has not said yet', 'Something new', 'REPO_RUN_REFUSED'],
  ])('a new pipeline GitLab will not start (%s) is said in words', async (_name, base, error) => {
    const { provider } = setup(
      rerunRoutes({ [`POST ${P}/pipeline`]: { status: 400, body: { message: { base: [base] } } } }),
    )
    expect(await code(provider.rerunRun(auth, repo, '9'))).toBe(error)
  })

  it('a pipeline the one connected may not run is REPO_RUN_NOT_ALLOWED, not a lost access', async () => {
    const retry = setup({
      [`POST ${P}/pipelines/9/retry`]: { status: 403, body: { message: '403 Forbidden' } },
    })
    expect(await code(retry.provider.rerunRun(auth, repo, '9'))).toBe('REPO_RUN_NOT_ALLOWED')
    const create = setup(
      rerunRoutes({ [`POST ${P}/pipeline`]: { status: 403, body: { message: '403 Forbidden' } } }),
    )
    expect(await code(create.provider.rerunRun(auth, repo, '9'))).toBe('REPO_RUN_NOT_ALLOWED')
  })

  // The branch moved between the read of its head and the start (seen on GitLab CE 19.5.6): the new
  // pipeline builds the new commit. The adapter says which; the caller stops it.
  it('a new pipeline of another commit comes back with its commit, for the caller to stop', async () => {
    const { provider, calls } = setup(
      rerunRoutes({
        [`POST ${P}/pipeline`]: {
          status: 201,
          body: { id: 15, sha: 'c'.repeat(40), ref: 'raditi/x', status: 'created' },
        },
      }),
    )
    expect(await provider.rerunRun(auth, repo, '9')).toEqual({ runId: '15', sha: 'c'.repeat(40) })
    expect(calls.at(-1)!.url.pathname).toBe(`${P}/pipeline`)
  })

  it('another 400 of a manual job is a failure, not a job gone', async () => {
    const { provider } = setup({
      [`POST ${P}/jobs/11/play`]: { status: 400, body: { message: 'job_variables_attributes' } },
    })
    expect(
      await code(
        provider.startDeploy(auth, repo, {
          id: '11',
          kind: 'manual_job',
          name: 'deploy',
          ref: 'main',
          sha: head,
        }),
      ),
    ).toBe('GIT_PROVIDER_FAILED')
  })

  it('a manual job that is not waiting any more is REPO_RUN_GONE (400 «Unplayable Job»)', async () => {
    const { provider } = setup({
      [`POST ${P}/jobs/11/play`]: {
        status: 400,
        body: { message: '400 Bad request - Unplayable Job' },
      },
    })
    expect(
      await code(
        provider.startDeploy(auth, repo, {
          id: '11',
          kind: 'manual_job',
          name: 'deploy',
          ref: 'main',
          sha: head,
        }),
      ),
    ).toBe('REPO_RUN_GONE')
  })

  it('adds the local includes the configuration names to those the lint found', async () => {
    const { provider } = setup({
      [`POST ${P}/ci/lint`]: {
        status: 200,
        // GitLab expands a wildcard to the files at the ref and leaves a missing file out.
        body: { valid: true, errors: [], includes: [{ type: 'local', location: 'ci/build.yml' }] },
      },
    })
    const config = [
      'include:',
      '  - local: /ci/build.yml',
      "  - local: 'ci/*.yml'",
      '  - ci/new.yml',
      'test:',
      '  script: [echo ok]',
    ].join('\n')
    expect((await provider.lintCi!(auth, repo, config, 'main')).includes).toEqual([
      'ci/build.yml',
      '/ci/build.yml',
      'ci/*.yml',
      'ci/new.yml',
    ])
  })
})

describe('the local includes of a configuration', () => {
  it.each([
    ['the plain form', "include: '/templates/main.yml'\n", ['/templates/main.yml']],
    ['a list of paths', 'include:\n  - a.yml\n  - "b/*.yml"\n', ['a.yml', 'b/*.yml']],
    [
      'a list at the depth of the key',
      'include:\n- local: a.yml\n- b.yml\nstages: [x]\n',
      ['a.yml', 'b.yml'],
    ],
    ['one mapping', 'include:\n  local: ci/a.yml # comment\n', ['ci/a.yml']],
    [
      'flow style',
      "include: ['a.yml', { local: 'b.yml' }, {remote: 'https://x.example/c.yml'}]\n",
      ['a.yml', 'b.yml'],
    ],
    ['a variable in a path', 'include:\n  - local: ci/$ENV/deploy.yml\n', ['ci/*/deploy.yml']],
    [
      'other places stay out',
      [
        'include:',
        '  - project: group/other',
        '    file: /templates/ci.yml',
        '  - remote: https://example.com/ci.yml',
        '  - template: Auto-DevOps.gitlab-ci.yml',
        '  - component: $CI_SERVER_FQDN/group/c@1.0',
        '  - local: own.yml',
        '    rules:',
        '      - exists:',
        '          - Dockerfile',
      ].join('\n'),
      ['own.yml'],
    ],
    ['a child pipeline', 'child:\n  trigger:\n    include: ci/child.yml\n', ['ci/child.yml']],
    ['nothing', 'stages: [test]\ntest:\n  script: [echo include: x]\n', []],
    ['a quoted key', 'include:\n  - "local": evil.yml\n', ['evil.yml']],
    [
      'a flow entry of a list',
      "include:\n  - { local: 'a.yml', rules: [{ if: $X }] }\n",
      ['a.yml'],
    ],
    // What it cannot read is every path: closed, not open (ПР16).
    ['an alias of YAML', 'include: *common\n', ['*']],
    ['a flow over several lines', "include: ['a.yml',\n  'b.yml']\n", ['*']],
    ['a block scalar', 'include:\n  - local: |\n      a.yml\n', ['*']],
    ['a quote left open', "include: 'a.yml\n", ['*']],
  ] as const)('%s', (_name, config, expected) => {
    expect(gitlabLocalIncludes(config)).toEqual([...expected].sort())
  })

  it('more entries than it reads are every path', () => {
    const many = Array.from({ length: 250 }, (_, i) => `  - local: ci/a${i}.yml`).join('\n')
    expect(gitlabLocalIncludes(`include:\n${many}\n`)).toEqual(['*'])
  })

  // The configuration is the agent's, and core reads it in its one process (§4.6, ПР33): 256 KiB
  // of the worst of it is read in well under a second (the review of 17.11.2026 measured 38 s and
  // 3.5 min of the reading before).
  it.each([
    ['nested include keys', `include:\n${'- include:\n'.repeat(23_800)}`],
    ['a long run of spaces', `include: a${' '.repeat(256 * 1024)}b\n`],
    ['a long run of spaces before a comment', `include:\n  - local: a${' '.repeat(256 * 1024)}#\n`],
  ])('reads %s of 256 KiB at once', (_name, config) => {
    const started = performance.now()
    gitlabLocalIncludes(config)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('whatever the form, the domain bounds a wildcard by its directory', () => {
    expect(ciIncludePaths(gitlabLocalIncludes("include:\n  - local: 'ci/*.yml'\n"))).toEqual([
      'ci/',
    ])
  })
})

describe('gitlab merges while GitLab still checks the request', () => {
  const quick = { tries: 5, everyMs: 1 }
  function checking(statuses: string[], merge: { status: number; body: unknown }[]) {
    const { send, calls } = fakeSend({
      [`GET ${P}/merge_requests/37`]: () => ({
        status: 200,
        body: { ...mr(), detailed_merge_status: statuses.shift() ?? 'mergeable' },
      }),
      [`PUT ${P}/merge_requests/37/merge`]: () => merge.shift() ?? null,
    })
    const provider = createGitlabProvider({
      host,
      transport: createGitTransport({ resolvePublic: async () => '203.0.113.7', send }),
      settle: quick,
    })
    return { provider, calls }
  }
  const opts = { expectedHeadSha: head, deleteBranch: false, whenGreen: false }

  it('a 405 while the request is checked waits for the check and merges', async () => {
    const merged = 'b'.repeat(40)
    const { provider, calls } = checking(
      ['unchecked', 'checking'],
      [
        { status: 405, body: { message: '405 Method Not Allowed' } },
        { status: 200, body: mr({ state: 'merged', merge_commit_sha: merged }) },
      ],
    )
    expect(await provider.mergePullRequest(auth, repo, 37, opts)).toEqual({
      state: 'merged',
      mergeSha: merged,
    })
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET', 'GET', 'GET', 'PUT'])
  })

  it('a 422 of a merge when green while the request is prepared is scheduled after it', async () => {
    const { provider } = checking(
      ['preparing'],
      [
        { status: 422, body: { message: 'Branch cannot be merged' } },
        { status: 200, body: mr({ merge_when_pipeline_succeeds: true }) },
      ],
    )
    expect(await provider.mergePullRequest(auth, repo, 37, { ...opts, whenGreen: true })).toEqual({
      state: 'scheduled',
    })
  })

  it('a refusal of a checked request is the answer: one read, no second merge', async () => {
    const { provider, calls } = checking(['conflict'], [{ status: 405, body: {} }])
    expect(await code(provider.mergePullRequest(auth, repo, 37, opts))).toBe('REPO_NOT_MERGEABLE')
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET'])
  })

  it('a target changed while the request is checked is REPO_CHANGED, and nothing is merged', async () => {
    const { send, calls } = fakeSend({
      [`GET ${P}/merge_requests/37`]: {
        status: 200,
        body: { ...mr({ target_branch: 'release' }), detailed_merge_status: 'checking' },
      },
      [`PUT ${P}/merge_requests/37/merge`]: { status: 405, body: {} },
    })
    const provider = createGitlabProvider({
      host,
      transport: createGitTransport({ resolvePublic: async () => '203.0.113.7', send }),
      settle: quick,
    })
    expect(
      await code(
        provider.mergePullRequest(auth, repo, 37, { ...opts, expectedTargetBranch: 'main' }),
      ),
    ).toBe('REPO_CHANGED')
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET'])
  })

  it('a check that never ends gives up after its reads', async () => {
    const { provider, calls } = checking(
      Array.from({ length: 10 }, () => 'checking'),
      [{ status: 405, body: {} }],
    )
    expect(await code(provider.mergePullRequest(auth, repo, 37, opts))).toBe('REPO_NOT_MERGEABLE')
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(quick.tries)
  })
})

describe('gitlab takes an auto-merge off that was not on', () => {
  it('409 «Can’t cancel the automatic merge» of a request without one is false', async () => {
    const { provider, calls } = setup({
      [`POST ${P}/merge_requests/37/cancel_auto_merge`]: {
        status: 409,
        body: { message: "Can't cancel the automatic merge" },
      },
      [`GET ${P}/merge_requests/37`]: { status: 200, body: mr({ state: 'closed' }) },
    })
    expect(await provider.cancelAutoMerge!(auth, repo, 37)).toBe(false)
    expect(calls.map((c) => c.url.pathname)).toEqual([
      `${P}/merge_requests/37/cancel_auto_merge`,
      `${P}/merge_requests/37`,
    ])
  })

  it('409 while the request still waits for its build is a failure', async () => {
    const { provider } = setup({
      [`POST ${P}/merge_requests/37/cancel_auto_merge`]: { status: 409, body: {} },
      [`GET ${P}/merge_requests/37`]: {
        status: 200,
        body: mr({ merge_when_pipeline_succeeds: true }),
      },
    })
    expect(await code(provider.cancelAutoMerge!(auth, repo, 37))).toBe('GIT_PROVIDER_FAILED')
  })
})

describe('gitlab runs and jobs', () => {
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
    expect(gitlabPathAllowed('POST', '/projects/42/jobs/5/retry', q, '42')).toBe(false)
    expect(gitlabPathAllowed('POST', '/projects/42/pipeline', q, '42')).toBe(true)
    // A new pipeline takes no query: `?variables[…]` never goes.
    expect(
      gitlabPathAllowed('POST', '/projects/42/pipeline', new URLSearchParams('ref=main'), '42'),
    ).toBe(false)
    expect(gitlabPathAllowed('POST', '/projects/42/jobs/5/cancel', q, '42')).toBe(false)
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

  it('a new pipeline carries its ref and nothing else: no variables, no inputs (ПР36)', () => {
    expect(gitlabBodyAllowed('POST', '/projects/42/pipeline', { ref: 'main' })).toBe(true)
    for (const body of [
      { ref: 'main', variables: [{ key: 'DEPLOY', value: 'yes' }] },
      { ref: 'main', inputs: { env: 'prod' } },
      { variables: [] },
      { ref: 7 },
      null,
    ])
      expect(gitlabBodyAllowed('POST', '/projects/42/pipeline', body)).toBe(false)
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
