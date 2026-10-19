import { createHmac } from 'node:crypto'
import type { GitProviderKind } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { createGitProvider } from './create-git-provider.ts'
import {
  giteaReleaseWebhooksRecorded,
  RECORDED_TAG_COMMIT,
  RECORDED_TAG_OBJECT,
} from './testing/gitea-release-recorded.ts'
import { giteaWebhooksRecorded, type RecordedWebhook } from './testing/gitea-webhooks-recorded.ts'

const secret = 'webhook-secret'
const head = '3f786850e387550fdab836ed7e6dc881de23001b'
const base = '89e6c98d92887913cadf06b2adb97f26cde4849b'
const zero = '0'.repeat(40)
const config = { baseUrl: 'http://localhost:3300', token: 't' }
const provider = (kind: GitProviderKind) => createGitProvider(kind, config)
const hmac = (key: string, body: string) =>
  createHmac('sha256', key).update(body, 'utf8').digest('hex')

/** Headers a provider sends for `body`, signed with `key`. */
function signed(kind: GitProviderKind, event: string, body: string, key = secret): Headers {
  switch (kind) {
    case 'gitea':
      return new Headers({ 'X-Gitea-Event': event, 'X-Gitea-Signature': hmac(key, body) })
    case 'github':
      return new Headers({
        'X-GitHub-Event': event,
        'X-Hub-Signature-256': `sha256=${hmac(key, body)}`,
      })
    case 'gitlab':
      return new Headers({ 'X-Gitlab-Event': event, 'X-Gitlab-Token': key })
  }
}

const parse = (kind: GitProviderKind, event: string, payload: unknown, key = secret) => {
  const body = JSON.stringify(payload)
  return provider(kind).parseWebhook(signed(kind, event, body, key), body, secret)
}

const repository = (owner: string) => ({
  id: 1,
  name: 'shop',
  full_name: `${owner}/shop`,
  owner: { id: 2, login: owner, username: owner },
})

const pullRequestPayload = (patch: Record<string, unknown> = {}) => ({
  action: 'opened',
  number: 7,
  pull_request: {
    id: 11,
    number: 7,
    html_url: 'http://localhost:3300/sites/shop/pulls/7',
    state: 'open',
    merged: false,
    head: { ref: 'agent/task-1', sha: head },
    base: { ref: 'main', sha: base },
    ...patch,
  },
  repository: repository('sites'),
})

const workflowRunPayload = (run: Record<string, unknown> = {}) => ({
  action: 'completed',
  workflow: { id: 3, name: 'deploy' },
  workflow_run: {
    id: 42,
    display_title: 'Merge pull request #7',
    head_sha: head,
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    html_url: 'http://localhost:3300/sites/shop/actions/runs/42',
    ...run,
  },
  repository: repository('sites'),
})

const pushPayload = (patch: Record<string, unknown> = {}) => ({
  ref: 'refs/heads/main',
  before: base,
  after: head,
  commits: [],
  repository: repository('sites'),
  ...patch,
})

