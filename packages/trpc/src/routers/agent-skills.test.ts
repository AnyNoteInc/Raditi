import { randomUUID } from 'node:crypto'

import type { PrismaClient, User } from '@repo/db'
import { legalDocuments } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { createCaller } from '../router.ts'
import { connectSignedInServer } from '../services/agent-skills.ts'
import type { ChatContext } from '../services/chat/context.ts'
import type { McpServerCheck, McpServerServices } from '../services/mcp-server-auth.ts'
import type { Context } from '../trpc.ts'

const now = new Date('2026-10-26T09:00:00Z')
const user: User = {
  id: randomUUID(),
  name: 'Анна',
  lastName: null,
  email: 'site-skills-test@example.ru',
  emailVerified: true,
  agentMemory: true,
  image: null,
  timezone: null,
  createdAt: now,
  updatedAt: now,
}
const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)
const workspaceId = randomUUID()
type Row = {
  name: string
  url: string | null
  enabled: boolean
  authKind?: 'none' | 'header' | 'oauth'
  headerName?: string | null
}

/** Vault that can only write, and a check of the server that answers as told. */
function mcpServers(check: McpServerCheck = { ok: true, tools: 3 }) {
  const vault: { path: string; data: Record<string, string>; cas: number | undefined }[] = []
  const versions = new Map<string, number>()
  const services: McpServerServices = {
    secrets: {
      kvMetadata: vi.fn(async (path: string) =>
        versions.has(path)
          ? {
              currentVersion: versions.get(path)!,
              createdTime: now,
              updatedTime: now,
              customMetadata: {},
            }
          : null,
      ) as McpServerServices['secrets']['kvMetadata'],
      kvWrite: vi.fn(async (path: string, data: Record<string, string>, options) => {
        vault.push({ path, data, cas: options?.cas })
        const version = (versions.get(path) ?? 0) + 1
        versions.set(path, version)
        return { version }
      }),
    },
    probe: vi.fn(async () => check),
  }
  return { services, vault, versions }
}

function setup(
  role: string | null = 'owner',
  rows: Row[] = [],
  services: McpServerServices | null = null,
) {
  const audits: unknown[] = []
  const writes: unknown[] = []
  const stored = rows.map((row) => ({
    authKind: 'none',
    headerName: null,
    authState: 'ok',
    authError: null,
    ...row,
  }))
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    workspaceAgentSkill: { findMany: vi.fn(async () => stored) },
    member: {
      findUnique: vi.fn().mockResolvedValue(role ? { role } : null),
      findFirst: vi.fn().mockResolvedValue(role ? { role } : null),
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        workspaceAgentSkill: {
          upsert: async (args: unknown) => writes.push(['upsert', args]),
          create: async (args: unknown) => writes.push(['create', args]),
          update: async (args: unknown) => writes.push(['update', args]),
          delete: async (args: unknown) => writes.push(['delete', args]),
        },
        credentialRef: {
          upsert: async (args: unknown) => writes.push(['credentialRef.upsert', args]),
          deleteMany: async (args: unknown) => writes.push(['credentialRef.deleteMany', args]),
        },
        auditLog: { create: async (args: unknown) => audits.push(args) },
      }),
  }
  const context: Context = {
    prisma: db as unknown as PrismaClient,
    headers: new Headers(),
    user,
    session: {
      id: randomUUID(),
      userId: user.id,
      token: 'site-skills-test-session',
      expiresAt: new Date('2030-01-01'),
      createdAt: now,
      updatedAt: now,
    },
    billing: null,
    chat: { appEnv: 'test' } as ChatContext,
    mcpServers: services,
  }
  return { db, audits, writes, caller: createCaller(context) }
}

