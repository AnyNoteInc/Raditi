import { Buffer } from 'node:buffer'

import {
  assertTurnInbox,
  assertTurnProjectFiles,
  badRequest,
  conflict,
  createLeftNothing,
  DomainError,
  driverPrepareInvalid,
  execLost,
  isDomainError,
  preparedFilesSchema,
  preparedRunExposesSecret,
  SANDBOX_WORKDIR,
  snapshotManifestSchema,
  turnMayHoldInbox,
  type AgentDriver,
  type AgentDriverId,
  type CapturedTurn,
  type DestroyReason,
  type ExecHandle,
  type RemovableSandbox,
  type Sandbox,
  type SandboxInfo,
  type SandboxLabels,
  type SandboxProvider,
  type SealedTurnPart,
  type SessionState,
  type TurnAdoptInput,
  type TurnAgentExec,
  type TurnAttachState,
  type TurnExecution,
  type TurnExecutor,
  type TurnOutputBatch,
  type TurnPrepareInput,
  type TurnRestoreSource,
  type TurnSealInput,
  type TurnTakeover,
} from '@repo/domain'
import type { PresignedTransfer, SandboxSnapshotTransport } from '@repo/snapshots'
import { openSnapshotParts, packOutbox, sealSnapshotPart } from '@repo/snapshots'

import { makeEmptyWorkdir } from './empty-workdir.ts'
import { placeInbox, placeProjectFiles } from './inbox.ts'
import { readTurnOutput, type TurnOutputStart } from './turn-output.ts'
import type { WarmSandboxes } from './warm-sandboxes.ts'

export interface LocalTurnExecutorDependencies {
  sandboxes: SandboxProvider
  /** The stateless event parser of a driver: an executor never prepares a turn itself. */
  parser(id: AgentDriverId): Pick<AgentDriver, 'parseEvent'>
  transport: Pick<SandboxSnapshotTransport, 'capture' | 'restore'> &
    Partial<Pick<SandboxSnapshotTransport, 'captureOutbox'>>
  /** Snapshot parts of the restored checkpoint in, the sealed home part out. */
  transfer: PresignedTransfer
  /**
   * The warm containers of completed turns (spec §8, «Тёплая песочница»): absent — every turn
   * gets a new container and every removal removes it.
   */
  warm?: Pick<WarmSandboxes, 'take' | 'park' | 'forget'>
  /** One line of the process log: why the agent's files for the client were left behind. */
  log?: (line: string) => void
}

/** A prepared turn launches its agent; an adopted one only re-attaches to it. */
type Purpose = 'turn' | 'work'

const loadFailed = () =>
  new DomainError('SNAPSHOT_LOAD_FAILED', 'Could not load the turn snapshot', 502)

/**
 * The sandbox side of a turn over a local SandboxProvider: core's executor in the PoC and tests,
 * and the one a runner drives on its VM. It never holds platform credentials: snapshot parts
 * move through presigned requests, the data key comes from core's functions. A turn has no
 * repository: its working directory is empty.
 */
export class LocalTurnExecutor implements TurnExecutor {
  readonly kind = 'local'

  private readonly deps: LocalTurnExecutorDependencies

  constructor(deps: LocalTurnExecutorDependencies) {
    this.deps = deps
  }

