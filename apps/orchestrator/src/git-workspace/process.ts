import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'

import { DomainError } from '@repo/domain'

import { nativeSupervisor } from './native-supervisor.ts'

/** stdout exceeded `maxBytes`: the caller's input is too large, not an infrastructure failure. */
export const PROCESS_OUTPUT_LIMIT = 'PROCESS_OUTPUT_LIMIT'

export interface ProcessResult {
  code: number
  stdout: Buffer
}
export interface ProcessOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  input?: Uint8Array
  maxBytes?: number
  timeoutMs?: number
}

/** Neither argv, environment, stderr nor a raw child-process error crosses this boundary. */
export async function runProcess(
  binary: string,
  argv: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 60_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
    throw new DomainError('INVALID_INPUT', 'Invalid trusted command deadline', 400)
  const deadlineNs = (process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n).toString()
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', nativeSupervisor], {
      cwd: options.cwd,
      // The supervisor cannot load NODE_OPTIONS/preloads from a caller or repository.
      env: { PATH: options.env.PATH, HOME: options.env.HOME, LANG: 'C' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let errors = 0
    let failed = false
    let exitCode: number | undefined
    const fail = (overflow = false) => {
      if (failed) return
      failed = true
      child.kill('SIGTERM')
      reject(
        overflow
          ? new DomainError(PROCESS_OUTPUT_LIMIT, 'Trusted command output exceeded its limit', 502)
          : new DomainError(
              'GIT_OPERATION_FAILED',
              'Trusted repository command failed or exceeded its limits',
              502,
            ),
      )
    }
    const { stdout, stderr, stdin } = child
    if (!stdout || !stderr || !stdin) {
      fail()
      return
    }
    const timer = setTimeout(() => fail(), timeoutMs)
    child.once('error', () => fail())
    stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) fail(true)
      else chunks.push(Buffer.from(chunk))
    })
    stderr.on('data', (chunk: Buffer) => {
      errors += chunk.byteLength
      if (errors > 64 * 1024) fail()
    })
    stdin.on('error', () => fail())
    child.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('type' in message)) return fail()
      if (
        message.type === 'complete' &&
        'code' in message &&
        typeof message.code === 'number' &&
        Number.isInteger(message.code) &&
        message.code >= 0 &&
        message.code <= 255
      )
        exitCode = message.code
      else fail()
    })
    child.once('close', () => {
      clearTimeout(timer)
      if (!failed) {
        if (exitCode === undefined) fail()
        else resolve({ code: exitCode, stdout: Buffer.concat(chunks) })
      }
    })
    child.send(
      { binary, argv, cwd: options.cwd, env: options.env, timeoutMs, deadlineNs },
      (error) => {
        if (error) fail()
      },
    )
    stdin.end(options.input)
  })
}
