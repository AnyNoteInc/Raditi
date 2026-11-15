import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createPrismaClient } from './client.ts'
import type { PrismaClient } from './generated/prisma/client.ts'

const databaseUrl = process.env.DATABASE_URL

// The authorization of an MCP server of a site's agent (docs/plan/80-mcp-server-credentials.md):
// the CHECKs of migration 20261115110100_site_agent_skill_auth.
describe.skipIf(!databaseUrl)('PostgreSQL authorization of MCP servers', () => {
  let db: PrismaClient
  const workspaces: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    for (const workspaceId of workspaces.splice(0)) {
      await db.credentialRef.deleteMany({ where: { workspaceId } })
      await db.site.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
    }
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function site() {
    const workspace = await db.workspace.create({ data: { name: 'Synthetic MCP auth check' } })
    workspaces.push(workspace.id)
    const row = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'MCP auth',
        url: 'https://fixture.invalid',
        stack: 'wordpress',
      },
    })
    return { siteId: row.id, workspaceId: workspace.id }
  }

  const url = 'https://mcp.example.com/mcp'
  const checkFailed = (error: unknown) =>
    expect(String((error as Error).message)).toMatch(/site_agent_skills_auth|23514|check/i)

  it('keeps a server without authorization as before and takes a header and a sign-in', async () => {
    const { siteId } = await site()
    const plain = await db.siteAgentSkill.create({ data: { siteId, name: 'plain', url } })
    expect(plain).toMatchObject({ authKind: 'none', authState: 'ok', headerName: null })
    await db.siteAgentSkill.create({
      data: { siteId, name: 'keyed', url, authKind: 'header', headerName: 'X-Api-Key' },
    })
    await db.siteAgentSkill.create({
      data: {
        siteId,
        name: 'signed',
        url,
        authKind: 'oauth',
        authState: 'needs_login',
        authError: 'token_refused',
        oauth: { issuer: 'https://auth.example.com', clientId: 'abc' },
      },
    })
    expect(await db.siteAgentSkill.count({ where: { siteId } })).toBe(3)
  })

  it.each([
    ['a header without its name', { authKind: 'header' as const }],
    [
      'a header with a name that is no HTTP token',
      { authKind: 'header' as const, headerName: 'Bad Name' },
    ],
    [
      'a header with OAuth metadata',
      { authKind: 'header' as const, headerName: 'X-Key', oauth: {} },
    ],
    ['a sign-in without its metadata', { authKind: 'oauth' as const }],
    ['a sign-in with a header', { authKind: 'oauth' as const, oauth: {}, headerName: 'X-Key' }],
    ['no authorization with a header name', { headerName: 'X-Key' }],
    ['no authorization that needs a sign-in', { authState: 'needs_login' as const }],
    ['an error that is not a code', { authError: 'The server said: no' }],
  ])('refuses %s', async (_, data) => {
    const { siteId } = await site()
    const error = await db.siteAgentSkill
      .create({ data: { siteId, name: 'bad', url, ...data } })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(error).not.toBeNull()
    checkFailed(error)
  })

  it('never gives a platform skill an authorization', async () => {
    const { siteId } = await site()
    const error = await db.siteAgentSkill
      .create({
        data: { siteId, name: 'context7', url: null, authKind: 'header', headerName: 'X-Key' },
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(error).not.toBeNull()
    checkFailed(error)
  })

  it('ties the secret of a server to its site', async () => {
    const { siteId, workspaceId } = await site()
    await db.credentialRef.create({
      data: { workspaceId, siteId, kind: 'mcp_server', vaultPath: `kv/sites/${siteId}/mcp/keyed` },
    })
    const error = await db.credentialRef
      .create({ data: { workspaceId, kind: 'mcp_server', vaultPath: `kv/x/${siteId}` } })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(String((error as Error | null)?.message)).toMatch(/credential_refs_site_scope|check/i)
  })
})