  async prepare(input: TurnPrepareInput, signal: AbortSignal): Promise<TurnExecution> {
    // Checked by core already, and again where the files are written.
    const parsed = preparedFilesSchema.safeParse(input.prepared)
    if (!parsed.success) throw driverPrepareInvalid('Invalid prepared turn file path, mode or size')
    if (preparedRunExposesSecret(parsed.data, input.credentials, input.argv))
      throw driverPrepareInvalid('Prepared turn files, env or command contain a turn credential')
    if (input.sandbox.secrets.length !== 0)
      throw badRequest('Turn secrets are installed only after restore')
    // The client's files go only to a turn that may hold them, within one turn's limits.
    assertTurnInbox(input.inbox ?? [], turnMayHoldInbox(input.sandbox.labels))
    assertTurnProjectFiles(input.projectFiles ?? [], turnMayHoldInbox(input.sandbox.labels))
    const { files, env, secrets } = parsed.data
    const parser = this.deps.parser(input.driverId)
    input.dispatched()
    // Counted from before the container, as its provider counts its deadline (spec §8).
    const startedAt = Date.now()
    const hardTimeoutMs = Math.min(input.sandbox.hardTimeoutMs, input.remainingMs)
    const { warm } = this.deps
    const key = warm ? warmKeyOf(input) : undefined
    // The container an earlier turn of this task left (spec §8, «Тёплая песочница»), if it is
    // still there: extended to this turn's deadline, as a new one would be created with it.
    let taken = warm && key && !signal.aborted ? await warm.take(key) : null
    if (taken)
      taken = await taken.extend(startedAt + hardTimeoutMs).then(
        () => taken,
        async () => {
          warm!.forget(taken!.id)
          await taken!.destroy('failed').catch(() => {})
          return null
        },
      )
    let sandbox: Sandbox
    if (taken) sandbox = taken
    else {
      try {
        sandbox = await this.deps.sandboxes.create(
          { ...input.sandbox, hardTimeoutMs, secrets: [] },
          signal,
        )
      } catch (error) {
        // The provider proved nothing is left: the site need not wait for its lease to expire.
        if (createLeftNothing(error)) input.vacated()
        throw error
      }
    }
    const execution = new LocalTurnExecution(
      sandbox,
      this.deps,
      'turn',
      parser,
      input.credentials,
      input.envValues ?? [],
      {
        argv: input.argv,
        env,
      },
    )
    if (warm && key) execution.warm = { pool: warm, key }
    await input.created(execution)
    signal.throwIfAborted()
    await makeEmptyWorkdir(sandbox)
    if (input.restore) {
      signal.throwIfAborted()
      const { home, archive } = await this.#restoreSource(input.restore)
      await this.deps.transport.restore(sandbox, home, { home: archive })
    }
    // Outside the working directory: nothing of them is captured.
    if (input.inbox?.length) await placeInbox(sandbox, input.inbox, signal)
    // The files of the chat's project, after them (docs/plan/84-projects.md, ПР8).
    if (input.projectFiles?.length) await placeProjectFiles(sandbox, input.projectFiles, signal)
    // Secrets only after restore: an archive of an earlier turn never lands next to them. A
    // secret is read-only unless its driver rewrites it, and never open beyond its owner. The
    // agent's commands run under that same uid: what keeps a secret from them is the driver's
    // wrapper, which removes the file once it read it.
    for (const [file, mode] of [
      ...files.map((file) => [file, file.mode ?? 0o600] as const),
      ...secrets.map((file) => [file, (file.mode ?? 0o400) & 0o600] as const),
    ]) {
      signal.throwIfAborted()
      await sandbox.fs.write(file.path, Buffer.from(file.content), { mode })
    }
    return execution
  }

  async adopt(input: TurnAdoptInput, signal: AbortSignal): Promise<TurnExecution | null> {
    signal.throwIfAborted()
    if (input.labels.siteId !== input.fence.siteId || input.labels.taskId !== input.fence.taskId)
      throw badRequest('Adopted container labels differ from the fence')
    if (input.purpose === 'removal') {
      // Also a container that can no longer run anything, such as one whose gateway died.
      const removable = await this.deps.sandboxes.getForRemoval(input.containerId)
      if (!removable) return null
      assertIdentity(removable, input)
      return new RemovalExecution(removable, () => this.deps.warm?.forget(removable.id))
    }
    // Without the turn's credentials its output cannot be filtered: the turn is given up.
    if (!input.credentials.length)
      throw execLost('The turn credentials are not available to this executor')
    const sandbox = await this.deps.sandboxes.get(input.containerId)
    if (!sandbox) {
      // Gone, or unable to run the agent any more: only an adoption for removal reaches it.
      if (await this.deps.sandboxes.getForRemoval(input.containerId))
        throw execLost('The turn container can no longer run the agent')
      return null
    }
    assertIdentity(sandbox, input)
    return new LocalTurnExecution(
      sandbox,
      this.deps,
      'work',
      this.deps.parser(input.driverId),
      input.credentials,
      input.envValues ?? [],
    )
  }

