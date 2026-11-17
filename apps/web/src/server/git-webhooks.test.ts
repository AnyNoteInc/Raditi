import { createHmac, randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import { gitlabHookSecrets } from '@repo/git-providers/webhooks'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { handleGithubWebhook, handleGitlabWebhook } from './git-webhooks'

// The webhooks of the repositories of projects (docs/plan/84-projects.md, ПР17; slice 84.26): a
// forged signature is refused before the database; on PostgreSQL a repeated delivery enqueues no
// second job and a storm of deliveries of one object is one `git.refresh`.

const databaseUrl = process.env.DATABASE_URL
const APP_SECRET = 'synthetic-github-app-webhook-secret-84-26'
const ROOT = 'synthetic-repo-confirm-secret-for-the-test-of-84-26'
const now = new Date('2026-11-17T10:00:00Z')

const githubRequest = (
  body: string,
  headers: Record<string, string>,
  secret: string = APP_SECRET,
) =>
  new Request('https://raditi.test/api/webhooks/github', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      ...headers,
    },
  })

const untouched = () =>
  ({
    $transaction: vi.fn(() => Promise.reject(new Error('no database here'))),
    projectRepository: {
      findMany: vi.fn(() => Promise.reject(new Error('no database here'))),
      findUnique: vi.fn(() => Promise.reject(new Error('no database here'))),
    },
  }) as unknown as PrismaClient