describe.each(['gitea', 'github'] as const)('%s parseWebhook', (kind) => {
  const repo = { provider: kind, owner: 'sites', name: 'shop' }

  it('parses a signed pull_request event', () => {
    expect(parse(kind, 'pull_request', pullRequestPayload())).toEqual({
      kind: 'pull_request',
      repo,
      pullRequest: {
        number: 7,
        url: 'http://localhost:3300/sites/shop/pulls/7',
        headBranch: 'agent/task-1',
        headSha: head,
        baseBranch: 'main',
        state: 'open',
      },
    })
  })

  it('tells merged from closed pull requests', () => {
    const merged = parse(
      kind,
      'pull_request',
      pullRequestPayload({ state: 'closed', merged: true }),
    )
    const closed = parse(kind, 'pull_request', pullRequestPayload({ state: 'closed' }))
    expect(merged).toMatchObject({ pullRequest: { state: 'merged' } })
    expect(closed).toMatchObject({ pullRequest: { state: 'closed' } })
  })

  it('parses a signed workflow_run event', () => {
    expect(parse(kind, 'workflow_run', workflowRunPayload())).toEqual({
      kind: 'workflow_run',
      repo,
      run: {
        id: '42',
        name: 'deploy',
        headSha: head,
        status: 'completed',
        conclusion: 'success',
        url: 'http://localhost:3300/sites/shop/actions/runs/42',
        workflowFile: null,
        workflowPath: null,
        ref: null,
        event: null,
        headBranch: 'main',
        runAttempt: null,
      },
    })
  })

  it('reads the workflow, its ref, the event and the attempt of a run', () => {
    const payload = workflowRunPayload({
      path: 'deploy.yml@refs/tags/v1.2.0',
      event: 'push',
      run_attempt: 2,
      head_branch: undefined,
    })
    expect(
      parse(kind, 'workflow_run', {
        ...payload,
        workflow: { name: 'deploy', path: '.gitea/scoped_workflows/deploy.yml' },
      }),
    ).toMatchObject({
      run: {
        workflowFile: 'deploy.yml',
        workflowPath: '.gitea/scoped_workflows/deploy.yml',
        ref: 'refs/tags/v1.2.0',
        event: 'push',
        headBranch: null,
        runAttempt: 2,
      },
    })
    // A path without a ref is a file alone; a ref that is not one is dropped, not guessed.
    expect(
      parse(kind, 'workflow_run', workflowRunPayload({ path: '.github/workflows/deploy.yml' })),
    ).toMatchObject({ run: { workflowFile: '.github/workflows/deploy.yml', ref: null } })
    expect(
      parse(kind, 'workflow_run', workflowRunPayload({ path: 'deploy.yml@main' })),
    ).toMatchObject({ run: { workflowFile: 'deploy.yml', ref: null } })
    expect(parse(kind, 'workflow_run', workflowRunPayload({ run_attempt: 0 }))).toBeNull()
  })

  it.each([
    [{ status: 'in_progress', conclusion: null }, 'in_progress', null],
    [{ status: 'waiting', conclusion: '' }, 'queued', null],
    [{ status: 'requested' }, 'queued', null],
    [{ conclusion: 'failure' }, 'completed', 'failure'],
    [{ conclusion: 'cancelled' }, 'completed', 'cancelled'],
    [{ conclusion: 'skipped' }, 'completed', 'skipped'],
    [{ conclusion: 'timed_out' }, 'completed', 'failure'],
    [{ conclusion: 'something-new' }, 'completed', 'failure'],
    [{ conclusion: undefined }, 'completed', 'failure'],
  ])('maps the run state %j', (run, status, conclusion) => {
    expect(parse(kind, 'workflow_run', workflowRunPayload(run))).toMatchObject({
      run: { status, conclusion },
    })
  })

  it('parses a signed push to a branch, lower-casing the sha', () => {
    expect(parse(kind, 'push', pushPayload({ after: head.toUpperCase() }))).toEqual({
      kind: 'push',
      repo,
      branch: 'main',
      headSha: head,
    })
  })

  it('parses a pushed tag; ignores deletions of a tag or a branch', () => {
    expect(parse(kind, 'push', pushPayload({ ref: 'refs/tags/v1.2.0' }))).toEqual({
      kind: 'tag',
      repo,
      tag: 'v1.2.0',
      sha: head,
    })
    expect(parse(kind, 'push', pushPayload({ ref: 'refs/tags/v1', after: zero }))).toBeNull()
    expect(parse(kind, 'push', pushPayload({ ref: 'refs/tags/v1', deleted: true }))).toBeNull()
    expect(parse(kind, 'push', pushPayload({ after: zero }))).toBeNull()
    expect(parse(kind, 'push', pushPayload({ deleted: true }))).toBeNull()
    // Neither a branch nor a tag: notes, pull refs and the like are no event.
    expect(parse(kind, 'push', pushPayload({ ref: 'refs/notes/commits' }))).toBeNull()
    expect(parse(kind, 'push', pushPayload({ ref: 'refs/tags/' }))).toBeNull()
  })

  it('parses a signed workflow_job event with its steps', () => {
    const job = {
      action: 'completed',
      workflow_job: {
        id: 11,
        run_id: 42,
        name: 'deploy',
        head_sha: head,
        run_attempt: 1,
        status: 'completed',
        conclusion: 'failure',
        html_url: 'http://localhost:3300/sites/shop/actions/runs/42/jobs/11',
        steps: [
          { name: 'backup', number: 0, status: 'completed', conclusion: 'success' },
          { name: 'verify', number: 1, status: 'completed', conclusion: 'failure' },
          { name: 'rollback', number: 2, status: 'in_progress', conclusion: null },
        ],
      },
      repository: repository('sites'),
    }
    expect(parse(kind, 'workflow_job', job)).toEqual({
      kind: 'workflow_job',
      repo,
      job: {
        id: '11',
        runId: '42',
        name: 'deploy',
        headSha: head,
        headBranch: null,
        runAttempt: 1,
        status: 'completed',
        conclusion: 'failure',
        url: 'http://localhost:3300/sites/shop/actions/runs/42/jobs/11',
        steps: [
          { name: 'backup', status: 'completed', conclusion: 'success' },
          { name: 'verify', status: 'completed', conclusion: 'failure' },
          { name: 'rollback', status: 'in_progress', conclusion: null },
        ],
      },
    })
    const { steps: _, ...withoutSteps } = job.workflow_job
    expect(parse(kind, 'workflow_job', { ...job, workflow_job: withoutSteps })).toMatchObject({
      job: { steps: [] },
    })
    expect(parse(kind, 'workflow_job', { ...job, workflow_job: { id: 11 } })).toBeNull()
  })

  it('returns null for a bad, foreign or missing signature', () => {
    const body = JSON.stringify(pushPayload())
    const parseWith = (headers: Headers) => provider(kind).parseWebhook(headers, body, secret)
    expect(parse(kind, 'push', pushPayload(), 'other-secret')).toBeNull()
    expect(parseWith(signed(kind, 'push', `${body} `))).toBeNull()
    expect(parseWith(new Headers({ 'X-Gitea-Event': 'push', 'X-GitHub-Event': 'push' }))).toBeNull()
    expect(provider(kind).parseWebhook(signed(kind, 'push', body, ''), body, '')).toBeNull()
    const other = kind === 'gitea' ? 'github' : 'gitea'
    const foreign = signed(other, 'push', body)
    foreign.set(kind === 'gitea' ? 'X-Gitea-Event' : 'X-GitHub-Event', 'push')
    expect(parseWith(foreign)).toBeNull()
  })

  it('returns null for a signed but unusable body', () => {
    const raw = (body: string, event = 'push') =>
      provider(kind).parseWebhook(signed(kind, event, body), body, secret)
    expect(raw('{not json')).toBeNull()
    expect(raw('null')).toBeNull()
    expect(raw('[]')).toBeNull()
    expect(raw(JSON.stringify(pushPayload()), 'issues')).toBeNull()
    expect(raw(JSON.stringify(pushPayload()), '')).toBeNull()
    expect(raw(JSON.stringify(pushPayload({ after: 'not-a-sha' })))).toBeNull()
    expect(raw(JSON.stringify(pushPayload({ repository: { name: 'shop' } })))).toBeNull()
    expect(parse(kind, 'pull_request', pullRequestPayload({ head: { ref: 'x' } }))).toBeNull()
    expect(parse(kind, 'pull_request', pullRequestPayload({ html_url: 'javascript:x' }))).toBeNull()
    expect(parse(kind, 'workflow_run', pushPayload())).toBeNull()
  })

  it('never throws, whatever the input', () => {
    const p = provider(kind)
    expect(p.parseWebhook(new Headers(), '', '')).toBeNull()
    expect(p.parseWebhook(signed(kind, 'push', '\u0000'), '\u0000', secret)).toBeNull()
  })
})