  list(filter: Partial<SandboxLabels>): Promise<SandboxInfo[]> {
    return this.deps.sandboxes.list(filter)
  }

  /** Always reachable; the turn credentials lived in the memory of the core that died. */
  takeover(): TurnTakeover {
    return { holdsCredentials: false }
  }

  /**
   * The home part is fetched and checked, and the data key zeroed, before anything is written.
   * Only `home`: the patch and new files a snapshot of a chat that had a project names are not
   * fetched (TurnRestoreSource); its home part opens under the manifest's AAD all the same.
   */
  async #restoreSource(
    source: TurnRestoreSource,
  ): Promise<{ home: SessionState; archive: Uint8Array }> {
    try {
      const manifest = snapshotManifestSchema.parse(source.manifest)
      const part = manifest.parts.find((p) => p.name === 'home')
      if (!part) throw badRequest('A restore part is missing')
      const body = await this.deps.transfer.get(source.parts.home, part.sizeBytes)
      const archives = await openSnapshotParts(
        manifest,
        [{ part: { ...part, name: 'home' as const }, body }],
        manifest.home,
        () => source.dataKey(),
      )
      return { home: manifest.home, archive: archives.home }
    } catch {
      // Whatever went wrong in storage, the key or the part: the prior turn is unusable here.
      throw loadFailed()
    }
  }
}

/**
 * The provider must return the exact immutable container id, never a reused name, with the
 * labels the caller names. A warm container (spec §8, «Тёплая песочница») that an earlier turn
 * of the session left keeps the labels it was created with — an earlier turn, an earlier epoch —
 * and is this turn's because this turn's assignment names its id.
 */
function sameContainer(
  found: Pick<RemovableSandbox, 'id' | 'labels'>,
  containerId: string,
  labels: Partial<SandboxLabels>,
): boolean {
  if (found.id !== containerId) return false
  const left = labels.turn !== undefined && found.labels.turn < labels.turn
  return (Object.entries(labels) as [keyof SandboxLabels, unknown][]).every(([key, value]) => {
    if (!left || (key !== 'turn' && key !== 'leaseEpoch')) return found.labels[key] === value
    if (key === 'turn') return true
    const epoch = found.labels.leaseEpoch
    return epoch !== undefined && typeof value === 'number' && epoch < value
  })
}

function assertIdentity(found: RemovableSandbox, input: TurnAdoptInput): void {
  if (!sameContainer(found, input.containerId, input.labels))
    throw conflict('Recovery container identity changed')
}

/**
 * The turns that may share a container: one task, one session, one driver, and the same
 * container — image, runtime, resources, user, network and env.
 */
function warmKeyOf({ sandbox, driverId }: TurnPrepareInput): string {
  const { workspaceId, siteId, taskId, sessionId } = sandbox.labels
  return canonicalJson([
    workspaceId,
    siteId,
    taskId,
    sessionId,
    driverId,
    sandbox.image,
    sandbox.runtime,
    sandbox.resources,
    sandbox.user,
    sandbox.network,
    sandbox.env,
  ])
}

/** JSON with the keys of every object in order: two equal specs give one text. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  )
}

const removalOnly = () => conflict('The container was adopted only for removal')

/** A container recovery only removes: nothing runs in it any more. */
class RemovalExecution implements TurnExecution {
  private readonly sandbox: RemovableSandbox
  private readonly removed: () => void

  constructor(sandbox: RemovableSandbox, removed: () => void) {
    this.sandbox = sandbox
    this.removed = removed
  }

  get containerId(): string {
    return this.sandbox.id
  }

