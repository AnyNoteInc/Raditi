import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  assertExecSpec,
  badRequest,
  type DestroyReason,
  type ExecChunk,
  type ExecCursor,
  type ExecExit,
  type ExecHandle,
  type ExecSpec,
  type FileEntry,
  type Sandbox,
  type SandboxFs,
  type SandboxLabels,
} from '@repo/domain'
import type Docker from 'dockerode'
import { z } from 'zod'

import {
  bounded,
  COMMAND_BYTES,
  commandError,
  HELPER,
  HELPER_ENV,
  helperCommand,
  startDetachedExec,
  isMissing,
  NODE,
} from './docker-api.ts'

const cursorSchema = z
  .object({
    stdout: z.number().int().nonnegative().max(COMMAND_BYTES),
    stderr: z.number().int().nonnegative().max(COMMAND_BYTES),
  })
  .strict()
const exitSchema = z
  .object({
    code: z.number().int().min(0).max(255).nullable(),
    reason: z.enum(['exited', 'timeout', 'cancelled', 'oom', 'lost']),
  })
  .strict()
const pageSchema = z
  .object({
    chunks: z
      .array(
        z
          .object({
            stream: z.enum(['stdout', 'stderr']),
            offset: z.number().int().nonnegative().max(COMMAND_BYTES),
            data: z
              .string()
              .max(90_000)
              .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
          })
          .strict(),
      )
      .max(2),
    exit: exitSchema.nullable(),
  })
  .strict()
const fileListSchema = z
  .array(
    z
      .object({
        path: z.string().max(1024),
        type: z.enum(['file', 'dir', 'symlink']),
        size: z.number().int().nonnegative(),
      })
      .strict(),
  )
  .max(10_000)
const ROOTS = ['/workspace', '/agent-home', '/tmp', '/run/raditi/secrets']
const checkedPath = (path: string, root = false) => {
  if (
    typeof path !== 'string' ||
    Buffer.byteLength(path) > 1024 ||
    /[\0\r\n\\]/.test(path) ||
    !ROOTS.some((base) => (root && path === base) || path.startsWith(`${base}/`)) ||
    path
      .split('/')
      .slice(1)
      .some((part) => !part || part === '.' || part === '..') ||
    path.split('/').length > 36
  )
    throw badRequest('Invalid sandbox filesystem path')
  return path
}
const input = async function* (bytes: Uint8Array) {
  yield bytes
}
const checkedNumber = (value: number | undefined, fallback: number, max: number) => {
  const n = value ?? fallback
  if (!Number.isSafeInteger(n) || n < 0 || n > max)
    throw badRequest('Invalid sandbox filesystem limit')
  return n
}

export interface SandboxLifecycle {
  originalInspect: Docker.ContainerInspectInfo
  assertOwned(): Promise<Docker.ContainerInspectInfo>
  release(inspect: Docker.ContainerInspectInfo): Promise<void>
}

