import { Buffer } from 'node:buffer'
import { chmod, lstat, realpath, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname as dirnameOf, isAbsolute, join, relative } from 'node:path'

import { DomainError, isDomainError, publicationLimits } from '@repo/domain'
import {
  ipLiteral,
  isLoopbackAddress,
  publicAddressCheck,
  type RefusedSubnet,
} from '@repo/ip-address'

import { runProcess } from './process.ts'
import {
  GIT_WORKER_PATH,
  GITLEAKS_REPORT,
  gitWorkerRequestSchema,
  gitWorkerSocketPath,
  type GitWorkerResponse,
} from './protocol.ts'
import { trustedGitEnvironment, trustedGitOptions } from './trusted-git.ts'

// The git worker (docs/plan/84-projects.md, ПР33): the only process that runs git and gitleaks
// on the repositories of clients. It holds no secret of core — no /run/raditi, no Vault token, no
// database or Redis — only the volume of the mirrors. Every request is one command in a directory
// of that volume; the worker adds the fixed options and environment of trusted-git.ts itself.

export interface GitWorkerOptions {
  /** GIT_MIRROR_DIR: the volume; every directory a request names lies below it. */
  root: string
  caFile?: string
  /** Outside production only: a `localhost` fake of a stand may be pinned. */
  allowLoopback: boolean
  refusedSubnets: readonly RefusedSubnet[]
  /** `file` remotes of test fixtures: only NODE_ENV=test outside production. */
  allowFileProtocol: boolean
  gitBinary?: string
  gitleaksBinary?: string
}

const MAX_REQUEST_BYTES = 96 * 1024 * 1024

const refused = (message: string) => new DomainError('GIT_WORKER_REFUSED', message, 400)

/** The fixed options of a gitleaks scan; the request names only the directory to scan. */
const GITLEAKS_FINDING_EXIT = 99

export interface GitWorkerServer {
  socket: string
  close(): Promise<void>
}