  launch(): Promise<TurnAgentExec> {
    return Promise.reject(removalOnly())
  }

  extend(): Promise<void> {
    return Promise.reject(removalOnly())
  }

  attach(): Promise<TurnAgentExec | null> {
    return Promise.reject(removalOnly())
  }

  quiesce(): Promise<void> {
    return Promise.reject(removalOnly())
  }

  capture(): Promise<CapturedTurn> {
    return Promise.reject(removalOnly())
  }

  seal(): Promise<SealedTurnPart> {
    return Promise.reject(removalOnly())
  }

  async destroy(reason: DestroyReason): Promise<void> {
    await this.sandbox.destroy(reason)
    this.removed()
  }
}

class LocalTurnExecution implements TurnExecution {
  #home: Uint8Array | undefined
  /** Where a completed turn leaves its container. */
  warm: { pool: Pick<WarmSandboxes, 'park' | 'forget'>; key: string } | undefined
  /** Left to the next turn of the task: nothing of this execution may touch it any more. */
  #handedOver = false

  private readonly sandbox: Sandbox
  private readonly deps: Pick<LocalTurnExecutorDependencies, 'transport' | 'transfer' | 'log'>
  private readonly purpose: Purpose
  private readonly parser: Pick<AgentDriver, 'parseEvent'>
  private readonly credentials: readonly string[]
  /** The values of the client's variables of the turn: masked in output, refused in home. */
  private readonly envValues: readonly string[]
  /** Only a freshly prepared turn launches its agent; an adopted one re-attaches. */
  private readonly command?: { argv: string[]; env: Record<string, string> }

  constructor(
    sandbox: Sandbox,
    deps: Pick<LocalTurnExecutorDependencies, 'transport' | 'transfer' | 'log'>,
    purpose: Purpose,
    parser: Pick<AgentDriver, 'parseEvent'>,
    credentials: readonly string[],
    envValues: readonly string[],
    command?: { argv: string[]; env: Record<string, string> },
  ) {
    this.sandbox = sandbox
    this.deps = deps
    this.purpose = purpose
    this.parser = parser
    this.credentials = credentials
    this.envValues = envValues
    this.command = command
  }

  get containerId(): string {
    return this.sandbox.id
  }

  /**
   * `timeoutMs` only for a core that runs this on a runner without `extend` (runnerFeatures):
   * otherwise the agent has no time limit (docs/plan/70-turn-without-time-limit.md, ВР1).
   */
  async launch(timeoutMs?: number): Promise<TurnAgentExec> {
    this.#allow('turn')
    if (!this.command) throw conflict('The turn has no agent command')
    const handle = await this.sandbox.exec({
      argv: this.command.argv,
      cwd: SANDBOX_WORKDIR,
      env: this.command.env,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })
    return new LocalAgentExec(handle, this.parser, this.credentials, this.envValues, {
      cursor: { stdout: 0, stderr: 0 },
      eventCount: 0,
    })
  }

  async extend(remainingMs: number): Promise<void> {
    this.#allow('turn', 'work')
    await this.sandbox.extend(Date.now() + remainingMs)
  }

  async attach(from: TurnAttachState): Promise<TurnAgentExec | null> {
    this.#allow('turn', 'work')
    let handle: ExecHandle
    try {
      handle = await this.sandbox.attach(from.execId, from.cursor)
    } catch (error) {
      // A missing or foreign exec is lost; any other failure is the host's and may be retried.
      if (isDomainError(error) && ['BAD_REQUEST', 'NOT_FOUND'].includes(error.code)) return null
      throw error
    }
    return new LocalAgentExec(handle, this.parser, this.credentials, this.envValues, from)
  }

  async quiesce(): Promise<void> {
    this.#allow('turn', 'work')
    await this.sandbox.quiesce()
  }

