import { Buffer } from 'node:buffer'

import {
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
  snapshotHasRepository,
  snapshotManifestSchema,
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
  type TurnWorkingTree,
  type TurnWorkingTreeInput,
} from '@repo/domain'
import type { PresignedTransfer, SandboxSnapshotTransport, TurnArchives } from '@repo/snapshots'
import { openSnapshotParts, sealSnapshotPart } from '@repo/snapshots'

import { bundleBase, importBaseBundle } from './base-bundle.ts'
import { makeEmptyWorkdir } from './empty-workdir.ts'
import { readTurnOutput, type TurnOutputStart } from './turn-output.ts'
import { WARM_MIN_LEFT_MS, type WarmSandboxes } from './warm-sandboxes.ts'
import { exportSandboxWorkingTree } from './working-tree-export.ts'

export interface LocalTurnExecutorDependencies {
  sandboxes: SandboxProvider
  /** The stateless event parser of a driver: an executor never prepares a turn itself. */
  parser(id: AgentDriverId): Pick<AgentDriver, 'parseEvent'>
  transport: Pick<SandboxSnapshotTransport, 'capture' | 'restore'>
  /** Snapshot parts of the restored checkpoint in, the sealed home part out. */
  transfer: PresignedTransfer
  importBundle?: typeof importBaseBundle
  /**
   * The warm containers of completed turns (spec §8, «Тёплая песочница»): absent — every turn
   * gets a new container and every removal removes it.
   */
  warm?: Pick<WarmSandboxes, 'take' | 'park' | 'forget'>
}

/** A prepared turn launches its agent; an adopted one only re-attaches to it. */
type Purpose = 'turn' | 'work'

const loadFailed = () =>
  new DomainError('SNAPSHOT_LOAD_FAILED', 'Could not load the turn snapshot', 502)

/**
 * The sandbox side of a turn over a local SandboxProvider: core's executor in the PoC and tests,
 * and the one a runner drives on its VM. It never holds platform credentials: snapshot parts
 * move through presigned requests, the data key and the base bundle come from core's functions.
 */
export class LocalTurnExecutor implements TurnExecutor {
  readonly kind = 'local'