describe('gitlab parseWebhook', () => {
  const project = {
    id: 5,
    name: 'shop',
    path_with_namespace: 'client/sites/shop',
    web_url: 'https://gitlab.com/client/sites/shop',
  }
  const repo = { provider: 'gitlab', owner: 'client/sites', name: 'shop' }

  const mergeRequest = (attrs: Record<string, unknown> = {}) => ({
    object_kind: 'merge_request',
    event_type: 'merge_request',
    project,
    object_attributes: {
      id: 99,
      iid: 3,
      url: 'https://gitlab.com/client/sites/shop/-/merge_requests/3',
      source_branch: 'agent/task-1',
      target_branch: 'main',
      state: 'opened',
      action: 'open',
      last_commit: { id: head },
      ...attrs,
    },
  })

  const pipeline = (attrs: Record<string, unknown> = {}) => ({
    object_kind: 'pipeline',
    project,
    object_attributes: {
      id: 31,
      iid: 3,
      name: null,
      ref: 'main',
      tag: false,
      sha: head,
      status: 'success',
      ...attrs,
    },
  })

  const push = (patch: Record<string, unknown> = {}) => ({
    object_kind: 'push',
    ref: 'refs/heads/main',
    before: base,
    after: head,
    checkout_sha: head,
    project,
    ...patch,
  })

  it('parses a merge request as a pull_request event', () => {
    expect(parse('gitlab', 'Merge Request Hook', mergeRequest())).toEqual({
      kind: 'pull_request',
      repo,
      pullRequest: {
        number: 3,
        url: 'https://gitlab.com/client/sites/shop/-/merge_requests/3',
        headBranch: 'agent/task-1',
        headSha: head,
        baseBranch: 'main',
        state: 'open',
      },
    })
    for (const [state, expected] of [
      ['merged', 'merged'],
      ['closed', 'closed'],
      ['locked', 'open'],
    ]) {
      expect(parse('gitlab', 'Merge Request Hook', mergeRequest({ state }))).toMatchObject({
        pullRequest: { state: expected },
      })
    }
  })

  it('parses a pipeline as a workflow_run event', () => {
    expect(parse('gitlab', 'Pipeline Hook', pipeline())).toEqual({
      kind: 'workflow_run',
      repo,
      run: {
        id: '31',
        name: 'pipeline',
        headSha: head,
        status: 'completed',
        conclusion: 'success',
        url: 'https://gitlab.com/client/sites/shop/-/pipelines/31',
        workflowFile: null,
        workflowPath: null,
        ref: null,
        event: null,
        headBranch: null,
        runAttempt: null,
      },
    })
    const withUrl = pipeline({ name: 'deploy', url: 'https://gitlab.com/x/-/pipelines/31' })
    expect(parse('gitlab', 'Pipeline Hook', withUrl)).toMatchObject({
      run: { name: 'deploy', url: 'https://gitlab.com/x/-/pipelines/31' },
    })
  })

  it.each([
    ['failed', 'completed', 'failure'],
    ['canceled', 'completed', 'cancelled'],
    ['skipped', 'completed', 'skipped'],
    ['running', 'in_progress', null],
    ['pending', 'queued', null],
    ['manual', 'queued', null],
  ])('maps the pipeline status %s', (status, expectedStatus, conclusion) => {
    expect(parse('gitlab', 'Pipeline Hook', pipeline({ status }))).toMatchObject({
      run: { status: expectedStatus, conclusion },
    })
  })

  it('parses a push to a branch and ignores tags and deletions', () => {
    expect(parse('gitlab', 'Push Hook', push())).toEqual({
      kind: 'push',
      repo,
      branch: 'main',
      headSha: head,
    })
    expect(parse('gitlab', 'Push Hook', push({ ref: 'refs/tags/v1' }))).toBeNull()
    expect(parse('gitlab', 'Push Hook', push({ after: zero, checkout_sha: null }))).toBeNull()
  })

  it('returns null for a wrong token or a missing one', () => {
    expect(parse('gitlab', 'Push Hook', push(), 'other-secret')).toBeNull()
    const body = JSON.stringify(push())
    const noToken = new Headers({ 'X-Gitlab-Event': 'Push Hook' })
    expect(provider('gitlab').parseWebhook(noToken, body, secret)).toBeNull()
  })

  it('returns null when the event header and object_kind disagree or are unsupported', () => {
    expect(parse('gitlab', 'Pipeline Hook', push())).toBeNull()
    expect(parse('gitlab', 'System Hook', push())).toBeNull()
    expect(parse('gitlab', 'Note Hook', { object_kind: 'note', project })).toBeNull()
    expect(
      parse('gitlab', 'Push Hook', push({ project: { ...project, path_with_namespace: 'shop' } })),
    ).toBeNull()
  })
})