export class DockerSandbox implements Sandbox {
  readonly id: string
  readonly labels: SandboxLabels
  readonly fs: SandboxFs
  #timer: ReturnType<typeof setTimeout>
  #destroyed = false
  #destroying: Promise<void> | undefined
  #quiescing = false
  #handles = new Map<string, DockerExecHandle>()
  readonly container: Docker.Container
  readonly deadline: number
  private readonly docker: Docker
  private readonly lifecycle: SandboxLifecycle
  constructor(
    container: Docker.Container,
    docker: Docker,
    labels: SandboxLabels,
    deadline: number,
    lifecycle: SandboxLifecycle,
  ) {
    this.container = container
    this.docker = docker
    this.deadline = deadline
    this.lifecycle = lifecycle
    this.id = container.id
    this.labels = Object.freeze({ ...labels })
    this.#timer = setTimeout(
      () => {
        void this.destroy('timeout').catch(() => {})
      },
      Math.max(1, deadline - Date.now()),
    )
    this.#timer.unref()
    this.fs = {
      read: async (path, opts) => {
        this.#available()
        return helperCommand(
          container,
          [
            'fs',
            'read',
            checkedPath(path),
            String(checkedNumber(opts?.maxBytes, COMMAND_BYTES, COMMAND_BYTES)),
          ],
          { maxBytes: checkedNumber(opts?.maxBytes, COMMAND_BYTES, COMMAND_BYTES) },
        )
      },
      write: async (path, data, opts) => {
        this.#available()
        if (!(data instanceof Uint8Array) || data.length > COMMAND_BYTES)
          throw badRequest('Sandbox file is too large')
        const owned = Buffer.from(data)
        await helperCommand(
          container,
          ['fs', 'write', checkedPath(path), String(checkedNumber(opts?.mode, 0o600, 0o777))],
          { stdin: input(owned) },
        )
      },
      remove: async (path, opts) => {
        this.#available()
        if (opts?.recursive !== undefined && typeof opts.recursive !== 'boolean')
          throw badRequest('Invalid recursive flag')
        await helperCommand(container, [
          'fs',
          'remove',
          checkedPath(path),
          String(opts?.recursive ?? false),
        ])
      },
      list: async (path, opts) => {
        this.#available()
        if (opts?.recursive !== undefined && typeof opts.recursive !== 'boolean')
          throw badRequest('Invalid recursive flag')
        const options = {
          recursive: opts?.recursive ?? false,
          maxEntries: checkedNumber(opts?.maxEntries, 1000, 10_000),
        }
        const result = await helperCommand(
          container,
          ['fs', 'list', checkedPath(path, true), JSON.stringify(options)],
          { maxBytes: 12 * 1024 * 1024 },
        )
        try {
          return fileListSchema.parse(JSON.parse(result.toString('utf8'))) as FileEntry[]
        } catch {
          throw commandError()
        }
      },
    }
  }
  #available(): void {
    if (this.#destroyed || this.#destroying || this.#quiescing || Date.now() >= this.deadline)
      throw commandError()
  }
  async exec(value: ExecSpec): Promise<ExecHandle> {
    this.#available()
    const spec = assertExecSpec(value)
    if (spec.signal?.aborted) throw commandError()
    const id = randomBytes(16).toString('hex')
    const timeoutMs = Math.min(spec.timeoutMs, this.deadline - Date.now())
    const encoded = Buffer.from(
      JSON.stringify({ argv: spec.argv, cwd: spec.cwd, env: spec.env, timeoutMs }),
    )
    if (encoded.length > 64 * 1024) throw badRequest('Sandbox exec specification is too large')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(encoded.length)
    const stdin = async function* () {
      yield header
      yield encoded
      if (spec.stdin) yield* spec.stdin
    }
    await helperCommand(this.container, ['stage', id], {
      stdin: stdin(),
      signal: spec.signal,
      timeoutMs: Math.min(timeoutMs, 30_000),
    })
    this.#available()
    const execDeadline = Math.min(this.deadline, Date.now() + timeoutMs)
    const exec = await bounded(
      this.container.exec({
        Cmd: [NODE, HELPER, 'run', id, String(execDeadline)],
        Env: HELPER_ENV,
        User: '10001:10001',
        Privileged: false,
        Tty: false,
        AttachStdin: false,
        AttachStdout: false,
        AttachStderr: false,
      }),
      10_000,
      spec.signal,
    )
    try {
      await startDetachedExec(exec, 10_000, spec.signal)
    } catch {
      // An ambiguous start may have launched a process; cleanup the whole owned container.
      await this.destroy('failed')
      throw commandError()
    }
    const handle = new DockerExecHandle(
      this,
      exec,
      id,
      { stdout: 0, stderr: 0 },
      Math.max(1, execDeadline - Date.now()),
      spec.signal,
    )
    this.#handles.set(handle.id, handle)
    return handle
  }
  async attach(execId: string, value: ExecCursor = { stdout: 0, stderr: 0 }): Promise<ExecHandle> {
    this.#available()
    if (!/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(execId))
      throw badRequest('Invalid sandbox exec identifier')
    const cursor = cursorSchema.safeParse(value)
    if (!cursor.success) throw badRequest('Invalid sandbox exec cursor')
    const [logical, dockerId] = execId.split('.') as [string, string]
    const exec = this.docker.getExec(dockerId)
    const info = await bounded(exec.inspect())
    const args = info.ProcessConfig?.arguments
    const execDeadline = Number(args?.[3])
    if (
      info.ContainerID !== this.id ||
      info.ProcessConfig?.entrypoint !== NODE ||
      args?.length !== 4 ||
      args[0] !== HELPER ||
      args[1] !== 'run' ||
      args[2] !== logical ||
      !Number.isSafeInteger(execDeadline) ||
      execDeadline <= 0 ||
      execDeadline > this.deadline ||
      info.ProcessConfig.privileged
    )
      throw badRequest('Exec does not belong to this sandbox')
    const handle = new DockerExecHandle(
      this,
      exec,
      logical,
      cursor.data,
      Math.max(1, execDeadline - Date.now()),
    )
    this.#handles.set(execId, handle)
    return handle
  }
  async quiesce(): Promise<void> {
    this.#available()
    this.#quiescing = true
    try {
      await helperCommand(this.container, ['quiesce'], { timeoutMs: 5000 })
      for (const handle of this.#handles.values()) handle.release()
      this.#handles.clear()
    } catch {
      await this.destroy('failed')
      throw commandError()
    } finally {
      this.#quiescing = false
    }
  }
  async destroy(_reason: DestroyReason): Promise<void> {
    if (this.#destroyed) return
    if (this.#destroying) return this.#destroying
    this.#destroying = (async () => {
      clearTimeout(this.#timer)
      for (const handle of this.#handles.values()) handle.release()
      let inspect = this.lifecycle.originalInspect
      try {
        inspect = await this.lifecycle.assertOwned()
      } catch (error) {
        // Main removal can succeed before gateway cleanup fails, or happen externally.
        // The original, verified immutable labels still identify only our gateway attempt.
        if (!isMissing(error)) throw error
      }
      try {
        await bounded(this.container.remove({ force: true, v: true }))
      } catch (error) {
        if (!isMissing(error)) throw commandError()
      }
      await this.lifecycle.release(inspect)
      this.#destroyed = true
    })()
    try {
      await this.#destroying
    } finally {
      this.#destroying = undefined
    }
  }
}

class DockerExecHandle implements ExecHandle {
  readonly id: string
  #timer: ReturnType<typeof setTimeout>
  #abort: (() => void) | undefined
  #done: ExecExit | undefined
  #reason: ExecExit['reason'] | undefined
  #killPromise: Promise<void> | undefined
  private readonly sandbox: DockerSandbox
  private readonly exec: Docker.Exec
  private readonly logicalId: string
  private readonly initial: ExecCursor
  private readonly signal: AbortSignal | undefined
  constructor(
    sandbox: DockerSandbox,
    exec: Docker.Exec,
    logicalId: string,
    initial: ExecCursor,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    this.sandbox = sandbox
    this.exec = exec
    this.logicalId = logicalId
    this.initial = initial
    this.signal = signal
    this.id = `${logicalId}.${exec.id}`
    this.#timer = setTimeout(() => {
      void this.#stop('timeout', 'SIGKILL').catch(() => {})
    }, timeoutMs)
    this.#timer.unref()
    this.#abort = () => {
      void this.#stop('cancelled', 'SIGTERM').catch(() => {})
    }
    signal?.addEventListener('abort', this.#abort, { once: true })
    if (signal?.aborted) this.#abort()
  }
  release(): void {
    clearTimeout(this.#timer)
    if (this.#abort) this.signal?.removeEventListener('abort', this.#abort)
  }
  async #page(cursor: ExecCursor) {
    const bytes = await helperCommand(
      this.sandbox.container,
      ['read-exec', this.logicalId, String(cursor.stdout), String(cursor.stderr)],
      { maxBytes: 200_000 },
    )
    try {
      return pageSchema.parse(JSON.parse(bytes.toString('utf8')))
    } catch {
      throw commandError()
    }
  }
  async *output(): AsyncIterable<ExecChunk> {
    const cursor = { ...this.initial }
    let stopped = false
    while (true) {
      const page = await this.#page(cursor)
      for (const chunk of page.chunks) {
        if (chunk.offset !== cursor[chunk.stream]) throw commandError()
        const data = Buffer.from(chunk.data, 'base64')
        if (!data.length || data.length > 64 * 1024 || data.toString('base64') !== chunk.data)
          throw commandError()
        cursor[chunk.stream] += data.length
        if (cursor[chunk.stream] > COMMAND_BYTES) throw commandError()
        yield { stream: chunk.stream, offset: chunk.offset, data }
      }
      if (!page.chunks.length) {
        if (page.exit) {
          await this.wait()
          return
        }
        if (stopped) return
        const info = await bounded(this.exec.inspect()).catch(() => null)
        if (!info?.Running) {
          await this.wait()
          // The process may have written its tail between the empty page and inspect.
          // Drain again from this iterator's cursor after completion is established.
          stopped = true
          continue
        }
        await delay(100)
      }
    }
  }
  async wait(): Promise<ExecExit> {
    if (this.#done) return this.#done
    while (true) {
      // Cancellation includes cleanup of escaped descendants. Do not publish completion
      // while that cleanup could still race the caller's next FS/snapshot exec.
      if (this.#killPromise) await this.#killPromise
      let info: Docker.ExecInspectInfo
      try {
        info = await bounded(this.exec.inspect())
      } catch {
        const container = await bounded(this.sandbox.container.inspect()).catch(() => null)
        return this.#finish({
          code: null,
          reason: this.#reason ?? (container?.State.OOMKilled ? 'oom' : 'lost'),
        })
      }
      if (!info.Running) {
        const page = await this.#page({ stdout: 0, stderr: 0 }).catch(() => null)
        if (this.#killPromise) await this.#killPromise
        const status = page?.exit
        if (!status || (status.code !== null && status.code !== info.ExitCode))
          return this.#finish({ code: null, reason: this.#reason ?? 'lost' })
        return this.#finish({ code: status.code, reason: this.#reason ?? status.reason })
      }
      if (Date.now() >= this.sandbox.deadline) {
        await this.#stop('timeout', 'SIGKILL')
        return this.#finish({ code: null, reason: 'timeout' })
      }
      await delay(100)
    }
  }
  #finish(exit: ExecExit): ExecExit {
    this.#done = exit
    this.release()
    return exit
  }
  async kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    if (signal !== 'SIGTERM' && signal !== 'SIGKILL') throw badRequest('Invalid sandbox signal')
    await this.#stop('cancelled', signal)
  }
  async #stop(reason: ExecExit['reason'], signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    if (this.#done) return
    if (this.#killPromise) return this.#killPromise
    this.#killPromise = (async () => {
      try {
        // A handle that nobody consumed may already have finished. Its stale timeout must
        // never quiesce a newer command that now runs in the same container.
        const before = await bounded(this.exec.inspect(), 3000)
        if (!before.Running) {
          const page = await this.#page({ stdout: 0, stderr: 0 }).catch(() => null)
          this.#reason = undefined
          this.#finish(
            page?.exit && (page.exit.code === null || page.exit.code === before.ExitCode)
              ? page.exit
              : { code: null, reason: 'lost' },
          )
          return
        }
        this.#reason = reason
        await helperCommand(this.sandbox.container, ['signal', this.logicalId, signal, reason], {
          timeoutMs: 3000,
        })
        await delay(signal === 'SIGTERM' ? 400 : 50)
        let info = await bounded(this.exec.inspect(), 3000)
        if (info.Running && signal === 'SIGTERM') {
          await helperCommand(
            this.sandbox.container,
            ['signal', this.logicalId, 'SIGKILL', reason],
            { timeoutMs: 3000 },
          )
          await delay(400)
          info = await bounded(this.exec.inspect(), 3000)
        }
        if (info.Running) await this.sandbox.destroy(reason === 'timeout' ? 'timeout' : 'cancelled')
        else await helperCommand(this.sandbox.container, ['quiesce'], { timeoutMs: 5000 })
      } catch {
        await this.sandbox.destroy(reason === 'timeout' ? 'timeout' : 'cancelled')
      }
      this.release()
    })()
    await this.#killPromise
  }
}
