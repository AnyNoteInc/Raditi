import { createHash } from 'node:crypto'

import {
  HostingGuardError,
  hostingPathProblem,
  isOptionRef,
  isTableRef,
  publishedContentHashMaterial,
  SiteConnectionError,
  temporaryNameOf,
  type ContentOperationRequest,
  type ContentRecoveryOutcome,
  type ContentWriteOutcome,
  type ContentWriteProof,
  type ContentWriteRequest,
  type DbCreatedRecord,
  type DbObjectState,
  type DbOperationRequest,
  type DbRecoveryOutcome,
  type DbTableState,
  type DbWriteOutcome,
  type DbWriteProof,
  type DbWriteRequest,
  type DeployAccess,
  type DeployManifest,
  type HostingEntry,
  type HostingPath,
  type HostingSession,
  type HostingWriteOptions,
  type PublishedContentGateway,
  type PublishedContentState,
  type ReleasePresigned,
  type ReleaseStep,
  type ReleaseStepAnswer,
  type ReleaseStepDetail,
  type ReleaseStepState,
  type SiteCodeCache,
  type SiteCodeCacheGateway,
  type SiteCodeRefresh,
  type SiteDbCapabilities,
  type SiteDbGateway,
} from '@repo/domain'

import {
  absentHashOf,
  createdHashOf,
  migratedHashOf,
  optionHashOf,
  tableHashOf,
} from '../deploy-step/content.ts'
import { ReleaseApiError, type ReleaseApi } from '../deploy-step/release-api.ts'

// Fakes of the world of the `deploy-step` command (apps/core/src/deploy-step): a hosting
// held in memory, the site's content plugin with its receipts and its epoch fence, and the
// release API of core recording every report. Each keeps a log of what was done to it, so a
// test reads the order of the writes.

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

/**
 * A hosting in memory: files with modes, folders, links; every change is logged. Its sessions
 * behave as SFTP sessions do: a closed or dropped one answers nothing, and a write broken
 * midway may leave its temporary file behind.
 */
export class MemoryHosting {
  readonly files = new Map<string, { bytes: Buffer; mode: number }>()
  readonly folders = new Set<string>()
  readonly links = new Set<string>()
  readonly log: string[] = []
  /** Called before each write or removal, by kind and path: may change the hosting or throw. */
  beforeChange: ((kind: 'write' | 'remove' | 'rmdir', path: string) => void) | null = null
  /** Called on every request of every session: a test advances its clock here (latency). */
  onRequest: (() => void) | null = null
  closed = 0
  opened = 0
  /** Requests of all sessions. */
  requests = 0
  readonly #live = new Set<{ alive: boolean }>()

