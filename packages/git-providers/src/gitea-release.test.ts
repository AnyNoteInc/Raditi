import type { RepoRef, SecretStore } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { GITEA_SECRET_MAX_BYTES } from './gitea-client.ts'
import { GITEA_ORG_OWNER_SECRET_PATH, giteaOrgOwnerToken } from './gitea-org-owner.ts'
import { createGiteaProvider } from './gitea.ts'
import { fakeGitea, type GiteaRoute } from './testing/fake-gitea.ts'
import {
  giteaReleaseRecorded as recorded,
  RECORDED_CREATED_TAG_COMMIT,
  RECORDED_TAG_COMMIT,
  RECORDED_TAG_OBJECT,
} from './testing/gitea-release-recorded.ts'
import { giteaRecorded } from './testing/gitea-recorded.ts'

const BASE = 'https://gitea.example.test'
const BOT_TOKEN = 'synthetic-bot-token'
const OWNER_TOKEN = 'synthetic-owner-token'
const ref: RepoRef = { provider: 'gitea', owner: 'sites', name: 'demo' }
const REPO = '/api/v1/repos/sites/demo'
const failed = { code: 'GIT_PROVIDER_FAILED', httpStatus: 502 }
const notConfigured = { code: 'GIT_PROVIDER_NOT_CONFIGURED', httpStatus: 503 }

function gitea(
  route: GiteaRoute,
  ownerToken: (() => Promise<string>) | null = async () => OWNER_TOKEN,
) {
  const fake = fakeGitea(BASE, route)
  const provider = createGiteaProvider(
    { baseUrl: BASE, token: BOT_TOKEN },
    { fetch: fake.fetch, ...(ownerToken ? { ownerToken } : {}) },
  )
  return { ...fake, provider }
}
/** Answers in order; a request beyond them fails the test. */
const answers =
  (...list: Awaited<ReturnType<GiteaRoute>>[]): GiteaRoute =>
  () =>
    list.shift() ?? new Error('Unexpected request')
const quiet = (error: unknown, ...values: string[]) => {
  for (const value of [BOT_TOKEN, OWNER_TOKEN, ...values])
    expect(String((error as Error).message)).not.toContain(value)
}

