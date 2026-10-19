import { Buffer } from 'node:buffer'
import type { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

import type Docker from 'dockerode'

import { bounded, commandError } from '../docker-api.ts'

export interface ExecRequest {
  /** No shell unless the caller passes one with fixed arguments. */
  argv: readonly string[]
  /** `uid:gid`. */
  user: string
  env?: readonly string[]
  workingDir?: string
  stdin?: Uint8Array | AsyncIterable<Uint8Array>
  /** Bytes of stdin at most; more is a failure, never a cut. */
  stdinBytes?: number
  stdoutBytes: number
  stderrBytes: number
  timeoutMs: number
  signal?: AbortSignal
}

export interface ExecOutcome {
  code: number
  stdout: Buffer
  stderr: Buffer
}

/** Docker's non-TTY framing, both streams kept and bounded; an overflow fails the command. */
export class ExecFrames {
  #buffer: Buffer = Buffer.alloc(0)
  readonly #out: { chunks: Buffer[]; bytes: number; limit: number }[]

  constructor(stdoutBytes: number, stderrBytes: number) {
    this.#out = [
      { chunks: [], bytes: 0, limit: stdoutBytes },
      { chunks: [], bytes: 0, limit: stderrBytes },
    ]
  }

  push(chunk: Uint8Array): void {
    this.#buffer = this.#buffer.length
      ? Buffer.concat([this.#buffer, chunk])
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    while (this.#buffer.length >= 8) {
      const type = this.#buffer[0]
      const length = this.#buffer.readUInt32BE(4)
      if ((type !== 1 && type !== 2) || this.#buffer.readUIntBE(1, 3) !== 0) throw commandError()
      const stream = this.#out[type - 1]!
      if (stream.bytes + length > stream.limit) throw commandError()
      if (this.#buffer.length < 8 + length) return
      stream.chunks.push(Buffer.from(this.#buffer.subarray(8, 8 + length)))
      stream.bytes += length
      this.#buffer = this.#buffer.subarray(8 + length)
    }
  }

  finish(): { stdout: Buffer; stderr: Buffer } {
    if (this.#buffer.length) throw commandError()
    const [stdout, stderr] = this.#out.map((stream) => Buffer.concat(stream.chunks, stream.bytes))
    return { stdout: stdout!, stderr: stderr! }
  }
}

const chunksOf = async function* (input: Uint8Array | AsyncIterable<Uint8Array>) {
  if (input instanceof Uint8Array) yield input
  else yield* input
}

/**
 * One exec in a running container: stdin streamed with back-pressure, stdout and stderr kept
 * apart within their limits, the exit code awaited. A timeout or an abort fails the call; the
 * process it started may outlive it, so callers of short-lived containers remove them then.
 */
export async function execIn(
  container: Docker.Container,
  request: ExecRequest,
): Promise<ExecOutcome> {
  let socket: Duplex | undefined
  const controller = new AbortController()
  const abort = () => controller.abort()
  request.signal?.addEventListener('abort', abort, { once: true })
  if (request.signal?.aborted) controller.abort()
  const operation = async (): Promise<ExecOutcome> => {
    const exec = await container.exec({
      Cmd: [...request.argv],
      Env: [...(request.env ?? [])],
      User: request.user,
      ...(request.workingDir ? { WorkingDir: request.workingDir } : {}),
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
    if (controller.signal.aborted) throw commandError()
    const frames = new ExecFrames(request.stdoutBytes, request.stderrBytes)
    const read = (async () => {
      for await (const chunk of socket) frames.push(chunk as Uint8Array)
      return frames.finish()
    })()
    const write = (async () => {
      let bytes = 0
      if (request.stdin)
        for await (const chunk of chunksOf(request.stdin)) {
          if (controller.signal.aborted || !(chunk instanceof Uint8Array)) throw commandError()
          bytes += chunk.byteLength
          if (bytes > (request.stdinBytes ?? Number.MAX_SAFE_INTEGER)) throw commandError()
          if (!socket!.write(chunk))
            await new Promise<void>((resolve, reject) => {
              const cleanup = () => {
                socket!.off('drain', drain)
                socket!.off('error', fail)
                socket!.off('close', fail)
              }
              const drain = () => {
                cleanup()
                resolve()
              }
              const fail = () => {
                cleanup()
                reject(commandError())
              }
              socket!.once('drain', drain).once('error', fail).once('close', fail)
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
    if (typeof info.ExitCode !== 'number') throw commandError()
    return { code: info.ExitCode, ...output }
  }
  try {
    return await bounded(operation(), request.timeoutMs, request.signal)
  } catch {
    throw commandError()
  } finally {
    controller.abort()
    socket?.destroy()
    request.signal?.removeEventListener('abort', abort)
  }
}

/** An exec that must succeed: a non-zero exit is a failure whose output is never echoed. */
export async function execChecked(
  container: Docker.Container,
  request: ExecRequest,
): Promise<Buffer> {
  const outcome = await execIn(container, request)
  if (outcome.code !== 0) throw commandError()
  return outcome.stdout
}
