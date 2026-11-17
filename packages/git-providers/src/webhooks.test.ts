import { createHmac } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { DomainError, type GitAuth, type RepoRef } from '@repo/domain'

import { createGitProvider } from './create-git-provider.ts'
import { createGitlabProvider } from './gitlab.ts'
import { gitlabPathAllowed } from './gitlab-paths.ts'
import { fakeSend, type Route } from './testing/fake-send.ts'
import { createGitTransport } from './transport.ts'
import {
  gitlabHookKeyId,
  gitlabHookSecrets,
  parseGithubInstallationWebhook,
  parseGithubWebhook,
  parseGitlabWebhook,
  verifyGithubSignature,
  verifyGitlabDelivery,
} from './webhooks.ts'

// The webhooks and the rest of the second queue (docs/plan/84-projects.md, ПР15, ПР17; slice 84.26)
// on HTTP fakes: signatures, the parsing of deliveries, the hooks of GitLab, the adoption of a merge
// request by its branch, a rerun and a cancel of a GitHub run.

const root = 'r'.repeat(48)
const repositoryId = '0199a3f2-0000-7000-8000-00000000d026'
const now = new Date('2026-11-17T10:00:00Z')

const githubSigned = (body: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

/** A Standard Webhooks signature, as GitLab ≥ 19.0 sends it. */
function gitlabSigned(body: string, signingToken: string, id: string, at: number) {
  const key = Buffer.from(signingToken.replace(/^whsec_/, ''), 'base64')
  return `v1,${createHmac('sha256', key).update(`${id}.${at}.${body}`).digest('base64')}`
}

describe('the signature of a GitHub delivery', () => {
  const body = JSON.stringify({ repository: { id: 42 } })
  it('takes the HMAC of the raw body by the app secret, and nothing else', () => {
    const ok = new Headers({ 'x-hub-signature-256': githubSigned(body, 'app-secret') })
    expect(verifyGithubSignature(ok, body, 'app-secret')).toBe(true)
    // Forged: another secret, another body, a missing prefix, an empty secret.
    expect(verifyGithubSignature(ok, body, 'other-secret')).toBe(false)
    expect(verifyGithubSignature(ok, `${body} `, 'app-secret')).toBe(false)
    const bare = new Headers({ 'x-hub-signature-256': githubSigned(body, 'app-secret').slice(7) })
    expect(verifyGithubSignature(bare, body, 'app-secret')).toBe(false)
    expect(verifyGithubSignature(new Headers(), body, 'app-secret')).toBe(false)
    expect(verifyGithubSignature(ok, body, '')).toBe(false)
  })
})

describe('the secrets of a GitLab hook', () => {
  it('are derived from the root secret, the repository and the nonce; the key id from the root', () => {
    const one = gitlabHookSecrets(root, repositoryId, 'a'.repeat(32))
    expect(gitlabHookSecrets(root, repositoryId.toUpperCase(), 'a'.repeat(32))).toEqual(one)
    expect(gitlabHookSecrets(root, repositoryId, 'b'.repeat(32)).token).not.toBe(one.token)
    expect(one.signingToken).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
    expect(Buffer.from(one.signingToken.slice(6), 'base64')).toHaveLength(32)
    expect(one.keyId).toBe(gitlabHookKeyId(root))
    expect(gitlabHookKeyId('s'.repeat(48))).not.toBe(one.keyId)
    expect(one.token).not.toContain(root)
  })
})

describe('the check of a GitLab delivery', () => {
  const secrets = gitlabHookSecrets(root, repositoryId, 'c'.repeat(32))
  const body = JSON.stringify({ object_kind: 'push', project: { id: 42 } })
  const at = Math.floor(now.getTime() / 1000)

  it('takes a signed delivery within five minutes, and refuses a forged or late one', () => {
    const signed = (
      id: string,
      when: number,
      signature = gitlabSigned(body, secrets.signingToken, id, when),
    ) =>
      new Headers({
        'webhook-id': id,
        'webhook-timestamp': String(when),
        'webhook-signature': signature,
      })
    const opts = { requireSignature: true, now }
    expect(verifyGitlabDelivery(signed('msg_1', at), body, secrets, opts)).toEqual({
      ok: true,
      signed: true,
    })
    // Several signatures, one of them right (the header may carry more).
    const many = signed(
      'msg_1',
      at,
      `v1,AAAA ${gitlabSigned(body, secrets.signingToken, 'msg_1', at)}`,
    )
    expect(verifyGitlabDelivery(many, body, secrets, opts).ok).toBe(true)
    const forged = gitlabSigned(
      body,
      gitlabHookSecrets(root, repositoryId, 'd'.repeat(32)).signingToken,
      'msg_1',
      at,
    )
    expect(verifyGitlabDelivery(signed('msg_1', at, forged), body, secrets, opts)).toEqual({
      ok: false,
      reason: 'signature',
    })
    // Another id or another time than the signed one; a replay after the window.
    expect(
      verifyGitlabDelivery(
        signed('msg_2', at, gitlabSigned(body, secrets.signingToken, 'msg_1', at)),
        body,
        secrets,
        opts,
      ).ok,
    ).toBe(false)
    expect(verifyGitlabDelivery(signed('msg_1', at - 301), body, secrets, opts)).toEqual({
      ok: false,
      reason: 'time',
    })
    expect(verifyGitlabDelivery(signed('msg_1', at), `${body}x`, secrets, opts).ok).toBe(false)
  })

  it('a hook GitLab signs refuses the token alone; an unsigned hook takes the right token only', () => {
    const token = new Headers({ 'x-gitlab-token': secrets.token })
    expect(verifyGitlabDelivery(token, body, secrets, { requireSignature: true, now })).toEqual({
      ok: false,
      reason: 'unsigned',
    })
    expect(verifyGitlabDelivery(token, body, secrets, { requireSignature: false, now })).toEqual({
      ok: true,
      signed: false,
    })
    const wrong = new Headers({ 'x-gitlab-token': `${secrets.token}x` })
    expect(verifyGitlabDelivery(wrong, body, secrets, { requireSignature: false, now }).ok).toBe(
      false,
    )
    expect(
      verifyGitlabDelivery(new Headers(), body, secrets, { requireSignature: false, now }).ok,
    ).toBe(false)
  })
})

describe('the parsing of a delivery', () => {
  const github = (event: string, body: unknown, delivery = 'd-1') =>
    parseGithubWebhook(
      new Headers({ 'x-github-event': event, 'x-github-delivery': delivery }),
      JSON.stringify(body),
    )

  it('names the repository and the object of a GitHub event, and nothing of no repository', () => {
    expect(github('push', { repository: { id: 42 } })).toEqual({
      deliveryId: 'd-1',
      providerRepoId: '42',
      kind: 'push',
    })
    expect(github('pull_request', { number: 7, repository: { id: 42 } })).toMatchObject({
      kind: 'merge_request',
      number: 7,
    })
    expect(
      github('workflow_run', { workflow_run: { id: 99 }, repository: { id: 42 } }),
    ).toMatchObject({
      kind: 'pipeline',
      runId: '99',
    })
    expect(github('check_suite', { repository: { id: 42 } })).toMatchObject({ kind: 'checks' })
    expect(github('installation', { installation: { id: 1 } })).toBeNull()
    expect(github('ping', { repository: { id: 42 } })).toBeNull()
    expect(github('push', { repository: { id: 42 } }, 'bad id with spaces')).toBeNull()
    expect(parseGithubWebhook(new Headers({ 'x-github-event': 'push' }), '{')).toBeNull()
  })

  it('names the project and the object of a GitLab event, with an id of the delivery', () => {
    const body = (value: unknown) => JSON.stringify(value)
    expect(
      parseGitlabWebhook(
        new Headers({ 'webhook-id': 'msg_1' }),
        body({ object_kind: 'merge_request', project: { id: 42 }, object_attributes: { iid: 37 } }),
      ),
    ).toEqual({ deliveryId: 'msg_1', providerRepoId: '42', kind: 'merge_request', number: 37 })
    expect(
      parseGitlabWebhook(
        new Headers({ 'x-gitlab-event-uuid': 'uuid-1' }),
        body({ object_kind: 'pipeline', project: { id: 42 }, object_attributes: { id: 9 } }),
      ),
    ).toMatchObject({ deliveryId: 'uuid-1', kind: 'pipeline', runId: '9' })
    // Without an id of the delivery: the hash of the body, so a repeat of it is a repeat.
    const plain = body({ object_kind: 'push', project: { id: 42 } })
    const first = parseGitlabWebhook(new Headers(), plain)
    expect(first?.deliveryId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(parseGitlabWebhook(new Headers(), plain)?.deliveryId).toBe(first?.deliveryId)
    expect(
      parseGitlabWebhook(new Headers(), body({ object_kind: 'note', project: { id: 42 } })),
    ).toBeNull()
  })
})

const glHost = 'gitlab.example.ru'
const auth: GitAuth = { kind: 'bearer', token: 'glpat-test' }
const glRepo: RepoRef = {
  provider: 'gitlab',
  host: glHost,
  path: 'group/project',
  providerRepoId: '42',
}
const head = 'a'.repeat(40)
const P = '/api/v4/projects/42'

function gitlab(routes: Record<string, Route | ReturnType<Route>>) {
  const { send, calls } = fakeSend(routes)
  const provider = createGitlabProvider({
    host: glHost,
    transport: createGitTransport({ resolvePublic: vi.fn(async () => '203.0.113.7'), send }),
  })
  return { provider, calls }
}

const mr = (over: Record<string, unknown> = {}) => ({
  iid: 37,
  title: 'Новое меню',
  state: 'opened',
  source_branch: 'raditi/novoe-menyu-1a2b3c4d',
  target_branch: 'main',
  sha: head,
  web_url: 'https://gitlab.example.ru/group/project/-/merge_requests/37',
  ...over,
})

describe('the GitLab adapter of 84.26', () => {
  it('says whether its user may make hooks: Maintainer of the project or of its group', async () => {
    const project = (permissions: unknown) => ({
      status: 200,
      body: { id: 42, path_with_namespace: 'group/project', permissions },
    })
    for (const [permissions, may] of [
      [{ project_access: { access_level: 40 }, group_access: null }, true],
      [{ project_access: { access_level: 30 }, group_access: { access_level: 50 } }, true],
      [{ project_access: { access_level: 30 }, group_access: null }, false],
    ] as const) {
      const { provider } = gitlab({ [`GET ${P}`]: project(permissions) })
      expect((await provider.getRepository(auth, glRepo))?.canManageHooks).toBe(may)
    }
    const { provider } = gitlab({
      [`GET ${P}`]: { status: 200, body: { id: 42, path_with_namespace: 'group/project' } },
    })
    expect((await provider.getRepository(auth, glRepo))?.canManageHooks).toBeUndefined()
  })

  it('makes a hook with the token and the signing token, and says whether GitLab signs', async () => {
    const { provider, calls } = gitlab({
      [`POST ${P}/hooks`]: { status: 201, body: { id: 5, signing_token_present: true } },
    })
    const made = await provider.createHook!(auth, glRepo, {
      url: 'https://raditi.ru/api/webhooks/gitlab?r=1',
      token: 'hook-token',
      signingToken: 'whsec_AAAA',
    })
    expect(made).toEqual({ hookId: '5', signed: true })
    expect(calls[0]!.body).toMatchObject({
      url: 'https://raditi.ru/api/webhooks/gitlab?r=1',
      token: 'hook-token',
      signing_token: 'whsec_AAAA',
      push_events: true,
      merge_requests_events: true,
      pipeline_events: true,
      enable_ssl_verification: true,
    })
    // An older server answers without the field: the hook is a hook of the token.
    const old = gitlab({ [`POST ${P}/hooks`]: { status: 201, body: { id: 6 } } })
    expect(
      await old.provider.createHook!(auth, glRepo, {
        url: 'https://x/y',
        token: 't',
        signingToken: 'whsec_AAAA',
      }),
    ).toEqual({ hookId: '6', signed: false })
  })

  it('finds the merge requests of one source branch, and only open or merged ones of it', async () => {
    const { provider, calls } = gitlab({
      [`GET ${P}/merge_requests`]: {
        status: 200,
        body: [
          mr(),
          mr({ iid: 36, state: 'closed' }),
          mr({ iid: 35, source_branch: 'raditi/other-11112222' }),
        ],
      },
    })
    const found = await provider.findPullRequests(auth, glRepo, 'raditi/novoe-menyu-1a2b3c4d')
    expect(found.map((pr) => pr.number)).toEqual([37])
    expect(calls[0]!.url.searchParams.get('source_branch')).toBe('raditi/novoe-menyu-1a2b3c4d')
    // The whitelist names it for the attached project only, and nothing else of the list.
    expect(
      gitlabPathAllowed('GET', '/projects/42/merge_requests', new URLSearchParams(), '42'),
    ).toBe(true)
    expect(
      gitlabPathAllowed('GET', '/projects/43/merge_requests', new URLSearchParams(), '42'),
    ).toBe(false)
    expect(gitlabPathAllowed('GET', '/merge_requests', new URLSearchParams(), '42')).toBe(false)
  })
})

describe('the GitHub adapter of 84.26', () => {
  const ghRepo: RepoRef = {
    provider: 'github',
    host: 'github.com',
    path: 'acme/site',
    providerRepoId: '42',
  }
  const bearer = { kind: 'bearer', token: 'ghs_operation' } as const
  function github(routes: Record<string, Route | ReturnType<Route>>) {
    const { send, calls } = fakeSend(routes)
    const transport = createGitTransport({ resolvePublic: async () => '140.82.112.6', send })
    return { provider: createGitProvider({ kind: 'github', host: 'github.com', transport }), calls }
  }
  const pull = (over: Record<string, unknown> = {}) => ({
    number: 7,
    title: 'Новое меню',
    state: 'open',
    draft: false,
    head: { ref: 'raditi/novoe-menyu-1a2b3c4d', sha: head, repo: { full_name: 'acme/site' } },
    base: { ref: 'main' },
    html_url: 'https://github.com/acme/site/pull/7',
    ...over,
  })

  it('reruns and cancels a run; a run that cannot is REPO_RUN_GONE', async () => {
    const { provider, calls } = github({
      'POST /repos/acme/site/actions/runs/99/rerun': { status: 201, body: {} },
      'POST /repos/acme/site/actions/runs/99/cancel': { status: 202, body: {} },
      'POST /repos/acme/site/actions/runs/98/cancel': { status: 409, body: {} },
    })
    // GitHub reruns the run itself: the same id goes again, its commit is the run's.
    expect(await provider.rerunRun(bearer, ghRepo, '99')).toEqual({ runId: '99' })
    await provider.cancelRun(bearer, ghRepo, '99')
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'POST /repos/acme/site/actions/runs/99/rerun',
      'POST /repos/acme/site/actions/runs/99/cancel',
    ])
    let caught: unknown
    await provider.cancelRun(bearer, ghRepo, '98').catch((error: unknown) => (caught = error))
    expect(caught).toBeInstanceOf(DomainError)
    expect((caught as DomainError).code).toBe('REPO_RUN_GONE')
  })

  it('finds the pull requests of a branch of this repository, never of a fork', async () => {
    const { provider, calls } = github({
      'GET /repos/acme/site/pulls': {
        status: 200,
        body: [
          pull(),
          pull({
            number: 6,
            head: {
              ref: 'raditi/novoe-menyu-1a2b3c4d',
              sha: head,
              repo: { full_name: 'evil/site' },
            },
          }),
          pull({ number: 5, state: 'closed', merged_at: null }),
          pull({
            number: 4,
            state: 'closed',
            merged_at: '2026-11-16T10:00:00Z',
            merge_commit_sha: 'b'.repeat(40),
          }),
        ],
      },
    })
    const found = await provider.findPullRequests(bearer, ghRepo, 'raditi/novoe-menyu-1a2b3c4d')
    expect(found.map((pr) => [pr.number, pr.state])).toEqual([
      [7, 'open'],
      [4, 'merged'],
    ])
    expect(calls[0]!.url.searchParams.get('head')).toBe('acme:raditi/novoe-menyu-1a2b3c4d')
    expect(calls[0]!.url.searchParams.get('state')).toBe('all')
  })
})