  constructor(initial: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(initial)) this.put(path, text)
  }

  put(path: string, text: string | Buffer, mode = 0o644): void {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index += 1)
      this.folders.add(segments.slice(0, index).join('/'))
    this.files.set(path, { bytes: Buffer.from(text), mode })
  }

  text(path: string): string | null {
    const file = this.files.get(path)
    return file ? file.bytes.toString('utf8') : null
  }

  /** The connections drop: every open session refuses every request from now on. */
  dropConnections(): void {
    for (const connection of this.#live) connection.alive = false
  }

  /** Temporary files of atomic writes left on the hosting. */
  get temporaries(): string[] {
    return [...this.files.keys()].filter((path) => /(^|\/)\.raditi-[0-9a-f]+\.tmp$/.test(path))
  }

  session(): HostingSession {
    const connection = { alive: true }
    this.#live.add(connection)
    this.opened += 1
    let open = true
    const join = (path: HostingPath) => {
      // A closed or dropped session answers nothing, as a closed SFTP channel does not.
      if (!open || !connection.alive) throw new SiteConnectionError('transfer_failed')
      if (hostingPathProblem(path) !== null) throw new HostingGuardError('path')
      this.requests += 1
      this.onRequest?.()
      return path.join('/')
    }
    const walk = (path: HostingPath, missing: 'null' | 'throw'): boolean => {
      for (let index = 1; index < path.length; index += 1) {
        const folder = path.slice(0, index).join('/')
        if (this.links.has(folder) || this.files.has(folder))
          throw new HostingGuardError('not_a_directory')
        if (!this.folders.has(folder)) {
          if (missing === 'null') return false
          throw new SiteConnectionError('not_found')
        }
      }
      return true
    }
    const entry = (full: string): HostingEntry | null => {
      if (this.links.has(full)) return { type: 'link', size: 0, mode: 0o777 }
      if (this.folders.has(full)) return { type: 'directory', size: 0, mode: 0o755 }
      const file = this.files.get(full)
      return file ? { type: 'file', size: file.bytes.byteLength, mode: file.mode } : null
    }
    return {
      stat: async (path) => {
        const full = join(path)
        if (!walk(path, 'null')) return null
        return entry(full)
      },
      read: async (path, maxBytes) => {
        const full = join(path)
        walk(path, 'throw')
        const found = entry(full)
        if (found === null) throw new SiteConnectionError('not_found')
        if (found.type !== 'file') throw new HostingGuardError('not_a_file')
        if (found.size > maxBytes) throw new HostingGuardError('bytes')
        return Buffer.from(this.files.get(full)!.bytes)
      },
      writeAtomic: async (path, bytes, options: HostingWriteOptions) => {
        const full = join(path)
        walk(path, 'throw')
        const temporary = options.temporaryKey
          ? [...path.slice(0, -1), temporaryNameOf(options.temporaryKey)].join('/')
          : null
        try {
          this.beforeChange?.('write', full)
        } catch (error) {
          // The upload broke after the temporary was made: it stays behind.
          if (temporary !== null && !connection.alive)
            this.files.set(temporary, { bytes: Buffer.from(bytes.subarray(0, 1)), mode: 0o600 })
          throw error
        }
        if (temporary !== null && this.files.has(temporary)) this.files.delete(temporary)
        const found = entry(full)
        if (found !== null && found.type !== 'file') throw new HostingGuardError('not_a_file')
        if (found !== null && !options.replace) throw new HostingGuardError('exists')
        this.files.set(full, { bytes: Buffer.from(bytes), mode: options.mode })
        this.log.push(`write ${full} ${options.mode.toString(8)}`)
      },
      remove: async (path) => {
        const full = join(path)
        if (!walk(path, 'null')) return
        const found = entry(full)
        if (found === null) return
        this.beforeChange?.('remove', full)
        if (found.type !== 'file') throw new HostingGuardError('not_a_file')
        this.files.delete(full)
        this.log.push(`remove ${full}`)
      },
      mkdirp: async (path) => {
        for (let index = 1; index <= path.length; index += 1) {
          const folder = join(path.slice(0, index))
          if (this.links.has(folder) || this.files.has(folder))
            throw new HostingGuardError('not_a_directory')
          if (!this.folders.has(folder)) {
            this.folders.add(folder)
            this.log.push(`mkdir ${folder}`)
          }
        }
      },
      removeEmptyDirectory: async (path) => {
        const full = join(path)
        if (!walk(path, 'null')) return
        const found = entry(full)
        if (found === null) return
        if (found.type !== 'directory') throw new HostingGuardError('not_a_directory')
        const inside = (known: string) => known.startsWith(`${full}/`)
        if (
          [...this.files.keys()].some(inside) ||
          [...this.folders].some(inside) ||
          [...this.links].some(inside)
        )
          throw new HostingGuardError('not_empty')
        this.beforeChange?.('rmdir', full)
        this.folders.delete(full)
        this.log.push(`rmdir ${full}`)
      },
      close: async () => {
        open = false
        this.#live.delete(connection)
        this.closed += 1
      },
    }
  }
}

/** A state of a page or a post as the plugin answers it. */
export function contentState(
  objectRef: string,
  fields: { title: string; content: string; excerpt?: string },
): PublishedContentState {
  const state = {
    version: 1 as const,
    objectRef,
    kind: objectRef.startsWith('page:') ? ('page' as const) : ('post' as const),
    title: fields.title,
    content: fields.content,
    excerpt: fields.excerpt ?? '',
  }
  return { ...state, stateHash: sha256Hex(publishedContentHashMaterial(state)) }
}