  private readonly deps: LocalTurnExecutorDependencies
  /**
   * Containers this executor prepared without a repository (plan 57, Б4) and has not removed:
   * their working directory is no working tree to export.
   */
  readonly #withoutRepository = new Set<string>()

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
    // A patch is never left without its repository, nor a session of one turn kind restored
    // into the other (plan 57, Б4).
    if (
      input.restore &&
      snapshotHasRepository(input.restore.manifest) !== (input.bundle !== undefined)
    )
      throw badRequest('The snapshot and the bundle disagree on the repository')
    const { files, env, secrets } = parsed.data
    const parser = this.deps.parser(input.driverId)
    input.dispatched()
    // Counted from before the container, as its provider counts its deadline (spec §8).
    const startedAt = Date.now()
    const hardTimeoutMs = Math.min(input.sandbox.hardTimeoutMs, input.remainingMs)
    const { warm } = this.deps
    const key = warm ? warmKeyOf(input) : undefined
    // The container an earlier turn of this task left (spec §8, «Тёплая песочница»), if it is
    // still there and leaves this turn enough of its own deadline.
    const taken =
      warm && key && !signal.aborted
        ? await warm.take(key, Math.min(hardTimeoutMs, WARM_MIN_LEFT_MS))
        : null
    let sandbox: Sandbox
    let deadline: number
    if (taken) ({ sandbox, deadline } = taken)
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
      deadline = startedAt + hardTimeoutMs
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
    if (warm && key)
      execution.warm = {
        pool: warm,
        key,
        deadline,
        // A taken container may end before the turn would: the agent ends that much earlier.
        shortfall: Math.max(0, startedAt + hardTimeoutMs - deadline),
      }
    await input.created(execution)
    signal.throwIfAborted()
    if (input.bundle) {
      await (this.deps.importBundle ?? importBaseBundle)(sandbox, input.bundle)
      execution.importedBase = bundleBase(input.bundle)
    } else {
      this.#withoutRepository.add(sandbox.id)
      execution.removed = () => this.#withoutRepository.delete(sandbox.id)
      await makeEmptyWorkdir(sandbox)
      execution.importedBase = null
    }
    if (input.restore) {
      signal.throwIfAborted()
      const { home, archives } = await this.#restoreSource(input.restore)
      await this.deps.transport.restore(sandbox, home, archives)
    }
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
      return new RemovalExecution(removable, () => {
        this.#withoutRepository.delete(removable.id)
        this.deps.warm?.forget(removable.id)
      })
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
   * The working tree of a running turn for its preview (plan 53, Р23): the container is found by
   * its exact id and labels, the agent goes on.
   */
  async exportWorkingTree(
    input: TurnWorkingTreeInput,
    signal: AbortSignal,
  ): Promise<TurnWorkingTree> {
    signal.throwIfAborted()
    const sandbox = await this.deps.sandboxes.get(input.containerId)
    if (!sandbox) throw conflict('The turn container is gone')
    if (!sameContainer(sandbox, input.containerId, input.labels))
      throw conflict('The turn container has other labels')
    if (this.#withoutRepository.has(sandbox.id))
      throw conflict('The turn has no repository to export')
    return exportSandboxWorkingTree(sandbox, {
      baseSha: input.baseSha,
      ...(input.addOnlyPaths ? { addOnlyPaths: input.addOnlyPaths } : {}),
      ...(input.alsoPaths ? { alsoPaths: input.alsoPaths } : {}),
    })
  }

  /**
   * Every part is fetched and checked, and the data key zeroed, before anything is written: all
   * three, or `home` alone for a snapshot without a repository — the parts its manifest names.
   */
  async #restoreSource(
    source: TurnRestoreSource,
  ): Promise<{ home: SessionState; archives: TurnArchives }> {
    try {
      const manifest = snapshotManifestSchema.parse(source.manifest)
      const stored = []
      for (const part of manifest.parts) {
        const request = source.parts[part.name]
        if (!request) throw badRequest('A restore part is missing')
        stored.push({ part, body: await this.deps.transfer.get(request, part.sizeBytes) })
      }
      // The schema holds the parts to snapshotPartNamesOf(manifest): all three, or home alone.
      const archives: TurnArchives = await openSnapshotParts(manifest, stored, manifest.home, () =>
        source.dataKey(),
      )
      return { home: manifest.home, archives }
    } catch {
      // Whatever went wrong in storage, the key or the parts: the prior turn is unusable here.
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
 * container — image, runtime, resources, user, network and env — with or without a repository.
 */
function warmKeyOf({ sandbox, driverId, bundle }: TurnPrepareInput): string {
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
    bundle !== undefined,
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
  /** Whether the home part waiting for seal() came with the parts of a repository. */
  #capturedRepository: boolean | undefined
  /**
   * The commit the sandbox was checked out at, when this execution imported it: capture diffs
   * against it and nothing else (plan 53, Р11). null when it was prepared without a repository
   * (plan 57, Б4): its capture takes the home part alone. Unknown for an adopted container.
   */
  importedBase: string | null | undefined
  /** Called once the container is removed. */
  removed: (() => void) | undefined
  /** Where a completed turn leaves its container, and that container's deadline. */
  warm:
    | {
        pool: Pick<WarmSandboxes, 'park' | 'forget'>
        key: string
        deadline: number
        shortfall: number
      }
    | undefined
  /** Left to the next turn of the task: nothing of this execution may touch it any more. */
  #handedOver = false

  private readonly sandbox: Sandbox
  private readonly deps: Pick<LocalTurnExecutorDependencies, 'transport' | 'transfer'>
  private readonly purpose: Purpose
  private readonly parser: Pick<AgentDriver, 'parseEvent'>
  private readonly credentials: readonly string[]
  /** The values of the client's variables of the turn: masked in output, refused in home. */
  private readonly envValues: readonly string[]
  /** Only a freshly prepared turn launches its agent; an adopted one re-attaches. */
  private readonly command?: { argv: string[]; env: Record<string, string> }

  constructor(
    sandbox: Sandbox,
    deps: Pick<LocalTurnExecutorDependencies, 'transport' | 'transfer'>,
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

  async launch(timeoutMs: number): Promise<TurnAgentExec> {
    this.#allow('turn')
    if (!this.command) throw conflict('The turn has no agent command')
    const handle = await this.sandbox.exec({
      argv: this.command.argv,
      cwd: SANDBOX_WORKDIR,
      env: this.command.env,
      // The turn limit includes publication: the agent's exec ends before the container does.
      timeoutMs: Math.max(1, timeoutMs - (this.warm?.shortfall ?? 0)),
    })
    return new LocalAgentExec(handle, this.parser, this.credentials, this.envValues, {
      cursor: { stdout: 0, stderr: 0 },
      eventCount: 0,
    })
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

  async capture(input: {
    home: SessionState
    baseSha?: string
    sandboxBaseSha?: string
    addOnlyPaths?: readonly string[]
  }): Promise<CapturedTurn> {
    this.#allow('turn', 'work')
    if (input.baseSha === undefined) return this.#captureHome(input)
    if (this.importedBase === null)
      throw conflict('Capture names a base, but the sandbox got no repository')
    const base = input.sandboxBaseSha ?? input.baseSha
    if (this.importedBase !== undefined && this.importedBase !== base)
      throw conflict('Capture names another base than the sandbox was given')
    // The agent may have copied a turn credential into its home or the site, or a value of the
    // client's variables into its home: never save it.
    const archives = await this.deps.transport.capture(
      this.sandbox,
      input.home,
      base,
      this.credentials,
      input.addOnlyPaths ?? [],
      this.envValues,
    )
    const { patch, untracked } = archives
    if (!patch || !untracked) throw conflict('A capture with a base took no candidate')
    this.#home = archives.home
    this.#capturedRepository = true
    return { patch, untracked, homeBytes: archives.home.byteLength }
  }

  /** A turn without a repository (plan 57, Б4): its session alone; no git command runs. */
  async #captureHome(input: {
    home: SessionState
    sandboxBaseSha?: string
    addOnlyPaths?: readonly string[]
  }): Promise<CapturedTurn> {
    if (input.sandboxBaseSha !== undefined || input.addOnlyPaths !== undefined)
      throw badRequest('A working set needs the base of the capture')
    if (typeof this.importedBase === 'string')
      throw conflict('Capture names no base, but the sandbox got a repository')
    const archives = await this.deps.transport.capture(
      this.sandbox,
      input.home,
      undefined,
      this.credentials,
      [],
      this.envValues,
    )
    this.#home = archives.home
    this.#capturedRepository = false
    return { homeBytes: archives.home.byteLength }
  }

  async seal({ base, dataKey, put }: TurnSealInput): Promise<SealedTurnPart> {
    this.#allow('turn', 'work')
    const home = this.#home
    if (!home) throw conflict('Nothing was captured to seal')
    if (snapshotHasRepository(base) !== this.#capturedRepository)
      throw conflict('The snapshot and the capture disagree on the repository')
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
      (await warm.pool.park(this.sandbox, warm.key, warm.deadline))
    ) {
      this.#handedOver = true
      this.removed?.()
      return
    }
    try {
      await this.sandbox.destroy(reason)
    } finally {
      warm?.pool.forget(this.sandbox.id)
    }
    this.removed?.()
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
