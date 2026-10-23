import { createHash } from 'node:crypto'

import {
  absentStateHashMaterial,
  additiveChange,
  badRequest,
  conflict,
  contentRecoveryOutcomeSchema,
  contentUndoStopCodes,
  contentWriteProofSchema,
  dbContentFields,
  dbCreatedRecordSchema,
  dbObjectStateSchema,
  dbOperationNotAllowed,
  dbSettingValueAllowed,
  dbStateHashMaterial,
  dbWriteProofSchema,
  DomainError,
  isAbsentState,
  isDomainError,
  isOptionState,
  isRecordState,
  isTableState,
  mentionsCreatedId,
  normalizeTableDefinition,
  orderDbContentFields,
  publishedContentHashMaterial,
  publishedContentPatchSchema,
  publishedContentStateSchema,
  tableDefinitionSchema,
  undoTaskInputSchema,
  undoTurnInputSchema,
  type ContentUndoResult,
  type ContentWriteOutcome,
  type ContentWriteProof,
  type DbAbsentState,
  type DbCreatedRecord,
  type DbObjectState,
  type DbOperationKind,
  type DbOptionState,
  type DbSetting,
  type DbTableState,
  type DbWriteOutcome,
  type PublishedContentGateway,
  type PublishedContentPatch,
  type PublishedContentState,
  type SiteContentGateway,
  type SiteDbGateway,
  type TableDefinition,
  type TrustedContentUndo,
} from '@repo/domain'
import { z } from 'zod'

import type { PreviewDbValueStorage } from '@repo/site-content'
import { publishedValueRefusal } from '@repo/site-content'

import type { McpAccess, McpSiteScope } from '../access/mcp-access.ts'
import type { ContentPrivacy } from '../privacy/content-privacy.ts'
import {
  createBody,
  dbSchemaCallSchema,
  restoreArgumentsSchema,
  tableName,
  wpRestCallSchema,
  type DbSchemaArguments,
  type RestoreArguments,
  type WpRestArguments,
} from './content-arguments.ts'
import {
  CONTENT_SNAPSHOT_MAX_BYTES,
  type ContentSnapshotRef,
  type ContentSnapshotStorage,
} from './content-snapshots.ts'
import {
  mcpUndoKey,
  type McpCallCompletion,
  type McpCreation,
  type McpJournalScope,
  type McpMutationCommand,
  type McpPreviewOperation,
  type McpRestoreSource,
  type McpUndoTarget,
  type PostgresMcpJournal,
} from './mcp-journal.ts'
import type { McpPreviewTarget, PreviewGatewayResolver } from './preview-content.ts'

export const MCP_CONTENT = Symbol('MCP_CONTENT')
/**
 * Finds the gateway of a site by the site alone — its workspace, stack and address. The scope
 * of an agent and the scope of the host both carry it, and a resolver may read nothing else.
 */
export type ContentGatewayResolver = (
  scope: McpSiteScope | McpJournalScope,
) => Promise<PublishedContentGateway>
/** The epoch of the lease that admits a call: every write to the site is fenced by it. */
const leaseEpoch = (scope: McpJournalScope) => ('fence' in scope ? scope.fence.epoch : scope.epoch)

/**
 * What a write carries to the plugin that holds the object, and what its receipt must repeat:
 * the site and the epoch of its lease, or the preview — its copy of the plugin is bound to the
 * preview — and the write epoch the call was admitted under (Р24). The build of a preview
 * replays the plan under that same epoch: a write of an earlier one finds the fence moved.
 */
interface WriteFence {
  siteId: string
  epoch: number
}
const writeFence = (
  scope: McpJournalScope,
  preview: { previewId: string; writeEpoch: number } | null,
): WriteFence =>
  preview
    ? { siteId: preview.previewId, epoch: preview.writeEpoch }
    : { siteId: scope.siteId, epoch: leaseEpoch(scope) }
/** What the trusted undo answers besides its counter: these codes reach its caller as they are. */
const undoCodes = new Set<string>([...contentUndoStopCodes, 'LEASE_LOST', 'BAD_REQUEST'])
const restoreFailed = () =>
  new DomainError('CONTENT_RESTORE_FAILED', 'Turn restore stopped before completion', 503)
const pending = () =>
  new DomainError('MCP_CALL_IN_FLIGHT', 'A content call requires completion or recovery', 409)
