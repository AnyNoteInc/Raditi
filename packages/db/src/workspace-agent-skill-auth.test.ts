import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createPrismaClient } from './client.ts'
import type { PrismaClient } from './generated/prisma/client.ts'

const databaseUrl = process.env.DATABASE_URL

// The authorization of an MCP server of a workspace's agent (docs/plan/81-mcp-server-credentials.md;
// per workspace since plan 83, БП11): the CHECKs of migration 20261116120100_workspace_agent_skills.
describe.skipIf(!databaseUrl)('PostgreSQL authorization of MCP servers', () => {
  let db: PrismaClient
  const workspaces: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    for (const workspaceId of workspaces.splice(0)) {
      await db.credentialRef.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
    }
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function space() {
    const workspace = await db.workspace.create({ data: { name: 'Synthetic MCP auth check' } })
    workspaces.push(workspace.id)
    return { workspaceId: workspace.id }
  }

  const url = 'https://mcp.example.com/mcp'
  const checkFailed = (error: unknown) =>
    expect(String((error as Error).message)).toMatch(/workspace_agent_skills_auth|23514|check/i)

  it('keeps a server without authorization as before and takes a header and a sign-in', async () => {
    const { workspaceId } = await space()
    const plain = await db.workspaceAgentSkill.create({ data: { workspaceId, name: 'plain', url } })
    expect(plain).toMatchObject({ authKind: 'none', authState: 'ok', headerName: null })
    await db.workspaceAgentSkill.create({
      data: { workspaceId, name: 'keyed', url, authKind: 'header', headerName: 'X-Api-Key' },
    })
    await db.workspaceAgentSkill.create({
      data: {
        workspaceId,
        name: 'signed',
        url,
        authKind: 'oauth',
        authState: 'needs_login',
        authError: 'token_refused',
        oauth: { issuer: 'https://auth.example.com', clientId: 'abc' },
      },
    })
    expect(await db.workspaceAgentSkill.count({ where: { workspaceId } })).toBe(3)
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
    const { workspaceId } = await space()
    const error = await db.workspaceAgentSkill
      .create({ data: { workspaceId, name: 'bad', url, ...data } })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(error).not.toBeNull()
    checkFailed(error)
  })

  it('never gives a platform skill an authorization', async () => {
    const { workspaceId } = await space()
    const error = await db.workspaceAgentSkill
      .create({
        data: { workspaceId, name: 'context7', url: null, authKind: 'header', headerName: 'X-Key' },
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(error).not.toBeNull()
    checkFailed(error)
  })

  it('ties the secret of a server to its workspace and no other reference to one', async () => {
    const { workspaceId } = await space()
    await db.credentialRef.create({
      data: {
        workspaceId,
        kind: 'mcp_server',
        vaultPath: `kv/workspaces/${workspaceId}/mcp/keyed`,
      },
    })
    const refused = (data: Parameters<typeof db.credentialRef.create>[0]['data']) =>
      db.credentialRef.create({ data }).then(
        () => null,
        (caught: unknown) => caught,
      )
    for (const error of [
      await refused({ kind: 'mcp_server', vaultPath: `kv/x/${workspaceId}/a` }),
      await refused({ workspaceId, kind: 'subscription', vaultPath: `kv/x/${workspaceId}/b` }),
    ])
      expect(String((error as Error | null)?.message)).toMatch(/credential_refs_platform_scope|check/i)
  })
})
