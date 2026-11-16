import { generateKeyPairSync, verify } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { GitGrant, RepoRef } from '@repo/domain'

import { createGitConnect } from './connect.ts'
import { githubAppJwt, githubChecksState, workflowDispatchable } from './github.ts'
import { createGitProvider } from './create-git-provider.ts'
import { fakeSend, type Route } from './testing/fake-send.ts'
import { createGitTransport } from './transport.ts'

// The GitHub App of slice 84.25 (docs/plan/84-projects.md, ПР10, ПР13–ПР16, §4.5) on an HTTP fake.

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const repo: RepoRef = {
  provider: 'github',
  host: 'github.com',
  path: 'acme/site',
  providerRepoId: '42',
}
const grant: GitGrant = {
  kind: 'github_installation',
  appId: '1001',
  privateKey: pem,
  installationId: '77',
}
const now = new Date('2026-11-16T10:00:00Z')
const bearer = { kind: 'bearer', token: 'ghs_operation' } as const
const sha = 'a'.repeat(40)

function setup(routes: Record<string, Route | ReturnType<Route>>) {
  const { send, calls } = fakeSend(routes)
  const transport = createGitTransport({ resolvePublic: async () => '140.82.112.6', send })
  const provider = createGitProvider({ kind: 'github', host: 'github.com', transport })
  return { provider, calls, transport }
}

const tokenRoute = {
  status: 201,
  body: { token: 'ghs_operation', expires_at: '2026-11-16T11:00:00Z' },
}