/**
 * The site's content plugin in memory: the precondition on the state hash, the epoch fence,
 * a receipt per call id (a replay answers it, another request under the same id is a conflict)
 * and reconciliation after the deadline.
 */
export class MemoryContentGateway implements PublishedContentGateway {
  /** The database part of the plugin (version 2); absent — a plugin of text changes alone. */
  db?: MemoryDbGateway
  readonly records = new Map<string, PublishedContentState>()
  readonly receipts = new Map<string, { digest: string; proof: ContentWriteProof }>()
  readonly log: string[] = []
  epoch = 0
  /** Lose the answers of the next writes: the write lands, the caller gets a failure. */
  loseAnswers = 0
  /** Fail the next writes before they land. */
  failWrites = 0
  /** Called before each write lands: may change the record. */
  beforeWrite: ((request: ContentWriteRequest) => void) | null = null

  constructor(
    readonly siteId: string,
    initial: PublishedContentState[] = [],
  ) {
    for (const state of initial) this.records.set(state.objectRef, state)
  }

  async read(objectRef: string): Promise<PublishedContentState> {
    const state = this.records.get(objectRef)
    if (!state) throw new Error('No such object')
    return { ...state }
  }

  async conditionalWrite(request: ContentWriteRequest): Promise<ContentWriteOutcome> {
    if (request.siteId !== this.siteId) throw new Error('Invalid published content write')
    if (this.failWrites > 0) {
      this.failWrites -= 1
      throw new Error('unavailable')
    }
    const outcome = this.#write(request)
    // The answer of a write — a new one or a replay — may be lost on its way back.
    if (this.loseAnswers > 0) {
      this.loseAnswers -= 1
      throw new Error('The answer was lost')
    }
    return outcome
  }

  #write(request: ContentWriteRequest): ContentWriteOutcome {
    const { ttlMs: _ttl, ...identity } = request
    const digest = sha256Hex(JSON.stringify(identity))
    const prior = this.receipts.get(request.callId)
    if (prior) {
      if (prior.digest !== digest) return { version: 1, kind: 'rejected', code: 'conflict' }
      return prior.proof
    }
    if (this.epoch > request.epoch) return { version: 1, kind: 'rejected', code: 'fenced' }
    this.beforeWrite?.(request)
    const state = this.records.get(request.objectRef)
    if (!state || state.stateHash !== request.expectedStateHash)
      return { version: 1, kind: 'rejected', code: 'conflict' }
    const next = contentState(request.objectRef, { ...state, ...request.fields })
    this.records.set(request.objectRef, next)
    this.epoch = request.epoch
    const proof: ContentWriteProof = {
      version: 1,
      kind: 'committed',
      callId: request.callId,
      siteId: request.siteId,
      epoch: request.epoch,
      requestHash: request.requestHash,
      objectRef: request.objectRef,
      stateHash: next.stateHash,
    }
    this.receipts.set(request.callId, { digest, proof })
    this.log.push(`${request.mode} ${request.objectRef}`)
    return proof
  }

  async operation(callId: string): Promise<ContentWriteProof | null> {
    return this.receipts.get(callId)?.proof ?? null
  }

  async reconcileOperation(request: ContentOperationRequest): Promise<ContentRecoveryOutcome> {
    const receipt = this.receipts.get(request.callId)
    if (receipt) return receipt.proof
    const { ttlMs: _ttl, ...ref } = request
    return { version: 1, kind: 'not_committed', ...ref }
  }

  async forgetOperation(): Promise<void> {}
}

/**
 * The database part of the site's plugin in memory (docs/plan/53, «Операции БД и миграции»):
 * settings, tables of the platform and the records the platform created, each with the same
 * precondition, fence and receipts as published content; a creation gets the next id of
 * production and keeps its mark; the trash takes only a record of its mark that holds what was
 * written. `log` — every write in order, as `<mode> <kind> <object>`.
 */
