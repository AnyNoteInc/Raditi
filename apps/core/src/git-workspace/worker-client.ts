import { Buffer } from 'node:buffer'
import { request } from 'node:http'

import { DomainError, publicationLimits } from '@repo/domain'

import {
  GIT_WORKER_PATH,
  gitWorkerResponseSchema,
  type GitWorkerRequest,
} from '../git-worker/protocol.ts'

// Core's side of the git worker (docs/plan/84-projects.md, ПР33): core runs no git or gitleaks
// itself; each command goes to the worker over its Unix socket, and core gets the exit code and
// stdout back. An error of the worker keeps its code (a limit is a limit), the rest is a failure.

export interface GitCommandResult {
  code: number
  stdout: Buffer
}

/** How core runs one trusted command: the worker over its socket, or a fake in a test. */
export interface GitRunner {
  run(command: GitWorkerRequest): Promise<GitCommandResult>
}

const failed = () =>
  new DomainError('GIT_OPERATION_FAILED', 'Trusted repository operation failed', 502)

/** A little more than the worker's own deadline: the worker answers first. */
const clientMs = (command: GitWorkerRequest) =>
  (command.timeoutMs ??
    (command.tool === 'gitleaks' ? publicationLimits.scanMs : publicationLimits.commandMs)) + 10_000

export class GitWorkerClient implements GitRunner {
  constructor(private readonly socket: string) {}

  run(command: GitWorkerRequest): Promise<GitCommandResult> {
    const body = Buffer.from(JSON.stringify(command))
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socket,
          method: 'POST',
          path: GIT_WORKER_PATH,
          headers: { 'content-type': 'application/json', 'content-length': body.byteLength },
          timeout: clientMs(command),
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('error', () => reject(failed()))
          res.on('end', () => {
            let parsed
            try {
              parsed = gitWorkerResponseSchema.safeParse(
                JSON.parse(Buffer.concat(chunks).toString('utf8')),
              )
            } catch {
              return reject(failed())
            }
            if (!parsed.success) return reject(failed())
            const value = parsed.data
            if ('error' in value)
              return reject(
                new DomainError(value.error.code, value.error.message, value.error.status),
              )
            resolve({ code: value.code, stdout: Buffer.from(value.stdout, 'base64') })
          })
        },
      )
      req.on('timeout', () => req.destroy())
      req.on('error', () => reject(failed()))
      req.end(body)
    })
  }
}
