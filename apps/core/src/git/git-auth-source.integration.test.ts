import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import {
  gitConnectionSecretPath,
  isDomainError,
  type KvSecret,
  type OAuthApp,
  type SecretStore,
} from '@repo/domain'
import { createGitTransport, type GitSend } from '@repo/git-providers'
import { createGitConnect } from '@repo/git-providers/connect'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { GitAuthSource } from './git-auth-source.ts'

// The renewal of a GitLab OAuth pair under the advisory lock of its connection (docs/plan/
// 84-projects.md, §4.3, slice 84.17): two renewers on two pools of connections — two processes of
// core as the database sees them — renew once, and both get the new pair. The token endpoint is an
// HTTP fake behind the real transport and the real sign-in adapter; a refresh token is good once,
// as on gitlab.com. Only on a disposable database (RADITI_GATEWAY_DB_TESTS).
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const app: OAuthApp = {
  host: 'gitlab.com',
  clientId: 'client',
  clientSecret: 'secret',
  redirectUri: 'https://raditi.test/api/git/gitlab/callback',
}

/** Vault KV with CAS, in memory, shared by both renewers. */
function memoryVault() {
  const keys = new Map<string, KvSecret>()
  const secrets: Pick<SecretStore, 'kvRead' | 'kvWrite'> = {
    kvRead: async (path) => keys.get(path) ?? null,
    kvWrite: async (path, data, options) => {
      const current = keys.get(path)
      if (options?.cas !== undefined && options.cas !== (current?.version ?? 0))
        throw new Error('check-and-set parameter did not match the current version')
      const version = (current?.version ?? 0) + 1
      keys.set(path, { data: { ...data }, version })
      return { version }
    },
  }
  return { keys, secrets }
}

/** gitlab.com's token endpoint: a refresh token is good once, the answer takes 150 ms. */
function tokenEndpoint() {
  let issued = 0
  const valid = new Set(['refresh-0'])
  const calls: string[] = []
  const send: GitSend = async (_address, request) => {
    const form = new URLSearchParams(request.body ?? '')
    calls.push(`${request.method} ${request.url.pathname} ${form.get('grant_type')}`)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const refresh = form.get('refresh_token') ?? ''
    if (!valid.delete(refresh))
      return {
        status: 400,
        headers: new Headers(),
        body: Buffer.from(JSON.stringify({ error: 'invalid_grant' })),
        truncated: false,
      }
    issued++
    valid.add(`refresh-${issued}`)
    return {
      status: 200,
      headers: new Headers(),
      body: Buffer.from(
        JSON.stringify({
          access_token: `access-${issued}`,
          refresh_token: `refresh-${issued}`,
          expires_in: 7200,
          created_at: Math.floor(Date.now() / 1000),
        }),
      ),
      truncated: false,
    }
  }
  const transport = createGitTransport({ resolvePublic: async () => '203.0.113.9', send })
  return { connect: () => createGitConnect('gitlab', { transport }), calls }
}

