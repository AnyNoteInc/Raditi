import { randomUUID } from 'node:crypto'

import { findPersonalWorkspace, setBuiltinMcp, type PrismaClient } from '@repo/db'
import {
  builtinMcpServerInfo,
  builtinMcpServers,
  DomainError,
  vkCommunityLimit,
  vkCommunityNotFound,
  vkCommunitySecretPath,
  vkKeyNoWall,
  vkLimits,
  vkTokenSchema,
  VK_TOKEN_FIELD,
  workspaceEnvVarTombstone,
  type AppEnv,
  type BuiltinMcpServer,
  type SecretStore,
  type VkApi,
  type VkConfirmMac,
} from '@repo/domain'

import { isManagerRole, memberRole } from './chat/access.ts'
import { personalWorkspaceOf } from './chat/dialog-lock.ts'
import { workspaceNotFound } from './chat/refusals.ts'

// «Настройки → Встроенные MCP» of a workspace (docs/plan/99-vk-community.md, ВК15, ВК16): the
// built-in servers of Raditi, each with its switch. Every member reads them; an owner or an admin
// switches them and connects their keys. A server that needs a key is turned on only with one: its
// form connects the key and turns it on together. A server that is off is not in a turn at all
// (the admission of mcp reads `workspace_builtin_mcp`).
//
// «ВКонтакте»: a community is connected by its key. Web checks the key against VK itself — the
// community it names and the right «Стена» — then writes it to Vault by a writer that cannot read it
// back, and only then the rows. A key VK refuses is never kept.

/** What the procedures reach outside the database. The app builds it once. */
export interface BuiltinMcpServices {
  /** Two methods of Vault: nothing that holds this object can read a key back (`sites-writer`). */
  secrets: Pick<SecretStore, 'kvWrite' | 'kvMetadata'>
  /** The check of a community key against VK. */
  vk: Pick<VkApi, 'community' | 'tokenPermissions'>
  /**
   * HMAC-SHA256 by VK_CONFIRM_SECRET, base64url: the press of «Опубликовать» on a card of VK.
   * null or absent — no card publishes; core checks every press again.
   */
  confirmMac?: VkConfirmMac | null
}

export const builtinMcpUnavailable = () =>
  new DomainError(
    'BUILTIN_MCP_UNAVAILABLE',
    'Keys of built-in servers cannot be connected here',
    503,
  )
export const builtinMcpNotAllowed = () =>
  new DomainError(
    'BUILTIN_MCP_NOT_ALLOWED',
    'Only an owner or an admin changes the built-in servers',
    403,
  )
/** A server that needs a key is turned on by connecting one. */
export const builtinMcpNeedsKey = () =>
  new DomainError('BUILTIN_MCP_NEEDS_KEY', 'Connect a key to turn this server on', 409)

export interface VkCommunityView {
  id: string
  name: string
  url: string
  closed: boolean
  /** The key VK refused at the last check: connect a new one. */
  refused: boolean
}

export interface BuiltinMcpServerView {
  server: BuiltinMcpServer
  title: string
  summary: string
  needsKey: boolean
  enabled: boolean
  /** «ВКонтакте» alone has them; [] for any other. */
  communities: VkCommunityView[]
}

export interface BuiltinMcpView {
  servers: BuiltinMcpServerView[]
  canManage: boolean
  /** null — the user has no workspace yet: the first change makes it. */
  workspaceId: string | null
  /** More communities the workspace may connect. */
  communitiesLeft: number
}

interface Place {
  appEnv: AppEnv
  userId: string
  /** Absent — the user's personal workspace. */
  workspaceId?: string | undefined
}

async function workspaceOf(db: PrismaClient, place: Place, create: boolean) {
  let id = place.workspaceId
  if (id === undefined) {
    const personal = create
      ? await personalWorkspaceOf(db, { userId: place.userId, appEnv: place.appEnv })
      : await findPersonalWorkspace(db, { userId: place.userId, appEnv: place.appEnv })
    if (personal === null) return null
    id = personal.id
  }
  const role = await memberRole(db, id, place.userId)
  if (role === null) throw workspaceNotFound()
  return { id, canManage: isManagerRole(role) }
}

