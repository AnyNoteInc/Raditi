import { createHash } from 'node:crypto'

import {
  badRequest,
  conflict,
  contentWriteProofSchema,
  contentRecoveryOutcomeSchema,
  contentUndoStopCodes,
  DomainError,
  isDomainError,
  publishedContentHashMaterial,
  publishedContentPatchSchema,
  publishedContentStateSchema,
  undoTaskInputSchema,
  undoTurnInputSchema,
  type ContentUndoResult,
  type ContentWriteOutcome,
  type ContentWriteProof,
  type PublishedContentGateway,
  type PublishedContentPatch,
  type PublishedContentState,
  type TrustedContentUndo,
} from '@repo/domain'
import { z } from 'zod'

import { TURN_KEY_IN_TEXT } from '../llm/turn-key.ts'
import {
  CONTENT_SNAPSHOT_MAX_BYTES,
  type ContentSnapshotRef,
  type ContentSnapshotStorage,
} from './content-snapshots.ts'
import type { ContentPrivacy } from './content-privacy.ts'
import type { McpAccess, McpSiteScope } from './mcp-access.ts'
import {
  mcpIdempotencyKeySchema as idempotencyKey,
  mcpUndoKey,
  type McpCallCompletion,
  type McpJournalScope,
  type McpMutationCommand,
  type McpUndoTarget,
  type PostgresMcpJournal,
} from './mcp-journal.ts'

export const MCP_CONTENT = Symbol('MCP_CONTENT')
const routeSchema = z.string().regex(/^\/wp\/v2\/(posts|pages)\/[1-9][0-9]{0,9}$/)
const wpRestCallSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('GET'), route: routeSchema }),
  z.strictObject({
    method: z.literal('POST'),
    route: routeSchema,
    body: publishedContentPatchSchema,
    idempotencyKey,
  }),
])
/**
 * MCP advertises a tool's input only as a JSON object schema, and clients refuse a tool list
 * with any tool lacking one. The flat object is what tools/list shows; the refinement keeps
 * the exact GET/POST combinations.
 */
export const wpRestArgumentsSchema = z
  .strictObject({
    method: z.enum(['GET', 'POST']).describe('GET reads the object, POST updates it'),
    route: routeSchema.describe('/wp/v2/posts/ID or /wp/v2/pages/ID'),
    body: publishedContentPatchSchema
      .optional()
      .describe('POST only: the new title, content or excerpt'),
    idempotencyKey: idempotencyKey
      .optional()
      .describe('POST only: a new key for every distinct change'),
  })
  .superRefine((value, context) => {
    if (!wpRestCallSchema.safeParse(value).success)
      context.addIssue({ code: 'custom', message: 'Invalid wp_rest arguments' })
  })
export const restoreArgumentsSchema = z.strictObject({ snapshotId: z.uuid(), idempotencyKey })
export type WpRestArguments = z.infer<typeof wpRestCallSchema>
export type RestoreArguments = z.infer<typeof restoreArgumentsSchema>
/**
 * Finds the gateway of a site by the site alone — its workspace, stack and address. The scope
 * of an agent and the scope of the host both carry it, and a resolver may read nothing else.
 */
export type ContentGatewayResolver = (
  scope: McpSiteScope | McpJournalScope,
) => Promise<PublishedContentGateway>
/** The epoch of the lease that admits a call: every write to the site is fenced by it. */
const leaseEpoch = (scope: McpJournalScope) => ('fence' in scope ? scope.fence.epoch : scope.epoch)
/** What the trusted undo answers besides its counter: these codes reach its caller as they are. */
const undoCodes = new Set<string>([...contentUndoStopCodes, 'LEASE_LOST', 'BAD_REQUEST'])
const restoreFailed = () =>
  new DomainError('CONTENT_RESTORE_FAILED', 'Turn restore stopped before completion', 503)
const pending = () =>
  new DomainError('MCP_CALL_IN_FLIGHT', 'A content call requires completion or recovery', 409)