/** Starts the worker on `<root>/worker.sock`; a stale socket of a dead worker is replaced. */
export async function startGitWorker(options: GitWorkerOptions): Promise<GitWorkerServer> {
  const root = await realpath(options.root)
  const socket = gitWorkerSocketPath(options.root)
  const isPublic = publicAddressCheck(options.refusedSubnets)
  const inside = async (path: string) => {
    let real: string
    try {
      real = await realpath(path)
    } catch {
      throw refused('Path does not exist')
    }
    const child = relative(root, real)
    if (child.startsWith('..') || isAbsolute(child)) throw refused('Path is outside the volume')
    return real
  }

  const handle = async (body: Buffer): Promise<GitWorkerResponse> => {
    const parsed = gitWorkerRequestSchema.safeParse(JSON.parse(body.toString('utf8')))
    if (!parsed.success) throw refused('Invalid request')
    const request = parsed.data
    const cwd = await inside(request.cwd)
    const quota = request.quota
      ? { ...request.quota, path: await inside(request.quota.path) }
      : undefined
    if (request.protocol === 'file' && !options.allowFileProtocol)
      throw refused('File remotes are for tests only')
    if (request.protocol === 'https') {
      const pin = request.pin
      const address = pin ? ipLiteral(pin.address) : undefined
      if (!pin || address === undefined) throw refused('An https remote needs a pinned address')
      const loopback = isLoopbackAddress(address)
      if (loopback ? !options.allowLoopback : !isPublic(address))
        throw refused('The pinned address is not a public one')
    } else if (request.pin) throw refused('Only an https remote is pinned')
    for (const name of ['GIT_DIR', 'GIT_INDEX_FILE'] as const) {
      const value = request.env[name]
      if (value !== undefined) await inside(name === 'GIT_INDEX_FILE' ? dirnameOf(value) : value)
    }
    for (const value of request.env.GIT_ALTERNATE_OBJECT_DIRECTORIES?.split(':') ?? [])
      await inside(value)
    const input = request.input === undefined ? undefined : Buffer.from(request.input, 'base64')
    const context = {
      home: cwd,
      protocol: request.protocol,
      ...(options.caFile === undefined ? {} : { caFile: options.caFile }),
      ...(request.pin ? { pin: request.pin } : {}),
    }
    const env = { ...trustedGitEnvironment(context), ...request.env }
    const result =
      request.tool === 'git'
        ? await runProcess(
            options.gitBinary ?? 'git',
            [...trustedGitOptions(context, request.env), ...request.args],
            {
              cwd,
              env,
              input,
              maxBytes: request.maxBytes,
              timeoutMs: request.timeoutMs,
              quota,
            },
          )
        : await runProcess(
            options.gitleaksBinary ?? 'gitleaks',
            gitleaksArgs(await Promise.all(request.args.map(inside))),
            {
              cwd,
              // gitleaks needs no grant, repository or identity: the fixed environment only.
              env: trustedGitEnvironment({ home: cwd, protocol: 'none' }),
              maxBytes: 64 * 1024,
              // A scan of a whole tree is one run (19.11.2026): its own deadline, not a git one.
              timeoutMs: request.timeoutMs ?? publicationLimits.scanMs,
            },
          )
    return { code: result.code, stdout: result.stdout.toString('base64') }
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, value: GitWorkerResponse) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.method !== 'POST' || req.url !== GIT_WORKER_PATH) {
      reply(404, { error: { code: 'NOT_FOUND', message: 'Not found', status: 404 } })
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > MAX_REQUEST_BYTES) req.destroy()
      else chunks.push(chunk)
    })
    req.on('end', () => {
      handle(Buffer.concat(chunks)).then(
        (value) => reply(200, value),
        (error: unknown) => {
          // A refusal or a limit keeps its code; nothing of a raw error leaves the worker.
          const known = isDomainError(error) ? error : null
          reply(200, {
            error: {
              code: known?.code ?? 'GIT_OPERATION_FAILED',
              message: known?.message.slice(0, 512) ?? 'Trusted repository operation failed',
              status: known?.httpStatus ?? 502,
            },
          })
        },
      )
    })
  })

  const stale = await lstat(socket).catch(() => null)
  if (stale) {
    if (!stale.isSocket()) throw refused('Something other than a socket holds the worker path')
    await rm(socket, { force: true })
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, () => resolve())
  })
  // core and the worker share a group (docs/plan/84-projects.md, ПР33): nobody else connects.
  // Some bind mounts (Docker Desktop) refuse chmod on a socket: the umask 007 of main.ts has
  // closed it to others already, and a socket open to others is refused.
  await chmod(socket, 0o660).catch(() => {})
  if (((await lstat(socket)).mode & 0o007) !== 0) {
    server.close()
    throw refused('The socket of the worker is open to other users')
  }
  return {
    socket,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }).finally(() => rm(socket, { force: true })),
  }
}

/**
 * `gitleaks dir <dir>` with the host's config and every allowance of the scanned files off. A
 * fourth directory, when named, gets the JSON report `report.json` there: the caller reads which
 * of its numbered copies were flagged in one scan instead of halving the tree (19.11.2026). Every
 * secret in the report is redacted; the caller reads only the file names.
 */
function gitleaksArgs(args: readonly string[]): string[] {
  const [directory, config, ignore, report, ...rest] = args
  if (rest.length || !directory || !config || !ignore) throw refused('Invalid scan')
  return [
    'dir',
    directory,
    '--config',
    config,
    '--gitleaks-ignore-path',
    ignore,
    '--ignore-gitleaks-allow',
    '--redact=100',
    '--no-banner',
    '--no-color',
    '--log-level=error',
    `--exit-code=${GITLEAKS_FINDING_EXIT}`,
    ...(report === undefined
      ? []
      : ['--report-format', 'json', '--report-path', join(report, GITLEAKS_REPORT)]),
  ]
}

export { GITLEAKS_FINDING_EXIT }