describe('GiteaProvider.setActionsSecret and deleteActionsSecret', () => {
  it('writes a secret of the repository as an owner of the organization, never as the bot', async () => {
    const { provider, calls } = gitea(answers(recorded.secretCreated, recorded.secretUpdated))
    await provider.setActionsSecret(ref, 'RADITI_DEPLOY_WRAP', 'synthetic-wrap-1')
    await provider.setActionsSecret(ref, 'RADITI_DEPLOY_WRAP', 'synthetic-wrap-2')
    expect(calls).toEqual(
      ['synthetic-wrap-1', 'synthetic-wrap-2'].map((data) => ({
        method: 'PUT',
        path: `${REPO}/actions/secrets/RADITI_DEPLOY_WRAP`,
        authorization: `token ${OWNER_TOKEN}`,
        body: { data },
        redirect: 'manual',
        hasTimeout: true,
      })),
    )
  })

  it('deletes it as the owner; a secret already gone counts as deleted', async () => {
    const { provider, calls } = gitea(answers(recorded.secretDeleted, recorded.secretMissing))
    await provider.deleteActionsSecret(ref, 'RADITI_DEPLOY_WRAP')
    await provider.deleteActionsSecret(ref, 'RADITI_DEPLOY_WRAP')
    expect(calls.map((call) => [call.method, call.path, call.authorization])).toEqual([
      ['DELETE', `${REPO}/actions/secrets/RADITI_DEPLOY_WRAP`, `token ${OWNER_TOKEN}`],
      ['DELETE', `${REPO}/actions/secrets/RADITI_DEPLOY_WRAP`, `token ${OWNER_TOKEN}`],
    ])
  })

  it.each([
    ['an account that is not an owner (403)', recorded.secretNotOwner, { reason: 'forbidden' }],
    ['a missing repository (404)', recorded.secretRepositoryMissing, { reason: 'not_found' }],
    ['a refused token (401)', giteaRecorded.repositoryBadToken, { reason: 'unauthorized' }],
    ['a refused value (400)', recorded.secretTooLong, { reason: 'invalid' }],
    ['a redirect', giteaRecorded.repositoryMoved, undefined],
    ['a server error', { status: 500, body: '{"message":"boom"}' }, undefined],
  ])('fails a write refused by %s without quoting the value', async (_, answer, details) => {
    const { provider, calls } = gitea(answers(answer))
    const error = await provider
      .setActionsSecret(ref, 'RADITI_DEPLOY_WRAP', 'synthetic-wrap-value')
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ ...failed, details })
    quiet(error, 'synthetic-wrap-value', 'boom')
    expect(calls).toHaveLength(1)
  })

  it('fails a deletion Gitea did not confirm', async () => {
    const { provider } = gitea(answers(recorded.secretNotOwner))
    await expect(provider.deleteActionsSecret(ref, 'RADITI_DEPLOY_WRAP')).rejects.toMatchObject({
      ...failed,
      details: { reason: 'forbidden' },
    })
  })

  it.each([
    ['a lower-case name (Gitea would store another)', 'raditi_deploy_wrap', 'x'],
    ['a name of Gitea itself', 'GITEA_TOKEN', 'x'],
    ['a name of GitHub', 'GITHUB_TOKEN', 'x'],
    ['a path', 'A/../B', 'x'],
    ['an empty value', 'RADITI_DEPLOY_WRAP', ''],
    [
      'a value over the limit of Gitea',
      'RADITI_DEPLOY_WRAP',
      'x'.repeat(GITEA_SECRET_MAX_BYTES + 1),
    ],
  ])('refuses %s before any request', async (_, name, value) => {
    const { provider, calls } = gitea(answers())
    await expect(provider.setActionsSecret(ref, name, value)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(calls).toEqual([])
  })

  it('takes a value of exactly the limit of Gitea', async () => {
    const { provider } = gitea(answers(recorded.secretCreated))
    await provider.setActionsSecret(ref, 'AT_LIMIT', 'x'.repeat(GITEA_SECRET_MAX_BYTES))
  })

  it('makes no call without the token of an owner', async () => {
    const { provider, calls } = gitea(answers(), null)
    await expect(provider.setActionsSecret(ref, 'RADITI_DEPLOY_WRAP', 'x')).rejects.toMatchObject(
      notConfigured,
    )
    await expect(provider.deleteActionsSecret(ref, 'RADITI_DEPLOY_WRAP')).rejects.toMatchObject(
      notConfigured,
    )
    expect(calls).toEqual([])
  })

  it('asks for the token of the owner on every call', async () => {
    const ownerToken = vi.fn(async () => OWNER_TOKEN)
    const { provider } = gitea(answers(recorded.secretCreated, recorded.secretDeleted), ownerToken)
    await provider.setActionsSecret(ref, 'RADITI_DEPLOY_WRAP', 'x')
    await provider.deleteActionsSecret(ref, 'RADITI_DEPLOY_WRAP')
    expect(ownerToken).toHaveBeenCalledTimes(2)
  })
})