// Real bodies of Gitea 1.27.3 (the pipeline stand, docs/plan/34-gitea-pipeline-spike.md): what
// the parser makes of them, and what it cannot tell.
describe('gitea parseWebhook on bodies recorded from Gitea 1.27.3', () => {
  const recorded = giteaWebhooksRecorded
  /** As Gitea delivers it: X-Gitea-Signature is the HMAC of the bytes of the body. */
  const deliver = (sample: RecordedWebhook, body = sample.body) =>
    provider('gitea').parseWebhook(signed('gitea', sample.event, sample.body), body, secret)

  interface RunBody {
    workflow: { name: string; path: string; html_url: string }
    workflow_run: {
      id: number
      head_sha: string
      html_url: string
      name?: string
      path: string
      event: string
      head_branch: string
      run_attempt: number
    }
    repository: { name: string }
  }
  const runBody = (sample: RecordedWebhook) => JSON.parse(sample.body) as RunBody

  it.each([
    ['runRequested', 'queued', null],
    ['runInProgress', 'in_progress', null],
    ['runSuccess', 'completed', 'success'],
    ['runFailure', 'completed', 'failure'],
    ['runCancelled', 'completed', 'cancelled'],
  ] as const)('maps the workflow_run delivery %s to %s', (name, status, conclusion) => {
    const body = runBody(recorded[name])
    // Gitea sends no workflow_run.name: the name of the run is the name of the workflow.
    expect(body.workflow_run.name).toBeUndefined()
    expect(deliver(recorded[name])).toEqual({
      kind: 'workflow_run',
      repo: { provider: 'gitea', owner: 'sites', name: body.repository.name },
      run: {
        id: String(body.workflow_run.id),
        name: 'deploy',
        headSha: body.workflow_run.head_sha,
        status,
        conclusion,
        url: body.workflow_run.html_url,
        workflowFile: 'deploy.yml',
        workflowPath: '.gitea/scoped_workflows/deploy.yml',
        ref: 'refs/heads/main',
        event: 'push',
        headBranch: 'main',
        runAttempt: 1,
      },
    })
    expect(body.workflow_run.path).toBe('deploy.yml@refs/heads/main')
    expect(body.workflow_run.html_url).toMatch(
      /^https:\/\/gitea\.example\.test\/sites\/(demo|other)\/actions\/runs\/\d+$/,
    )
  })

  it('checks the signature over the bytes Gitea sent, not over a re-serialised body', () => {
    const sample = recorded.runSuccess
    // Gitea pretty-prints: a route that parses the JSON and serialises it again loses the bytes.
    const compact = JSON.stringify(JSON.parse(sample.body))
    expect(compact).not.toBe(sample.body)
    expect(deliver(sample)).not.toBeNull()
    expect(deliver(sample, compact)).toBeNull()
    const foreign = signed('gitea', sample.event, sample.body, 'another-secret')
    expect(provider('gitea').parseWebhook(foreign, sample.body, secret)).toBeNull()
  })

  it('parses the pull request of a task when it is opened and when it is merged', () => {
    const opened = deliver(recorded.pullRequestOpened)
    expect(opened).toMatchObject({
      kind: 'pull_request',
      repo: { provider: 'gitea', owner: 'sites', name: 'demo' },
      pullRequest: { headBranch: 'agent/task-1', baseBranch: 'main', state: 'open' },
    })
    const merged = deliver(recorded.pullRequestMerged)
    expect(merged).toMatchObject({ kind: 'pull_request', pullRequest: { state: 'merged' } })
    if (opened?.kind !== 'pull_request' || merged?.kind !== 'pull_request') throw new Error('kind')
    expect(merged.pullRequest.number).toBe(opened.pullRequest.number)
    expect(merged.pullRequest.headSha).toBe(opened.pullRequest.headSha)
  })

  it('parses the push of the merge commit to main', () => {
    const body = JSON.parse(recorded.pushMain.body) as { after: string }
    expect(deliver(recorded.pushMain)).toEqual({
      kind: 'push',
      repo: { provider: 'gitea', owner: 'sites', name: 'demo' },
      branch: 'main',
      headSha: body.after,
    })
  })

  it('parses a signed workflow_job: the only event that names the step that failed', () => {
    const sample = recorded.jobFailure
    expect(sample.event).toBe('workflow_job')
    const event = deliver(sample)
    // workflow_run says `failure` and nothing else.
    expect(event).toMatchObject({
      kind: 'workflow_job',
      repo: { provider: 'gitea', owner: 'sites', name: 'demo' },
      job: { name: 'deploy', status: 'completed', conclusion: 'failure', runAttempt: 1 },
    })
    if (event?.kind !== 'workflow_job') throw new Error('kind')
    const body = JSON.parse(sample.body) as { workflow_job: { id: number; run_id: number } }
    expect([event.job.id, event.job.runId]).toEqual([
      String(body.workflow_job.id),
      String(body.workflow_job.run_id),
    ])
    expect(event.job.steps.map((step) => `${step.name}=${step.conclusion}`)).toEqual([
      'vault-login=success',
      'backup=success',
      'deploy=success',
      'verify=failure',
      'rollback=success',
      'vault-logout=success',
    ])
  })

  it('tells a workflow file of the site repository from the obligatory one by its path', () => {
    // A file .gitea/workflows/deploy.yml of a site repository, named `deploy` like the scoped
    // workflow of platform/ci, has the same name and the same `deploy.yml@refs/heads/main`;
    // only `workflow.path` of the body tells them apart, and the event carries it.
    const obligatory = runBody(recorded.runSuccess)
    const repository = runBody(recorded.runRepositoryWorkflow)
    expect(obligatory.workflow.html_url).toMatch(
      /^https:\/\/gitea\.example\.test\/platform\/ci\/src\/commit\/[0-9a-f]{40}\//,
    )
    expect(repository.workflow_run.path).toBe(obligatory.workflow_run.path)
    expect(deliver(recorded.runSuccess)).toMatchObject({
      run: { name: 'deploy', workflowPath: '.gitea/scoped_workflows/deploy.yml' },
    })
    expect(deliver(recorded.runRepositoryWorkflow)).toMatchObject({
      kind: 'workflow_run',
      run: {
        name: 'deploy',
        status: 'completed',
        conclusion: 'success',
        workflowPath: '.gitea/workflows/deploy.yml',
      },
    })
  })

  it('keeps no address, secret header or signature of the stand in the samples', () => {
    for (const sample of Object.values(recorded)) {
      expect(sample.body).not.toMatch(/localhost|host\.docker\.internal|gitea(-hardened)?:3000/)
      // No literal IPv4 address at all: loopback, a container, a gateway.
      expect(sample.body).not.toMatch(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/)
      expect(sample.body).not.toMatch(/\/(Users|home)\//)
      expect(Object.keys(sample).sort()).toEqual(['body', 'event'])
    }
  })
})

// Bodies of the release flow from Gitea 1.27.3 (recorded 2026-10-17, plan 53): a tag push and
// the run it starts, a dispatched run, the job of a run.
describe('gitea parseWebhook on release bodies recorded from Gitea 1.27.3', () => {
  const recorded = giteaReleaseWebhooksRecorded
  const repo = { provider: 'gitea', owner: 'sites', name: 'demo' }
  const deliver = (sample: RecordedWebhook) =>
    provider('gitea').parseWebhook(signed('gitea', sample.event, sample.body), sample.body, secret)

  it('parses a lightweight tag push: the tag names its commit', () => {
    expect(deliver(recorded.pushTag)).toEqual({
      kind: 'tag',
      repo,
      tag: 'v1.0.0',
      sha: RECORDED_TAG_COMMIT,
    })
  })

  it('parses an annotated tag push: the ref names the tag object, not the commit', () => {
    expect(deliver(recorded.pushAnnotatedTag)).toEqual({
      kind: 'tag',
      repo,
      tag: 'v1.1.0',
      sha: RECORDED_TAG_OBJECT,
    })
  })

  it('parses the run a tag push starts: its ref is the tag, it has no branch', () => {
    const body = JSON.parse(recorded.runOfTagRequested.body) as {
      workflow_run: { id: number; head_branch?: string }
    }
    expect(body.workflow_run.head_branch).toBeUndefined()
    expect(deliver(recorded.runOfTagRequested)).toMatchObject({
      kind: 'workflow_run',
      repo,
      run: {
        id: String(body.workflow_run.id),
        headSha: RECORDED_TAG_COMMIT,
        status: 'queued',
        conclusion: null,
        workflowFile: 'probe.yml',
        workflowPath: '.gitea/workflows/probe.yml',
        ref: 'refs/tags/v1.0.0',
        event: 'push',
        headBranch: null,
        runAttempt: 1,
      },
    })
  })

  it('parses a dispatched run: event workflow_dispatch on the branch it was given', () => {
    expect(deliver(recorded.runDispatchedRequested)).toMatchObject({
      kind: 'workflow_run',
      run: {
        workflowFile: 'probe.yml',
        ref: 'refs/heads/main',
        event: 'workflow_dispatch',
        headBranch: 'main',
        runAttempt: 1,
      },
    })
  })

  it('parses the queued job of the run of a tag', () => {
    const run = deliver(recorded.runOfTagRequested)
    expect(deliver(recorded.jobOfTagQueued)).toMatchObject({
      kind: 'workflow_job',
      job: {
        runId: run?.kind === 'workflow_run' ? run.run.id : 'none',
        name: 'probe',
        headSha: RECORDED_TAG_COMMIT,
        headBranch: null,
        status: 'queued',
        conclusion: null,
        steps: [],
      },
    })
  })

  it('keeps no address of the recording in the samples', () => {
    for (const sample of Object.values(recorded)) {
      expect(sample.body).not.toMatch(/localhost|host\.docker\.internal|127\.0\.0\.1/)
      expect(sample.body).not.toMatch(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/)
      expect(sample.body).not.toMatch(/\/(Users|home)\//)
    }
  })
})
