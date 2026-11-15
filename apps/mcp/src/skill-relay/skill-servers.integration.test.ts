import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { PostgresSkillServers } from './skill-servers.ts'

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const url = 'https://mcp.example.com/v1/mcp'

/**
 * The servers the relay serves, on PostgreSQL (docs/plan/80-mcp-server-credentials.md): only one
 * that is on, has authorization that works and belongs to the turn's site; its state is written
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
      await db.site.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
    }
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function site() {
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic relay', dataClass: 'synthetic' },
    })
    workspaces.push(workspace.id)
    const row = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Relay',
        url: 'https://fixture.invalid',
        stack: 'wordpress',
      },
    })
    return row.id
  }

  it('finds a server with a working key of its own site and nothing else', async () => {
    const siteId = await site()
    const other = await site()
    await db.siteAgentSkill.createMany({
      data: [
        { siteId, name: 'keyed', url, authKind: 'header', headerName: 'X-Api-Key' },
        { siteId, name: 'signed', url, authKind: 'oauth', oauth: { issuer: 'https://a.example' } },
        { siteId, name: 'open', url },
        { siteId, name: 'off', url, enabled: false, authKind: 'header', headerName: 'X-Key' },
        { siteId, name: 'login', url, authKind: 'oauth', authState: 'needs_login', oauth: {} },
      ],
    })
    expect(await store.find(siteId, 'keyed')).toEqual({
      url,
      authKind: 'header',
      headerName: 'X-Api-Key',
    })
    expect(await store.find(siteId, 'signed')).toEqual({ url, authKind: 'oauth', headerName: null })
    for (const name of ['open', 'off', 'login', 'missing'])
      expect(await store.find(siteId, name), name).toBeNull()
    expect(await store.find(other, 'keyed')).toBeNull()
  })

  it('writes the state of a server and never one without authorization', async () => {
    const siteId = await site()
    await db.siteAgentSkill.createMany({
      data: [
        { siteId, name: 'keyed', url, authKind: 'header', headerName: 'X-Api-Key' },
        { siteId, name: 'open', url },
      ],
    })
    const at = new Date('2026-11-15T10:00:00Z')
    await store.record(siteId, 'keyed', { state: 'failed', error: 'unauthorized', at })
    await store.record(siteId, 'open', { state: 'failed', error: 'unauthorized', at })
    const rows = await db.siteAgentSkill.findMany({
      where: { siteId },
      select: { name: true, authState: true, authError: true, authCheckedAt: true },
      orderBy: { name: 'asc' },
    })
    expect(rows).toEqual([
      { name: 'keyed', authState: 'failed', authError: 'unauthorized', authCheckedAt: at },
      { name: 'open', authState: 'ok', authError: null, authCheckedAt: null },
    ])
    // A failed server is not served until the owner fixes it.
    expect(await store.find(siteId, 'keyed')).toBeNull()
  })
})