  async capture(input: { home: SessionState }): Promise<CapturedTurn> {
    this.#allow('turn', 'work')
    // The agent may have copied a turn credential or a value of the client's variables into its
    // home: never save it.
    const archives = await this.deps.transport.capture(
      this.sandbox,
      input.home,
      this.credentials,
      this.envValues,
    )
    const outbox = await this.#outbox()
    this.#home = archives.home
    return { homeBytes: archives.home.byteLength, ...(outbox ? { outbox } : {}) }
  }

  /**
   * The files the agent left for the client (docs/plan/66-chat-visuals.md, В8): an outbox the
   * checks refused is dropped whole and the turn goes on, with a line in the log why. The turn's
   * answer may speak of the files all the same, so what is left in its place is an archive that
   * says they were refused: core tells the client.
   */
  async #outbox(): Promise<Uint8Array | undefined> {
    const { transport, log } = this.deps
    if (!transport.captureOutbox) return undefined
    try {
      const taken = await transport.captureOutbox(this.sandbox, this.credentials, this.envValues)
      if (taken.skipped > 0)
        log?.(`turn_outbox_skipped container=${this.sandbox.id} entries=${taken.skipped}`)
      return taken.archive
    } catch (error) {
      const reason = isDomainError(error) ? error.code : 'unknown'
      log?.(`turn_outbox_dropped container=${this.sandbox.id} reason=${reason}`)
      return packOutbox([], { refused: true }).catch(() => undefined)
    }
  }

  async seal({ base, dataKey, put }: TurnSealInput): Promise<SealedTurnPart> {
    this.#allow('turn', 'work')
    const home = this.#home
    if (!home) throw conflict('Nothing was captured to seal')
    if (base.git !== undefined) throw conflict('A turn has no repository to seal')
    const key = await dataKey()
    let sealed: ReturnType<typeof sealSnapshotPart>
    try {
      sealed = sealSnapshotPart(base, 'home', home, key)
    } finally {
      key.fill(0)
    }
    await this.deps.transfer.put(put, sealed.body)
    return sealed.sealed
  }

  async destroy(reason: DestroyReason): Promise<void> {
    if (this.#handedOver) return
    const { warm } = this
    // A completed turn leaves its container to the next turn of its task, reset (spec §8,
    // «Тёплая песочница»); otherwise, or when it cannot wait, it is removed as before. An
    // adopted container is always removed: this process does not know its deadline.
    if (
      warm &&
      reason === 'completed' &&
      this.purpose === 'turn' &&
      (await warm.pool.park(this.sandbox, warm.key))
    ) {
      this.#handedOver = true
      return
    }
    try {
      await this.sandbox.destroy(reason)
    } finally {
      warm?.pool.forget(this.sandbox.id)
    }
  }

  #allow(...purposes: Purpose[]): void {
    if (this.#handedOver) throw conflict('The container was left to the next turn')
    if (!purposes.includes(this.purpose)) throw conflict('An adopted turn re-attaches to its agent')
  }
}

class LocalAgentExec implements TurnAgentExec {
  private readonly handle: ExecHandle
  private readonly parser: Pick<AgentDriver, 'parseEvent'>
  private readonly credentials: readonly string[]
  private readonly envValues: readonly string[]
  private readonly start: TurnOutputStart

  constructor(
    handle: ExecHandle,
    parser: Pick<AgentDriver, 'parseEvent'>,
    credentials: readonly string[],
    envValues: readonly string[],
    start: TurnOutputStart,
  ) {
    this.handle = handle
    this.parser = parser
    this.credentials = credentials
    this.envValues = envValues
    this.start = start
  }

  get execId(): string {
    return this.handle.id
  }

  async output(record: (batch: TurnOutputBatch) => Promise<void>): Promise<void> {
    let from = this.start.cursor
    await readTurnOutput(
      this.handle,
      this.parser,
      async (to, events) => {
        await record({ from, to, events })
        from = to
      },
      // The caller stops a turn by killing the exec: its output then ends.
      () => {},
      this.credentials,
      this.start,
      this.envValues,
    )
  }

  wait() {
    return this.handle.wait()
  }

  async kill(): Promise<void> {
    await this.handle.kill('SIGKILL')
  }
}
