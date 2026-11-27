import { createHash, createHmac, randomUUID } from 'node:crypto'

import { createPrismaClient, enabledBuiltinMcp, type PrismaClient, type User } from '@repo/db'
import {
  legalDocuments,
  readVkConfirmToken,
  vkKeyInvalid,
  type KvMetadata,
  type ObjectStorage,
  type SecretStore,
  type VkCommunityInfo,
} from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createCaller } from '../router.ts'
import type { BuiltinMcpServices } from '../services/builtin-mcp.ts'
import type { ChatContext } from '../services/chat/context.ts'

// «Настройки → Встроенные MCP» on PostgreSQL (docs/plan/99-vk-community.md, ВК15): the router
// `builtinMcp`. Vault is a fake that can only write, as `sites-writer`; VK is a fake that names the
// community of a key and its rights.

const databaseUrl = process.env.DATABASE_URL
const mac = (material: string) =>
  createHmac('sha256', 'test-vk-confirm-secret-0123456789abcdef')
    .update(material)
    .digest('base64url')

const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)

/** A chat id is a UUID v7 (CHECK `tasks_chat_id_check`). */
function v7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function refusal(act: () => Promise<unknown>): Promise<string> {
  try {
    await act()
  } catch (error) {
    if (error instanceof TRPCError)
      return (error.cause as { code?: string } | undefined)?.code ?? error.code
    throw error
  }
  throw new Error('The procedure was not refused')
}

function writerVault() {
  const keys = new Map<string, { data: Record<string, string>; version: number }>()
  const secrets: BuiltinMcpServices['secrets'] = {
    kvWrite: async (path, data, options) => {
      const current = keys.get(path)
      if (options?.cas !== undefined && options.cas !== (current?.version ?? 0))
        throw new Error('cas mismatch')
      const version = (current?.version ?? 0) + 1
      keys.set(path, { data: { ...data }, version })
      return { version }
    },
    kvMetadata: async (path) => {
      const current = keys.get(path)
      return current
        ? ({
            currentVersion: current.version,
            custom: {},
            createdTime: new Date(),
            deleted: false,
            destroyed: false,
          } satisfies KvMetadata)
        : null
    },
  }
  return { keys, secrets }
}

/** VK as the fake sees it: each key names its community and its rights. */
const groups: Record<string, { community: VkCommunityInfo; rights: string[] }> = {
  'vk1.a.coffee-key-000001': {
    community: { groupId: 1001, name: 'Кофейня у дома', screenName: 'coffee', isClosed: false },
    rights: ['manage', 'wall'],
  },
  'vk1.a.coffee-key-000002': {
    community: { groupId: 1001, name: 'Кофейня у дома', screenName: 'coffee', isClosed: false },
    rights: ['wall'],
  },
  'vk1.a.bakery-key-000001': {
    community: { groupId: 2002, name: 'Пекарня', screenName: 'bakery', isClosed: true },
    rights: ['wall'],
  },
  'vk1.a.nowall-key-000001': {
    community: { groupId: 3003, name: 'Без стены', screenName: 'nowall', isClosed: false },
    rights: ['manage'],
  },
}