const failure = (code: string): McpCallCompletion => ({ result: 'error', response: { code } })
/** Fixed, content-free refusals a site adapter may raise while reading the object. */
const preparationCodes = new Set(['CONTENT_TOO_LARGE', 'CONTENT_OBJECT_UNAVAILABLE'])
/** Why a site found a value invalid; parsed here until the port carries it. */
const refusalReasonSchema = z.object({ reason: z.enum(['markup', 'size', 'storage']) })
const refusalCodes = {
  markup: 'CONTENT_MARKUP_UNSUPPORTED',
  size: 'CONTENT_TOO_LARGE',
  storage: 'CONTENT_STORAGE_MISMATCH',
} as const

function refusalCode(outcome: Exclude<ContentWriteOutcome, ContentWriteProof>): string {
  if (outcome.code === 'conflict') return 'CONTENT_CONFLICT'
  if (outcome.code === 'unavailable') return 'CONTENT_SITE_UNAVAILABLE'
  const reason = refusalReasonSchema.safeParse(outcome)
  return outcome.code === 'invalid' && reason.success
    ? refusalCodes[reason.data.reason]
    : 'CONTENT_WRITE_REJECTED'
}

function contentWriteSuccess(
  intent: { objectRef: string; snapshotId: string; restoresSnapshotId: string | null },
  stateHash: string,
): McpCallCompletion {
  return {
    result: 'ok',
    appliedStateHash: stateHash,
    response: intent.restoresSnapshotId
      ? { objectRef: intent.objectRef, restored: true, snapshotId: intent.restoresSnapshotId }
      : { objectRef: intent.objectRef, updated: true, snapshotId: intent.snapshotId },
  }
}

function verifyContentProof(
  scope: McpJournalScope,
  intent: { callId: string; requestHash: string; objectRef: string },
  proof: ContentWriteProof,
) {
  if (
    !contentWriteProofSchema.safeParse(proof).success ||
    proof.callId !== intent.callId ||
    proof.siteId !== scope.siteId ||
    proof.epoch !== leaseEpoch(scope) ||
    proof.requestHash !== intent.requestHash ||
    proof.objectRef !== intent.objectRef
  )
    throw conflict('Content write receipt failed verification')
}

/**
 * Trusted host recovery, not an agent tool. No dispatch is retried: only a matching site
 * receipt, or its durable negative proof after the deadline, closes an admitted write.
 */
export async function recoverContentWrite(
  journal: PostgresMcpJournal,
  resolve: ContentGatewayResolver,
  scope: McpJournalScope,
  callId: string,
): Promise<'completed' | 'not_committed' | 'unknown'> {
  const intent = await journal.recoveryIntent(scope, callId)
  if (intent.kind === 'closed') return intent.committed ? 'completed' : 'not_committed'
  const gateway = await resolve(scope)
  const proof = await gateway.reconcileOperation({
    callId,
    siteId: scope.siteId,
    epoch: leaseEpoch(scope),
    requestHash: intent.requestHash,
    objectRef: intent.objectRef,
    deadlineAt: intent.deadlineAt,
    ttlMs: intent.ttlMs,
  })
  if (!contentRecoveryOutcomeSchema.safeParse(proof).success)
    throw conflict('Content recovery receipt failed verification')
  if (proof.kind === 'unknown') {
    await journal.markAmbiguous(scope, callId)
    return 'unknown'
  }
  if (proof.kind === 'not_committed') {
    if (
      proof.callId !== callId ||
      proof.siteId !== scope.siteId ||
      proof.epoch !== leaseEpoch(scope) ||
      proof.requestHash !== intent.requestHash ||
      proof.objectRef !== intent.objectRef ||
      proof.deadlineAt !== intent.deadlineAt
    )
      throw conflict('Content recovery receipt failed verification')
    await journal.finish(scope, callId, failure('CONTENT_WRITE_NOT_COMMITTED'))
    return 'not_committed'
  }
  verifyContentProof(scope, intent, proof)
  await journal.finish(scope, callId, contentWriteSuccess(intent, proof.stateHash))
  return 'completed'
}