describe('the webhooks of repositories without a database', () => {
  it('refuses a forged GitHub signature before anything is read', async () => {
    const prisma = untouched()
    const body = JSON.stringify({ repository: { id: 42 } })
    const forged = githubRequest(
      body,
      { 'x-github-event': 'push', 'x-github-delivery': 'd-1' },
      'another-secret',
    )
    const answer = await handleGithubWebhook(forged, {
      prisma,
      now: () => now,
      webhookSecret: APP_SECRET,
    })
    expect(answer.status).toBe(401)
    expect(prisma.projectRepository.findMany).not.toHaveBeenCalled()
    // No app here at all: the route is not there.
    expect(
      (await handleGithubWebhook(forged, { prisma, now: () => now, webhookSecret: null })).status,
    ).toBe(404)
  })

  it('refuses a GitLab delivery without a repository of the hook, and a body too large', async () => {
    const prisma = untouched()
    const request = (url: string, body = '{}') =>
      new Request(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
    expect(
      (
        await handleGitlabWebhook(request('https://raditi.test/api/webhooks/gitlab?r=nope'), {
          prisma,
          now: () => now,
          rootSecret: ROOT,
        })
      ).status,
    ).toBe(404)
    const big = request(
      `https://raditi.test/api/webhooks/gitlab?r=${randomUUID()}`,
      'x'.repeat(300 * 1024),
    )
    expect(
      (await handleGitlabWebhook(big, { prisma, now: () => now, rootSecret: ROOT })).status,
    ).toBe(413)
  })
})

describe.skipIf(!databaseUrl)('the webhooks of repositories in PostgreSQL', () => {
  let db: PrismaClient
  const users: string[] = []
  const repositories: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    await db.outboxEvent.deleteMany({
      where: {
        OR: repositories.map((id) => ({ dedupeKey: { startsWith: `git.refresh:${id}:` } })),
      },
    })
    repositories.splice(0)
    await db.gitWebhookDelivery.deleteMany({ where: { deliveryId: { startsWith: 'test-8426-' } } })
    for (const userId of users.splice(0)) {
      const workspaces = { workspace: { createdById: userId } }
      await db.projectRepository.deleteMany({ where: workspaces })
      await db.project.deleteMany({ where: workspaces })
      await db.workspace.deleteMany({ where: { createdById: userId } })
      await db.user.deleteMany({ where: { id: userId } })
    }
  })
  afterAll(async () => {
    await db?.$disconnect()
  })

  async function repository(input: {
    provider: 'github' | 'gitlab'
    providerRepoId: string
    hook?: { nonce: string; keyId: string; signed: boolean }
  }) {
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    users.push(user.id)
    const ws = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
    })
    const random = randomUUID().replaceAll('-', '')
    const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
    const projectId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    await db.project.create({
      data: { id: projectId, workspaceId: ws.id, createdById: user.id, name: 'Колос' },
    })
    const id = randomUUID()
    repositories.push(id)
    const host = input.provider === 'github' ? 'github.com' : 'gitlab.example.ru'
    await db.projectRepository.create({
      data: {
        id,
        projectId,
        workspaceId: ws.id,
        provider: input.provider,
        host,
        providerRepoId: input.providerRepoId,
        path: 'kolos/site',
        webUrl: `https://${host}/kolos/site`,
        defaultBranch: 'main',
        mode: 'read',
        mirrorState: 'ready',
        ...(input.hook
          ? {
              hookId: '5',
              hookState: 'active',
              hookNonce: input.hook.nonce,
              hookKeyId: input.hook.keyId,
              hookSigned: input.hook.signed,
            }
          : {}),
      },
    })
    return id
  }

  const refreshes = (id: string) =>
    db.outboxEvent.findMany({
      where: { dedupeKey: { startsWith: `git.refresh:${id}:` } },
      select: { type: true, payload: true, dedupeKey: true, availableAt: true },
    })

  it('a repeated GitHub delivery enqueues no second job; every repository of the id gets one', async () => {
    const providerRepoId = String(Date.now())
    const one = await repository({ provider: 'github', providerRepoId })
    const two = await repository({ provider: 'github', providerRepoId })
    const body = JSON.stringify({ number: 7, repository: { id: Number(providerRepoId) } })
    const deliver = () =>
      handleGithubWebhook(
        githubRequest(body, {
          'x-github-event': 'pull_request',
          'x-github-delivery': 'test-8426-a',
        }),
        { prisma: db, now: () => now, webhookSecret: APP_SECRET },
      )
    expect((await deliver()).status).toBe(202)
    expect((await deliver()).status).toBe(202)
    for (const id of [one, two]) {
      const rows = await refreshes(id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        type: 'git.refresh',
        payload: { projectRepositoryId: id, kind: 'merge_request', number: 7 },
      })
      // Published at the end of its window: the window coalesces first.
      expect(rows[0]!.availableAt.getTime()).toBeGreaterThan(now.getTime())
    }
    expect(
      await db.gitWebhookDelivery.count({
        where: { provider: 'github', deliveryId: 'test-8426-a' },
      }),
    ).toBe(1)
  })

  it('a storm of GitLab deliveries of one merge request is one job; a forged one is refused', async () => {
    const nonce = 'e'.repeat(32)
    const secrets = gitlabHookSecrets(ROOT, randomUUID(), nonce)
    const id = await repository({
      provider: 'gitlab',
      providerRepoId: '42',
      hook: { nonce, keyId: secrets.keyId, signed: true },
    })
    const own = gitlabHookSecrets(ROOT, id, nonce)
    const body = JSON.stringify({
      object_kind: 'merge_request',
      project: { id: 42 },
      object_attributes: { iid: 37 },
    })
    const at = Math.floor(now.getTime() / 1000)
    const signed = (deliveryId: string, signingToken = own.signingToken) => {
      const key = Buffer.from(signingToken.replace(/^whsec_/, ''), 'base64')
      const signature = `v1,${createHmac('sha256', key).update(`${deliveryId}.${at}.${body}`).digest('base64')}`
      return new Request(`https://raditi.test/api/webhooks/gitlab?r=${id}`, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'webhook-id': deliveryId,
          'webhook-timestamp': String(at),
          'webhook-signature': signature,
        },
      })
    }
    const deps = { prisma: db, now: () => now, rootSecret: ROOT }
    // A hook GitLab signs: the token alone, or a signature of another hook's key, is refused.
    const tokenOnly = new Request(`https://raditi.test/api/webhooks/gitlab?r=${id}`, {
      method: 'POST',
      body,
      headers: { 'x-gitlab-token': own.token },
    })
    expect((await handleGitlabWebhook(tokenOnly, deps)).status).toBe(401)
    expect(
      (await handleGitlabWebhook(signed('test-8426-forged', secrets.signingToken), deps)).status,
    ).toBe(401)
    expect(await refreshes(id)).toHaveLength(0)
    // Fifty deliveries, each its own id, within one window: fifty kept, one job.
    for (let n = 0; n < 50; n++)
      expect((await handleGitlabWebhook(signed(`test-8426-storm-${n}`), deps)).status).toBe(202)
    expect(
      await db.gitWebhookDelivery.count({
        where: { provider: 'gitlab', deliveryId: { startsWith: 'test-8426-storm-' } },
      }),
    ).toBe(50)
    expect(await refreshes(id)).toHaveLength(1)
    // Another project's event under this hook: taken, nothing for this repository.
    const other = JSON.stringify({ object_kind: 'push', project: { id: 43 } })
    const key = Buffer.from(own.signingToken.replace(/^whsec_/, ''), 'base64')
    const foreign = new Request(`https://raditi.test/api/webhooks/gitlab?r=${id}`, {
      method: 'POST',
      body: other,
      headers: {
        'webhook-id': 'test-8426-other',
        'webhook-timestamp': String(at),
        'webhook-signature': `v1,${createHmac('sha256', key).update(`test-8426-other.${at}.${other}`).digest('base64')}`,
      },
    })
    expect((await handleGitlabWebhook(foreign, deps)).status).toBe(202)
    expect(await refreshes(id)).toHaveLength(1)
    // A hook made by another root secret (rotated): 404, GitLab turns it off.
    expect(
      (
        await handleGitlabWebhook(signed('test-8426-rotated'), {
          ...deps,
          rootSecret: 'another-root-secret-of-at-least-thirty-two-chars',
        })
      ).status,
    ).toBe(404)
  })
})