const failure = (code: string): McpCallCompletion => ({ result: 'error', response: { code } })
/** Fixed, content-free refusals a site adapter or the preview may raise before a write. */
const preparationCodes = new Set([
  'CONTENT_TOO_LARGE',
  'CONTENT_OBJECT_UNAVAILABLE',
  'CONTENT_PREVIEW_NOT_READY',
  'CONTENT_PREVIEW_UNAVAILABLE',
  'CONTENT_PREVIEW_RESET',
  'CONTENT_CREATED_ID',
  'DB_OPERATION_NOT_ALLOWED',
  'DB_SCHEMA_CONFLICT',
  'DB_SCHEMA_INVALID',
])
/** Content of a dialog with a preview goes there alone; this one takes none now (Р3, Р4). */
const previewUnavailable = () =>
  new DomainError(
    'CONTENT_PREVIEW_UNAVAILABLE',
    'The preview of the dialog does not take content',
    409,
  )
/**
 * A value that names the preview's own address: its database keeps the site's address (Р15),
 * and a release would carry a link to a temporary preview onto the site.
 */
const previewOriginRefused = () =>
  new DomainError(
    'CONTENT_PREVIEW_ORIGIN',
    'Published content must not carry the address of the preview',
    400,
  )
const credentialRefused = () =>
  new DomainError(
    'CONTENT_CREDENTIAL_REFUSED',
    'Published content must not carry a turn credential',
    400,
  )
/**
 * A value that names the id a record created by the dialog has in its preview: production gives
 * the record another, and the value would point at nothing there (M3 of the review of «Операции
 * БД и миграции»). A new page is named by its address.
 */
const createdIdRefused = () =>
  new DomainError(
    'CONTENT_CREATED_ID',
    'A value names the id of a record created in this dialog: name it by its address',
    400,
  )
const settingNotAllowed = () =>
  new DomainError('DB_SETTING_NOT_ALLOWED', 'This setting of the site is not changed here', 422)
const settingInvalid = () =>
  new DomainError('DB_SETTING_INVALID', 'The value does not fit this setting', 400)
const schemaInvalid = () =>
  new DomainError(
    'DB_SCHEMA_INVALID',
    'A table of the platform is created, or extended by nullable columns or ones with a default and by non-unique indexes',
    400,
  )
const schemaConflict = () =>
  new DomainError(
    'DB_SCHEMA_CONFLICT',
    'The table is not where the call expects it: read it again with db_schema GET',
    409,
  )
/** Why a site found a value invalid; parsed here until the port carries it. */
const refusalReasonSchema = z.object({
  reason: z.enum(['markup', 'size', 'storage', 'slug', 'unsupported']),
})
const refusalCodes = {
  markup: 'CONTENT_MARKUP_UNSUPPORTED',
  size: 'CONTENT_TOO_LARGE',
  storage: 'CONTENT_STORAGE_MISMATCH',
  slug: 'CONTENT_SLUG_TAKEN',
  unsupported: 'DB_SCHEMA_UNSUPPORTED',
} as const

