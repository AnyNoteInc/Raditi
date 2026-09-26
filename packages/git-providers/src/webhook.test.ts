import { createHmac } from 'node:crypto'
import type { GitProviderKind } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { createGitProvider } from './create-git-provider.ts'

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
      },
    })
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

  it('ignores tag pushes and branch deletions', () => {
    expect(parse(kind, 'push', pushPayload({ ref: 'refs/tags/v1' }))).toBeNull()
    expect(parse(kind, 'push', pushPayload({ after: zero }))).toBeNull()
    expect(parse(kind, 'push', pushPayload({ deleted: true }))).toBeNull()
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