export class MemoryDbGateway implements SiteDbGateway {
  readonly options = new Map<string, string | null>()
  readonly tables = new Map<string, Pick<DbTableState, 'exists' | 'managed' | 'definition'>>()
  /** Production's records the platform created, by their reference there. */
  readonly created = new Map<string, { record: DbCreatedRecord; mark: string; trashed: boolean }>()
  readonly receipts = new Map<string, { digest: string; proof: DbWriteProof }>()
  readonly log: string[] = []
  /** Addresses production's own records hold: `<type>/<slug>`. */
  readonly taken = new Set<string>()
  /** Every fence the plugin was asked to raise, in order. */
  readonly fences: number[] = []
  /** Records of the site that stand on a record (comments, records below it, menu items). */
  readonly dependentsOf = new Map<string, number>()
  /** Lose the answers of the next writes: the write lands, the caller gets a failure. */
  loseAnswers = 0
  /** Called before each write lands: may change the site. */
  beforeWrite: ((request: DbWriteRequest) => void) | null = null
  nextId = 900
  capabilitiesOf: SiteDbCapabilities = {
    version: 1,
    kind: 'capabilities',
    plugin: 2,
    operations: ['content_update', 'option_update', 'post_create', 'schema_migration'],
    settings: ['blogname', 'blogdescription', 'posts_per_page'],
    maxRecordId: 120,
  }

  constructor(readonly content: MemoryContentGateway) {}

  async capabilities(): Promise<SiteDbCapabilities> {
    return structuredClone(this.capabilitiesOf)
  }

  async readObject(objectRef: string): Promise<DbObjectState> {
    if (isOptionRef(objectRef)) {
      const value = this.options.get(objectRef) ?? null
      return { version: 1, objectRef, value, stateHash: optionHashOf(objectRef, value) }
    }
    if (isTableRef(objectRef)) {
      const table = this.tables.get(objectRef) ?? {
        exists: false,
        managed: false,
        definition: null,
      }
      return { version: 1, objectRef, ...table, stateHash: tableHashOf(objectRef, table) }
    }
    const created = this.created.get(objectRef)
    if (created?.trashed || (!created && !this.content.records.has(objectRef)))
      return { version: 1, objectRef, absent: true, stateHash: absentHashOf(objectRef) }
    if (created) return createdState(objectRef, created.record)
    return this.content.read(objectRef)
  }

  async slugTaken(type: string, slug: string): Promise<boolean> {
    return (
      this.taken.has(`${type}/${slug}`) ||
      [...this.created].some(
        ([ref, item]) => !item.trashed && ref.startsWith(`${type}:`) && item.record.slug === slug,
      )
    )
  }

  async dependents(objectRef: string): Promise<number> {
    return this.dependentsOf.get(objectRef) ?? 0
  }

  async writeObject(request: DbWriteRequest): Promise<DbWriteOutcome> {
    const outcome = this.#write(request)
    if (this.loseAnswers > 0) {
      this.loseAnswers -= 1
      throw new Error('The answer was lost')
    }
    return outcome
  }