function refusalCode(
  outcome: Exclude<ContentWriteOutcome | DbWriteOutcome, { kind: 'committed' }>,
): string {
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
  fence: WriteFence,
  intent: { callId: string; requestHash: string; objectRef: string },
  proof: ContentWriteProof,
) {
  if (
    !contentWriteProofSchema.safeParse(proof).success ||
    proof.callId !== intent.callId ||
    proof.siteId !== fence.siteId ||
    proof.epoch !== fence.epoch ||
    proof.requestHash !== intent.requestHash ||
    proof.objectRef !== intent.objectRef
  )
    throw conflict('Content write receipt failed verification')
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** Every text a state holds: what the rules of published content look at. */
function stateValues(state: DbObjectState): string[] {
  if (isRecordState(state)) return [state.title, state.content, state.excerpt]
  if (isOptionState(state)) return state.value === null ? [] : [state.value]
  if (isTableState(state))
    return (state.definition?.columns ?? []).flatMap((column) =>
      column.default && 'value' in column.default ? [column.default.value] : [],
    )
  return []
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
  verifyContentProof(writeFence(scope, null), intent, proof)
  await journal.finish(scope, callId, contentWriteSuccess(intent, proof.stateHash))
  return 'completed'
}

/**
 * Where content of a dialog with a preview goes (docs/plan/53-chat-preview-release.md, Р3, Р24):
 * the gateway to the preview's copy and the store of the values of its database plan.
 */
export interface McpPreviewContent {
  resolve: PreviewGatewayResolver
  values: Pick<PreviewDbValueStorage, 'save'>
}

export interface McpContentOptions {
  /**
   * The P6 path: content of a dialog without a preview row goes to the site itself. The role
   * turns it on only where previews are not configured (the local stands); a dialog with a
   * preview writes into its preview alone, whatever this says. Default: on.
   */
  siteContent?: boolean
  previews?: McpPreviewContent
  /** The settings of a site a plan may change (`SiteAdapter.dbSettings`). Default: none. */
  dbSettings?: (site: Pick<McpAccess, 'stack' | 'url'>) => readonly DbSetting[]
}

/** What one call asks to write, decided from its arguments before it is admitted. */
type Change =
  | { kind: 'fields'; fields: PublishedContentPatch }
  | { kind: 'create'; record: DbCreatedRecord }
  | { kind: 'option'; setting: string; value: string }
  | { kind: 'table'; create?: TableDefinition; add?: Pick<TableDefinition, 'columns' | 'indexes'> }
  | { kind: 'restore' }

/** The write a call makes, from the state the object holds before it. */
type Planned =
  | { kind: 'record'; before: PublishedContentState; fields: PublishedContentPatch }
  | { kind: 'create'; before: DbAbsentState; record: DbCreatedRecord }
  | { kind: 'trash'; before: PublishedContentState; createCallId: string }
  | { kind: 'option'; before: DbOptionState; value: string | null }
  | { kind: 'table'; before: DbTableState; definition: TableDefinition | null }

/** CMS writes are never retried here. Only a durable, matching site-side receipt closes one. */
export class McpContentService implements TrustedContentUndo {
  readonly #siteContent: boolean
  readonly #previews: McpPreviewContent | undefined
  readonly #dbSettings: (site: Pick<McpAccess, 'stack' | 'url'>) => readonly DbSetting[]

  constructor(
    private readonly journal: PostgresMcpJournal,
    private readonly snapshots: ContentSnapshotStorage,
    private readonly privacy: ContentPrivacy,
    private readonly resolve: ContentGatewayResolver,
    options: McpContentOptions = {},
  ) {
    this.#siteContent = options.siteContent ?? true
    this.#previews = options.previews
    this.#dbSettings = options.dbSettings ?? (() => [])
  }

  async wpRest(scope: McpAccess, input: WpRestArguments): Promise<McpCallCompletion> {
    const parsed = wpRestCallSchema.safeParse(input)
    // Which stack has published content is the resolver's question: it asks the registry of
    // site adapters and refuses a site without one.
    if (!parsed.success)
      throw badRequest(
        'Unsupported published content request: wp_rest reads or updates one post or page, ' +
          'creates one, or reads or changes one setting of the list; a release carries no other ' +
          'change of the database',
      )
    const args = parsed.data
    // An agent never writes the site of a dialog that has a preview, nor of any dialog where
    // the role is not on the P6 path (Р3).
    if (scope.preview === null && !this.#siteContent) throw previewUnavailable()
    if (args.route === '/wp/v2/settings')
      return args.method === 'GET'
        ? this.#readSettings(scope)
        : this.#writeSetting(scope, args.body as Record<string, string | number>, args)
    const parts = args.route.split('/')
    const type = parts[3] === 'posts' ? 'post' : 'page'
    if (parts.length === 4)
      return this.#create(scope, type, createBody.parse('body' in args ? args.body : null), args)
    const objectRef = `${type}:${parts[4]}`
    if (args.method === 'GET') {
      let gateway: PublishedContentGateway
      if (scope.preview)
        gateway = await this.#previewGateway(await this.journal.previewTarget(scope))
      else {
        await this.journal.noteContentAccess(scope)
        gateway = await this.resolve(scope)
      }
      const state = this.#state(await gateway.read(objectRef), objectRef)
      const masked = await this.privacy.mask(scope, this.#fields(state))
      if (Buffer.byteLength(JSON.stringify(masked)) > 64 * 1024)
        throw badRequest('Masked content exceeds its limit')
      return {
        result: 'ok',
        response: {
          objectRef,
          ...masked,
          ...(state.status === 'draft' ? { status: 'draft' } : {}),
        },
      }
    }
    const body = publishedContentPatchSchema.parse(args.body)
    this.#refuseValues(Object.values(body), scope)
    // Rehydrated contacts are never included in journal arguments or responses.
    const fields = await this.privacy.rehydrate(scope, body)
    this.#boundedPatch(fields)
    return this.#mutate(
      scope,
      {
        tool: 'wp_rest',
        objectRef,
        idempotencyKey: (args as { idempotencyKey: string }).idempotencyKey,
        arguments: { method: args.method, route: args.route, body },
      },
      { kind: 'fields', fields },
    )
  }

  /**
   * `db_schema` (docs/plan/53, «Операции БД и миграции»): a table of the platform read, created
   * or extended by the dictionary — never SQL of the agent's — in the preview of the dialog.
   */
  async dbSchema(scope: McpAccess, input: DbSchemaArguments): Promise<McpCallCompletion> {
    const parsed = dbSchemaCallSchema.safeParse(input)
    const table = tableName.safeParse(`table:${parsed.data?.table ?? ''}`)
    if (!parsed.success || !table.success) throw schemaInvalid()
    const args = parsed.data
    const objectRef = `table:${table.data}`
    const target = await this.#kindTarget(scope, 'schema_migration')
    if (args.method === 'GET') {
      const state = await this.#readTable(await this.#previewGateway(target), objectRef)
      return {
        result: 'ok',
        response: {
          table: table.data,
          exists: state.exists,
          managed: state.managed,
          definition: state.definition,
        },
      }
    }
    let change: Change
    if ('create' in args) {
      const definition = tableDefinitionSchema.safeParse(
        normalizeTableDefinition({
          columns: args.create.columns ?? [],
          indexes: args.create.indexes ?? [],
        }),
      )
      if (!definition.success) throw schemaInvalid()
      change = { kind: 'table', create: definition.data }
    } else
      change = {
        kind: 'table',
        add: { columns: args.add.columns ?? [], indexes: args.add.indexes ?? [] },
      }
    const values = [...(change.create?.columns ?? []), ...(change.add?.columns ?? [])].flatMap(
      (column) => (column.default && 'value' in column.default ? [column.default.value] : []),
    )
    this.#refuseValues(values, scope)
    return this.#mutate(
      scope,
      {
        tool: 'db_schema',
        objectRef,
        idempotencyKey: args.idempotencyKey,
        arguments: {
          method: 'POST',
          table: table.data,
          ...('create' in args ? { create: args.create } : { add: args.add }),
        },
      },
      change,
    )
  }

  /** The agent's tool: only snapshots of its own turn, into the target they were taken from. */
  async restore(scope: McpAccess, input: RestoreArguments): Promise<McpCallCompletion> {
    if (scope.preview === null && !this.#siteContent) throw previewUnavailable()
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
      { kind: 'restore' },
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

  // -------------------------------------------------------------------------------------------
  // The kinds of a plan beyond the text of a record (docs/plan/53, «Операции БД и миграции»)
  // -------------------------------------------------------------------------------------------

  /** The preview of the dialog when its last build found `kind` writable there; refused else. */
  async #kindTarget(scope: McpAccess, kind: DbOperationKind): Promise<McpPreviewTarget> {
    if (scope.preview === null) throw dbOperationNotAllowed(kind)
    const target = await this.journal.previewTarget(scope)
    if (!target.db?.kinds.includes(kind)) throw dbOperationNotAllowed(kind)
    return target
  }

  /** The settings of the list this preview's plugins both keep, by the agent's names. */
  #settingsOf(scope: McpAccess, target: McpPreviewTarget): DbSetting[] {
    const allowed = new Set(target.db?.settings ?? [])
    return this.#dbSettings(scope).filter((setting) => allowed.has(setting.option))
  }

  /** `GET /wp/v2/settings`: every setting of the list, contacts in it masked like any text. */
  async #readSettings(scope: McpAccess): Promise<McpCallCompletion> {
    const target = await this.#kindTarget(scope, 'option_update')
    const db = this.#db(await this.#previewGateway(target))
    const values: Record<string, string> = {}
    for (const setting of this.#settingsOf(scope, target)) {
      const state = await db.readObject(`option:${setting.option}`)
      if (!isOptionState(state) || sha256(dbStateHashMaterial(state)) !== state.stateHash)
        throw conflict('Setting state failed verification')
      values[setting.setting] = state.value ?? ''
    }
    return { result: 'ok', response: { settings: await this.privacy.mask(scope, values) } }
  }

  /** `POST /wp/v2/settings`: one setting of the list, its value as the list allows it. */
  async #writeSetting(
    scope: McpAccess,
    body: Record<string, string | number>,
    args: { method: string; route: string; idempotencyKey?: string },
  ): Promise<McpCallCompletion> {
    const target = await this.#kindTarget(scope, 'option_update')
    const [name, given] = Object.entries(body)[0]!
    const setting = this.#settingsOf(scope, target).find((candidate) => candidate.setting === name)
    if (!setting) throw settingNotAllowed()
    const value = typeof given === 'number' ? String(given) : given
    this.#refuseValues([value], scope)
    const { value: whole } = await this.privacy.rehydrate(scope, { value })
    if (!dbSettingValueAllowed(setting, whole)) throw settingInvalid()
    return this.#mutate(
      scope,
      {
        tool: 'wp_rest',
        objectRef: `option:${setting.option}`,
        idempotencyKey: args.idempotencyKey!,
        arguments: { method: 'POST', route: args.route, body },
      },
      { kind: 'option', setting: setting.setting, value: whole },
    )
  }

  /** `POST /wp/v2/pages` or `/wp/v2/posts`: a new record, its id given by the journal. */
  async #create(
    scope: McpAccess,
    type: 'post' | 'page',
    body: z.infer<typeof createBody>,
    args: { method: string; route: string; idempotencyKey?: string },
  ): Promise<McpCallCompletion> {
    const target = await this.#kindTarget(scope, 'post_create')
    if (!target.db?.createdIds) throw dbOperationNotAllowed('post_create')
    const texts = { title: body.title, content: body.content ?? '', excerpt: body.excerpt ?? '' }
    this.#refuseValues(Object.values(texts), scope)
    const fields = await this.privacy.rehydrate(scope, texts)
    this.#boundedPatch(fields)
    const record = dbCreatedRecordSchema.parse({ ...fields, slug: body.slug, status: body.status })
    // The lowest free id the preview names: its own records above the base (a revision, a draft
    // of the agent's browser) are never overwritten. The preview runs the agent's code, so this
    // only raises the id the journal gives, never chooses it.
    const capabilities = await this.#db(await this.#previewGateway(target)).capabilities()
    return this.#mutate(
      scope,
      {
        tool: 'wp_rest',
        objectRef: `${type}:new`,
        idempotencyKey: args.idempotencyKey!,
        arguments: { method: 'POST', route: args.route, body },
      },
      { kind: 'create', record },
      undefined,
      false,
      { type, floor: capabilities.nextCreatedId ?? 0 },
    )
  }

  #db(gateway: SiteContentGateway): SiteDbGateway {
    if (!gateway.db) throw dbOperationNotAllowed('option_update')
    return gateway.db
  }

  async #readTable(gateway: PublishedContentGateway, objectRef: string): Promise<DbTableState> {
    const state = await this.#db(gateway).readObject(objectRef)
    if (!isTableState(state) || state.objectRef !== objectRef || !this.#verified(state))
      throw conflict('Table state failed verification')
    return state
  }

  /** A state whose hash is that of its own fields: the preview's plugin is taken at no word. */
  #verified(state: DbObjectState): boolean {
    return (
      dbObjectStateSchema.safeParse(state).success &&
      sha256(dbStateHashMaterial(state)) === state.stateHash
    )
  }

  /**
   * The rules of published content on a value an agent sends: no turn credential, no address of
   * a preview. The ids of created records are checked once the journal has named them.
   */
  #refuseValues(values: readonly string[], scope: McpAccess) {
    // The agent can read its own turn credentials in the sandbox; output filters stop them in
    // events and Git, this stops a public page. A value naming the preview would carry a link to
    // a temporary preview onto the site.
    const refusals = values.map((value) =>
      publishedValueRefusal(value, { hostname: scope.preview?.hostname }),
    )
    if (refusals.includes('credential')) throw credentialRefused()
    if (refusals.includes('preview_origin')) throw previewOriginRefused()
  }

  /** The values a change writes: what may not name a created record. */
  #changeValues(change: Change): string[] {
    switch (change.kind) {
      case 'fields':
        return Object.values(change.fields)
      case 'create':
        return [change.record.title, change.record.content, change.record.excerpt]
      case 'option':
        return [change.value]
      case 'table':
        return [...(change.create?.columns ?? []), ...(change.add?.columns ?? [])].flatMap(
          (column) => (column.default && 'value' in column.default ? [column.default.value] : []),
        )
      case 'restore':
        return []
    }
  }

  /**
   * The write a call makes and the state it starts from. A restore puts back the state its
   * snapshot holds — the text of a record, a setting, a table, or the absence of a record the
   * dialog created (its trash) — and only over the state the restored call left.
   */
  async #plan(
    gateway: PublishedContentGateway,
    objectRef: string,
    change: Change,
    source: McpRestoreSource | undefined,
  ): Promise<Planned> {
    const object = async (): Promise<DbObjectState> => {
      const state = await this.#db(gateway).readObject(objectRef)
      if (state.objectRef !== objectRef || !this.#verified(state))
        throw conflict('Database object state failed verification')
      return state
    }
    switch (change.kind) {
      case 'fields':
        return {
          kind: 'record',
          before: this.#state(await gateway.read(objectRef), objectRef),
          fields: change.fields,
        }
      case 'create': {
        const before = await object()
        if (!isAbsentState(before)) throw conflict('A created record is already there')
        return { kind: 'create', before, record: change.record }
      }
      case 'option': {
        const before = await object()
        if (!isOptionState(before)) throw conflict('Setting state failed verification')
        return { kind: 'option', before, value: change.value }
      }
      case 'table': {
        const before = await object()
        if (!isTableState(before)) throw conflict('Table state failed verification')
        if (change.create) {
          if (before.exists) throw schemaConflict()
          return { kind: 'table', before, definition: change.create }
        }
        if (!before.exists || !before.managed || !before.definition) throw schemaConflict()
        const added = tableDefinitionSchema.safeParse(
          normalizeTableDefinition({
            columns: [...before.definition.columns, ...(change.add?.columns ?? [])],
            indexes: [...before.definition.indexes, ...(change.add?.indexes ?? [])],
          }),
        )
        if (!added.success || additiveChange(before.definition, added.data) !== 'add')
          throw schemaInvalid()
        return { kind: 'table', before, definition: added.data }
      }
      case 'restore': {
        const original = await this.#load(source!.receipt)
        if (isRecordState(original))
          return {
            kind: 'record',
            before: this.#state(await gateway.read(objectRef), objectRef),
            fields: this.#fields(original),
          }
        const before = isAbsentState(original)
          ? this.#state(await gateway.read(objectRef), objectRef)
          : await object()
        if (isAbsentState(original)) {
          if (!isRecordState(before) || !source!.callId) throw conflict('Not a created record')
          return { kind: 'trash', before, createCallId: source!.callId }
        }
        if (isOptionState(original) && isOptionState(before))
          return { kind: 'option', before, value: original.value }
        if (isTableState(original) && isTableState(before))
          return {
            kind: 'table',
            before,
            definition: original.exists ? original.definition : null,
          }
        throw conflict('A snapshot of another kind of object')
      }
    }
  }

  async #mutate(
    scope: McpJournalScope,
    command: McpMutationCommand,
    change: Change,
    sourceId?: string,
    hostUndo = false,
    creation?: McpCreation,
  ): Promise<McpCallCompletion> {
    let reservation = await this.journal.reserve(scope, command, sourceId, hostUndo, creation)
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
      reservation = await this.journal.reserve(scope, command, sourceId, hostUndo, creation)
    }
    if (reservation.kind === 'replay') return reservation.completion
    if (reservation.kind === 'pending') throw pending()
    // prepare: no write was admitted, so a failure closes the call;
    // admitted: a write may have started, only recovery closes it;
    // foreign: another process owns this call's outcome.
    const call: { stage: 'prepare' | 'admitted' | 'foreign' } = { stage: 'prepare' }
    const preview = reservation.preview
    const objectRef = reservation.objectRef ?? command.objectRef
    const createdIds = reservation.createdIds ?? []
    try {
      if (change.kind !== 'fields' && change.kind !== 'restore' && !preview)
        throw dbOperationNotAllowed('option_update')
      // A value that names the id of a record of this dialog (this one's own included) means
      // nothing on production (M3 of the review).
      if (this.#changeValues(change).some((value) => mentionsCreatedId(value, createdIds)))
        throw createdIdRefused()
      const gateway = preview ? await this.#previewGateway(preview) : await this.resolve(scope)
      const planned = await this.#plan(gateway, objectRef, change, reservation.restoreSource)
      if (
        reservation.restoreSource &&
        planned.before.stateHash !== reservation.restoreSource.expectedStateHash
      ) {
        const outcome = failure('CONTENT_CONFLICT')
        await this.journal.finish(scope, reservation.callId, outcome)
        return outcome
      }
      // A write into a preview is kept as an operation with its state after (#operation): one
      // too large to keep is refused before it is written, not left in the preview unrecorded.
      if (
        preview &&
        Buffer.byteLength(JSON.stringify(this.#expectedAfter(planned, objectRef))) >
          CONTENT_SNAPSHOT_MAX_BYTES
      )
        throw new DomainError('CONTENT_TOO_LARGE', 'Published content exceeds its limit', 413)
      const bytes = Buffer.from(JSON.stringify(planned.before))
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
      const fence = writeFence(scope, intent.preview)
      const envelope = {
        callId: intent.callId,
        requestHash: intent.requestHash,
        objectRef: intent.objectRef,
        deadlineAt: intent.deadlineAt,
        ttlMs: intent.ttlMs,
        siteId: fence.siteId,
        epoch: fence.epoch,
        expectedStateHash: planned.before.stateHash,
      }
      const outcome = await this.#write(gateway, planned, envelope, sourceId ? 'restore' : 'edit')
      if (outcome.kind === 'committed') {
        if (
          !dbWriteProofSchema.safeParse(outcome).success ||
          outcome.callId !== intent.callId ||
          outcome.siteId !== fence.siteId ||
          outcome.epoch !== fence.epoch ||
          outcome.requestHash !== intent.requestHash ||
          outcome.objectRef !== intent.objectRef ||
          (planned.kind === 'create'
            ? 'createdRef' in outcome && outcome.createdRef !== intent.objectRef
            : 'createdRef' in outcome && outcome.createdRef !== undefined)
        )
          throw conflict('Content write receipt failed verification')
        const completion = this.#success(intent, planned, change, outcome.stateHash)
        // Into a preview the write is an operation of the dialog's database plan, recorded
        // with its closing. Until it is recorded the preview holds a change the plan does not:
        // a failure here is an unknown outcome, closed by the reset of the preview.
        if (preview) {
          // Only the agent writes into a preview: the host restores the site alone.
          if ('fence' in scope) throw conflict('The host scope does not write into a preview')
          const operation = await this.#operation(
            scope,
            preview,
            reservation.callId,
            gateway,
            planned,
            outcome.stateHash,
            createdIds,
          )
          await this.journal.finish(scope, reservation.callId, completion, operation)
        } else await this.journal.finish(scope, reservation.callId, completion)
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

  /** The state a write is meant to leave, for its size: the next write of the plan is bounded. */
  #expectedAfter(planned: Planned, objectRef: string): unknown {
    switch (planned.kind) {
      case 'record':
        return { ...planned.before, ...planned.fields }
      case 'create':
        return { objectRef, ...planned.record }
      case 'option':
        return { ...planned.before, value: planned.value }
      case 'table':
        return { ...planned.before, definition: planned.definition }
      case 'trash':
        return planned.before
    }
  }

  /** One write through the plugin: the text of a record, or an object of a plan. */
  #write(
    gateway: PublishedContentGateway,
    planned: Planned,
    envelope: {
      callId: string
      requestHash: string
      objectRef: string
      deadlineAt: number
      ttlMs: number
      siteId: string
      epoch: number
      expectedStateHash: string
    },
    mode: 'edit' | 'restore',
  ): Promise<ContentWriteOutcome | DbWriteOutcome> {
    if (planned.kind === 'record')
      return gateway.conditionalWrite({ ...envelope, mode, fields: planned.fields })
    const db = this.#db(gateway)
    switch (planned.kind) {
      case 'create':
        return db.writeObject({
          ...envelope,
          mode,
          change: { kind: 'post_create', record: planned.record, createCallId: envelope.callId },
        })
      case 'trash':
        return db.writeObject({
          ...envelope,
          mode: 'restore',
          change: {
            kind: 'post_trash',
            expectedSlug: planned.before.slug ?? '',
            createCallId: planned.createCallId,
          },
        })
      case 'option':
        return db.writeObject({
          ...envelope,
          mode,
          change: { kind: 'option_update', value: planned.value },
        })
      case 'table':
        return db.writeObject({
          ...envelope,
          mode,
          change: {
            kind: 'schema_migration',
            before: {
              exists: planned.before.exists,
              managed: planned.before.managed,
              definition: planned.before.definition,
            },
            definition: planned.definition,
          },
        })
    }
  }

  /** What the agent reads of a write that committed: no value, no id but its object's. */
  #success(
    intent: { objectRef: string; snapshotId: string; restoresSnapshotId: string | null },
    planned: Planned,
    change: Change,
    stateHash: string,
  ): McpCallCompletion {
    if (intent.restoresSnapshotId || planned.kind === 'record')
      return contentWriteSuccess(intent, stateHash)
    const response =
      planned.kind === 'create'
        ? {
            objectRef: intent.objectRef,
            created: true,
            slug: planned.record.slug,
            status: planned.record.status,
          }
        : change.kind === 'option'
          ? { setting: change.setting, updated: true }
          : { table: intent.objectRef.slice('table:'.length), migrated: true }
    return {
      result: 'ok',
      appliedStateHash: stateHash,
      response: { ...response, snapshotId: intent.snapshotId },
    }
  }

  async #previewGateway(target: McpPreviewTarget): Promise<PublishedContentGateway> {
    if (!this.#previews) throw previewUnavailable()
    return this.#previews.resolve(target)
  }

  /**
   * What a write into a preview changed, as an operation of the database plan (Р3, Р30,
   * «Операции БД и миграции»): the whole state before and after, sealed in raditi-artifacts. The
   * state after is what the plugin's receipt names — the written fields over the state before,
   * or the object read back with that very hash; anything else is unknown. A state read back
   * comes from a preview that runs the agent's code: whatever its plugin answers is held to the
   * rules of the agent's own input. A refusal leaves the write unknown, and the reset of the
   * preview closes it — the plan never keeps such a value. The release checks the values again,
   * and production's plugin filters them (Р30).
   */
  async #operation(
    scope: McpAccess,
    preview: McpPreviewTarget,
    callId: string,
    gateway: PublishedContentGateway,
    planned: Planned,
    stateHash: string,
    createdIds: readonly number[],
  ): Promise<McpPreviewOperation | null> {
    const objectRef = planned.before.objectRef
    let after: DbObjectState
    let kind: McpPreviewOperation['kind']
    let fields: string[]
    if (planned.kind === 'record') {
      const before = planned.before
      const expected = {
        version: before.version,
        objectRef: before.objectRef,
        kind: before.kind,
        ...(before.status ? { status: before.status } : {}),
        ...(before.slug === undefined ? {} : { slug: before.slug }),
        title: planned.fields.title ?? before.title,
        content: planned.fields.content ?? before.content,
        excerpt: planned.fields.excerpt ?? before.excerpt,
      }
      let record: PublishedContentState
      if (sha256(publishedContentHashMaterial(expected)) === stateHash)
        record = { ...expected, stateHash }
      else {
        record = this.#state(await gateway.read(objectRef), objectRef)
        if (record.stateHash !== stateHash) throw conflict('Preview content moved after its write')
      }
      after = record
      kind = 'content_update'
      fields = orderDbContentFields(
        dbContentFields.filter((field) => record[field] !== before[field]),
      )
      if (fields.length === 0) return null
    } else if (planned.kind === 'create' || planned.kind === 'trash') {
      if (planned.kind === 'create') {
        const record = this.#state(await gateway.read(objectRef), objectRef)
        if (
          record.stateHash !== stateHash ||
          record.slug !== planned.record.slug ||
          (record.status ?? 'publish') !== planned.record.status
        )
          throw conflict('Preview content moved after its write')
        after = record
        kind = 'post_create'
        fields = [...dbContentFields]
      } else {
        if (sha256(absentStateHashMaterial(objectRef)) !== stateHash)
          throw conflict('Preview content moved after its write')
        after = { version: 1, objectRef, absent: true, stateHash }
        kind = 'post_trash'
        fields = []
      }
    } else {
      const state = await this.#db(gateway).readObject(objectRef)
      if (state.objectRef !== objectRef || !this.#verified(state) || state.stateHash !== stateHash)
        throw conflict('Preview content moved after its write')
      if (planned.before.stateHash === stateHash) return null
      after = state
      kind = planned.kind === 'option' ? 'option_update' : 'schema_migration'
      fields = planned.kind === 'option' ? ['value'] : ['definition']
    }
    if (
      stateValues(after).some(
        (value) =>
          publishedValueRefusal(value, { hostname: preview.hostname }) !== null ||
          mentionsCreatedId(value, createdIds),
      )
    )
      throw conflict('Preview content broke the rules of published content after its write')
    const value = {
      workspaceId: scope.workspaceId,
      taskId: scope.taskId,
      previewId: preview.previewId,
      callId,
      objectRef,
    }
    const values = this.#previews!.values
    return {
      kind,
      fields,
      beforeHash: planned.before.stateHash,
      afterHash: stateHash,
      before: await values.save({ ...value, side: 'before' }, planned.before),
      after: await values.save({ ...value, side: 'after' }, after),
    }
  }

  #state(raw: unknown, objectRef: string): PublishedContentState {
    const parsed = publishedContentStateSchema.safeParse(raw)
    if (
      !parsed.success ||
      parsed.data.objectRef !== objectRef ||
      parsed.data.kind !== objectRef.split(':')[0] ||
      sha256(publishedContentHashMaterial(parsed.data)) !== parsed.data.stateHash
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
  /** The state a snapshot holds, its hash checked against its own fields. */
  async #load(
    receipt: ContentSnapshotRef & { payloadSha256: string; sizeBytes: number },
  ): Promise<DbObjectState> {
    const bytes = await this.snapshots.load(receipt)
    try {
      const raw = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
      const record = publishedContentStateSchema.safeParse(raw)
      if (record.success) return this.#state(record.data, receipt.objectRef)
      const state = dbObjectStateSchema.safeParse(raw)
      if (
        !state.success ||
        state.data.objectRef !== receipt.objectRef ||
        !this.#verified(state.data)
      )
        throw conflict('Published content state failed verification')
      return state.data
    } finally {
      bytes.fill(0)
    }
  }
}
