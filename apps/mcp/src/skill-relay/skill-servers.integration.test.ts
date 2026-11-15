import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { PostgresSkillServers } from './skill-servers.ts'

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const url = 'https://mcp.example.com/v1/mcp'

/**
 * The servers the relay serves, on PostgreSQL (docs/plan/81-mcp-server-credentials.md): only one
 * that is on, has authorization that works and belongs to the turn's workspace; its state is written
 * back and a server turned to no authorization meanwhile is left alone.
 */
describe.skipIf(!enabled)('the servers of the MCP relay with PostgreSQL', () => {
  let db: PrismaClient
  let store: PostgresSkillServers
  const workspaces: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    store = new PostgresSkillServers(db)
  })
  afterEach(async () => {
    for (const workspaceId of workspaces.splice(0)) {
      await db.workspace.delete({ where: { id: workspaceId } })
    }
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function space() {
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic relay', dataClass: 'synthetic' },
    })
    workspaces.push(workspace.id)
    return workspace.id
  }

  const signIn = {
    issuer: 'https://auth.example.com',
    tokenEndpoint: 'https://auth.example.com/token',
    clientId: 'client-1',
    resource: url,
  }

  it('finds a server with a working key of its own workspace and nothing else', async () => {
    const workspaceId = await space()
    const other = await space()
    await db.workspaceAgentSkill.createMany({
      data: [
        { workspaceId, name: 'keyed', url, authKind: 'header', headerName: 'X-Api-Key' },
        { workspaceId, name: 'signed', url, authKind: 'oauth', oauth: signIn },
        { workspaceId, name: 'broken', url, authKind: 'oauth', oauth: { issuer: 'https://a.example' } },
        { workspaceId, name: 'open', url },
        { workspaceId, name: 'off', url, enabled: false, authKind: 'header', headerName: 'X-Key' },
        { workspaceId, name: 'login', url, authKind: 'oauth', authState: 'needs_login', oauth: signIn },
      ],
    })
    const ok = { state: 'ok', error: null }
    expect(await store.find(workspaceId, 'keyed')).toEqual({
      url,
      authKind: 'header',
      headerName: 'X-Api-Key',
      ...ok,
      oauth: null,
    })
    expect(await store.find(workspaceId, 'signed')).toEqual({
      url,
      authKind: 'oauth',
      headerName: null,
      ...ok,
      oauth: signIn,
    })
    // A server that needs a sign-in is found, with its state: the relay says why it is not served.
    expect(await store.find(workspaceId, 'login')).toMatchObject({ state: 'needs_login' })
    // Metadata of a sign-in that does not parse: nowhere to renew its token, not served.
    for (const name of ['open', 'off', 'missing', 'broken'])
      expect(await store.find(workspaceId, name), name).toBeNull()
    expect(await store.find(other, 'keyed')).toBeNull()
  })

  it('writes the state of a server and never one without authorization', async () => {
    const workspaceId = await space()
    await db.workspaceAgentSkill.createMany({
      data: [
        { workspaceId, name: 'keyed', url, authKind: 'header', headerName: 'X-Api-Key' },
        { workspaceId, name: 'open', url },
      ],
    })
    const at = new Date('2026-11-15T10:00:00Z')
    await store.record(workspaceId, 'keyed', { state: 'failed', error: 'unauthorized', at })
    await store.record(workspaceId, 'open', { state: 'failed', error: 'unauthorized', at })
    const rows = await db.workspaceAgentSkill.findMany({
      where: { workspaceId },
      select: { name: true, authState: true, authError: true, authCheckedAt: true },
      orderBy: { name: 'asc' },
    })
    expect(rows).toEqual([
      { name: 'keyed', authState: 'failed', authError: 'unauthorized', authCheckedAt: at },
      { name: 'open', authState: 'ok', authError: null, authCheckedAt: null },
    ])
    // A failed server is not served until the owner fixes it; the relay reads why.
    expect(await store.find(workspaceId, 'keyed')).toMatchObject({
      state: 'failed',
      error: 'unauthorized',
    })
  })
})