describe('the installation event of the GitHub App (84.27)', () => {
  const headers = (event: string, delivery = 'd-77') =>
    new Headers({ 'x-github-event': event, 'x-github-delivery': delivery })
  const body = (action: string, id: unknown = 77) =>
    JSON.stringify({ action, installation: { id }, sender: { login: 'acme' } })

  it('says gone of deleted and suspend, back of unsuspend and created', () => {
    for (const [action, change] of [
      ['deleted', 'gone'],
      ['suspend', 'gone'],
      ['unsuspend', 'back'],
      ['created', 'back'],
    ] as const)
      expect(parseGithubInstallationWebhook(headers('installation'), body(action))).toEqual({
        deliveryId: 'd-77',
        installationId: '77',
        change,
      })
  })

  it('takes nothing else: another action or event, no id, no delivery', () => {
    expect(
      parseGithubInstallationWebhook(headers('installation'), body('new_permissions_accepted')),
    ).toBeNull()
    expect(parseGithubInstallationWebhook(headers('push'), body('deleted'))).toBeNull()
    expect(
      parseGithubInstallationWebhook(headers('installation_repositories'), body('removed')),
    ).toBeNull()
    expect(
      parseGithubInstallationWebhook(headers('installation'), body('deleted', '77')),
    ).toBeNull()
    expect(
      parseGithubInstallationWebhook(
        new Headers({ 'x-github-event': 'installation' }),
        body('deleted'),
      ),
    ).toBeNull()
    expect(parseGithubInstallationWebhook(headers('installation'), 'not json')).toBeNull()
  })
})
