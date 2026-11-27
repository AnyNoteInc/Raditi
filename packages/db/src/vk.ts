import {
  builtinMcpServers,
  vkLimits,
  vkProposalLimit,
  vkProposalPayloadSchema,
  type BuiltinMcpServer,
  type VkProposalPayload,
} from '@repo/domain'

import type { Prisma, PrismaClient } from './generated/prisma/client.ts'
import { uuidv7 } from './uuidv7.ts'

// The built-in MCP servers of a workspace and its VK communities (docs/plan/99-vk-community.md,
// ВК15, §3, §4): which servers are on, the communities the agent may name, and the proposals it
// reserves in a turn. Nothing here calls VK or reads a key: a publication is `vk.action` of core,
// after a button of the client.

type Tx = Prisma.TransactionClient

// --- the built-in MCP servers (ВК15) ------------------------------------------------------------

/** The built-in servers a workspace has on, in the order of `builtinMcpServers`. */
export async function enabledBuiltinMcp(
  db: Pick<Tx, 'workspaceBuiltinMcp'>,
  workspaceId: string,
): Promise<BuiltinMcpServer[]> {
  const rows = await db.workspaceBuiltinMcp.findMany({
    where: { workspaceId, enabled: true },
    select: { server: true },
  })
  const on = new Set(rows.map((row) => row.server))
  return builtinMcpServers.filter((server) => on.has(server))
}

/** Turns a built-in server of a workspace on or off. */
export async function setBuiltinMcp(
  db: Pick<Tx, 'workspaceBuiltinMcp'>,
  input: { workspaceId: string; server: BuiltinMcpServer; enabled: boolean; userId: string | null },
): Promise<void> {
  const data = { enabled: input.enabled, updatedById: input.userId, updatedAt: new Date() }
  await db.workspaceBuiltinMcp.upsert({
    where: { workspaceId_server: { workspaceId: input.workspaceId, server: input.server } },
    create: { workspaceId: input.workspaceId, server: input.server, ...data },
    update: data,
  })
}

// --- the communities (§3.1) ---------------------------------------------------------------------

/** A community the agent may name: connected, its key accepted at the last check. */
export interface VkCommunityRow {
  id: string
  groupId: number
  name: string
  screenName: string
  isClosed: boolean
}

const communitySelect = {
  id: true,
  groupId: true,
  name: true,
  screenName: true,
  isClosed: true,
} as const

const rowOf = (row: {
  id: string
  groupId: bigint
  name: string
  screenName: string
  isClosed: boolean
}): VkCommunityRow => ({
  id: row.id,
  groupId: Number(row.groupId),
  name: row.name,
  screenName: row.screenName,
  isClosed: row.isClosed,
})

/** The communities of a workspace whose key VK accepted, oldest first. */
export async function workingVkCommunities(
  db: Pick<Tx, 'vkCommunity'>,
  workspaceId: string,
): Promise<VkCommunityRow[]> {
  const rows = await db.vkCommunity.findMany({
    where: { workspaceId, state: 'ok' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: communitySelect,
  })
  return rows.map(rowOf)
}

/** One working community of a workspace, or null for any other id. */
export async function workingVkCommunity(
  db: Pick<Tx, 'vkCommunity'>,
  workspaceId: string,
  communityId: string,
): Promise<VkCommunityRow | null> {
  const row = await db.vkCommunity.findFirst({
    where: { id: communityId, workspaceId, state: 'ok' },
    select: communitySelect,
  })
  return row === null ? null : rowOf(row)
}

// --- the proposals of the agent (§3.3) ----------------------------------------------------------

/** `vk_post_propose`, `vk_reply_propose`: at most `vkLimits.proposalsPerTurn` a turn (ВК7). */
export async function reserveVkProposal(
  db: Pick<PrismaClient, '$transaction'>,
  input: {
    workspaceId: string
    taskId: string
    turnNo: number
    communityId: string
    proposal: VkProposalPayload
  },
): Promise<{ reservationId: string }> {
  const payload = vkProposalPayloadSchema.parse(input.proposal)
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`vk-turn:${input.taskId}:${input.turnNo}`}, 0))`
    const open = await tx.vkReservation.count({
      where: { taskId: input.taskId, turnNo: input.turnNo, outcome: null },
    })
    if (open >= vkLimits.proposalsPerTurn) throw vkProposalLimit()
    const row = await tx.vkReservation.create({
      data: {
        id: uuidv7(),
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        turnNo: input.turnNo,
        communityId: input.communityId,
        kind: payload.kind,
        payload,
      },
      select: { id: true },
    })
    return { reservationId: row.id }
  })
}

export interface PendingVkProposal {
  id: string
  communityId: string
  payload: unknown
}

export async function pendingVkProposals(
  db: Pick<PrismaClient, 'vkReservation'>,
  taskId: string,
  turnNo: number,
): Promise<PendingVkProposal[]> {
  return db.vkReservation.findMany({
    where: { taskId, turnNo, outcome: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, communityId: true, payload: true },
  })
}

/** Closes an open proposal; false — it was closed already. */
export async function closeVkProposal(
  db: Pick<Tx, 'vkReservation'>,
  id: string,
  outcome: 'done' | 'refused' | 'failed',
  reason: string,
): Promise<boolean> {
  const closed = await db.vkReservation.updateMany({
    where: { id, outcome: null },
    data: { outcome, reason: reason.slice(0, 24), closedAt: new Date() },
  })
  return closed.count > 0
}

/** The proposals of a failed or cancelled pass, closed at once, never shown. The count. */
export async function failVkTurn(
  db: Pick<PrismaClient, 'vkReservation'>,
  taskId: string,
  turnNo: number,
): Promise<number> {
  const closed = await db.vkReservation.updateMany({
    where: { taskId, turnNo, outcome: null },
    data: { outcome: 'failed', reason: 'failed', closedAt: new Date() },
  })
  return closed.count
}

/**
 * The proposals of passes that never ended, older than `before`, of a task with no turn assigned
 * now: closed failed, never shown. The count.
 */
export async function closeStaleVkProposals(
  db: Pick<PrismaClient, 'vkReservation'>,
  before: Date,
): Promise<number> {
  const closed = await db.vkReservation.updateMany({
    where: {
      outcome: null,
      createdAt: { lt: before },
      task: { turnAssignments: { none: { finishedAt: null } } },
    },
    data: { outcome: 'failed', reason: 'failed', closedAt: new Date() },
  })
  return closed.count
}