describe('GiteaProvider.protectTags', () => {
  /** GET /token and the list of rules answer from state; anything else goes to `extra`. */
  const route = (state: { rules: unknown[] }, extra: GiteaRoute = () => new Error('unexpected')) =>
    ((call) => {
      if (call.method === 'GET' && call.path === '/api/v1/token') return recorded.ownerToken
      if (call.method === 'GET' && call.path === `${REPO}/tag_protections`)
        return { status: 200, body: JSON.stringify(state.rules) }
      return extra(call)
    }) satisfies GiteaRoute
  const ofOwner = JSON.parse(recorded.tagProtectionOfOwner.body) as Record<string, unknown>
  // Recorded naming another member: the rule a protection of the owner replaces.
  const ofWriter = JSON.parse(recorded.tagProtectionCreated.body) as Record<string, unknown>
  const owners = { name_pattern: 'v*', whitelist_usernames: ['stand-owner'], whitelist_teams: [] }

  it('creates the one rule of the pattern, naming the account of the owner token', async () => {
    const state = { rules: [] as unknown[] }
    const { provider, calls } = gitea(
      route(state, () => {
        state.rules.push(ofOwner)
        return recorded.tagProtectionOfOwner
      }),
    )
    await provider.protectTags(ref, 'v*')
    expect(calls.map((call) => [call.method, call.path, call.authorization, call.body])).toEqual([
      ['GET', '/api/v1/token', `token ${OWNER_TOKEN}`, undefined],
      ['GET', `${REPO}/tag_protections`, `token ${OWNER_TOKEN}`, undefined],
      ['POST', `${REPO}/tag_protections`, `token ${OWNER_TOKEN}`, owners],
    ])
  })

  it('leaves a rule that is already the one asked for', async () => {
    const { provider, calls } = gitea(route({ rules: [ofOwner] }))
    await provider.protectTags(ref, 'v*')
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET'])
  })

  it('narrows a rule of the pattern that allows someone else, the bot included', async () => {
    for (const rule of [ofWriter, { ...ofWriter, whitelist_usernames: ['raditi-bot'] }]) {
      const { provider, calls } = gitea(
        route({ rules: [rule] }, () => ({ status: 200, body: JSON.stringify(ofOwner) })),
      )
      await provider.protectTags(ref, 'v*')
      expect(calls.at(-1)).toMatchObject({
        method: 'PATCH',
        path: `${REPO}/tag_protections/1`,
        authorization: `token ${OWNER_TOKEN}`,
        body: owners,
      })
    }
  })

  it('reads again after a refused creation: another call made the rule meanwhile', async () => {
    const state = { rules: [] as unknown[] }
    const { provider, calls } = gitea(
      route(state, () => {
        state.rules.push(ofOwner)
        return recorded.tagProtectionExists
      }),
    )
    await provider.protectTags(ref, 'v*')
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST', 'GET'])
  })

  it('fails when the refusal stays: the account may not protect tags', async () => {
    const { provider, calls } = gitea(route({ rules: [] }, () => recorded.tagProtectionNotAdmin))
    await expect(provider.protectTags(ref, 'v*')).rejects.toMatchObject({
      ...failed,
      details: { reason: 'forbidden' },
    })
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST', 'GET', 'POST'])
  })

  it('fails as final on a list it cannot read, a refused token and a refused rule', async () => {
    const forbidden = gitea(answers(recorded.ownerToken, recorded.tagProtectionNotAdmin))
    await expect(forbidden.provider.protectTags(ref, 'v*')).rejects.toMatchObject({
      details: { reason: 'forbidden' },
    })
    const unknownToken = gitea(answers(giteaRecorded.repositoryBadToken))
    await expect(unknownToken.provider.protectTags(ref, 'v*')).rejects.toMatchObject({
      ...failed,
      details: { reason: 'unauthorized' },
    })
    // Gitea refuses the rule itself (recorded with an account it does not know): no retry cures it.
    const invalid = gitea(route({ rules: [] }, () => recorded.tagProtectionUnknownUser))
    const error = await invalid.provider.protectTags(ref, 'x*').catch((e: unknown) => e)
    expect(error).toMatchObject({ ...failed, details: { reason: 'invalid' } })
    quiet(error, 'nobody-here', 'exist')
  })

  it.each(['/v.*/', '', 'v* x', 'v/*'])(
    'refuses the pattern %j before any request',
    async (pattern) => {
      const { provider, calls } = gitea(answers())
      await expect(provider.protectTags(ref, pattern)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
      expect(calls).toEqual([])
    },
  )

  it('makes no call without the token of an owner', async () => {
    const { provider, calls } = gitea(answers(), null)
    await expect(provider.protectTags(ref, 'v*')).rejects.toMatchObject(notConfigured)
    expect(calls).toEqual([])
  })
})

describe('GiteaProvider.createTag', () => {
  const tag = {
    name: 'v1.0.0',
    commitSha: RECORDED_CREATED_TAG_COMMIT,
    objectSha: RECORDED_CREATED_TAG_COMMIT,
  }

  it('makes a lightweight tag through the API as the owner, never as the bot', async () => {
    const { provider, calls } = gitea(answers(recorded.tagCreated))
    await expect(provider.createTag(ref, 'v1.0.0', RECORDED_CREATED_TAG_COMMIT)).resolves.toEqual(
      tag,
    )
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `${REPO}/tags`,
        authorization: `token ${OWNER_TOKEN}`,
        // No message: one would make an annotated tag.
        body: { tag_name: 'v1.0.0', target: RECORDED_CREATED_TAG_COMMIT },
        redirect: 'manual',
        hasTimeout: true,
      },
    ])
  })

  it('answers a taken name with the tag as it is, without moving it', async () => {
    // The name is taken on another commit: the recorded v1.0.0 of the first recording.
    const { provider, calls } = gitea(answers(recorded.tagExists, recorded.tagLightweight))
    await expect(provider.createTag(ref, 'v1.0.0', RECORDED_CREATED_TAG_COMMIT)).resolves.toEqual({
      name: 'v1.0.0',
      commitSha: RECORDED_TAG_COMMIT,
      objectSha: RECORDED_TAG_COMMIT,
    })
    expect(calls.map((call) => [call.method, call.path, call.authorization])).toEqual([
      ['POST', `${REPO}/tags`, `token ${OWNER_TOKEN}`],
      ['GET', `${REPO}/tags/v1.0.0`, `token ${BOT_TOKEN}`],
    ])
  })

  it('fails when a taken name is not shown afterwards', async () => {
    const { provider } = gitea(answers(recorded.tagExists, recorded.tagMissing))
    await expect(
      provider.createTag(ref, 'v1.0.0', RECORDED_CREATED_TAG_COMMIT),
    ).rejects.toMatchObject(failed)
  })

  it.each([
    [
      'a protection naming another account (422)',
      recorded.tagCreationProtected,
      { reason: 'forbidden' },
    ],
    ['a commit the repository lacks (404)', recorded.tagTargetMissing, { reason: 'not_found' }],
    ['a refused token (401)', giteaRecorded.repositoryBadToken, { reason: 'unauthorized' }],
    ['a server error', { status: 500, body: '{"message":"boom"}' }, undefined],
  ])('fails on %s', async (_, answer, details) => {
    const { provider, calls } = gitea(answers(answer))
    const error = await provider
      .createTag(ref, 'v1.0.0', RECORDED_CREATED_TAG_COMMIT)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ ...failed, details })
    quiet(error, 'protected', 'boom', 'target')
    expect(calls).toHaveLength(1)
  })

  it('fails on a tag of another name, commit or kind', async () => {
    for (const body of [
      recorded.tagCreated.body.replace('"name":"v1.0.0"', '"name":"v1.0.1"'),
      recorded.tagCreated.body.replace(
        `"sha":"${RECORDED_CREATED_TAG_COMMIT}"`,
        `"sha":"${RECORDED_TAG_COMMIT}"`,
      ),
      recorded.tagCreated.body.replace(
        `"id":"${RECORDED_CREATED_TAG_COMMIT}"`,
        `"id":"${RECORDED_TAG_OBJECT}"`,
      ),
    ]) {
      const { provider } = gitea(answers({ status: 201, body }))
      await expect(
        provider.createTag(ref, 'v1.0.0', RECORDED_CREATED_TAG_COMMIT),
      ).rejects.toMatchObject(failed)
    }
  })

  it.each([
    ['a tag that climbs', '../v1', RECORDED_CREATED_TAG_COMMIT],
    ['a tag with a space', 'v 1', RECORDED_CREATED_TAG_COMMIT],
    ['a branch as the target', 'v1.0.0', 'main'],
    ['a short target', 'v1.0.0', RECORDED_CREATED_TAG_COMMIT.slice(0, 12)],
  ])('refuses %s before any request', async (_, name, target) => {
    const { provider, calls } = gitea(answers())
    await expect(provider.createTag(ref, name, target)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(calls).toEqual([])
  })

  it('makes no call without the token of an owner', async () => {
    const { provider, calls } = gitea(answers(), null)
    await expect(
      provider.createTag(ref, 'v1.0.0', RECORDED_CREATED_TAG_COMMIT),
    ).rejects.toMatchObject(notConfigured)
    expect(calls).toEqual([])
  })
})