describe.skipIf(!enabled)('GitAuthSource with PostgreSQL (plan 84, 84.17)', () => {
  let first: PrismaClient
  let second: PrismaClient
  const users: string[] = []

  beforeAll(() => {
    first = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    second = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    for (const userId of users.splice(0)) {
      const refs = await first.gitConnection.findMany({
        where: { createdById: userId },
        select: { credentialRefId: true },
      })
      await first.gitConnection.deleteMany({ where: { createdById: userId } })
      await first.credentialRef.deleteMany({
        where: {
          id: { in: refs.flatMap((ref) => (ref.credentialRefId ? [ref.credentialRefId] : [])) },
        },
      })
      await first.workspace.deleteMany({ where: { createdById: userId } })
      await first.user.deleteMany({ where: { id: userId } })
    }
  })
  afterAll(async () => {
    await first.$disconnect()
    await second.$disconnect()
  })

  /** A connection of gitlab.com whose pair ends in a minute. */
  async function connection(vault: ReturnType<typeof memoryVault>) {
    const user = await first.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    users.push(user.id)
    const workspace = await first.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
    })
    const id = randomUUID()
    const path = gitConnectionSecretPath(workspace.id, id)
    await vault.secrets.kvWrite(path, {
      accessToken: 'access-0',
      refreshToken: 'refresh-0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const ref = await first.credentialRef.create({
      data: { workspaceId: workspace.id, kind: 'git_connection', vaultPath: path },
    })
    await first.gitConnection.create({
      data: {
        id,
        workspaceId: workspace.id,
        createdById: user.id,
        kind: 'gitlab_oauth',
        host: 'gitlab.com',
        accountLogin: 'elena.k',
        accountId: '42',
        credentialRefId: ref.id,
        state: 'ok',
      },
    })
    return {
      id,
      workspaceId: workspace.id,
      kind: 'gitlab_oauth' as const,
      host: 'gitlab.com',
      path,
    }
  }

  it('two renewers renew once under the lock, and both get the new pair', async () => {
    const vault = memoryVault()
    const endpoint = tokenEndpoint()
    const conn = await connection(vault)
    const source = (prisma: PrismaClient) =>
      new GitAuthSource({
        prisma,
        secrets: vault.secrets,
        connect: endpoint.connect,
        gitlabOauth: app,
      })
    const [a, b] = await Promise.all([source(first).grantFor(conn), source(second).grantFor(conn)])
    expect(a).toEqual({ kind: 'token', token: 'access-1' })
    expect(b).toEqual({ kind: 'token', token: 'access-1' })
    expect(endpoint.calls).toEqual(['POST /oauth/token refresh_token'])
    const kept = vault.keys.get(conn.path)!
    expect(kept.data).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' })
    expect(kept.version).toBe(2)
    const ref = await first.credentialRef.findUniqueOrThrow({ where: { vaultPath: conn.path } })
    expect(ref.keyVersion).toBe(2)
    const row = await first.gitConnection.findUniqueOrThrow({ where: { id: conn.id } })
    expect(row.state).toBe('ok')
  })

  it('without the lock the second renewal would spend a used refresh token: a control', async () => {
    const vault = memoryVault()
    const endpoint = tokenEndpoint()
    const conn = await connection(vault)
    const connect = endpoint.connect()
    const answers = await Promise.all([
      connect.refreshAccess(app, 'refresh-0'),
      connect.refreshAccess(app, 'refresh-0'),
    ])
    expect(answers.filter((answer) => 'reauth' in answer)).toHaveLength(1)
    expect(conn.id).toBeTruthy()
  })

  it('a refused refresh is a new sign-in: reauth_needed and GIT_CONNECTION_REAUTH', async () => {
    const vault = memoryVault()
    const endpoint = tokenEndpoint()
    const conn = await connection(vault)
    await vault.secrets.kvWrite(conn.path, {
      accessToken: 'access-0',
      refreshToken: 'refresh-revoked',
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    })
    const source = new GitAuthSource({
      prisma: first,
      secrets: vault.secrets,
      connect: endpoint.connect,
      gitlabOauth: app,
    })
    const refused = await source.grantFor(conn).catch((error: unknown) => error)
    expect(isDomainError(refused) && refused.code).toBe('GIT_CONNECTION_REAUTH')
    const row = await first.gitConnection.findUniqueOrThrow({ where: { id: conn.id } })
    expect(row).toMatchObject({ state: 'reauth_needed', stateReason: 'reauth' })
    // The pair in Vault is left as it was: the next sign-in of web replaces it.
    expect(vault.keys.get(conn.path)!.data.refreshToken).toBe('refresh-revoked')
  })

  it('a fresh pair is used as it is, without the token endpoint', async () => {
    const vault = memoryVault()
    const endpoint = tokenEndpoint()
    const conn = await connection(vault)
    await vault.secrets.kvWrite(conn.path, {
      accessToken: 'access-fresh',
      refreshToken: 'refresh-0',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const source = new GitAuthSource({
      prisma: first,
      secrets: vault.secrets,
      connect: endpoint.connect,
      gitlabOauth: app,
    })
    expect(await source.grantFor(conn)).toEqual({ kind: 'token', token: 'access-fresh' })
    expect(endpoint.calls).toEqual([])
  })
})