describe.skipIf(!databaseUrl)('PostgreSQL: the built-in MCP servers', () => {
  let db: PrismaClient
  const userIds: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const users = userIds.splice(0)
    const workspaces = await db.workspace.findMany({
      where: { createdById: { in: users } },
      select: { id: true },
    })
    const owned = { workspaceId: { in: workspaces.map(({ id }) => id) } }
    await db.outboxEvent.deleteMany({ where: { topic: 'vk' } })
    await db.vkAction.deleteMany({ where: owned })
    await db.vkReservation.deleteMany({ where: owned })
    await db.task.deleteMany({ where: owned })
    await db.vkCommunity.deleteMany({ where: owned })
    await db.workspaceBuiltinMcp.deleteMany({ where: owned })
    await db.credentialRef.deleteMany({ where: owned })
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.auditLog.deleteMany({ where: owned })
    await db.workspace.deleteMany({ where: { id: owned.workspaceId } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  const chat: ChatContext = {
    appEnv: 'test',
    browser: null,
    storage: () => ({}) as ObjectStorage,
    secrets: () => ({}) as SecretStore,
  }

  async function owner() {
    const user: User = await db.user.create({
      data: { name: 'Built-in MCP', email: `${randomUUID()}@vk.example.ru` },
    })
    userIds.push(user.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({ ...consent, userId: user.id, source: 'sign_up' })),
    })
    const vault = writerVault()
    let vkServers = 0
    const vk = {
      community: vi.fn(async (token: string) => {
        const group = groups[token]
        if (!group) throw vkKeyInvalid()
        return group.community
      }),
      tokenPermissions: vi.fn(async (token: string) => groups[token]?.rights ?? []),
      addCallbackServer: vi.fn(
        async (_token: string, _groupId: number, _server: { url: string; secretKey: string }) => ({
          serverId: 70 + vkServers++,
          confirmationCode: 'c0nf1rm',
        }),
      ),
      deleteCallbackServer: vi.fn(async () => undefined),
    }
    const caller = createCaller({
      prisma: db,
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `vk-test-${randomUUID()}`,
        expiresAt: new Date('2030-01-01'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
      billing: null,
      chat,
      builtinMcp: {
        secrets: vault.secrets,
        vk,
        confirmMac: mac,
        callbackUrl: (id: string) => `https://raditi.test/api/webhooks/vk/${id}`,
      },
    })
    return { user, caller, vault, vk }
  }

  it('lists «ВКонтакте» off, and does not turn it on without a key', async () => {
    const { caller } = await owner()
    const view = await caller.builtinMcp.list({})
    expect(view.servers).toEqual([
      expect.objectContaining({
        server: 'vk',
        title: 'ВКонтакте',
        enabled: false,
        needsKey: true,
        communities: [],
      }),
    ])
    expect(await refusal(() => caller.builtinMcp.switch({ server: 'vk', enabled: true }))).toBe(
      'BUILTIN_MCP_NEEDS_KEY',
    )
  })

  it('connects a community by its key, keeps the key in Vault alone and turns «ВКонтакте» on', async () => {
    const { caller, vault } = await owner()
    const view = await caller.builtinMcp.vkConnect({ token: ' vk1.a.coffee-key-000001 ' })
    const vk = view.servers[0]!
    expect(vk.enabled).toBe(true)
    expect(vk.communities).toEqual([
      {
        id: expect.any(String),
        name: 'Кофейня у дома',
        url: 'https://vk.com/coffee',
        closed: false,
        refused: false,
        notices: true,
      },
    ])
    const workspaceId = view.workspaceId!
    const id = vk.communities[0]!.id
    expect([...vault.keys.entries()]).toEqual([
      [
        `kv/workspaces/${workspaceId}/vk/${id}`,
        { data: { token: 'vk1.a.coffee-key-000001' }, version: 1 },
      ],
    ])
    const row = await db.vkCommunity.findUniqueOrThrow({
      where: { id },
      include: { credentialRef: true },
    })
    expect(row).toMatchObject({
      groupId: 1001n,
      permissions: ['manage', 'wall'],
      state: 'ok',
      // The Callback API (slice 99.6): the server of Raditi with the derived secret, and its code.
      callbackServerId: 70,
      callbackCode: 'c0nf1rm',
    })
    expect(row.credentialRef).toMatchObject({ kind: 'vk_community', keyVersion: 1, workspaceId })
    expect(
      JSON.stringify(row, (_key, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    ).not.toContain('coffee-key')
    await expect(enabledBuiltinMcp(db, workspaceId)).resolves.toEqual(['vk'])
  })

  it('replaces the key of a community connected already, and adds another', async () => {
    const { caller, vault, vk } = await owner()
    const first = await caller.builtinMcp.vkConnect({ token: 'vk1.a.coffee-key-000001' })
    const again = await caller.builtinMcp.vkConnect({ token: 'vk1.a.coffee-key-000002' })
    // The new key has no right «Управление»: no notices, and nothing is asked of the old server.
    expect(again.servers[0]!.communities[0]!.notices).toBe(false)
    expect(vk.addCallbackServer).toHaveBeenCalledTimes(1)
    expect(vk.addCallbackServer.mock.calls[0]![2]).toMatchObject({
      url: `https://raditi.test/api/webhooks/vk/${first.servers[0]!.communities[0]!.id}`,
      secretKey: expect.stringMatching(/^[A-Za-z0-9]{32}$/),
    })
    expect(again.servers[0]!.communities.map((group) => group.id)).toEqual(
      first.servers[0]!.communities.map((group) => group.id),
    )
    expect([...vault.keys.values()]).toEqual([
      { data: { token: 'vk1.a.coffee-key-000002' }, version: 2 },
    ])
    const two = await caller.builtinMcp.vkConnect({ token: 'vk1.a.bakery-key-000001' })
    expect(two.servers[0]!.communities.map((group) => [group.name, group.closed])).toEqual([
      ['Кофейня у дома', false],
      ['Пекарня', true],
    ])
  })

  it('keeps nothing of a key VK refuses or that has no right to the wall', async () => {
    const { caller, vault } = await owner()
    expect(
      await refusal(() => caller.builtinMcp.vkConnect({ token: 'vk1.a.unknown-key-0001' })),
    ).toBe('VK_KEY_INVALID')
    expect(
      await refusal(() => caller.builtinMcp.vkConnect({ token: 'vk1.a.nowall-key-000001' })),
    ).toBe('VK_KEY_NO_WALL')
    expect(await refusal(() => caller.builtinMcp.vkConnect({ token: 'short' }))).toBe(
      'VK_KEY_INVALID',
    )
    expect(vault.keys.size).toBe(0)
    expect((await caller.builtinMcp.list({})).servers[0]!.enabled).toBe(false)
  })

  it('switches «ВКонтакте» off and on again without a new key', async () => {
    const { caller } = await owner()
    const { workspaceId } = await caller.builtinMcp.vkConnect({ token: 'vk1.a.coffee-key-000001' })
    expect(
      (await caller.builtinMcp.switch({ server: 'vk', enabled: false })).servers[0]!.enabled,
    ).toBe(false)
    await expect(enabledBuiltinMcp(db, workspaceId!)).resolves.toEqual([])
    expect(
      (await caller.builtinMcp.switch({ server: 'vk', enabled: true })).servers[0]!.enabled,
    ).toBe(true)
  })

  it('erases the key of a disconnected community, and the last one turns «ВКонтакте» off', async () => {
    const { caller, vault } = await owner()
    const view = await caller.builtinMcp.vkConnect({ token: 'vk1.a.coffee-key-000001' })
    const id = view.servers[0]!.communities[0]!.id
    const after = await caller.builtinMcp.vkDisconnect({ communityId: id })
    expect(after.servers[0]).toMatchObject({ enabled: false, communities: [] })
    const [kept] = [...vault.keys.values()]
    expect(kept!.data).not.toHaveProperty('token')
    expect(await db.credentialRef.count({ where: { workspaceId: view.workspaceId! } })).toBe(0)
    expect(await refusal(() => caller.builtinMcp.vkDisconnect({ communityId: id }))).toBe(
      'VK_COMMUNITY_NOT_FOUND',
    )
  })

  it('lets only an owner or an admin change them', async () => {
    const { caller, user } = await owner()
    const { workspaceId } = await caller.builtinMcp.vkConnect({ token: 'vk1.a.coffee-key-000001' })
    const member = await owner()
    await db.member.create({
      data: { workspaceId: workspaceId!, userId: member.user.id, role: 'member' },
    })
    expect(user.id).not.toBe(member.user.id)
    const view = await member.caller.builtinMcp.list({ workspaceId: workspaceId! })
    expect(view.canManage).toBe(false)
    expect(
      await refusal(() =>
        member.caller.builtinMcp.switch({
          workspaceId: workspaceId!,
          server: 'vk',
          enabled: false,
        }),
      ),
    ).toBe('BUILTIN_MCP_NOT_ALLOWED')
  })

  it('publishes a card by a signed press: one row, one job, once, the edited text named by its hash', async () => {
    const { caller, user } = await owner()
    const view = await caller.builtinMcp.vkConnect({ token: 'vk1.a.coffee-key-000001' })
    const workspaceId = view.workspaceId!
    const communityId = view.servers[0]!.communities[0]!.id
    const task = await db.task.create({
      data: {
        id: v7(),
        workspaceId,
        createdById: user.id,
        status: 'awaiting_user',
        title: 'Новости кофейни',
      },
    })
    const reservation = await db.vkReservation.create({
      data: {
        id: randomUUID(),
        workspaceId,
        taskId: task.id,
        turnNo: 1,
        communityId,
        kind: 'post',
        payload: { kind: 'post', text: 'Мы открылись!', publishAt: null },
        outcome: 'done',
        reason: 'shown',
        closedAt: new Date(),
      },
    })
    const { actionId } = await caller.builtinMcp.vkPublish({
      reservedId: reservation.id,
      text: 'Мы открылись! Ждём вас.',
    })
    const action = await db.vkAction.findUniqueOrThrow({ where: { id: actionId } })
    expect(action).toMatchObject({
      state: 'queued',
      kind: 'post',
      createdById: user.id,
      communityId,
    })
    const args = action.args as { token: string; text: string }
    expect(args.text).toBe('Мы открылись! Ждём вас.')
    const claims = readVkConfirmToken(args.token, mac, new Date())
    expect(claims).toMatchObject({
      userId: user.id,
      reservationId: reservation.id,
      textSha256: createHash('sha256').update('Мы открылись! Ждём вас.').digest('hex'),
    })
    expect(
      await db.outboxEvent.count({ where: { topic: 'vk', dedupeKey: `vk.action:${actionId}` } }),
    ).toBe(1)
    // One publication a card.
    expect(
      await refusal(() =>
        caller.builtinMcp.vkPublish({ reservedId: reservation.id, text: 'Ещё раз' }),
      ),
    ).toBe('VK_ALREADY_PUBLISHED')
    // A member who does not manage the workspace sees the chat of nobody here: not found.
    const stranger = await owner()
    expect(
      await refusal(() =>
        stranger.caller.builtinMcp.vkPublish({ reservedId: reservation.id, text: 'x' }),
      ),
    ).toBe('NOT_FOUND')
    // Disconnecting the community keeps the press and what it did (rule 4).
    await caller.builtinMcp.vkDisconnect({ communityId })
    await expect(db.vkAction.findUniqueOrThrow({ where: { id: actionId } })).resolves.toMatchObject(
      {
        communityId: null,
        tokenSha256: action.tokenSha256,
      },
    )
  })
})