describe('GiteaProvider.getTag', () => {
  it('reads a lightweight tag with the bot token: the ref names the commit', async () => {
    const { provider, calls } = gitea(answers(recorded.tagLightweight))
    await expect(provider.getTag(ref, 'v1.0.0')).resolves.toEqual({
      name: 'v1.0.0',
      commitSha: RECORDED_TAG_COMMIT,
      objectSha: RECORDED_TAG_COMMIT,
    })
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: `${REPO}/tags/v1.0.0`,
      authorization: `token ${BOT_TOKEN}`,
    })
  })

  it('tells an annotated tag by its object', async () => {
    const { provider } = gitea(answers(recorded.tagAnnotated))
    await expect(provider.getTag(ref, 'v1.1.0')).resolves.toEqual({
      name: 'v1.1.0',
      commitSha: RECORDED_TAG_COMMIT,
      objectSha: RECORDED_TAG_OBJECT,
    })
  })

  it('answers null for a missing tag and fails on an answer about another one', async () => {
    await expect(
      gitea(answers(recorded.tagMissing)).provider.getTag(ref, 'v7.0.0'),
    ).resolves.toBeNull()
    await expect(
      gitea(answers(recorded.tagLightweight)).provider.getTag(ref, 'v2.0.0'),
    ).rejects.toMatchObject(failed)
  })

  it.each([
    ['a refused token (401)', giteaRecorded.repositoryBadToken, 'unauthorized'],
    ['a bot without the code unit (403)', recorded.tagProtectionNotAdmin, 'forbidden'],
  ])('fails as final on %s: no retry of a poll cures it', async (_, answer, reason) => {
    const { provider } = gitea(answers(answer))
    await expect(provider.getTag(ref, 'v1.0.0')).rejects.toMatchObject({
      ...failed,
      details: { reason },
    })
  })

  it.each(['', '../main', 'v1/../x', 'v 1', '-v1'])(
    'refuses the tag %j before any request',
    async (name) => {
      const { provider, calls } = gitea(answers())
      await expect(provider.getTag(ref, name)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(calls).toEqual([])
    },
  )
})

