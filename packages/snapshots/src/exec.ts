import { Buffer } from 'node:buffer'

import { withTimeout, type ExecHandle, type ExecSpec, type Sandbox } from '@repo/domain'

export const SANDBOX_EXEC_TIMEOUT_MS = 60_000
const STDERR_BYTES = 64 * 1024
const MAX_EXEC_CHUNKS = 100_000

export interface BoundedExecOptions extends Pick<ExecSpec, 'cwd' | 'env' | 'stdin'> {
  maxStdout: number
  allowedCodes?: readonly number[]
  timeoutMs?: number
  /** The only error callers see: never output, argv or a raw cause. */
  failure: () => Error
  /** Instead of `failure` when stdout exceeds maxStdout: a size limit, not a broken command. */
  tooLarge?: () => Error
}

/**
 * One command through exec only (no archive API or docker cp), with gap-free, bounded output
 * and a hard deadline. Any failure kills the process, including one returned after the deadline.
 */
export async function execBounded(
  sandbox: Sandbox,
  argv: string[],
  options: BoundedExecOptions,
): Promise<{ stdout: Buffer; code: number }> {
  const timeoutMs = options.timeoutMs ?? SANDBOX_EXEC_TIMEOUT_MS
  const controller = new AbortController()
  let handle: ExecHandle | undefined
  let overflow = false
  const run = async () => {
    handle = await sandbox.exec({
      argv,
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin,
      timeoutMs,
      signal: controller.signal,
    })
    if (controller.signal.aborted) {
      void handle.kill('SIGKILL').catch(() => {})
      throw options.failure()
    }
    const current = handle
    const consume = async () => {
      const chunks: Buffer[] = []
      const offsets = { stdout: 0, stderr: 0 }
      let count = 0
      for await (const chunk of current.output()) {
        if (
          ++count > MAX_EXEC_CHUNKS ||
          (chunk.stream !== 'stdout' && chunk.stream !== 'stderr') ||
          !(chunk.data instanceof Uint8Array) ||
          chunk.data.byteLength === 0 ||
          chunk.offset !== offsets[chunk.stream]
        )
          throw options.failure()
        offsets[chunk.stream] += chunk.data.byteLength
        if (
          offsets[chunk.stream] > (chunk.stream === 'stdout' ? options.maxStdout : STDERR_BYTES)
        ) {
          overflow = chunk.stream === 'stdout'
          throw options.failure()
        }
        if (chunk.stream === 'stdout') chunks.push(Buffer.from(chunk.data))
      }
      return Buffer.concat(chunks, offsets.stdout)
    }
    const [stdout, exit] = await Promise.all([consume(), current.wait()])
    if (
      exit.reason !== 'exited' ||
      exit.code === null ||
      !(options.allowedCodes ?? [0]).includes(exit.code)
    )
      throw options.failure()
    return { stdout, code: exit.code }
  }
  try {
    return await withTimeout(run(), timeoutMs, 'Sandbox command timed out')
  } catch {
    controller.abort()
    if (handle) void handle.kill('SIGKILL').catch(() => {})
    throw overflow && options.tooLarge ? options.tooLarge() : options.failure()
  }
}