/** CMS writes are never retried here. Only a durable, matching site-side receipt closes one. */
export class McpContentService implements TrustedContentUndo {
  constructor(
    private readonly journal: PostgresMcpJournal,
    private readonly snapshots: ContentSnapshotStorage,
    private readonly privacy: ContentPrivacy,
    private readonly resolve: ContentGatewayResolver,
  ) {}

  async wpRest(scope: McpAccess, input: WpRestArguments): Promise<McpCallCompletion> {
    const parsed = wpRestCallSchema.safeParse(input)
    // Which stack has published content is the resolver's question: it asks the registry of
    // site adapters and refuses a site without one.
    if (!parsed.success) throw badRequest('Unsupported published content request')
    const args = parsed.data
    const parts = args.route.split('/')
    const objectRef = `${parts[3] === 'posts' ? 'post' : 'page'}:${parts[4]}`
    if (args.method === 'GET') {
      await this.journal.noteContentAccess(scope)
      const state = this.#state(await (await this.resolve(scope)).read(objectRef), objectRef)
      const masked = await this.privacy.mask(scope, this.#fields(state))
      if (Buffer.byteLength(JSON.stringify(masked)) > 64 * 1024)
        throw badRequest('Masked content exceeds its limit')
      return { result: 'ok', response: { objectRef, ...masked } }
    }
    // The agent can read its own turn credentials in the sandbox; output filters stop them in
    // events and Git, this stops a public page.
    if (Object.values(args.body).some((value) => TURN_KEY_IN_TEXT.test(value)))
      throw new DomainError(
        'CONTENT_CREDENTIAL_REFUSED',
        'Published content must not carry a turn credential',
        400,
      )
    // Rehydrated contacts are never included in journal arguments or responses.
    const fields = await this.privacy.rehydrate(scope, args.body)
    this.#boundedPatch(fields)
    return this.#mutate(
      scope,
      {
        tool: 'wp_rest',
        objectRef,
        idempotencyKey: args.idempotencyKey,
        arguments: { method: args.method, route: args.route, body: args.body },
      },
      fields,
    )
  }

  /** The agent's tool: only snapshots of its own turn. */
  restore(scope: McpAccess, input: RestoreArguments): Promise<McpCallCompletion> {
    return this.#restore(scope, input, false)
  }