describe('GiteaProvider.listWorkflowRuns and getWorkflowRun', () => {
  const tagRun = JSON.parse(recorded.run.body) as { id: number; html_url: string }

  it('lists the runs of a commit by its event, with the workflow, the ref and the attempt', async () => {
    const { provider, calls } = gitea(answers(recorded.runsOfTag))
    const runs = await provider.listWorkflowRuns(ref, {
      headSha: RECORDED_TAG_COMMIT,
      event: 'push',
    })
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: `${REPO}/actions/runs?head_sha=${RECORDED_TAG_COMMIT}&event=push&page=1&limit=50`,
      authorization: `token ${BOT_TOKEN}`,
    })
    expect(runs.map((run) => [run.workflowFile, run.ref, run.event, run.headBranch])).toEqual([
      ['probe.yml', 'refs/tags/v1.1.0', 'push', null],
      ['probe.yml', 'refs/tags/v1.0.0', 'push', null],
    ])
    expect(runs[0]).toEqual({
      id: String(tagRun.id),
      name: 'probe.yml',
      headSha: RECORDED_TAG_COMMIT,
      status: 'queued',
      conclusion: null,
      url: tagRun.html_url,
      workflowFile: 'probe.yml',
      // The REST run does not say where the file lives: only a webhook does.
      workflowPath: null,
      ref: 'refs/tags/v1.1.0',
      event: 'push',
      headBranch: null,
      runAttempt: 1,
    })
  })

  it('reads every page the count of Gitea promises, and no more', async () => {
    const page = (ids: number[], total: number) => ({
      status: 200,
      body: JSON.stringify({
        total_count: total,
        workflow_runs: ids.map((id) => ({
          id,
          html_url: `${BASE}/sites/demo/actions/runs/${id}`,
          path: 'deploy.yml@refs/tags/v1.0.0',
          event: 'push',
          run_attempt: 1,
          head_sha: RECORDED_TAG_COMMIT,
          status: 'completed',
          conclusion: 'success',
        })),
      }),
    })
    const first = Array.from({ length: 50 }, (_, i) => 60 - i)
    const { provider, calls } = gitea(answers(page(first, 52), page([10, 9], 52)))
    const runs = await provider.listWorkflowRuns(ref, { event: 'push' })
    expect(runs).toHaveLength(52)
    expect(calls.map((call) => new URLSearchParams(call.path.split('?')[1]).get('page'))).toEqual([
      '1',
      '2',
    ])
    expect(runs[0]).toMatchObject({ status: 'completed', conclusion: 'success' })
  })

  it('reads again from the first page when a run comes in the middle of the read', async () => {
    const page = (ids: number[], total: number) => ({
      status: 200,
      body: JSON.stringify({
        total_count: total,
        workflow_runs: ids.map((id) => ({
          id,
          html_url: `${BASE}/sites/demo/actions/runs/${id}`,
          head_sha: RECORDED_TAG_COMMIT,
          status: 'queued',
        })),
      }),
    })
    const ids = (from: number) => Array.from({ length: 50 }, (_, i) => from - i)
    // Run 61 starts after page 1 was read: page 2 repeats run 11 and run 61 would be missed.
    const { provider, calls } = gitea(
      answers(page(ids(60), 52), page([11, 10, 9], 53), page(ids(61), 53), page([11, 10, 9], 53)),
    )
    const runs = await provider.listWorkflowRuns(ref, {})
    expect(runs.map((run) => Number(run.id))).toEqual([...ids(61), 11, 10, 9])
    expect(calls.map((call) => new URLSearchParams(call.path.split('?')[1]).get('page'))).toEqual([
      '1',
      '2',
      '1',
      '2',
    ])
  })

  it('counts a repeated row once and fails when runs keep coming', async () => {
    const run = (id: number) => ({
      id,
      html_url: `${BASE}/sites/demo/actions/runs/${id}`,
      head_sha: RECORDED_TAG_COMMIT,
      status: 'queued',
    })
    const page = (ids: number[], total: number) => ({
      status: 200,
      body: JSON.stringify({ total_count: total, workflow_runs: ids.map(run) }),
    })
    const repeated = gitea(answers(page([3, 2], 3), page([2, 1], 3)))
    const runs = await repeated.provider.listWorkflowRuns(ref, {})
    expect(runs.map((found) => found.id)).toEqual(['3', '2', '1'])
    let total = 100
    const busy = gitea(() => page([total], total++))
    await expect(busy.provider.listWorkflowRuns(ref, {})).rejects.toMatchObject(failed)
    expect(busy.calls).toHaveLength(4)
  })

  it.each([
    ['a refused token (401)', giteaRecorded.repositoryBadToken, 'unauthorized'],
    ['a bot without the actions unit (403)', recorded.tagProtectionNotAdmin, 'forbidden'],
    ['a missing repository (404)', giteaRecorded.repositoryMissing, 'not_found'],
  ])('fails a poll as final on %s', async (_, answer, reason) => {
    const listed = gitea(answers(answer))
    await expect(listed.provider.listWorkflowRuns(ref, {})).rejects.toMatchObject({
      ...failed,
      details: { reason },
    })
    if (answer.status === 404) return
    const one = gitea(answers(answer))
    await expect(one.provider.getWorkflowRun(ref, '2')).rejects.toMatchObject({
      ...failed,
      details: { reason },
    })
  })

  it('leaves a poll that got no usable answer open to a retry', async () => {
    const { provider } = gitea(answers({ status: 502, body: 'bad gateway' }))
    await expect(provider.listWorkflowRuns(ref, {})).rejects.toMatchObject({
      ...failed,
      details: undefined,
    })
  })

  it('refuses to read past ten pages', async () => {
    const full = {
      status: 200,
      body: JSON.stringify({
        total_count: 10_000,
        workflow_runs: Array.from({ length: 50 }, (_, i) => ({
          id: i + 1,
          html_url: `${BASE}/sites/demo/actions/runs/${i + 1}`,
          head_sha: RECORDED_TAG_COMMIT,
          status: 'queued',
        })),
      }),
    }
    const { provider, calls } = gitea(() => full)
    await expect(provider.listWorkflowRuns(ref, {})).rejects.toMatchObject(failed)
    expect(calls).toHaveLength(10)
  })

  it('reads one run, and null for a missing one', async () => {
    const { provider, calls } = gitea(answers(recorded.run, recorded.runMissing))
    await expect(provider.getWorkflowRun(ref, String(tagRun.id))).resolves.toMatchObject({
      id: String(tagRun.id),
      ref: 'refs/tags/v1.1.0',
      event: 'push',
    })
    await expect(provider.getWorkflowRun(ref, '999999')).resolves.toBeNull()
    expect(calls.map((call) => call.path)).toEqual([
      `${REPO}/actions/runs/${tagRun.id}`,
      `${REPO}/actions/runs/999999`,
    ])
  })

  it('reads the dispatched runs with their branch', async () => {
    const { provider } = gitea(answers(recorded.runsDispatched))
    const runs = await provider.listWorkflowRuns(ref, { event: 'workflow_dispatch' })
    expect(runs.map((run) => [run.ref, run.event, run.headBranch])).toEqual([
      ['refs/tags/v1.0.0', 'workflow_dispatch', null],
      ['refs/heads/main', 'workflow_dispatch', 'main'],
    ])
  })

  it.each([
    ['a short sha', () => ({ headSha: 'abc' })],
    ['an event with a query', () => ({ event: 'push&status=x' })],
    ['a full ref as the branch', () => ({ branch: 'refs/heads/main' })],
  ])('refuses %s before any request', async (_, filter) => {
    const { provider, calls } = gitea(answers())
    await expect(provider.listWorkflowRuns(ref, filter())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(calls).toEqual([])
  })

  it.each(['', '0', '-1', '1.5', '12a', '9'.repeat(16)])('refuses the run id %j', async (id) => {
    const { provider, calls } = gitea(answers())
    await expect(provider.getWorkflowRun(ref, id)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(calls).toEqual([])
  })

  it('fails on an answer about another run', async () => {
    const { provider } = gitea(answers(recorded.run))
    await expect(provider.getWorkflowRun(ref, '77')).rejects.toMatchObject(failed)
  })
})