async function managed(db: PrismaClient, place: Place): Promise<{ id: string }> {
  const workspace = await workspaceOf(db, place, true)
  if (workspace === null) throw workspaceNotFound()
  if (!workspace.canManage) throw builtinMcpNotAllowed()
  return workspace
}

async function viewOf(
  db: PrismaClient,
  workspace: { id: string; canManage: boolean } | null,
): Promise<BuiltinMcpView> {
  const [switches, communities] =
    workspace === null
      ? [[], []]
      : await Promise.all([
          db.workspaceBuiltinMcp.findMany({
            where: { workspaceId: workspace.id },
            select: { server: true, enabled: true },
          }),
          db.vkCommunity.findMany({
            where: { workspaceId: workspace.id },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, name: true, screenName: true, isClosed: true, state: true },
          }),
        ])
  const on = new Set(switches.filter((row) => row.enabled).map((row) => row.server))
  const vk = communities.map((row) => ({
    id: row.id,
    name: row.name,
    url: `https://vk.com/${row.screenName}`,
    closed: row.isClosed,
    refused: row.state !== 'ok',
  }))
  return {
    servers: builtinMcpServers.map((server) => ({
      server,
      ...builtinMcpServerInfo[server],
      enabled: on.has(server),
      communities: server === 'vk' ? vk : [],
    })),
    canManage: workspace?.canManage ?? true,
    workspaceId: workspace?.id ?? null,
    communitiesLeft: Math.max(0, vkLimits.communitiesPerWorkspace - communities.length),
  }
}

/** The built-in servers of a workspace, for every member of it. */
export async function readBuiltinMcp(db: PrismaClient, place: Place): Promise<BuiltinMcpView> {
  return viewOf(db, await workspaceOf(db, place, false))
}

/**
 * Turns a server on or off. A server that needs a key turns on only while it has one: «ВКонтакте» —
 * a community with a key VK accepts. Off keeps the keys: on again needs none.
 */
export async function switchBuiltinMcp(
  db: PrismaClient,
  input: Place & { server: BuiltinMcpServer; enabled: boolean },
): Promise<BuiltinMcpView> {
  const workspace = await managed(db, input)
  if (input.enabled && builtinMcpServerInfo[input.server].needsKey) {
    const working = await db.vkCommunity.count({
      where: { workspaceId: workspace.id, state: 'ok' },
    })
    if (working === 0) throw builtinMcpNeedsKey()
  }
  await setBuiltinMcp(db, {
    workspaceId: workspace.id,
    server: input.server,
    enabled: input.enabled,
    userId: input.userId,
  })
  return viewOf(db, { id: workspace.id, canManage: true })
}

/**
 * Connects a VK community by its key and turns «ВКонтакте» on (ВК15). The key of a community
 * connected already replaces its old one (a refused key renewed). The key never enters an error or
 * a log; VK's words never enter a message.
 */