describe('agentSkills', () => {
  it('shows the platform skills on by default, then the added ones by name', async () => {
    const { caller } = setup('member', [
      { name: 'zeta', url: 'https://zeta.example.org/mcp', enabled: false },
      { name: 'context7', url: null, enabled: false },
      { name: 'alpha', url: 'https://alpha.example.org/mcp', enabled: true },
    ])
    const view = await caller.agentSkills.list({ workspaceId })
    expect(view.canManage).toBe(false)
    expect(view.addable).toBe(6)
    expect(view.skills.map(({ name, builtin, enabled }) => [name, builtin, enabled])).toEqual([
      ['context7', true, false],
      ['playwright', true, true],
      ['alpha', false, true],
      ['zeta', false, false],
    ])
    expect(view.skills[1]).toMatchObject({ title: 'Playwright', url: null })
  })

  it('switches a platform skill with a row of its own, and audits it', async () => {
    const { audits, writes, caller } = setup()
    const view = await caller.agentSkills.switch({
      workspaceId,
      name: 'playwright',
      enabled: false,
    })
    expect(view.canManage).toBe(true)
    expect(writes).toEqual([
      [
        'upsert',
        {
          where: { workspaceId_name: { workspaceId, name: 'playwright' } },
          create: { workspaceId, name: 'playwright', url: null, enabled: false },
          update: { enabled: false },
        },
      ],
    ])
    expect(audits).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'workspace.agent_skill.switch',
          meta: { name: 'playwright', enabled: false },
        }),
      }),
    ])
  })

  it('adds a remote skill by its kept address, and refuses anything secret or private', async () => {
    const { writes, caller } = setup()
    await caller.agentSkills.add({
      workspaceId,
      name: ' Docs ',
      url: ' https://Docs.Example.org/mcp ',
    })
    expect(writes).toEqual([
      ['create', { data: { workspaceId, name: 'docs', url: 'https://docs.example.org/mcp' } }],
    ])
    for (const url of [
      'http://docs.example.org/mcp',
      'https://docs.example.org/mcp?api_key=1',
      'https://user:pw@docs.example.org/mcp',
      'https://10.0.0.1/mcp',
      'https://vault.internal/mcp',
    ])
      await expect(
        caller.agentSkills.add({ workspaceId, name: 'other', url }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    for (const name of ['raditi-docs', 'my_docs', ''])
      await expect(
        caller.agentSkills.add({ workspaceId, name, url: 'https://docs.example.org/mcp' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.agentSkills.add({
        workspaceId,
        name: 'context7',
        url: 'https://docs.example.org/mcp',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(writes).toHaveLength(1)
  })

  it('keeps the number of added skills bounded and their names unique', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      name: `s${index}`,
      url: `https://s${index}.example.org/mcp`,
      enabled: true,
    }))
    const { writes, caller } = setup('admin', rows)
    expect((await caller.agentSkills.list({ workspaceId })).addable).toBe(0)
    await expect(
      caller.agentSkills.add({ workspaceId, name: 'more', url: 'https://more.example.org/mcp' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      caller.agentSkills.add({ workspaceId, name: 's1', url: 'https://more.example.org/mcp' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(writes).toEqual([])
  })

  it('removes an added skill, never a platform one', async () => {
    const { writes, caller } = setup('owner', [
      { name: 'docs', url: 'https://docs.example.org/mcp', enabled: true },
    ])
    await caller.agentSkills.remove({ workspaceId, name: 'docs' })
    expect(writes).toEqual([
      ['delete', { where: { workspaceId_name: { workspaceId, name: 'docs' } } }],
      [
        'credentialRef.deleteMany',
        { where: { workspaceId, vaultPath: `kv/workspaces/${workspaceId}/mcp/docs` } },
      ],
    ])
    await expect(
      caller.agentSkills.remove({ workspaceId, name: 'context7' }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(caller.agentSkills.remove({ workspaceId, name: 'nothing' })).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
      },
    )
    await expect(
      caller.agentSkills.switch({ workspaceId, name: 'nothing', enabled: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('lets only an owner or an admin change them', async () => {
    const { writes, caller } = setup('member')
    await expect(
      caller.agentSkills.switch({ workspaceId, name: 'context7', enabled: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      caller.agentSkills.add({ workspaceId, name: 'docs', url: 'https://docs.example.org/mcp' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(writes).toEqual([])
  })

  it('adds a server with a key: checked against the server, written to Vault, never kept in a row', async () => {
    const { services, vault } = mcpServers()
    const { writes, audits, caller } = setup('owner', [], services)
    const view = await caller.agentSkills.add({
      workspaceId,
      name: 'menu',
      url: 'https://mcp.krosha.example:8443/api/v1/mcp',
      header: { headerName: 'X-Api-Key', value: 'sk_live_0123456789' },
    })
    expect(services.probe).toHaveBeenCalledWith({
      url: 'https://mcp.krosha.example:8443/api/v1/mcp',
      header: { name: 'X-Api-Key', value: 'sk_live_0123456789' },
    })
    const path = `kv/workspaces/${workspaceId}/mcp/menu`
    expect(vault).toEqual([{ path, data: { value: 'sk_live_0123456789' }, cas: 0 }])
    expect(writes).toEqual([
      [
        'create',
        {
          data: {
            workspaceId,
            name: 'menu',
            url: 'https://mcp.krosha.example:8443/api/v1/mcp',
            authKind: 'header',
            headerName: 'X-Api-Key',
            authCheckedAt: expect.any(Date),
          },
        },
      ],
      [
        'credentialRef.upsert',
        {
          where: { vaultPath: path },
          create: { workspaceId, kind: 'mcp_server', vaultPath: path, keyVersion: 1 },
          update: { keyVersion: 1 },
        },
      ],
    ])
    // The key is in no row, no audit and no answer.
    expect(JSON.stringify([writes, audits, view])).not.toContain('sk_live_0123456789')
    expect(audits).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'workspace.agent_skill.add',
          meta: {
            name: 'menu',
            url: 'https://mcp.krosha.example:8443/api/v1/mcp',
            header: 'X-Api-Key',
          },
        }),
      }),
    ])
  })

  it('keeps nothing when the server refuses the key, and says why', async () => {
    const { services, vault } = mcpServers({ ok: false, reason: 'unauthorized' })
    const { writes, caller } = setup('owner', [], services)
    await expect(
      caller.agentSkills.add({
        workspaceId,
        name: 'menu',
        url: 'https://mcp.krosha.example/mcp',
        header: { headerName: 'Authorization', value: 'Bearer wrong-key-123' },
      }),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      message: 'Сервер не принял ключ. Проверьте имя заголовка и ключ и попробуйте снова',
    })
    expect(vault).toEqual([])
    expect(writes).toEqual([])
  })

  it('refuses a header the relay owns and a key it could not mask, before asking the server', async () => {
    const { services } = mcpServers()
    const { caller } = setup('owner', [], services)
    for (const header of [
      { headerName: 'Cookie', value: 'session=0123456789' },
      { headerName: 'X-Api-Key', value: 'short' },
      { headerName: 'X-Api-Key', value: 'two\nlines-of-key' },
    ])
      await expect(
        caller.agentSkills.add({
          workspaceId,
          name: 'menu',
          url: 'https://mcp.example.org/mcp',
          header,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(services.probe).not.toHaveBeenCalled()
    const { caller: offline } = setup('owner', [], null)
    await expect(
      offline.agentSkills.add({
        workspaceId,
        name: 'menu',
        url: 'https://mcp.example.org/mcp',
        header: { headerName: 'X-Api-Key', value: 'sk_live_0123456789' },
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('replaces a key over the old one and makes the server work again', async () => {
    const { services, vault, versions } = mcpServers()
    const path = `kv/workspaces/${workspaceId}/mcp/menu`
    versions.set(path, 2)
    const { writes, caller } = setup(
      'admin',
      [
        {
          name: 'menu',
          url: 'https://mcp.example.org/mcp',
          enabled: true,
          authKind: 'header',
          headerName: 'X-Api-Key',
        },
      ],
      services,
    )
    await caller.agentSkills.key({
      workspaceId,
      name: 'menu',
      header: { headerName: 'X-Api-Key', value: 'sk_live_new_0123456' },
    })
    expect(vault).toEqual([{ path, data: { value: 'sk_live_new_0123456' }, cas: 2 }])
    expect(writes[0]).toEqual([
      'update',
      {
        where: { workspaceId_name: { workspaceId, name: 'menu' } },
        data: {
          headerName: 'X-Api-Key',
          authState: 'ok',
          authError: null,
          authCheckedAt: expect.any(Date),
        },
      },
    ])
    await expect(
      setup(
        'owner',
        [{ name: 'open', url: 'https://mcp.example.org/mcp', enabled: true }],
        services,
      ).caller.agentSkills.key({
        workspaceId,
        name: 'open',
        header: { headerName: 'X-Api-Key', value: 'sk_live_new_0123456' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('erases the key of a removed server before its row goes', async () => {
    const { services, vault, versions } = mcpServers()
    const path = `kv/workspaces/${workspaceId}/mcp/menu`
    versions.set(path, 1)
    const { writes, caller } = setup(
      'owner',
      [
        {
          name: 'menu',
          url: 'https://mcp.example.org/mcp',
          enabled: true,
          authKind: 'header',
          headerName: 'X-Api-Key',
        },
      ],
      services,
    )
    await caller.agentSkills.remove({ workspaceId, name: 'menu' })
    expect(vault).toEqual([{ path, data: { removed: expect.any(String) }, cas: 1 }])
    expect((writes as unknown[][]).map(([kind]) => kind)).toEqual([
      'delete',
      'credentialRef.deleteMany',
    ])
  })

  it('lets a sign-in start for a new name or a server that signs in again, never over another', async () => {
    const url = 'https://mcp.example.org/mcp'
    const { caller } = setup('owner', [
      { name: 'signed', url, enabled: true, authKind: 'oauth' },
      { name: 'keyed', url, enabled: true, authKind: 'header', headerName: 'X-Key' },
    ])
    expect(await caller.agentSkills.signInCheck({ workspaceId, name: ' Menu ', url })).toEqual({
      workspaceId,
      name: 'menu',
      url,
    })
    expect(await caller.agentSkills.signInCheck({ workspaceId, name: 'signed', url })).toEqual({
      workspaceId,
      name: 'signed',
      url,
    })
    await expect(
      caller.agentSkills.signInCheck({ workspaceId, name: 'keyed', url }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(
      caller.agentSkills.signInCheck({
        workspaceId,
        name: 'signed',
        url: 'https://other.example.org/mcp',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      setup('member').caller.agentSkills.signInCheck({ workspaceId, name: 'menu', url }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('connects a signed-in server: checked with its token, tokens to Vault, the rest in the row', async () => {
    const { services, vault } = mcpServers()
    const { db, writes, audits } = setup('owner', [], services)
    const url = 'https://mcp.example.org/mcp'
    await connectSignedInServer(db as unknown as PrismaClient, services, {
      appEnv: 'test',
      userId: user.id,
      workspaceId,
      name: 'menu',
      url,
      ip: null,
      now,
      tokens: { accessToken: 'access-token-1', refreshToken: 'refresh-token-1', expiresIn: 3600 },
      oauth: {
        issuer: 'https://auth.example.org',
        tokenEndpoint: 'https://auth.example.org/token',
        clientId: 'client-1',
        resource: url,
      },
    })
    expect(services.probe).toHaveBeenCalledWith({
      url,
      header: { name: 'Authorization', value: 'Bearer access-token-1' },
    })
    expect(vault).toEqual([
      {
        path: `kv/workspaces/${workspaceId}/mcp/menu`,
        data: { accessToken: 'access-token-1', refreshToken: 'refresh-token-1' },
        cas: 0,
      },
    ])
    expect(writes[0]).toEqual([
      'upsert',
      expect.objectContaining({
        create: expect.objectContaining({
          name: 'menu',
          authKind: 'oauth',
          oauth: {
            issuer: 'https://auth.example.org',
            tokenEndpoint: 'https://auth.example.org/token',
            clientId: 'client-1',
            resource: url,
            expiresAt: '2026-10-26T10:00:00.000Z',
          },
        }),
      }),
    ])
    expect(JSON.stringify([writes, audits])).not.toMatch(/access-token-1|refresh-token-1/)
  })

  it('keeps no token of a server that does not answer with it', async () => {
    const { services, vault } = mcpServers({ ok: false, reason: 'unauthorized' })
    const { db } = setup('owner', [], services)
    await expect(
      connectSignedInServer(db as unknown as PrismaClient, services, {
        appEnv: 'test',
        userId: user.id,
        workspaceId,
        name: 'menu',
        url: 'https://mcp.example.org/mcp',
        ip: null,
        tokens: { accessToken: 'access-token-1' },
        oauth: {
          issuer: 'i',
          tokenEndpoint: 'https://auth.example.org/token',
          clientId: 'c',
          resource: 'r',
        },
      }),
    ).rejects.toMatchObject({ code: 'AGENT_SKILL_CHECK_FAILED' })
    expect(vault).toEqual([])
  })
})