describe('GiteaProvider.dispatchWorkflow', () => {
  it('starts a workflow of the repository with the bot token and names the run', async () => {
    const { provider, calls } = gitea(answers(recorded.dispatched))
    await expect(
      provider.dispatchWorkflow(ref, {
        workflow: 'probe.yml',
        ref: 'main',
        inputs: { release: 'synthetic' },
      }),
    ).resolves.toEqual({ runId: '3' })
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `${REPO}/actions/workflows/probe.yml/dispatches?return_run_details=true`,
        authorization: `token ${BOT_TOKEN}`,
        body: { ref: 'main', inputs: { release: 'synthetic' } },
        redirect: 'manual',
        hasTimeout: true,
      },
    ])
  })

  it('starts a scoped workflow by the id of its source repository', async () => {
    const platform = giteaRecorded.repository.body.replace('"id":1,', '"id":42,')
    const { provider, calls } = gitea(answers({ status: 200, body: platform }, recorded.dispatched))
    await provider.dispatchWorkflow(ref, {
      workflow: 'deploy.yml',
      ref: 'refs/tags/v1.2.0',
      source: { provider: 'gitea', owner: 'sites', name: 'demo' },
    })
    expect(calls.map((call) => call.path)).toEqual([
      '/api/v1/repos/sites/demo',
      `${REPO}/actions/workflows/deploy.yml/dispatches?return_run_details=true&scoped_workflow_source_repo_id=42`,
    ])
    expect(calls[1]?.body).toEqual({ ref: 'refs/tags/v1.2.0', inputs: {} })
  })

  it.each([
    ['a workflow without the trigger (422)', recorded.dispatchNoTrigger, 'no_trigger'],
    ['a missing workflow (404)', recorded.dispatchMissingWorkflow, 'not_found'],
    ['a missing ref (404)', recorded.dispatchMissingRef, 'not_found'],
    ['a source that does not apply (404)', recorded.dispatchScopedSourceMissing, 'not_found'],
  ])('answers NOT_SUPPORTED to %s', async (_, answer, reason) => {
    const { provider } = gitea(answers(answer))
    const error = await provider
      .dispatchWorkflow(ref, { workflow: 'probe.yml', ref: 'main' })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'NOT_SUPPORTED', httpStatus: 501, details: { reason } })
    quiet(error, 'workflow_dispatch', 'exist')
  })

  it('answers NOT_SUPPORTED when the source is not visible, before any dispatch', async () => {
    const { provider, calls } = gitea(answers(giteaRecorded.repositoryMissing))
    await expect(
      provider.dispatchWorkflow(ref, {
        workflow: 'deploy.yml',
        ref: 'main',
        source: { provider: 'gitea', owner: 'platform', name: 'ci' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    expect(calls).toHaveLength(1)
  })

  it('fails a refusal of the account rather than calling it unsupported', async () => {
    const { provider } = gitea(answers(recorded.tagProtectionNotAdmin))
    await expect(
      provider.dispatchWorkflow(ref, { workflow: 'probe.yml', ref: 'main' }),
    ).rejects.toMatchObject({ ...failed, details: { reason: 'forbidden' } })
  })

  it.each([
    ['a file that is no workflow', { workflow: 'probe.sh', ref: 'main' }],
    ['a path as the file', { workflow: '../probe.yml', ref: 'main' }],
    ['a ref that climbs', { workflow: 'probe.yml', ref: 'refs/heads/../x' }],
    ['a ref of another kind', { workflow: 'probe.yml', ref: 'refs/pull/1/head' }],
    ['an input name with a space', { workflow: 'probe.yml', ref: 'main', inputs: { 'a b': 'x' } }],
    [
      'eleven inputs',
      {
        workflow: 'probe.yml',
        ref: 'main',
        inputs: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`i${i}`, 'x'])),
      },
    ],
    ['a long input', { workflow: 'probe.yml', ref: 'main', inputs: { a: 'x'.repeat(1025) } }],
  ])('refuses %s before any request', async (_, dispatch) => {
    const { provider, calls } = gitea(answers())
    await expect(provider.dispatchWorkflow(ref, dispatch)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(calls).toEqual([])
  })
})