  #write(request: DbWriteRequest): DbWriteOutcome {
    const { ttlMs: _ttl, ...identity } = request
    const digest = sha256Hex(JSON.stringify(identity))
    const prior = this.receipts.get(request.callId)
    if (prior)
      return prior.digest === digest
        ? prior.proof
        : { version: 1, kind: 'rejected', code: 'conflict' }
    if (this.content.epoch > request.epoch) return { version: 1, kind: 'rejected', code: 'fenced' }
    this.beforeWrite?.(request)
    const ref = request.objectRef
    const change = request.change
    const current = this.#stateHash(ref)
    let stateHash: string
    let createdRef: string | undefined
    switch (change.kind) {
      case 'option_update':
        if (current !== request.expectedStateHash)
          return { version: 1, kind: 'rejected', code: 'conflict' }
        this.options.set(ref, change.value)
        stateHash = optionHashOf(ref, change.value)
        break
      case 'schema_migration': {
        const target = change.definition === null ? null : migratedHashOf(ref, change.definition)
        if (current !== request.expectedStateHash && current !== target)
          return { version: 1, kind: 'rejected', code: 'conflict' }
        if (change.definition === null) return { version: 1, kind: 'rejected', code: 'invalid' }
        this.tables.set(ref, { exists: true, managed: true, definition: change.definition })
        stateHash = target!
        break
      }
      case 'post_create': {
        if (request.expectedStateHash !== absentHashOf(ref))
          return { version: 1, kind: 'rejected', code: 'conflict' }
        const type = ref.slice(0, ref.indexOf(':'))
        if (this.taken.has(`${type}/${change.record.slug}`))
          return { version: 1, kind: 'rejected', code: 'invalid', reason: 'slug' }
        createdRef = `${type}:${this.nextId}`
        this.nextId += 1
        this.created.set(createdRef, {
          record: change.record,
          mark: change.createCallId,
          trashed: false,
        })
        stateHash = createdHashOf(createdRef, change.record)
        break
      }
      case 'post_trash': {
        const item = this.created.get(ref)
        if (
          !item ||
          item.trashed ||
          item.mark !== change.createCallId ||
          item.record.slug !== change.expectedSlug ||
          createdHashOf(ref, item.record) !== request.expectedStateHash
        )
          return { version: 1, kind: 'rejected', code: 'conflict' }
        if ((this.dependentsOf.get(ref) ?? 0) > 0)
          return { version: 1, kind: 'rejected', code: 'conflict', reason: 'dependents' }
        item.trashed = true
        stateHash = absentHashOf(ref)
        break
      }
      case 'post_untrash': {
        const item = this.created.get(ref)
        if (
          request.mode !== 'restore' ||
          !item?.trashed ||
          item.mark !== change.createCallId ||
          item.record.slug !== change.expectedSlug ||
          request.expectedStateHash !== absentHashOf(ref)
        )
          return { version: 1, kind: 'rejected', code: 'conflict' }
        item.trashed = false
        stateHash = createdHashOf(ref, item.record)
        break
      }
    }
    this.content.epoch = request.epoch
    const proof: DbWriteProof = {
      version: 1,
      kind: 'committed',
      callId: request.callId,
      siteId: request.siteId,
      epoch: request.epoch,
      requestHash: request.requestHash,
      objectRef: ref,
      stateHash,
      ...(createdRef ? { createdRef } : {}),
    }
    this.receipts.set(request.callId, { digest, proof })
    this.log.push(`${request.mode} ${change.kind} ${ref}`)
    return proof
  }

  #stateHash(objectRef: string): string {
    if (isOptionRef(objectRef)) return optionHashOf(objectRef, this.options.get(objectRef) ?? null)
    if (isTableRef(objectRef))
      return tableHashOf(
        objectRef,
        this.tables.get(objectRef) ?? { exists: false, managed: false, definition: null },
      )
    return absentHashOf(objectRef)
  }

  async operation(callId: string): Promise<DbWriteProof | null> {
    return this.receipts.get(callId)?.proof ?? null
  }

  async reconcile(request: DbOperationRequest): Promise<DbRecoveryOutcome> {
    const receipt = this.receipts.get(request.callId)
    if (receipt) return receipt.proof
    const { ttlMs: _ttl, ...ref } = request
    return { version: 1, kind: 'not_committed', ...ref }
  }

  async fence(input: { siteId: string; epoch: number }): Promise<void> {
    this.fences.push(input.epoch)
    this.content.epoch = Math.max(this.content.epoch, input.epoch)
  }

  /** Someone edits a created record of production: its title changes. */
  editCreated(productionRef: string, title: string): void {
    const item = this.created.get(productionRef)!
    item.record = { ...item.record, title }
  }
}

/** The state of a created record of production, as the plugin reads it. */
export function createdState(objectRef: string, record: DbCreatedRecord): PublishedContentState {
  return {
    version: 1,
    objectRef,
    kind: objectRef.startsWith('page:') ? 'page' : 'post',
    status: record.status,
    slug: record.slug,
    title: record.title,
    content: record.content,
    excerpt: record.excerpt,
    stateHash: createdHashOf(objectRef, record),
  }
}

