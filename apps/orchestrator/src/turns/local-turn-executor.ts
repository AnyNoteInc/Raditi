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
} from '@repo/domain'

import { importBaseBundle } from '../git-workspace/base-bundle.ts'
import type { PresignedTransfer } from '../sessions/presigned-transfer.ts'
import type { SandboxSnapshotTransport, SnapshotArchives } from '../sessions/sandbox-snapshot.ts'
import { openSnapshotParts, sealSnapshotPart } from '../sessions/snapshot-parts.ts'
import { readTurnOutput, type TurnOutputStart } from './turn-output.ts'

export interface LocalTurnExecutorDependencies {
  sandboxes: SandboxProvider
  /** The stateless event parser of a driver: an executor never prepares a turn itself. */
  parser(id: AgentDriverId): Pick<AgentDriver, 'parseEvent'>
  transport: Pick<SandboxSnapshotTransport, 'capture' | 'restore'>
  /** Snapshot parts of the restored checkpoint in, the sealed home part out. */
  transfer: PresignedTransfer
  importBundle?: typeof importBaseBundle
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

  constructor(private readonly deps: LocalTurnExecutorDependencies) {}

  async prepare(input: TurnPrepareInput, signal: AbortSignal): Promise<TurnExecution> {
    // Checked by core already, and again where the files are written.
    const parsed = preparedFilesSchema.safeParse(input.prepared)
    if (!parsed.success) throw driverPrepareInvalid('Invalid prepared turn file path, mode or size')
    if (preparedRunExposesSecret(parsed.data, input.credentials, input.argv))
      throw driverPrepareInvalid('Prepared turn files, env or command contain a turn credential')
    if (input.sandbox.secrets.length !== 0)
      throw badRequest('Turn secrets are installed only after restore')
    const { files, env, secrets } = parsed.data
    const parser = this.deps.parser(input.driverId)
    let sandbox: Sandbox
    input.dispatched()
    try {
      sandbox = await this.deps.sandboxes.create(
        {
          ...input.sandbox,
          hardTimeoutMs: Math.min(input.sandbox.hardTimeoutMs, input.remainingMs),
          secrets: [],
        },
        signal,
      )
    } catch (error) {
      // The provider proved nothing is left: the site need not wait for its lease to expire.
      if (createLeftNothing(error)) input.vacated()
      throw error
    }
    const execution = new LocalTurnExecution(
      sandbox,
      this.deps,
      'turn',
      parser,
      input.credentials,
      {
        argv: input.argv,
        env,
      },
    )
    await input.created(execution)
    signal.throwIfAborted()
    await (this.deps.importBundle ?? importBaseBundle)(sandbox, input.bundle)
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
      return new RemovalExecution(removable)
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
    )
  }

  list(filter: Partial<SandboxLabels>): Promise<SandboxInfo[]> {
    return this.deps.sandboxes.list(filter)
  }

  /** Always reachable; the turn credentials lived in the memory of the core that died. */
  takeover(): TurnTakeover {
    return { holdsCredentials: false }
  }

  /** Every part is fetched and checked, and the data key zeroed, before anything is written. */
  async #restoreSource(
    source: TurnRestoreSource,
  ): Promise<{ home: SessionState; archives: SnapshotArchives }> {
    try {
      const manifest = snapshotManifestSchema.parse(source.manifest)
      const stored = []
      for (const part of manifest.parts)
        stored.push({
          part,
          body: await this.deps.transfer.get(source.parts[part.name], part.sizeBytes),
        })
      const archives = await openSnapshotParts(manifest, stored, manifest.home, () =>
        source.dataKey(),
      )
      return { home: manifest.home, archives }
    } catch {
      // Whatever went wrong in storage, the key or the parts: the prior turn is unusable here.
      throw loadFailed()
    }
  }
}

/** The provider must return the exact immutable container id, never a reused name. */
function assertIdentity(found: RemovableSandbox, input: TurnAdoptInput): void {
  if (
    found.id !== input.containerId ||
    (Object.entries(input.labels) as [keyof SandboxLabels, unknown][]).some(
      ([key, value]) => found.labels[key] !== value,
    )
  )
    throw conflict('Recovery container identity changed')
}

const removalOnly = () => conflict('The container was adopted only for removal')

/** A container recovery only removes: nothing runs in it any more. */
class RemovalExecution implements TurnExecution {
  constructor(private readonly sandbox: RemovableSandbox) {}

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

  destroy(reason: DestroyReason): Promise<void> {
    return this.sandbox.destroy(reason)
  }
}

class LocalTurnExecution implements TurnExecution {
  #home: Uint8Array | undefined

  constructor(
    private readonly sandbox: Sandbox,
    private readonly deps: Pick<LocalTurnExecutorDependencies, 'transport' | 'transfer'>,
    private readonly purpose: Purpose,
    private readonly parser: Pick<AgentDriver, 'parseEvent'>,
    private readonly credentials: readonly string[],
    /** Only a freshly prepared turn launches its agent; an adopted one re-attaches. */
    private readonly command?: { argv: string[]; env: Record<string, string> },
  ) {}

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
      timeoutMs,
    })
    return new LocalAgentExec(handle, this.parser, this.credentials, {
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
    return new LocalAgentExec(handle, this.parser, this.credentials, from)
  }

  async quiesce(): Promise<void> {
    this.#allow('turn', 'work')
    await this.sandbox.quiesce()
  }

  async capture(input: { home: SessionState; baseSha: string }): Promise<CapturedTurn> {
    this.#allow('turn', 'work')
    // The agent may have copied a turn credential into its home or the site: never save it.
    const archives = await this.deps.transport.capture(
      this.sandbox,
      input.home,
      input.baseSha,
      this.credentials,
    )
    this.#home = archives.home
    return {
      patch: archives.patch,
      untracked: archives.untracked,
      homeBytes: archives.home.byteLength,
    }
  }

  async seal({ base, dataKey, put }: TurnSealInput): Promise<SealedTurnPart> {
    this.#allow('turn', 'work')
    const home = this.#home
    if (!home) throw conflict('Nothing was captured to seal')
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
    await this.sandbox.destroy(reason)
  }

  #allow(...purposes: Purpose[]): void {
    if (!purposes.includes(this.purpose)) throw conflict('An adopted turn re-attaches to its agent')
  }
}

class LocalAgentExec implements TurnAgentExec {
  constructor(
    private readonly handle: ExecHandle,
    private readonly parser: Pick<AgentDriver, 'parseEvent'>,
    private readonly credentials: readonly string[],
    private readonly start: TurnOutputStart,
  ) {}

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
    )
  }

  wait() {
    return this.handle.wait()
  }

  async kill(): Promise<void> {
    await this.handle.kill('SIGKILL')
  }
}