describe('the JWT of the GitHub App', () => {
  it('is RS256, issued by the app id, dated a minute back and lives under ten minutes', () => {
    const jwt = githubAppJwt('1001', pem, now)
    const [head, body, signature] = jwt.split('.')
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    })
    const claims = JSON.parse(Buffer.from(body!, 'base64url').toString())
    const at = now.getTime() / 1000
    expect(claims.iss).toBe('1001')
    expect(claims.iat).toBe(at - 60)
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
    expect(claims.exp).toBeGreaterThan(at)
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${body}`),
        publicKey,
        Buffer.from(signature!, 'base64url'),
      ),
    ).toBe(true)
  })

  it('a key that does not sign is refused without the key in the error', () => {
    let error: unknown
    try {
      githubAppJwt('1001', '-----BEGIN RSA PRIVATE KEY-----\nnot a key\n', now)
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'GIT_PROVIDER_FAILED' })
    expect(String((error as Error).message)).not.toContain('not a key')
  })
})

describe('installation tokens', () => {
  it('one repository, the rights of the operation; workflows only when asked; revoked after', async () => {
    const { provider, calls } = setup({
      'POST /app/installations/77/access_tokens': tokenRoute,
      'DELETE /installation/token': { status: 204 },
    })
    const read = await provider.issueCredentials(grant, repo, 'read', { ttlSeconds: 600 })
    const write = await provider.issueCredentials(grant, repo, 'write', { ttlSeconds: 600 })
    const ci = await provider.issueCredentials(grant, repo, 'write', {
      ttlSeconds: 600,
      workflows: true,
    })
    const bodies = calls.map((call) => call.body as Record<string, Record<string, string>>)
    expect(bodies[0]).toEqual({
      repository_ids: [42],
      permissions: {
        metadata: 'read',
        contents: 'read',
        pull_requests: 'read',
        actions: 'read',
        checks: 'read',
        statuses: 'read',
      },
    })
    expect(bodies[1]!.permissions).toMatchObject({
      contents: 'write',
      pull_requests: 'write',
      actions: 'write',
      checks: 'read',
      statuses: 'read',
    })
    expect(bodies[1]!.permissions!.workflows).toBeUndefined()
    expect(bodies[2]!.permissions!.workflows).toBe('write')
    // The JWT is the authorization of the request for a token, never a token itself.
    expect(calls[0]!.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(write.basic).toEqual({ username: 'x-access-token', password: 'ghs_operation' })
    expect(read.auth).toEqual(bearer)
    expect(read.expiresAt.toISOString()).toBe('2026-11-16T11:00:00.000Z')
    await ci.revoke!()
    await ci.revoke!()
    const revokes = calls.filter((call) => call.method === 'DELETE')
    expect(revokes).toHaveLength(1)
    expect(revokes[0]!.headers.authorization).toBe('Bearer ghs_operation')
  })

  it('a reading access with workflows and a repository without its id are refused before GitHub', async () => {
    const { provider, calls } = setup({ 'POST /app/installations/77/access_tokens': tokenRoute })
    await expect(
      provider.issueCredentials(grant, repo, 'read', { ttlSeconds: 60, workflows: true }),
    ).rejects.toMatchObject({ code: 'GIT_PROVIDER_FAILED' })
    await expect(
      provider.issueCredentials(
        grant,
        { provider: 'github', host: 'github.com', path: 'acme/site' },
        'write',
        { ttlSeconds: 60 },
      ),
    ).rejects.toMatchObject({ code: 'GIT_PROVIDER_FAILED' })
    expect(calls).toHaveLength(0)
  })

  it('an access of the whole installation for a sync names no repository', async () => {
    const { provider, calls } = setup({ 'POST /app/installations/77/access_tokens': tokenRoute })
    await provider.issueCredentials(grant, null, 'read', { ttlSeconds: 60 })
    expect((calls[0]!.body as Record<string, unknown>).repository_ids).toBeUndefined()
  })
})

describe('the rights of the person who connected (ПР10)', () => {
  const permission = (body: unknown): Record<string, Route | ReturnType<Route>> => ({
    'GET /user/9': { status: 200, body: { id: 9, login: 'reader' } },
    'GET /repos/acme/site/collaborators/reader/permission': { status: 200, body },
  })

  it('a reader may neither push nor merge', async () => {
    const { provider } = setup(
      permission({
        permission: 'read',
        role_name: 'read',
        user: { id: 9, permissions: { pull: true, push: false, maintain: false, admin: false } },
      }),
    )
    expect(await provider.personRights!(bearer, repo, '9')).toEqual({
      push: false,
      maintain: false,
    })
  })

  it('a writer pushes, a maintainer also merges into a protected branch', async () => {
    const writer = setup(
      permission({
        permission: 'write',
        role_name: 'write',
        user: { id: 9, permissions: { push: true, maintain: false, admin: false } },
      }),
    )
    expect(await writer.provider.personRights!(bearer, repo, '9')).toEqual({
      push: true,
      maintain: false,
    })
    const maintainer = setup(
      permission({
        permission: 'write',
        role_name: 'maintain',
        user: { id: 9, permissions: { push: true, maintain: true, admin: false } },
      }),
    )
    expect(await maintainer.provider.personRights!(bearer, repo, '9')).toEqual({
      push: true,
      maintain: true,
    })
  })

  it('an answer about another person who took the login is no right', async () => {
    const { provider } = setup(
      permission({ permission: 'admin', role_name: 'admin', user: { id: 10, permissions: {} } }),
    )
    expect(await provider.personRights!(bearer, repo, '9')).toEqual({
      push: false,
      maintain: false,
    })
  })
})

describe('branch rules and «сборка прошла» (ПР15)', () => {
  it('reads required checks of the classic protection and of rulesets', async () => {
    const { provider } = setup({
      'GET /repos/acme/site/branches/main': {
        status: 200,
        body: {
          commit: { sha },
          protected: true,
          protection: {
            required_status_checks: { contexts: ['build'], checks: [{ context: 'lint' }] },
          },
        },
      },
      'GET /repos/acme/site/rules/branches/main': {
        status: 200,
        body: [
          {
            type: 'required_status_checks',
            parameters: { required_status_checks: [{ context: 'e2e' }] },
          },
        ],
      },
    })
    expect(await provider.branchRules!(bearer, repo, 'main')).toEqual({
      protected: true,
      requiredChecks: ['build', 'e2e', 'lint'],
    })
  })

  it('an unprotected branch without rules has no required check', async () => {
    const { provider } = setup({
      'GET /repos/acme/site/branches/main': {
        status: 200,
        body: { commit: { sha }, protected: false },
      },
      'GET /repos/acme/site/rules/branches/main': { status: 200, body: [] },
    })
    expect(await provider.branchRules!(bearer, repo, 'main')).toEqual({
      protected: false,
      requiredChecks: [],
    })
  })

  it('every suite and every required check must have passed', () => {
    const suite = (status: string, conclusion: string | null) => ({ status, conclusion })
    const run = (name: string, status: string, conclusion: string | null) => ({
      name,
      status,
      conclusion,
    })
    const done = { suites: [suite('completed', 'success')], statuses: [] }
    expect(
      githubChecksState({ ...done, runs: [run('build', 'completed', 'success')] }, ['build']),
    ).toBe('success')
    // A required check that has not reported yet is waited for.
    expect(githubChecksState({ ...done, runs: [] }, ['build'])).toBe('pending')
    expect(
      githubChecksState(
        {
          suites: [suite('in_progress', null)],
          runs: [run('build', 'completed', 'success')],
          statuses: [],
        },
        ['build'],
      ),
    ).toBe('pending')
    // A suite of the agent's own workflow that failed fails the head, required or not.
    expect(
      githubChecksState(
        {
          suites: [suite('completed', 'success'), suite('completed', 'failure')],
          runs: [run('build', 'completed', 'success')],
          statuses: [],
        },
        ['build'],
      ),
    ).toBe('failure')
    expect(
      githubChecksState(
        { suites: [], runs: [], statuses: [{ context: 'build', state: 'error' }] },
        ['build'],
      ),
    ).toBe('failure')
    expect(githubChecksState({ suites: [], runs: [], statuses: [] }, [])).toBe('none')
  })

  it('reads the suites, the runs and the statuses of the head', async () => {
    const { provider } = setup({
      [`GET /repos/acme/site/commits/${sha}/check-suites`]: {
        status: 200,
        body: {
          check_suites: [
            { status: 'completed', conclusion: 'success', latest_check_runs_count: 1 },
            // An app that ran nothing on this push.
            { status: 'queued', conclusion: null, latest_check_runs_count: 0 },
          ],
        },
      },
      [`GET /repos/acme/site/commits/${sha}/check-runs`]: {
        status: 200,
        body: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] },
      },
      [`GET /repos/acme/site/commits/${sha}/status`]: { status: 200, body: { statuses: [] } },
    })
    expect(await provider.headChecks!(bearer, repo, sha, ['build'])).toBe('success')
  })
})

describe('pull requests', () => {
  const pull = (over: Record<string, unknown> = {}) => ({
    number: 5,
    title: 'Меню',
    state: 'open',
    draft: false,
    merged_at: null,
    html_url: 'https://github.com/acme/site/pull/5',
    head: { ref: 'raditi/menu-12345678', sha, repo: { full_name: 'acme/site' } },
    base: { ref: 'main' },
    auto_merge: null,
    ...over,
  })

  it('opens one and closes one', async () => {
    const { provider, calls } = setup({
      'POST /repos/acme/site/pulls': { status: 201, body: pull() },
      'PATCH /repos/acme/site/pulls/5': { status: 200, body: pull({ state: 'closed' }) },
    })
    const opened = await provider.openPullRequest(bearer, repo, {
      head: 'raditi/menu-12345678',
      base: 'main',
      title: 'Меню',
      body: 'текст',
      draft: false,
    })
    expect(opened).toMatchObject({ number: 5, sourceBranch: 'raditi/menu-12345678', state: 'open' })
    await provider.closePullRequest(bearer, repo, 5)
    expect(calls[1]).toMatchObject({ method: 'PATCH', body: { state: 'closed' } })
  })

  it('merges with the head expected; another head is REPO_CHANGED, not mergeable — REPO_NOT_MERGEABLE', async () => {
    let answer = { status: 200, body: { merged: true, sha: 'b'.repeat(40) } as unknown }
    const { provider, calls } = setup({
      'PUT /repos/acme/site/pulls/5/merge': () => answer as { status: number; body: unknown },
      'GET /repos/acme/site/pulls/5': {
        status: 200,
        body: pull({ merged_at: '2026-11-16T10:00:00Z' }),
      },
      'DELETE /repos/acme/site/git/refs/heads/raditi/menu-12345678': { status: 204 },
    })
    expect(
      await provider.mergePullRequest(bearer, repo, 5, {
        expectedHeadSha: sha,
        deleteBranch: true,
        whenGreen: false,
      }),
    ).toEqual({ state: 'merged', mergeSha: 'b'.repeat(40) })
    expect(calls[0]!.body).toEqual({ sha, merge_method: 'merge' })
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' })
    answer = { status: 409, body: { message: 'Head branch was modified' } }
    await expect(
      provider.mergePullRequest(bearer, repo, 5, {
        expectedHeadSha: sha,
        deleteBranch: false,
        whenGreen: false,
      }),
    ).rejects.toMatchObject({ code: 'REPO_CHANGED' })
    answer = { status: 405, body: { message: 'Pull Request is not mergeable' } }
    await expect(
      provider.mergePullRequest(bearer, repo, 5, {
        expectedHeadSha: sha,
        deleteBranch: false,
        whenGreen: false,
      }),
    ).rejects.toMatchObject({ code: 'REPO_NOT_MERGEABLE' })
    // GitHub waits for nothing itself: «когда сборка пройдёт» is the platform's.
    await expect(
      provider.mergePullRequest(bearer, repo, 5, {
        expectedHeadSha: sha,
        deleteBranch: false,
        whenGreen: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })

  it('the branch of a fork is never deleted', async () => {
    const { provider, calls } = setup({
      'PUT /repos/acme/site/pulls/5/merge': {
        status: 200,
        body: { merged: true, sha: 'b'.repeat(40) },
      },
      'GET /repos/acme/site/pulls/5': {
        status: 200,
        body: pull({
          merged_at: '2026-11-16T10:00:00Z',
          head: { ref: 'main', sha, repo: { full_name: 'stranger/site' } },
        }),
      },
    })
    await provider.mergePullRequest(bearer, repo, 5, {
      expectedHeadSha: sha,
      deleteBranch: true,
      whenGreen: false,
    })
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  })
})

describe('logs and deploys', () => {
  it('a log follows one redirect to the storage of Actions without the access', async () => {
    const { provider, calls } = setup({
      'GET /repos/acme/site/actions/jobs/31/logs': {
        status: 302,
        headers: {
          location: 'https://productionresultssa3.blob.core.windows.net/actions-results/x?sig=1',
        },
      },
      'GET /actions-results/x': { status: 200, text: 'line 1\nline 2\n' },
    })
    expect(await provider.getJobLog(bearer, repo, '31', { tailBytes: 1024 })).toEqual({
      text: 'line 1\nline 2\n',
      truncated: false,
    })
    expect(calls[1]!.url.host).toBe('productionresultssa3.blob.core.windows.net')
    expect(calls[1]!.headers.authorization).toBeUndefined()
    expect(calls[1]!.limits.tailBytes).toBe(1024)
  })

  it('a log redirected anywhere else is refused', async () => {
    for (const location of [
      'https://evil.example/log',
      'http://productionresultssa3.blob.core.windows.net/x',
      'https://pipelines.actions.githubusercontent.com:8443/x',
      'https://attacker.blob.core.windows.net/x',
    ]) {
      const { provider, calls } = setup({
        'GET /repos/acme/site/actions/jobs/31/logs': { status: 302, headers: { location } },
      })
      await expect(
        provider.getJobLog(bearer, repo, '31', { tailBytes: 1024 }),
      ).rejects.toMatchObject({ code: 'GIT_PROVIDER_FAILED' })
      expect(calls).toHaveLength(1)
    }
  })

  it('offers the workflows of the head of the main branch that run on workflow_dispatch', async () => {
    const file = (text: string) => ({
      status: 200,
      body: { encoding: 'base64', content: Buffer.from(text).toString('base64') },
    })
    const { provider, calls } = setup({
      'GET /repos/acme/site/branches/main': { status: 200, body: { commit: { sha } } },
      'GET /repos/acme/site/actions/workflows': {
        status: 200,
        body: {
          workflows: [
            { id: 1, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' },
            { id: 2, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
            { id: 3, name: 'Old', path: '.github/workflows/old.yml', state: 'disabled_manually' },
          ],
        },
      },
      'GET /repos/acme/site/contents/.github/workflows/deploy.yml': file(
        'on:\n  workflow_dispatch:\n  push:\n',
      ),
      'GET /repos/acme/site/contents/.github/workflows/ci.yml': file(
        'on: [push]\n# workflow_dispatch: later\n',
      ),
    })
    expect(await provider.listDeployActions(bearer, repo, 'main')).toEqual([
      { id: '1', kind: 'workflow_dispatch', name: 'Deploy', ref: 'main', sha },
    ])
    expect(
      calls.find((call) => call.url.pathname.endsWith('deploy.yml'))!.url.searchParams.get('ref'),
    ).toBe(sha)
  })

  it('starts a workflow on the main branch: 204 of this API version, 200 of a later one', async () => {
    let answer: { status: number; body?: unknown } = { status: 204 }
    const { provider, calls } = setup({
      'POST /repos/acme/site/actions/workflows/1/dispatches': () => answer,
    })
    const action = { id: '1', kind: 'workflow_dispatch' as const, name: 'Deploy', ref: 'main', sha }
    expect(await provider.startDeploy(bearer, repo, action)).toEqual({ runId: null })
    expect(calls[0]!.body).toEqual({ ref: 'main' })
    answer = { status: 200, body: { workflow_run_id: 555, run_url: 'x', html_url: 'y' } }
    expect(await provider.startDeploy(bearer, repo, action)).toEqual({ runId: '555' })
  })

  it('the word workflow_dispatch counts only outside comments', () => {
    expect(workflowDispatchable('on: [push, workflow_dispatch]')).toBe(true)
    expect(workflowDispatchable("on:\n  'workflow_dispatch':\n")).toBe(true)
    expect(workflowDispatchable('on: push # workflow_dispatch')).toBe(false)
    expect(workflowDispatchable('on: push\nname: not_workflow_dispatch_x')).toBe(false)
  })
})

describe('the check of an installation by the user (ПР10)', () => {
  const app = {
    host: 'github.com',
    clientId: 'Iv1.abc',
    clientSecret: 'secret',
    redirectUri: 'https://raditi.ru/api/git/github/callback',
  }

  function connectOf(routes: Record<string, Route | ReturnType<Route>>) {
    const { send, calls } = fakeSend({
      'GET /user': { status: 200, body: { id: 9, login: 'reader' } },
      'GET /user/installations': {
        status: 200,
        body: { total_count: 1, installations: [{ id: 77, account: { id: 500, login: 'acme' } }] },
      },
      ...routes,
    })
    const transport = createGitTransport({ resolvePublic: async () => '140.82.112.6', send })
    return { connect: createGitConnect('github', { transport }), calls }
  }

  it('a forged installation_id — one the user does not see — is null', async () => {
    const { connect, calls } = connectOf({})
    expect(await connect.verifyInstallation!('ghu_user', '78')).toBeNull()
    expect(calls.every((call) => !call.url.pathname.includes('/78/'))).toBe(true)
  })

  it('offers only the repositories where the user may push', async () => {
    const { connect } = connectOf({
      'GET /user/installations/77/repositories': {
        status: 200,
        body: {
          total_count: 2,
          repositories: [
            {
              id: 42,
              full_name: 'acme/site',
              default_branch: 'main',
              private: true,
              permissions: { pull: true, push: true },
            },
            {
              id: 43,
              full_name: 'acme/billing',
              default_branch: 'main',
              private: true,
              permissions: { pull: true, push: false },
            },
          ],
        },
      },
    })
    const checked = await connect.verifyInstallation!('ghu_user', '77')
    expect(checked).toMatchObject({
      installationId: '77',
      account: { login: 'acme', id: '500' },
      user: { login: 'reader', id: '9' },
    })
    expect(checked!.repositories.map((r) => r.ref.path)).toEqual(['acme/site'])
  })

  it('exchanges a code with the verifier of PKCE; a refused code is an error', async () => {
    let answer: { status: number; body: unknown } = {
      status: 200,
      body: {
        access_token: 'ghu_user',
        expires_in: 28800,
        refresh_token: 'ghr_r',
        token_type: 'bearer',
      },
    }
    const { connect, calls } = connectOf({ 'POST /login/oauth/access_token': () => answer })
    const tokens = await connect.exchangeCode(app, 'code', 'verifier')
    expect(tokens.accessToken).toBe('ghu_user')
    expect(calls[0]!.url.host).toBe('github.com')
    expect(calls[0]!.body).toMatchObject({
      client_id: 'Iv1.abc',
      code: 'code',
      code_verifier: 'verifier',
      redirect_uri: app.redirectUri,
    })
    answer = { status: 200, body: { error: 'bad_verification_code' } }
    await expect(connect.exchangeCode(app, 'code', 'verifier')).rejects.toMatchObject({
      code: 'GIT_PROVIDER_FAILED',
    })
  })
})