/**
 * The code cache of the site's PHP as its plugin answers it (stand R12): the state it reports and
 * every refresh it was asked for, in order; `failRefreshes` — the next refreshes fail.
 */
export class FakeCodeCache implements SiteCodeCacheGateway {
  readonly refreshes: string[][] = []
  failRefreshes = 0
  /** The state read fails: an older plugin, a broken site. */
  unknown = false

  constructor(public state: SiteCodeCache) {}

  async codeCache(): Promise<SiteCodeCache> {
    if (this.unknown) throw new Error('unavailable')
    return { ...this.state }
  }

  async refreshCode(paths: readonly string[]): Promise<SiteCodeRefresh> {
    if (this.failRefreshes > 0) {
      this.failRefreshes -= 1
      throw new Error('unavailable')
    }
    this.refreshes.push([...paths])
    return {
      version: 1,
      kind: 'code_cache_refreshed',
      refreshed: paths.length,
      absent: 0,
      failed: 0,
    }
  }
}

export interface RecordedReport {
  step: ReleaseStep
  state: ReleaseStepState
  detail: ReleaseStepDetail
}

/**
 * The release API of core for one attempt: answers the manifest and the access, keeps every
 * report (a repeated key is the same report) and the uploaded backup, and verifies it by size
 * and SHA-256 as core does.
 */
export class FakeReleaseApi implements ReleaseApi {
  readonly reports: RecordedReport[] = []
  readonly calls: string[] = []
  /** Every report call that reached core, repeats included, with the time of the test's clock. */
  readonly delivered: { key: string; at: number }[] = []
  /** The clock of the test, for `delivered`. */
  now: () => number = () => 0
  /** A report this answers true for gets no answer (the network): nothing is kept. */
  drop: ((report: RecordedReport) => boolean) | null = null
  accessCalls = 0
  backup: Buffer | null = null
  backupNamed: { sha256: string; sizeBytes: number } | null = null
  /** The answer to a report; by default accepted and go on. */
  answer: (report: RecordedReport) => ReleaseStepAnswer = () => ({ accepted: true, proceed: true })

  constructor(
    public manifestOf: DeployManifest,
    public accessOf: DeployAccess,
  ) {}

  async manifest(): Promise<DeployManifest> {
    this.calls.push('manifest')
    return structuredClone(this.manifestOf)
  }

  async access(): Promise<DeployAccess> {
    this.calls.push('access')
    this.accessCalls += 1
    if (this.accessCalls > 1) throw new Error('The release API refused (409)')
    return structuredClone(this.accessOf)
  }

  async report(
    step: ReleaseStep,
    state: ReleaseStepState,
    detail: ReleaseStepDetail = {},
  ): Promise<ReleaseStepAnswer> {
    const key = `${step}:${state}`
    this.calls.push(`report ${key}`)
    const report = { step, state, detail }
    if (this.drop?.(report)) throw new ReleaseApiError(null)
    this.delivered.push({ key, at: this.now() })
    if (!this.reports.some((kept) => `${kept.step}:${kept.state}` === key))
      this.reports.push(report)
    return this.answer(report)
  }

  async backupPut(facts: { sha256: string; sizeBytes: number }): Promise<ReleasePresigned> {
    this.calls.push('backup put')
    this.backupNamed = facts
    return {
      method: 'PUT',
      url: 'https://s3.example.test/raditi-backups/backup',
      headers: {},
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }
  }

  async backupVerify(facts: { sha256: string; sizeBytes: number }): Promise<boolean> {
    this.calls.push('backup verify')
    return (
      this.backup !== null &&
      this.backup.byteLength === facts.sizeBytes &&
      sha256Hex(this.backup) === facts.sha256 &&
      this.backupNamed?.sha256 === facts.sha256
    )
  }

  /** `step state` of every report in order. */
  get sequence(): string[] {
    return this.reports.map(
      (report) =>
        `${report.step} ${report.state}${report.detail.code ? ` ${report.detail.code}` : ''}`,
    )
  }
}
