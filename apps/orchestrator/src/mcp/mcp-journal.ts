import { createHash, randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient } from '@repo/db'
import {
  badRequest,
  conflict,
  contentHashSchema,
  contentUndoFenceSchema,
  DomainError,
  isDomainError,
  leaseLost,
  terminalTaskStatuses,
  turnPlanSchema,
  type SiteLeaseFence,
} from '@repo/domain'
import { z } from 'zod'

import {
  mcpAccessSchema,
  mcpHostScopeSchema,
  type McpAccess,
  type McpHostScope,
} from './mcp-access.ts'
import {
  CONTENT_SNAPSHOT_TTL_MS,
  contentObjectRefSchema,
  contentSnapshotKey,
  contentSnapshotReceiptSchema,
  isOneLine,
  type ContentSnapshotReceipt,
  type ContentSnapshotRef,
} from './content-snapshots.ts'

type Tx = Prisma.TransactionClient
type Call = Prisma.McpCallGetPayload<{
  include: { snapshot: true; assignment: true; turn: { include: { task: true } } }
}>
const callInclude = { snapshot: true, assignment: true, turn: { include: { task: true } } } as const
/** The caller's key for one distinct change; the tools and the journal share this rule. */
export const mcpIdempotencyKeySchema = z.string().min(1).max(200).refine(isOneLine)
const commandSchema = z.strictObject({
  tool: z.string().regex(/^[a-z][a-z0-9_]{0,199}$/),
  objectRef: contentObjectRefSchema,
  idempotencyKey: mcpIdempotencyKeySchema,
  arguments: z.unknown(),
})
export type McpMutationCommand = z.infer<typeof commandSchema>
/** Whose call it is: the agent under its turn key, or the trusted host under a lease fence. */
export type McpJournalScope = McpAccess | McpHostScope
/**
 * The host scope as the journal reads it: `taskId` is the task whose edits are returned and
 * `epoch` the epoch of the lease that admits the call, as they are for the agent.
 */
interface HostScope {
  host: McpHostScope
  siteId: string
  workspaceId: string
  taskId: string
  epoch: number
}
type Scope = (McpAccess & { host?: undefined }) | HostScope
/** An edit the trusted undo returns: its snapshot and the turn that made it. */
export interface McpUndoTarget {
  snapshotId: string
  turnNo: number
}
/**
 * The caller's key of a trusted restore. The host has no other: the journal derives its own
 * key from the task, the turn of the edit and the snapshot.
 */
export const mcpUndoKey = (target: McpUndoTarget) => `undo:${target.turnNo}:${target.snapshotId}`
export interface McpCallCompletion {
  result: 'ok' | 'error' | 'denied'
  /** A bounded, already filtered tool result; never a raw exception or adapter log. */
  response: unknown
  /** Host-side evidence only; never part of the tool response. */
  appliedStateHash?: string
}
export interface McpRestoreSource {
  receipt: ContentSnapshotReceipt
  expectedStateHash: string
}
export type McpCallReservation =
  | {
      kind: 'claimed'
      callId: string
      snapshot: ContentSnapshotRef
      restoreSource?: McpRestoreSource
    }
  | {
      kind: 'pending'
      callId: string
      stage: 'capture' | 'ready' | 'write'
      recoveryRequired: boolean
      /** Unstarted for longer than a preparation lasts: its owner may close it and go on. */
      stale: boolean
    }
  | { kind: 'replay'; callId: string; completion: McpCallCompletion }

/**
 * How long a preparation can last on the PostgreSQL clock: resolving the site, reading the
 * object (10 s), sealing and storing its snapshot, with room to spare. A call that has not
 * started its write by then has lost its request, or the record that closes it. Closing it
 * is safe even if that request is only slow: a closed call never opens a write.
 */
export const CONTENT_PREPARATION_LIMIT_MS = 60_000
const unavailable = () =>
  new DomainError('MCP_JOURNAL_UNAVAILABLE', 'MCP journal is unavailable', 503)
const busy = () =>
  new DomainError('MCP_CALL_IN_FLIGHT', 'A content call requires completion or recovery', 409)
const mismatch = () => conflict('MCP call does not match its original scope or input')
const hostInactive = () => leaseLost('MCP host scope is no longer active')
const hostRequestSchema = z.strictObject({ fence: contentUndoFenceSchema, targetTaskId: z.uuid() })