  async #restore(
    scope: McpJournalScope,
    input: RestoreArguments,
    hostUndo: boolean,
  ): Promise<McpCallCompletion> {
    const parsed = restoreArgumentsSchema.safeParse(input)
    if (!parsed.success) throw badRequest('Invalid restore request')
    const args = parsed.data
    const source = await this.journal.restoreSource(scope, args.snapshotId)
    return this.#mutate(
      scope,
      {
        tool: 'restore',
        objectRef: source.receipt.objectRef,
        idempotencyKey: args.idempotencyKey,
        arguments: { snapshotId: args.snapshotId },
      },
      undefined,
      args.snapshotId,
      hostUndo,
    )
  }

  /** Trusted host recovery, not an agent tool. No dispatch is retried. */
  recoverWrite(scope: McpJournalScope, callId: string) {
    return recoverContentWrite(this.journal, this.resolve, scope, callId)
  }

  /**
   * Trusted turn undo, never an agent tool. Stops at a conflict instead of erasing later
   * edits; any other failure is retryable. Under the scope of an agent the caller must keep
   * the turn active; the host scope asks for the fence of the site lease only.
   */
  async rollbackTurn(scope: McpJournalScope, turnNo: number): Promise<string[]> {
    const ids = await this.journal.turnSnapshots(scope, turnNo)
    return this.#undo(
      scope,
      ids.map((snapshotId) => ({ snapshotId, turnNo })),
    )
  }

  /**
   * The edits of one turn of the task that holds the turn lease, returned by the fence alone:
   * the key of the turn may be revoked or gone. Only the trusted side of the role calls this.
   */
  async undoTurn(input: Parameters<TrustedContentUndo['undoTurn']>[0]): Promise<ContentUndoResult> {
    const parsed = undoTurnInputSchema.safeParse(input)
    if (!parsed.success) throw badRequest('Invalid content undo request')
    const { fence, turn } = parsed.data
    return this.#trusted(async () => {
      const scope = await this.journal.hostScope(fence, fence.taskId)
      return { restored: (await this.rollbackTurn(scope, turn)).length }
    })
  }

  /**
   * «Отменить»: every edit of the target task that is not returned yet, newest first. The
   * target is the holder of the lease or the task the holder reverts.
   */
  async undoTask(input: Parameters<TrustedContentUndo['undoTask']>[0]): Promise<ContentUndoResult> {
    const parsed = undoTaskInputSchema.safeParse(input)
    if (!parsed.success) throw badRequest('Invalid content undo request')
    const { fence, targetTaskId } = parsed.data
    return this.#trusted(async () => {
      const scope = await this.journal.hostScope(fence, targetTaskId)
      return { restored: (await this.#undo(scope, await this.journal.taskSnapshots(scope))).length }
    })
  }

  /** The port answers with a counter or one of its fixed codes; nothing else leaves the role. */
  async #trusted(work: () => Promise<ContentUndoResult>): Promise<ContentUndoResult> {
    try {
      return await work()
    } catch (error) {
      if (isDomainError(error) && undoCodes.has(error.code)) throw error
      // An unknown write, a journal or site outage: the same call goes on after it is over.
      throw restoreFailed()
    }
  }

  async #undo(scope: McpJournalScope, targets: McpUndoTarget[]): Promise<string[]> {
    const restored: string[] = []
    for (const target of targets) {
      const outcome = await this.#restore(
        scope,
        { snapshotId: target.snapshotId, idempotencyKey: mcpUndoKey(target) },
        true,
      )
      if (outcome.result !== 'ok') {
        if (z.object({ code: z.literal('CONTENT_CONFLICT') }).safeParse(outcome.response).success)
          throw conflict('Turn restore stopped at a content conflict')
        throw restoreFailed()
      }
      restored.push(target.snapshotId)
    }
    return restored
  }

  async #mutate(
    scope: McpJournalScope,
    command: McpMutationCommand,
    patch?: PublishedContentPatch,
    sourceId?: string,
    hostUndo = false,
  ): Promise<McpCallCompletion> {
    let reservation = await this.journal.reserve(scope, command, sourceId, hostUndo)
    // A preparation of this very turn that outlived every step it has: its request is gone,
    // or the record that closes it was lost. Close it and answer with its closed result, so
    // that the agent goes on with a new key. A request that is only late finds its call
    // closed and sends nothing; a write that has started is left to recovery.
    if (
      reservation.kind === 'pending' &&
      reservation.stale &&
      reservation.stage !== 'write' &&
      !reservation.recoveryRequired
    ) {
      await this.journal.recoveryIntent(scope, reservation.callId)
      reservation = await this.journal.reserve(scope, command, sourceId, hostUndo)
    }
    if (reservation.kind === 'replay') return reservation.completion
    if (reservation.kind === 'pending') throw pending()
    // prepare: no write was admitted, so a failure closes the call;
    // admitted: a write may have started, only recovery closes it;
    // foreign: another process owns this call's outcome.
    const call: { stage: 'prepare' | 'admitted' | 'foreign' } = { stage: 'prepare' }
    try {
      const gateway = await this.resolve(scope)
      const before = this.#state(await gateway.read(command.objectRef), command.objectRef)
      let fields = patch!
      let expectedStateHash = before.stateHash
      if (reservation.restoreSource) {
        const original = await this.#load(reservation.restoreSource.receipt)
        fields = this.#fields(original)
        expectedStateHash = reservation.restoreSource.expectedStateHash
        if (before.stateHash !== expectedStateHash) {
          const outcome = failure('CONTENT_CONFLICT')
          await this.journal.finish(scope, reservation.callId, outcome)
          return outcome
        }
      }
      const bytes = Buffer.from(JSON.stringify(before))
      try {
        if (bytes.byteLength > CONTENT_SNAPSHOT_MAX_BYTES)
          throw new DomainError('CONTENT_TOO_LARGE', 'Published content exceeds its limit', 413)
        const receipt = await this.snapshots.save(reservation.snapshot, bytes)
        await this.journal.attachSnapshot(scope, reservation.callId, receipt)
      } finally {
        bytes.fill(0)
      }
      // A failed/lost admission response cannot authorize a write or close another writer.
      // A refusal inside the admission transaction rolled it back; a lost commit did not.
      try {
        call.stage = (await this.journal.beginWrite(scope, reservation.callId))
          ? 'admitted'
          : 'foreign'
      } catch (error) {
        if (!isDomainError(error) || error.code === 'MCP_JOURNAL_UNAVAILABLE')
          call.stage = 'admitted'
        throw error
      }
      if (call.stage === 'foreign') throw pending()
      const intent = await this.journal.writeIntent(scope, reservation.callId)
      const outcome = await gateway.conditionalWrite({
        callId: intent.callId,
        requestHash: intent.requestHash,
        objectRef: intent.objectRef,
        deadlineAt: intent.deadlineAt,
        ttlMs: intent.ttlMs,
        siteId: scope.siteId,
        epoch: leaseEpoch(scope),
        mode: sourceId ? 'restore' : 'edit',
        expectedStateHash,
        fields,
      })
      if (outcome.kind === 'committed') {
        verifyContentProof(scope, intent, outcome)
        const completion = contentWriteSuccess(intent, outcome.stateHash)
        await this.journal.finish(scope, reservation.callId, completion)
        return completion
      }
      const completion = failure(refusalCode(outcome))
      await this.journal.finish(scope, reservation.callId, completion)
      return completion
    } catch (error) {
      if (call.stage === 'foreign') throw pending()
      if (call.stage === 'admitted') {
        // Including a lost journal acknowledgement: recovery reconciles the persisted state.
        try {
          await this.journal.markAmbiguous(scope, reservation.callId)
        } catch {
          /* durable marker remains */
        }
        throw pending()
      }
      // Nothing was dispatched: a fixed code only, never an adapter or storage message.
      const completion = failure(
        isDomainError(error) && preparationCodes.has(error.code)
          ? error.code
          : 'CONTENT_PREPARATION_FAILED',
      )
      await this.journal.finish(scope, reservation.callId, completion)
      return completion
    }
  }

  #state(raw: unknown, objectRef: string): PublishedContentState {
    const parsed = publishedContentStateSchema.safeParse(raw)
    if (
      !parsed.success ||
      parsed.data.objectRef !== objectRef ||
      parsed.data.kind !== objectRef.split(':')[0] ||
      createHash('sha256').update(publishedContentHashMaterial(parsed.data)).digest('hex') !==
        parsed.data.stateHash
    )
      throw conflict('Published content state failed verification')
    return parsed.data
  }
  #fields(state: PublishedContentState) {
    return { title: state.title, content: state.content, excerpt: state.excerpt }
  }
  #boundedPatch(fields: PublishedContentPatch) {
    if (
      !publishedContentPatchSchema.safeParse(fields).success ||
      Buffer.byteLength(JSON.stringify(fields)) > CONTENT_SNAPSHOT_MAX_BYTES
    )
      throw badRequest('Published content patch exceeds its limit')
  }
  async #load(receipt: ContentSnapshotRef & { payloadSha256: string; sizeBytes: number }) {
    const bytes = await this.snapshots.load(receipt)
    try {
      return this.#state(
        JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown,
        receipt.objectRef,
      )
    } finally {
      bytes.fill(0)
    }
  }
}