export async function connectVkCommunity(
  db: PrismaClient,
  services: BuiltinMcpServices | null | undefined,
  input: Place & { token: string; now?: Date },
): Promise<BuiltinMcpView> {
  if (!services) throw builtinMcpUnavailable()
  const workspace = await managed(db, input)
  const token = vkTokenSchema.safeParse(input.token)
  if (!token.success) throw new DomainError('VK_KEY_INVALID', 'Not a key of a VK community', 400)
  // The community of the key and its rights, by VK itself, before anything is kept.
  const community = await services.vk.community(token.data)
  const permissions = await services.vk.tokenPermissions(token.data)
  if (!permissions.includes('wall')) throw vkKeyNoWall()
  const existing = await db.vkCommunity.findUnique({
    where: {
      workspaceId_groupId: { workspaceId: workspace.id, groupId: BigInt(community.groupId) },
    },
    select: { id: true, credentialRefId: true },
  })
  if (existing === null) {
    const count = await db.vkCommunity.count({ where: { workspaceId: workspace.id } })
    if (count >= vkLimits.communitiesPerWorkspace) throw vkCommunityLimit()
  }
  const id = existing?.id ?? randomUUID()
  const path = vkCommunitySecretPath(workspace.id, id)
  // Vault first: a row never names a key Vault does not have. A key of a community removed before
  // leaves a version without a value: the write follows it.
  const metadata = await services.secrets.kvMetadata(path)
  const written = await services.secrets.kvWrite(
    path,
    { [VK_TOKEN_FIELD]: token.data },
    { cas: metadata?.currentVersion ?? 0, maxVersions: 1 },
  )
  const now = input.now ?? new Date()
  const fields = {
    name: community.name.slice(0, 200),
    screenName: community.screenName.slice(0, 100),
    isClosed: community.isClosed,
    permissions: permissions.map((name) => name.slice(0, 32)).slice(0, 32),
    state: 'ok',
    stateReason: null,
    checkedAt: now,
  }
  await db.$transaction(async (tx) => {
    if (existing?.credentialRefId) {
      await tx.credentialRef.update({
        where: { id: existing.credentialRefId },
        data: { keyVersion: written.version },
      })
      await tx.vkCommunity.update({ where: { id }, data: fields })
    } else {
      const ref = await tx.credentialRef.upsert({
        where: { vaultPath: path },
        create: {
          workspaceId: workspace.id,
          kind: 'vk_community',
          vaultPath: path,
          keyVersion: written.version,
        },
        update: { keyVersion: written.version },
        select: { id: true },
      })
      if (existing === null)
        await tx.vkCommunity.create({
          data: {
            id,
            workspaceId: workspace.id,
            createdById: input.userId,
            groupId: BigInt(community.groupId),
            credentialRefId: ref.id,
            ...fields,
          },
        })
      else
        await tx.vkCommunity.update({ where: { id }, data: { ...fields, credentialRefId: ref.id } })
    }
    await setBuiltinMcp(tx, {
      workspaceId: workspace.id,
      server: 'vk',
      enabled: true,
      userId: input.userId,
    })
  })
  return viewOf(db, { id: workspace.id, canManage: true })
}

/**
 * Disconnects a community: its key is erased (one version without a value), its row goes with its
 * open proposals. The last one turns «ВКонтакте» off.
 */
export async function disconnectVkCommunity(
  db: PrismaClient,
  services: BuiltinMcpServices | null | undefined,
  input: Place & { communityId: string; now?: Date },
): Promise<BuiltinMcpView> {
  if (!services) throw builtinMcpUnavailable()
  const workspace = await managed(db, input)
  const row = await db.vkCommunity.findFirst({
    where: { id: input.communityId, workspaceId: workspace.id },
    select: { id: true, credentialRefId: true },
  })
  if (row === null) throw vkCommunityNotFound()
  const path = vkCommunitySecretPath(workspace.id, row.id)
  const metadata = await services.secrets.kvMetadata(path)
  if (metadata !== null)
    await services.secrets.kvWrite(path, workspaceEnvVarTombstone(input.now ?? new Date()), {
      cas: metadata.currentVersion,
      maxVersions: 1,
    })
  await db.$transaction(async (tx) => {
    await tx.vkCommunity.delete({ where: { id: row.id } })
    if (row.credentialRefId !== null)
      await tx.credentialRef.delete({ where: { id: row.credentialRefId } })
    const left = await tx.vkCommunity.count({ where: { workspaceId: workspace.id } })
    if (left === 0)
      await setBuiltinMcp(tx, {
        workspaceId: workspace.id,
        server: 'vk',
        enabled: false,
        userId: input.userId,
      })
  })
  return viewOf(db, { id: workspace.id, canManage: true })
}