/** Stable JSON with limits applied before recursive descent. No input enters diagnostics. */
export function mcpCanonicalJson(value: unknown): string {
  let nodes = 0
  function visit(input: unknown, depth: number): unknown {
    if (++nodes > 5000 || depth > 16) throw badRequest('Invalid MCP journal JSON')
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (Array.isArray(input)) return input.map((child) => visit(child, depth + 1))
    if (
      typeof input !== 'object' ||
      !input ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      throw badRequest('Invalid MCP journal JSON')
    const entries = Object.entries(input).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [key, child] of entries) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw badRequest('Invalid MCP journal JSON')
      result[key] = visit(child, depth + 1)
    }
    return result
  }
  const encoded = JSON.stringify(visit(value, 1))
  if (Buffer.byteLength(encoded) > 64 * 1024) throw badRequest('MCP journal JSON exceeds its limit')
  return encoded
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Durable admission only. The site adapter must validate reversibility, privacy and approval
 * before reserve(), and start exactly one external write only when beginWrite() returns true.
 * Every transaction locks the lease first; no network or CMS work runs in a SQL transaction.
 * An unfinished writer leaves a persisted lease barrier and is never automatically retried.
 *
 * Two owners are admitted, each by its own check and neither by the other's. The agent: a live
 * turn key, its assignment and the turn lease (#active). The trusted host: the fence of a site
 * lease — a turn or a revert — and the task whose edits it returns (#hostActive); it has no
 * key, no assignment and no tool but a restore.
 */
export class PostgresMcpJournal {
  constructor(private readonly db: Pick<PrismaClient, '$transaction'>) {}

  /** Records GET-only privacy maps too; a stale host scope cannot recreate retired data. */
  async noteContentAccess(inputScope: McpAccess): Promise<void> {
    const scope = this.#access(inputScope)
    await this.#transaction(async (tx) => {
      await this.#active(tx, scope)
    })
  }

  /**
   * The scope of the trusted host for a lease fence, read from the database: the site, its
   * workspace and its address never come from a request. The target is the holder of the lease
   * or the task the holder reverts. Every later step checks the fence again under the lock.
   */
  async hostScope(fence: SiteLeaseFence, targetTaskId: string): Promise<McpHostScope> {
    const parsed = hostRequestSchema.safeParse({ fence, targetTaskId })
    if (!parsed.success) throw badRequest('Invalid content undo scope')
    const request = parsed.data
    return this.#transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ workspaceId: string; stack: string; url: string; retired: boolean }>
      >`
        SELECT s.workspace_id AS "workspaceId", s.stack::text AS stack, s.url,
          t.content_retired_at IS NOT NULL AS retired
        FROM site_leases l
        JOIN tasks h ON h.id = l.holder_task_id AND h.site_id = l.site_id
        JOIN tasks t ON t.site_id = l.site_id AND (t.id = h.id OR t.id = h.reverts_task_id)
        JOIN sites s ON s.id = l.site_id AND s.workspace_id = t.workspace_id
          AND s.workspace_id = h.workspace_id
        WHERE l.site_id = ${request.fence.siteId}::uuid
          AND l.holder_task_id = ${request.fence.taskId}::uuid AND l.epoch = ${request.fence.epoch}
          AND l.operation = ${request.fence.operation}::"LeaseOperation"
          AND NOT l.held_for_operator AND l.expires_at > clock_timestamp()
          AND t.id = ${request.targetTaskId}::uuid AND s.status = 'active'`
      if (rows.length !== 1) throw hostInactive()
      // Not a lost lease: the undo window of the task is over, and a repeat cannot help.
      if (rows[0]!.retired) throw conflict('Task content context has expired')
      const scope = mcpHostScopeSchema.safeParse({
        workspaceId: rows[0]!.workspaceId,
        siteId: request.fence.siteId,
        stack: rows[0]!.stack,
        url: rows[0]!.url,
        targetTaskId: request.targetTaskId,
        fence: request.fence,
      })
      // Broken site data, not a bad fence: fail closed with a fixed message.
      if (!scope.success)
        throw new DomainError('MCP_ACCESS_SCOPE_INVALID', 'MCP admission row is invalid', 503)
      return scope.data
    })
  }

  /**
   * hostUndo is for the trusted turn undo only: it may restore a snapshot of an earlier turn,
   * and it does not count toward the agent's object limit. An agent restores only its own turn.
   * The host scope reserves nothing but a restore.
   */
  async reserve(
    inputScope: McpJournalScope,
    input: McpMutationCommand,
    restoresSnapshotId?: string,
    hostUndo = false,
  ): Promise<McpCallReservation> {
    const scope = this.#scope(inputScope)
    const parsed = commandSchema.safeParse(input)
    if (!parsed.success) throw badRequest('Invalid MCP mutation command')
    const command = parsed.data
    if (
      restoresSnapshotId !== undefined &&
      (!z.uuid().safeParse(restoresSnapshotId).success || command.tool !== 'restore')
    )
      throw badRequest('Invalid restore source')
    const requestHash = hash(
      mcpCanonicalJson({
        tool: command.tool,
        objectRef: command.objectRef,
        arguments: command.arguments,
      }),
    )
    if (scope.host) {
      if (command.tool !== 'restore' || restoresSnapshotId === undefined)
        throw badRequest('The host scope only restores')
      return this.#transaction((tx) =>
        this.#reserveHost(tx, scope, command, requestHash, restoresSnapshotId),
      )
    }
    return this.#transaction(async (tx) => {
      const owned = await this.#active(tx, scope)
      const idempotencyKey = hash(
        JSON.stringify([owned.assignmentId, scope.keyId, command.idempotencyKey]),
      )
      const existing = await tx.mcpCall.findUnique({
        where: { idempotencyKey },
        include: callInclude,
      })
      if (existing) {
        this.#belongs(existing, scope, false)
        if (
          existing.requestHash !== requestHash ||
          existing.assignmentId !== owned.assignmentId ||
          existing.restoresSnapshotId !== (restoresSnapshotId ?? null)
        )
          throw mismatch()
        if (existing.revertedAt) throw conflict('MCP call has been reverted')
        if (existing.result !== null)
          return {
            kind: 'replay',
            callId: existing.id,
            completion: {
              result: existing.result,
              response: existing.response,
              ...(existing.appliedStateHash ? { appliedStateHash: existing.appliedStateHash } : {}),
            },
          }
        return {
          kind: 'pending',
          callId: existing.id,
          stage: existing.writeStartedAt
            ? 'write'
            : existing.snapshot?.payloadSha256
              ? 'ready'
              : 'capture',
          recoveryRequired: existing.leaseEpoch !== scope.epoch || existing.writeStartedAt !== null,
          stale:
            existing.writeStartedAt === null &&
            owned.now.getTime() - existing.createdAt.getTime() >= CONTENT_PREPARATION_LIMIT_MS,
        }
      }
      // Reserve the site while capturing too: two captures cannot race around the same edit.
      // A capture whose owner is gone, or one that outlived any preparation, never dispatched
      // a write: close it under this lock.
      // Legacy in-flight calls are conservatively included until an operator reconciles them.
      await this.#closeAbandonedCaptures(tx, scope.siteId)
      const unfinished = await tx.mcpCall.findFirst({
        where: { result: null, turn: { task: { siteId: scope.siteId } } },
        select: { id: true },
      })
      if (unfinished || owned.inflightMcpCallId !== null) throw busy()
      const restoreSource = restoresSnapshotId
        ? await this.#restoreSource(
            tx,
            scope,
            restoresSnapshotId,
            true,
            hostUndo ? undefined : scope.turn,
          )
        : undefined
      if (restoreSource && restoreSource.receipt.objectRef !== command.objectRef) throw mismatch()
      // Only the agent's edits count: its restores return objects it already changed in this
      // turn, and the host undo of a replaced turn is not a change of the new one.
      if (!restoresSnapshotId) {
        const objects = await tx.mcpCall.findMany({
          where: {
            turnId: owned.turnId,
            restoresSnapshotId: null,
            OR: [{ result: null }, { result: 'ok' }],
          },
          select: { objectRef: true },
          distinct: ['objectRef'],
        })
        if (objects.length >= 20 && !objects.some((row) => row.objectRef === command.objectRef))
          throw new DomainError(
            'MCP_APPROVAL_REQUIRED',
            'Changing more than 20 objects requires approval',
            403,
          )
      }
      const expiresAt = new Date(owned.now.getTime() + CONTENT_SNAPSHOT_TTL_MS)
      const snapshotId = randomUUID()
      const snapshot = await tx.snapshot.create({
        data: {
          id: snapshotId,
          siteId: scope.siteId,
          taskId: scope.taskId,
          objectRef: command.objectRef,
          s3Key: contentSnapshotKey({ siteId: scope.siteId, id: snapshotId }),
          expiresAt,
        },
      })
      const reference: ContentSnapshotRef = {
        id: snapshot.id,
        workspaceId: scope.workspaceId,
        siteId: scope.siteId,
        taskId: scope.taskId,
        objectRef: command.objectRef,
        expiresAt,
      }
      const call = await tx.mcpCall.create({
        data: {
          turnId: owned.turnId,
          tool: command.tool,
          objectRef: command.objectRef,
          idempotencyKey,
          requestHash,
          credentialKeyId: scope.keyId,
          assignmentId: owned.assignmentId,
          leaseEpoch: scope.epoch,
          snapshotId: snapshot.id,
          restoresSnapshotId,
          // Prisma would fill this from the clock of this process; the age of a preparation
          // is measured against PostgreSQL's.
          createdAt: owned.now,
        },
      })
      return {
        kind: 'claimed',
        callId: call.id,
        snapshot: reference,
        ...(restoreSource ? { restoreSource } : {}),
      }
    })
  }

  /**
   * A restore of the trusted host. The call is written under the turn of the edit it returns,
   * with the holder of the lease and its operation for an owner. Its key is the journal's own:
   * the target task, the turn of the edit, the snapshot — and how many restores of that
   * snapshot the host has already closed without success, so that a repeat after a refusal of
   * the site or an abandoned preparation is a new call, never a replay of the failure.
   */
  async #reserveHost(
    tx: Tx,
    scope: HostScope,
    command: McpMutationCommand,
    requestHash: string,
    restoresSnapshotId: string,
  ): Promise<McpCallReservation> {
    const owned = await this.#hostActive(tx, scope)
    // A preparation whose owner lost the site, or one older than any preparation, never
    // dispatched a write: closed under this lock, it is counted as a closed attempt below.
    await this.#closeAbandonedCaptures(tx, scope.siteId)
    const source = await this.#restoreCall(tx, scope, restoresSnapshotId)
    const target = { snapshotId: restoresSnapshotId, turnNo: source.turn.turnNo }
    if (command.idempotencyKey !== mcpUndoKey(target) || source.objectRef !== command.objectRef)
      throw badRequest('Invalid host restore command')
    const attempt = await tx.mcpCall.count({
      where: {
        restoresSnapshotId,
        hostTaskId: { not: null },
        result: { in: ['error', 'denied'] },
      },
    })
    const idempotencyKey = hash(
      JSON.stringify(['host', scope.taskId, target.turnNo, restoresSnapshotId, attempt]),
    )
    const existing = await tx.mcpCall.findUnique({
      where: { idempotencyKey },
      include: callInclude,
    })
    if (existing) {
      this.#belongs(existing, scope, false)
      if (
        existing.requestHash !== requestHash ||
        existing.restoresSnapshotId !== restoresSnapshotId
      )
        throw mismatch()
      if (existing.revertedAt) throw conflict('MCP call has been reverted')
      if (existing.result !== null)
        return {
          kind: 'replay',
          callId: existing.id,
          completion: {
            result: existing.result,
            response: existing.response,
            ...(existing.appliedStateHash ? { appliedStateHash: existing.appliedStateHash } : {}),
          },
        }
      return {
        kind: 'pending',
        callId: existing.id,
        stage: existing.writeStartedAt
          ? 'write'
          : existing.snapshot?.payloadSha256
            ? 'ready'
            : 'capture',
        recoveryRequired: existing.leaseEpoch !== scope.epoch || existing.writeStartedAt !== null,
        stale:
          existing.writeStartedAt === null &&
          owned.now.getTime() - existing.createdAt.getTime() >= CONTENT_PREPARATION_LIMIT_MS,
      }
    }
    const unfinished = await tx.mcpCall.findFirst({
      where: { result: null, turn: { task: { siteId: scope.siteId } } },
      select: { id: true },
    })
    if (unfinished || owned.inflightMcpCallId !== null) throw busy()
    const restoreSource = await this.#restoreSource(tx, scope, restoresSnapshotId, true)
    const expiresAt = new Date(owned.now.getTime() + CONTENT_SNAPSHOT_TTL_MS)
    const snapshotId = randomUUID()
    const snapshot = await tx.snapshot.create({
      data: {
        id: snapshotId,
        siteId: scope.siteId,
        taskId: scope.taskId,
        objectRef: command.objectRef,
        s3Key: contentSnapshotKey({ siteId: scope.siteId, id: snapshotId }),
        expiresAt,
      },
    })
    const call = await tx.mcpCall.create({
      data: {
        turnId: source.turnId,
        tool: command.tool,
        objectRef: command.objectRef,
        idempotencyKey,
        requestHash,
        hostTaskId: scope.host.fence.taskId,
        hostOperation: scope.host.fence.operation,
        leaseEpoch: scope.epoch,
        snapshotId: snapshot.id,
        restoresSnapshotId,
        createdAt: owned.now,
      },
    })
    return {
      kind: 'claimed',
      callId: call.id,
      snapshot: {
        id: snapshot.id,
        workspaceId: scope.workspaceId,
        siteId: scope.siteId,
        taskId: scope.taskId,
        objectRef: command.objectRef,
        expiresAt,
      },
      restoreSource,
    }
  }

  async attachSnapshot(
    inputScope: McpJournalScope,
    callId: string,
    input: ContentSnapshotReceipt,
  ): Promise<void> {
    const scope = this.#scope(inputScope)
    const parsed = contentSnapshotReceiptSchema.safeParse(input)
    if (!parsed.success) throw badRequest('Invalid content snapshot receipt')
    const receipt = parsed.data
    await this.#transaction(async (tx) => {
      await this.#admit(tx, scope)
      const call = await this.#call(tx, scope, callId, true)
      const original = this.#reference(call, scope)
      const { payloadSha256: _hash, sizeBytes: _size, ...metadata } = receipt
      if (
        JSON.stringify(original) !== JSON.stringify(metadata) ||
        call.writeStartedAt ||
        call.result !== null
      )
        throw mismatch()
      if (call.snapshot!.payloadSha256 !== null) {
        if (
          call.snapshot!.payloadSha256 !== receipt.payloadSha256 ||
          call.snapshot!.sizeBytes !== receipt.sizeBytes
        )
          throw mismatch()
        return
      }
      await tx.snapshot.update({
        where: { id: receipt.id },
        data: { payloadSha256: receipt.payloadSha256, sizeBytes: receipt.sizeBytes },
      })
    })
  }

  /** true is the sole right to start a write. A duplicate or replay returns false. */
  async beginWrite(inputScope: McpJournalScope, callId: string): Promise<boolean> {
    const scope = this.#scope(inputScope)
    return this.#transaction(async (tx) => {
      const owned = await this.#admit(tx, scope)
      const call = await this.#call(tx, scope, callId, true)
      if (call.result !== null || call.writeStartedAt !== null) return false
      if (
        !call.snapshot?.payloadSha256 ||
        call.snapshot.sizeBytes === null ||
        call.snapshot.expiresAt <= owned.now ||
        call.revertedAt
      )
        throw conflict('MCP write requires an acknowledged content snapshot')
      if (owned.inflightMcpCallId !== null) throw busy()
      if (call.restoresSnapshotId)
        await this.#restoreSource(tx, scope, call.restoresSnapshotId, true)
      if (owned.deadlineAt.getTime() - owned.now.getTime() < 2000)
        throw leaseLost('MCP write deadline is too close')
      await tx.siteLease.update({
        where: { siteId: scope.siteId },
        data: { inflightMcpCallId: call.id },
      })
      await tx.mcpCall.update({
        where: { id: call.id },
        data: { writeStartedAt: owned.now, writeDeadlineAt: owned.deadlineAt },
      })
      return true
    })
  }

  /**
   * Only a proven outcome may complete a write. An expired/revoked owner can persist its
   * evidence while it still owns the same epoch; it cannot authorize another external call.
   * A transport timeout is ambiguous: call markAmbiguous(), never finish(error).
   */
  async finish(
    inputScope: McpJournalScope,
    callId: string,
    completion: McpCallCompletion,
  ): Promise<void> {
    const scope = this.#scope(inputScope)
    if (!['ok', 'error', 'denied'].includes(completion.result))
      throw badRequest('Invalid MCP completion')
    if (
      completion.appliedStateHash !== undefined &&
      (completion.result !== 'ok' ||
        !contentHashSchema.safeParse(completion.appliedStateHash).success)
    )
      throw badRequest('Invalid MCP content proof')
    const response = JSON.parse(mcpCanonicalJson(completion.response)) as Prisma.InputJsonValue
    await this.#transaction(async (tx) => {
      const owned = await this.#held(tx, scope)
      const call = await this.#call(tx, scope, callId)
      if (call.result !== null) {
        if (
          call.result !== completion.result ||
          call.appliedStateHash !== (completion.appliedStateHash ?? null) ||
          mcpCanonicalJson(call.response) !== mcpCanonicalJson(response)
        )
          throw mismatch()
        return
      }
      if (completion.result === 'ok' && !call.writeStartedAt)
        throw conflict('MCP write has not started')
      if (call.writeStartedAt && owned.inflightMcpCallId !== call.id) throw mismatch()
      if (call.restoresSnapshotId && completion.result === 'ok') {
        if (!completion.appliedStateHash) throw badRequest('Restore requires content proof')
        const source = await this.#restoreCall(tx, scope, call.restoresSnapshotId)
        if (source.revertedAt) throw mismatch()
        await tx.mcpCall.update({ where: { id: source.id }, data: { revertedAt: owned.now } })
        await tx.snapshot.update({
          where: { id: call.restoresSnapshotId },
          data: { restoredAt: owned.now },
        })
      }
      await tx.mcpCall.update({
        where: { id: call.id },
        data: {
          result: completion.result,
          response: response === null ? Prisma.JsonNull : response,
          finishedAt: owned.now,
          appliedStateHash: completion.appliedStateHash,
        },
      })
      if (call.writeStartedAt)
        await tx.siteLease.update({
          where: { siteId: scope.siteId },
          data: { inflightMcpCallId: null },
        })
      // An operator hold is not silently cleared by a late acknowledgement.
    })
  }

  async markAmbiguous(inputScope: McpJournalScope, callId: string): Promise<void> {
    const scope = this.#scope(inputScope)
    await this.#transaction(async (tx) => {
      const owned = await this.#held(tx, scope)
      const call = await this.#call(tx, scope, callId)
      if (call.result !== null || !call.writeStartedAt || owned.inflightMcpCallId !== call.id)
        throw mismatch()
      await tx.siteLease.update({
        where: { siteId: scope.siteId },
        data: { heldForOperator: true },
      })
    })
  }

  /** Ownership lookup permits replay after a restore; eligibility is checked in reserve. */
  async restoreSource(inputScope: McpJournalScope, snapshotId: string): Promise<McpRestoreSource> {
    const scope = this.#scope(inputScope)
    return this.#transaction(async (tx) => {
      await this.#admit(tx, scope)
      return this.#restoreSource(tx, scope, snapshotId, false)
    })
  }

  async writeIntent(inputScope: McpJournalScope, callId: string) {
    const scope = this.#scope(inputScope)
    return this.#transaction(async (tx) => {
      const owned = await this.#held(tx, scope)
      const call = await this.#call(tx, scope, callId)
      if (!call.writeStartedAt || !call.writeDeadlineAt || !call.requestHash || !call.objectRef)
        throw conflict('MCP write has not started')
      return {
        callId: call.id,
        requestHash: call.requestHash,
        objectRef: call.objectRef,
        deadlineAt: call.writeDeadlineAt.getTime(),
        ttlMs: call.writeDeadlineAt.getTime() - owned.now.getTime(),
        snapshotId: call.snapshotId!,
        restoresSnapshotId: call.restoresSnapshotId,
      }
    })
  }

  /** Serialize recovery with beginWrite: a closed capture can never dispatch afterwards. */
  async recoveryIntent(inputScope: McpJournalScope, callId: string) {
    const scope = this.#scope(inputScope)
    return this.#transaction(async (tx) => {
      const owned = await this.#held(tx, scope)
      const call = await this.#call(tx, scope, callId)
      if (call.result !== null) return { kind: 'closed' as const, committed: call.result === 'ok' }
      if (!call.writeStartedAt) {
        await tx.mcpCall.update({
          where: { id: call.id },
          data: {
            result: 'error',
            response: { code: 'CONTENT_PREPARATION_INTERRUPTED' },
            finishedAt: owned.now,
          },
        })
        return { kind: 'closed' as const, committed: false }
      }
      if (!call.writeDeadlineAt || owned.inflightMcpCallId !== call.id) throw mismatch()
      return {
        kind: 'write' as const,
        callId: call.id,
        requestHash: call.requestHash!,
        objectRef: call.objectRef!,
        deadlineAt: call.writeDeadlineAt.getTime(),
        ttlMs: call.writeDeadlineAt.getTime() - owned.now.getTime(),
        snapshotId: call.snapshotId!,
        restoresSnapshotId: call.restoresSnapshotId,
      }
    })
  }

  /**
   * Abandoned captures have no site dispatch: those whose owner is gone, and those a live
   * owner left open for longer than a preparation lasts. Lock against all old/new beginWrite
   * calls.
   */
  async recoverCaptures(siteId: string): Promise<number> {
    if (!z.uuid().safeParse(siteId).success) throw badRequest('Invalid content recovery site')
    return this.#transaction(async (tx) => {
      await tx.$queryRaw`SELECT site_id FROM site_leases WHERE site_id = ${siteId}::uuid FOR UPDATE`
      return this.#closeAbandonedCaptures(tx, siteId)
    })
  }

  /**
   * The caller holds the site lease row lock, which every beginWrite takes first. The owner of
   * a capture is looked for where its kind lives: the agent's in its assignment, key and turn
   * lease; the host's in the lease of the holder, epoch and operation the call was written under.
   */
  async #closeAbandonedCaptures(tx: Tx, siteId: string): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE mcp_calls c SET result = 'error', response = '{"code":"CONTENT_PREPARATION_INTERRUPTED"}'::jsonb,
          finished_at = clock_timestamp()
        FROM task_turns tt JOIN tasks t ON t.id = tt.task_id
        WHERE c.turn_id = tt.id AND t.site_id = ${siteId}::uuid
          AND (c.assignment_id IS NOT NULL OR c.host_task_id IS NOT NULL)
          AND c.request_hash IS NOT NULL
          AND c.result IS NULL AND c.write_started_at IS NULL
          AND (c.created_at <= clock_timestamp()
              - make_interval(secs => ${CONTENT_PREPARATION_LIMIT_MS / 1000}::double precision)
            OR (c.assignment_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM turn_assignments a JOIN site_leases l ON l.site_id = a.site_id
                JOIN llm_keys k ON k.id = c.credential_key_id
              WHERE a.id = c.assignment_id AND a.finished_at IS NULL AND a.outcome IS NULL
                AND a.deadline_at > clock_timestamp() AND a.task_id = t.id
                AND l.holder_task_id = t.id AND l.epoch = c.lease_epoch AND a.lease_epoch = c.lease_epoch
                AND l.operation = 'turn' AND NOT l.held_for_operator AND l.expires_at > clock_timestamp()
                AND k.revoke_requested_at IS NULL AND k.revoked_at IS NULL
                AND k.expires_at > clock_timestamp() AND k.valid_until > clock_timestamp()
                AND k.task_attempt = t.attempt AND t.content_retired_at IS NULL
                AND t.status <> ALL(${[...terminalTaskStatuses]}::"TaskStatus"[])))
            OR (c.host_task_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM site_leases l
              WHERE l.site_id = t.site_id AND l.holder_task_id = c.host_task_id
                AND l.epoch = c.lease_epoch AND l.operation = c.host_operation
                AND NOT l.held_for_operator AND l.expires_at > clock_timestamp()
                AND t.content_retired_at IS NULL)))
        RETURNING c.id`
    return rows.length
  }

  /** Original edits only, in reverse admission order. Every individual restore is fenced. */
  async turnSnapshots(inputScope: McpJournalScope, turnNo: number): Promise<string[]> {
    const scope = this.#scope(inputScope)
    if (
      !Number.isSafeInteger(turnNo) ||
      turnNo < 1 ||
      turnNo > (scope.host ? 2_147_483_647 : scope.turn)
    )
      throw badRequest('Invalid restore turn')
    return this.#transaction(async (tx) => {
      await this.#admit(tx, scope)
      if (
        await tx.mcpCall.count({
          where: {
            turn: { taskId: scope.taskId, turnNo },
            result: null,
            writeStartedAt: { not: null },
          },
        })
      )
        // For the host an unknown write is a reason to come back after its reconciliation.
        throw scope.host ? busy() : conflict('Turn contains an unresolved content write')
      const calls = await tx.mcpCall.findMany({
        where: {
          turn: { taskId: scope.taskId, turnNo },
          restoresSnapshotId: null,
          result: 'ok',
          revertedAt: null,
          appliedStateHash: { not: null },
        },
        orderBy: { journalNo: 'desc' },
        select: { snapshotId: true },
      })
      return calls.map((call) => call.snapshotId!)
    })
  }

  /**
   * Host only: every edit of the target task that is not returned yet, of all its turns,
   * newest first. Each restore is fenced again on its own.
   */
  async taskSnapshots(inputScope: McpHostScope): Promise<McpUndoTarget[]> {
    const scope = this.#scope(inputScope)
    if (!scope.host) throw badRequest('Invalid MCP journal scope')
    return this.#transaction(async (tx) => {
      await this.#hostActive(tx, scope)
      if (
        await tx.mcpCall.count({
          where: { turn: { taskId: scope.taskId }, result: null, writeStartedAt: { not: null } },
        })
      )
        throw busy()
      const calls = await tx.mcpCall.findMany({
        where: {
          turn: { taskId: scope.taskId },
          restoresSnapshotId: null,
          result: 'ok',
          revertedAt: null,
          appliedStateHash: { not: null },
        },
        orderBy: { journalNo: 'desc' },
        select: { snapshotId: true, turn: { select: { turnNo: true } } },
      })
      return calls.map((call) => ({ snapshotId: call.snapshotId!, turnNo: call.turn.turnNo }))
    })
  }

  /**
   * Include interrupted replacement undo chains, newest first, before making any writes. The
   * agent scope names the replacing turn by its key; for the host it is the one unfinished
   * assignment under the fence, and its saved plan must say that it replaces `turnNo`.
   */
  async replacementTargets(inputScope: McpJournalScope, turnNo: number): Promise<number[]> {
    const scope = this.#scope(inputScope)
    if (!Number.isSafeInteger(turnNo) || turnNo < 1) throw badRequest('Invalid replacement turn')
    if (scope.host) {
      if (scope.host.fence.operation !== 'turn' || scope.host.fence.taskId !== scope.taskId)
        throw badRequest('Invalid replacement turn')
    } else if (turnNo !== scope.turn - 1) throw badRequest('Invalid replacement turn')
    return this.#transaction(async (tx) => {
      let sessionId: string
      if (scope.host) sessionId = await this.#replacingSession(tx, scope, turnNo)
      else {
        await this.#active(tx, scope)
        sessionId = scope.sessionId
      }
      const targets: number[] = []
      for (let next: number | undefined = turnNo; next !== undefined;) {
        const rows = await tx.turnAssignment.findMany({
          where: {
            taskId: scope.taskId,
            siteId: scope.siteId,
            sessionId,
            turnNo: next,
          },
        })
        if (rows.length !== 1 || !rows[0]!.finishedAt) throw mismatch()
        const parsed = turnPlanSchema.safeParse(rows[0]!.plan)
        if (!parsed.success || parsed.data.sandbox.labels.turn !== next) throw mismatch()
        targets.push(next)
        const replaces: number | undefined = parsed.data.replacesTurn
        if (replaces !== undefined && replaces !== next - 1) throw mismatch()
        next = replaces
      }
      return targets
    })
  }

  /** Host only: the session of the open assignment under the fence that replaces `turnNo`. */
  async #replacingSession(tx: Tx, scope: HostScope, turnNo: number): Promise<string> {
    await this.#hostActive(tx, scope)
    const open = await tx.turnAssignment.findMany({
      where: { taskId: scope.taskId, siteId: scope.siteId, finishedAt: null },
    })
    const plan = open.length === 1 ? turnPlanSchema.safeParse(open[0]!.plan) : undefined
    if (
      !plan?.success ||
      open[0]!.leaseEpoch !== scope.epoch ||
      open[0]!.turnNo !== turnNo + 1 ||
      plan.data.sandbox.labels.turn !== open[0]!.turnNo ||
      plan.data.replacesTurn !== turnNo
    )
      throw badRequest('Invalid replacement turn')
    return open[0]!.sessionId
  }

  /** The edit a snapshot was taken for: always a call of the agent of the scope's task. */
  async #restoreCall(tx: Tx, scope: Scope, snapshotId: string): Promise<Call> {
    if (!z.uuid().safeParse(snapshotId).success) throw badRequest('Invalid restore source')
    const calls = await tx.mcpCall.findMany({
      where: { snapshotId, restoresSnapshotId: null, result: 'ok' },
      include: callInclude,
    })
    const call = calls[0]
    if (
      calls.length !== 1 ||
      !call ||
      !call.assignmentId ||
      call.assignment?.taskId !== scope.taskId ||
      call.assignment.siteId !== scope.siteId ||
      call.assignment.turnNo !== call.turn.turnNo ||
      !call.credentialKeyId ||
      !call.appliedStateHash ||
      !call.snapshot?.payloadSha256 ||
      call.snapshot.sizeBytes === null ||
      call.turn.taskId !== scope.taskId ||
      call.turn.task.workspaceId !== scope.workspaceId ||
      call.turn.task.siteId !== scope.siteId ||
      call.snapshot.siteId !== scope.siteId ||
      call.snapshot.taskId !== scope.taskId ||
      call.snapshot.objectRef !== call.objectRef ||
      call.snapshot.s3Key !== contentSnapshotKey(call.snapshot)
    )
      throw mismatch()
    return call
  }

  /**
   * A snapshot stays restorable until its purge is claimed, which waits for the end of the
   * task plus the undo window; its capture expiry only bounds the earliest purge.
   */
  async #restoreSource(
    tx: Tx,
    scope: Scope,
    snapshotId: string,
    eligible: boolean,
    turnNo?: number,
  ): Promise<McpRestoreSource> {
    const call = await this.#restoreCall(tx, scope, snapshotId)
    if (eligible) {
      if (call.revertedAt || call.snapshot!.restoredAt || call.snapshot!.purgeRequestedAt)
        throw conflict('Content snapshot is no longer available for restore')
      // An agent's restore of an earlier turn would survive the undo of its own turn.
      if (turnNo !== undefined && call.turn.turnNo !== turnNo)
        throw conflict('Only the turn undo restores a snapshot of an earlier turn')
      const latest = await tx.mcpCall.findFirst({
        where: {
          objectRef: call.objectRef,
          restoresSnapshotId: null,
          result: 'ok',
          revertedAt: null,
          turn: { task: { siteId: scope.siteId } },
        },
        orderBy: { journalNo: 'desc' },
        select: { id: true },
      })
      if (latest?.id !== call.id) throw conflict('A later content edit must be restored first')
    }
    return {
      receipt: {
        ...this.#reference(call, scope),
        payloadSha256: call.snapshot!.payloadSha256!,
        sizeBytes: call.snapshot!.sizeBytes!,
      },
      expectedStateHash: call.appliedStateHash!,
    }
  }

  #access(input: McpAccess): McpAccess {
    const parsed = mcpAccessSchema.safeParse(input)
    if (!parsed.success) throw badRequest('Invalid MCP journal scope')
    return parsed.data
  }

  /** Both shapes are strict: an agent scope with host fields added to it is neither. */
  #scope(input: McpJournalScope): Scope {
    const agent = mcpAccessSchema.safeParse(input)
    if (agent.success) return agent.data
    const host = mcpHostScopeSchema.safeParse(input)
    if (!host.success) throw badRequest('Invalid MCP journal scope')
    return {
      host: host.data,
      siteId: host.data.siteId,
      workspaceId: host.data.workspaceId,
      taskId: host.data.targetTaskId,
      epoch: host.data.fence.epoch,
    }
  }

  /**
   * `preparing`: the call is being led to its write. The host leads only its own restore
   * there; a call of the agent it may only close from the evidence of the site.
   */
  async #call(tx: Tx, scope: Scope, callId: string, preparing = false): Promise<Call> {
    if (!z.uuid().safeParse(callId).success) throw badRequest('Invalid MCP call reference')
    const call = await tx.mcpCall.findUnique({ where: { id: callId }, include: callInclude })
    if (!call) throw mismatch()
    this.#belongs(call, scope, true)
    if (preparing && scope.host && call.hostTaskId === null) throw mismatch()
    return call
  }

  #belongs(call: Call, scope: Scope, exactEpoch: boolean): void {
    if (scope.host) return this.#hostOwns(call, scope, exactEpoch)
    const assignment = call.assignment
    if (
      !assignment ||
      call.credentialKeyId !== scope.keyId ||
      !call.requestHash ||
      (exactEpoch && call.leaseEpoch !== scope.epoch) ||
      assignment.taskId !== scope.taskId ||
      assignment.siteId !== scope.siteId ||
      assignment.sessionId !== scope.sessionId ||
      assignment.turnNo !== scope.turn ||
      assignment.firstEpoch !== scope.firstEpoch ||
      call.turn.taskId !== scope.taskId ||
      call.turn.turnNo !== scope.turn ||
      call.turn.task.workspaceId !== scope.workspaceId ||
      call.turn.task.siteId !== scope.siteId ||
      call.snapshot?.siteId !== scope.siteId ||
      call.snapshot.taskId !== scope.taskId ||
      call.snapshot.objectRef !== call.objectRef
    )
      throw mismatch()
    if (call.snapshot.s3Key !== contentSnapshotKey(call.snapshot)) throw mismatch()
  }

  /**
   * The host owns a call written under the very lease of its fence: its own restore, or — for
   * reconciliation after the turn — a call of the agent of the task that holds a turn lease.
   */
  #hostOwns(call: Call, scope: HostScope, exactEpoch: boolean): void {
    const { fence } = scope.host
    const owner =
      call.hostTaskId !== null
        ? call.assignmentId === null &&
          call.credentialKeyId === null &&
          call.hostTaskId === fence.taskId &&
          call.hostOperation === fence.operation
        : call.assignment !== null &&
          call.credentialKeyId !== null &&
          fence.operation === 'turn' &&
          call.assignment.taskId === fence.taskId &&
          call.assignment.siteId === scope.siteId &&
          call.assignment.turnNo === call.turn.turnNo
    if (
      !owner ||
      !call.requestHash ||
      (exactEpoch && call.leaseEpoch !== scope.epoch) ||
      call.turn.taskId !== scope.taskId ||
      call.turn.task.workspaceId !== scope.workspaceId ||
      call.turn.task.siteId !== scope.siteId ||
      call.snapshot?.siteId !== scope.siteId ||
      call.snapshot.taskId !== scope.taskId ||
      call.snapshot.objectRef !== call.objectRef
    )
      throw mismatch()
    if (call.snapshot.s3Key !== contentSnapshotKey(call.snapshot)) throw mismatch()
  }

  #reference(call: Call, scope: Scope): ContentSnapshotRef {
    const snapshot = call.snapshot!
    return {
      id: snapshot.id,
      workspaceId: scope.workspaceId,
      siteId: scope.siteId,
      taskId: scope.taskId,
      objectRef: snapshot.objectRef,
      expiresAt: snapshot.expiresAt,
    }
  }

  /** The live owner of the scope: the agent's key and assignment, or the host's lease fence. */
  #admit(tx: Tx, scope: Scope) {
    return scope.host ? this.#hostActive(tx, scope) : this.#active(tx, scope)
  }

  /** Whoever still owns the epoch may record evidence of a write it started. */
  #held(tx: Tx, scope: Scope) {
    return scope.host ? this.#hostLease(tx, scope) : this.#lease(tx, scope)
  }

  async #hostLease(tx: Tx, scope: HostScope) {
    const { fence } = scope.host
    const rows = await tx.$queryRaw<Array<{ inflightMcpCallId: string | null; now: Date }>>`
      SELECT inflight_mcp_call_id AS "inflightMcpCallId", clock_timestamp() AS now
      FROM site_leases WHERE site_id = ${scope.siteId}::uuid AND holder_task_id = ${fence.taskId}::uuid
        AND epoch = ${fence.epoch} AND operation = ${fence.operation}::"LeaseOperation" FOR UPDATE`
    if (rows.length !== 1) throw leaseLost('MCP call no longer owns its site lease')
    return rows[0]!
  }

  /**
   * Admission of the trusted host: the fence holds the site — the holder, the epoch and the
   * operation, a turn or a revert — the site is not held for the operator and its lease has
   * not expired; the site is active; the target task is the holder or the task the holder
   * reverts, and its content context is not retired. No key and no assignment are looked at.
   */
  async #hostActive(tx: Tx, scope: HostScope) {
    const lease = await this.#hostLease(tx, scope)
    const { fence } = scope.host
    const rows = await tx.$queryRaw<Array<{ now: Date; deadlineAt: Date }>>`
      SELECT clock_timestamp() AS now,
        LEAST(l.expires_at, clock_timestamp() + interval '15 seconds') AS "deadlineAt"
      FROM site_leases l
      JOIN tasks h ON h.id = l.holder_task_id AND h.site_id = l.site_id
      JOIN tasks t ON t.site_id = l.site_id AND (t.id = h.id OR t.id = h.reverts_task_id)
      JOIN sites s ON s.id = l.site_id AND s.workspace_id = t.workspace_id
        AND s.workspace_id = h.workspace_id
      WHERE l.site_id = ${scope.siteId}::uuid AND l.holder_task_id = ${fence.taskId}::uuid
        AND l.epoch = ${fence.epoch} AND l.operation = ${fence.operation}::"LeaseOperation"
        AND NOT l.held_for_operator AND l.expires_at > clock_timestamp()
        AND t.id = ${scope.taskId}::uuid AND t.workspace_id = ${scope.workspaceId}::uuid
        AND s.status = 'active' AND t.content_retired_at IS NULL`
    if (rows.length !== 1) throw hostInactive()
    return { ...lease, ...rows[0]! }
  }

  async #lease(tx: Tx, scope: McpAccess) {
    const rows = await tx.$queryRaw<Array<{ inflightMcpCallId: string | null; now: Date }>>`
      SELECT inflight_mcp_call_id AS "inflightMcpCallId", clock_timestamp() AS now
      FROM site_leases WHERE site_id = ${scope.siteId}::uuid AND holder_task_id = ${scope.taskId}::uuid
        AND epoch = ${scope.epoch} AND operation = 'turn' FOR UPDATE`
    if (rows.length !== 1) throw leaseLost('MCP call no longer owns its site lease')
    return rows[0]!
  }

  async #active(tx: Tx, scope: McpAccess) {
    const lease = await this.#lease(tx, scope)
    const rows = await tx.$queryRaw<
      Array<{ assignmentId: string; turnId: string | null; now: Date; deadlineAt: Date }>
    >`
      SELECT a.id AS "assignmentId", tt.id AS "turnId", clock_timestamp() AS now,
        LEAST(k.expires_at, k.valid_until, a.deadline_at, l.expires_at,
          clock_timestamp() + interval '15 seconds') AS "deadlineAt"
      FROM llm_keys k JOIN tasks t ON t.id = k.task_id
      JOIN sites s ON s.id = t.site_id AND s.workspace_id = t.workspace_id
      JOIN turn_assignments a ON a.task_id = t.id AND a.site_id = s.id
        AND a.session_id = k.session_id AND a.turn_no = k.turn_no AND a.first_epoch = k.first_epoch
      JOIN site_leases l ON l.site_id = s.id AND l.holder_task_id = t.id AND l.epoch = a.lease_epoch
      LEFT JOIN task_turns tt ON tt.task_id = t.id AND tt.turn_no = a.turn_no AND tt.status = 'running'
      WHERE k.id = ${scope.keyId}::uuid AND t.id = ${scope.taskId}::uuid AND s.id = ${scope.siteId}::uuid
        AND t.workspace_id = ${scope.workspaceId}::uuid AND a.session_id = ${scope.sessionId}
        AND a.turn_no = ${scope.turn} AND a.first_epoch = ${scope.firstEpoch} AND a.lease_epoch = ${scope.epoch}
        AND k.mcp_token_hash IS NOT NULL AND k.revoke_requested_at IS NULL AND k.revoked_at IS NULL
        AND k.task_attempt = t.attempt AND k.expires_at > clock_timestamp() AND k.valid_until > clock_timestamp()
        AND a.deadline_at > clock_timestamp() AND a.finished_at IS NULL AND a.outcome IS NULL
        AND l.operation = 'turn' AND NOT l.held_for_operator AND l.expires_at > clock_timestamp()
        AND s.status = 'active' AND t.content_retired_at IS NULL
        AND t.status <> ALL(${[...terminalTaskStatuses]}::"TaskStatus"[])`
    if (rows.length !== 1) throw leaseLost('MCP mutation scope is no longer active')
    const row = rows[0]!
    if (!row.turnId) throw conflict('MCP mutation requires a persisted task turn')
    await tx.task.updateMany({
      where: { id: scope.taskId, contentAccessedAt: null },
      data: { contentAccessedAt: row.now },
    })
    return { ...lease, ...row, turnId: row.turnId }
  }

  async #transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(work)
    } catch (error) {
      if (isDomainError(error)) throw error
      throw unavailable()
    }
  }
}
