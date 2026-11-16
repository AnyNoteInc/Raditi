import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'

import { DomainError, repositoryTooLarge } from '@repo/domain'

import { directoryBytes } from './disk.ts'
import { nativeSupervisor } from './native-supervisor.ts'

// One native command of the git worker (docs/plan/84-projects.md, ПР33), returned from main
// (apps/core/src/git-workspace/process.ts there): a deadline and the cleanup of its process group
// in a supervisor of its own, bounded stdout and stderr — and, new, a disk quota of the directory
// the command writes into, checked while it runs (ПР12: a pack bomb stops at the quota).

/** stdout exceeded `maxBytes`: the caller's input is too large, not an infrastructure failure. */
export const PROCESS_OUTPUT_LIMIT = 'PROCESS_OUTPUT_LIMIT'

export interface ProcessResult {
  code: number
  stdout: Buffer
}

export interface DiskQuota {
  /** The directory whose files count, every file below it. */
  path: string
  bytes: number
}

export interface ProcessOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  input?: Uint8Array
  maxBytes?: number
  timeoutMs?: number
  quota?: DiskQuota
}

/** How often a running command's directory is measured against its quota. */
const QUOTA_POLL_MS = 50

export const quotaExceeded = (): DomainError =>
  repositoryTooLarge('Repository download exceeds its disk quota')

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
    let quota: ReturnType<typeof setInterval> | undefined
    const fail = (error?: DomainError) => {
      if (failed) return
      failed = true
      clearInterval(quota)
      child.kill('SIGTERM')
      reject(
        error ??
          new DomainError(
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
    if (options.quota) {
      const { path, bytes: limit } = options.quota
      let measuring = false
      quota = setInterval(() => {
        if (measuring) return
        measuring = true
        void directoryBytes(path)
          .then((used) => {
            if (used > limit) fail(quotaExceeded())
          })
          .finally(() => {
            measuring = false
          })
      }, QUOTA_POLL_MS)
    }
    child.once('error', () => fail())
    stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > (options.maxBytes ?? 16 * 1024 * 1024))
        fail(
          new DomainError(PROCESS_OUTPUT_LIMIT, 'Trusted command output exceeded its limit', 502),
        )
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
      clearInterval(quota)
      if (failed) return
      if (exitCode === undefined) return fail()
      const done = { code: exitCode, stdout: Buffer.concat(chunks) }
      // A command faster than one poll is measured once more when it is done.
      if (!options.quota) return resolve(done)
      const { path, bytes: limit } = options.quota
      void directoryBytes(path).then(
        (used) => (used > limit ? fail(quotaExceeded()) : resolve(done)),
        () => fail(),
      )
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
