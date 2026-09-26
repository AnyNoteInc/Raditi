import { Buffer } from 'node:buffer'
import type { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

import { DomainError } from '@repo/domain'
import type Docker from 'dockerode'

export const HELPER = '/usr/local/lib/raditi/runtime.mjs'
export const NODE = '/usr/local/bin/node'
// The trusted helper must not load task-controlled preload/import hooks from container env.
export const HELPER_ENV = [
  'NODE_OPTIONS=',
  'NODE_PATH=',
  'NODE_V8_COVERAGE=',
  'NODE_REDIRECT_WARNINGS=',
  'LD_PRELOAD=',
  'LD_LIBRARY_PATH=',
  'LD_AUDIT=',
]
export const COMMAND_BYTES = 64 * 1024 * 1024
export const commandError = () =>
  new DomainError('SANDBOX_COMMAND_FAILED', 'Sandbox command failed or exceeded its limits', 502)
export const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404

/** Bound daemon requests too: a disconnected Docker socket must not leave callers hanging. */
export async function bounded<T>(
  operation: Promise<T>,
  ms = 10_000,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw commandError()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(commandError()), ms)
        abort = () => reject(commandError())
        signal?.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

/** Dockerode returns an HTTP response stream even for a detached exec with no output. */
export async function startDetachedExec(
  exec: Docker.Exec,
  timeoutMs = 10_000,
  signal?: AbortSignal,
) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  try {
    await bounded(
      exec
        .start({
          Detach: true,
          Tty: false,
          abortSignal: controller.signal,
        } as Docker.ExecStartOptions)
        .then((stream) => {
          // Retain cleanup on the underlying promise if the bounded wait ends first.
          // The accepted command is detached; closing this HTTP response cannot kill it.
          const response = stream as Duplex | undefined
          response?.destroy()
        }),
      timeoutMs,
      signal,
    )
  } finally {
    controller.abort()
    signal?.removeEventListener('abort', abort)
  }
}

/** Parse Docker's non-TTY framing without ever decoding stdout bytes as text. */
export class DockerFrames {
  #buffer = Buffer.alloc(0)
  #stdout: Buffer[] = []
  #bytes = 0
  #stderr = 0
  private readonly limit: number
  constructor(limit: number) {
    this.limit = limit
  }
  push(chunk: Uint8Array): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    while (this.#buffer.length >= 8) {
      const type = this.#buffer[0]
      const length = this.#buffer.readUInt32BE(4)
      if (
        (type !== 1 && type !== 2) ||
        this.#buffer[1] !== 0 ||
        this.#buffer[2] !== 0 ||
        this.#buffer[3] !== 0 ||
        length > COMMAND_BYTES
      )
        throw commandError()
      if (this.#buffer.length < 8 + length) {
        if (this.#buffer.length > this.limit + 65544) throw commandError()
        return
      }
      const body = this.#buffer.subarray(8, 8 + length)
      if (type === 1) {
        this.#bytes += length
        if (this.#bytes > this.limit) throw commandError()
        this.#stdout.push(Buffer.from(body))
      } else {
        this.#stderr += length
        if (this.#stderr > 64 * 1024) throw commandError()
      }
      this.#buffer = this.#buffer.subarray(8 + length)
    }
  }
  finish(): Buffer {
    if (this.#buffer.length) throw commandError()
    return Buffer.concat(this.#stdout, this.#bytes)
  }
}

export async function helperCommand(
  container: Docker.Container,
  argv: string[],
  options: {
    /** Trusted one-time initialization before any task input enters the container. */
    bootstrap?: boolean
    stdin?: AsyncIterable<Uint8Array>
    maxBytes?: number
    signal?: AbortSignal
    timeoutMs?: number
  } = {},
): Promise<Buffer> {
  if (options.bootstrap && (argv.length !== 1 || argv[0] !== 'bootstrap')) throw commandError()
  let socket: Duplex | undefined
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const operation = async () => {
    const exec = await container.exec({
      Cmd: [NODE, HELPER, ...argv],
      Env: HELPER_ENV,
      User: options.bootstrap ? '0:0' : '10001:10001',
      Privileged: false,
      Tty: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    })
    const stream = await exec.start({
      hijack: true,
      stdin: true,
      Tty: false,
      abortSignal: controller.signal,
    } as Docker.ExecStartOptions)
    socket = stream as Duplex
    if (controller.signal.aborted) {
      socket.destroy()
      throw commandError()
    }
    const frames = new DockerFrames(options.maxBytes ?? 1024 * 1024)
    const read = (async () => {
      for await (const chunk of socket) frames.push(Buffer.from(chunk as Uint8Array))
      return frames.finish()
    })()
    const write = (async () => {
      let bytes = 0
      if (options.stdin)
        for await (const chunk of options.stdin) {
          if (controller.signal.aborted || !(chunk instanceof Uint8Array)) throw commandError()
          bytes += chunk.length
          if (bytes > COMMAND_BYTES + 64 * 1024 + 4) throw commandError()
          if (!socket!.write(Buffer.from(chunk)))
            await new Promise<void>((resolve, reject) => {
              const cleanup = () => {
                socket!.off('drain', drain)
                socket!.off('error', error)
                socket!.off('close', close)
              }
              const drain = () => {
                cleanup()
                resolve()
              }
              const error = () => {
                cleanup()
                reject(commandError())
              }
              const close = () => {
                cleanup()
                reject(commandError())
              }
              socket!.once('drain', drain).once('error', error).once('close', close)
            })
        }
      socket!.end()
    })()
    const [output] = await Promise.all([read, write])
    let info = await exec.inspect()
    while (info.Running) {
      await delay(20)
      info = await exec.inspect()
    }
    if (info.ExitCode !== 0) throw commandError()
    return output
  }
  try {
    return await bounded(operation(), options.timeoutMs ?? 10_000, options.signal)
  } catch {
    throw commandError()
  } finally {
    controller.abort()
    socket?.destroy()
    options.signal?.removeEventListener('abort', abort)
  }
}