describe('giteaOrgOwnerToken', () => {
  const store = (data: Record<string, string> | null) => {
    const kvRead = vi.fn(async () => (data ? { data, version: 3 } : null))
    return { kvRead, secrets: { kvRead } as Pick<SecretStore, 'kvRead'> }
  }

  it('reads the token of the owner from its one Vault path on every call', async () => {
    const { kvRead, secrets } = store({ v: '1', token: OWNER_TOKEN })
    const read = giteaOrgOwnerToken(secrets)
    await expect(read()).resolves.toBe(OWNER_TOKEN)
    await expect(read()).resolves.toBe(OWNER_TOKEN)
    expect(kvRead.mock.calls).toEqual([
      [GITEA_ORG_OWNER_SECRET_PATH],
      [GITEA_ORG_OWNER_SECRET_PATH],
    ])
    expect(GITEA_ORG_OWNER_SECRET_PATH).toBe('kv/platform/gitea-org-owner')
  })

  it.each([
    ['no secret', null],
    ['another version of the shape', { v: '2', token: OWNER_TOKEN }],
    ['a token with a space', { v: '1', token: 'two words' }],
    ['a field more', { v: '1', token: OWNER_TOKEN, login: 'stand-owner' }],
  ])('fails as not configured on %s, quoting nothing', async (_, data) => {
    const error = await giteaOrgOwnerToken(store(data).secrets)().catch((e: unknown) => e)
    expect(error).toMatchObject(notConfigured)
    quiet(error, 'two words')
  })

  it('gives the provider the token it reads', async () => {
    const { secrets } = store({ v: '1', token: OWNER_TOKEN })
    const { provider, calls } = gitea(answers(recorded.secretCreated), giteaOrgOwnerToken(secrets))
    await provider.setActionsSecret(ref, 'RADITI_DEPLOY_WRAP', 'x')
    expect(calls[0]?.authorization).toBe(`token ${OWNER_TOKEN}`)
  })
})
