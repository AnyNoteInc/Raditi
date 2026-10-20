import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import {
  badRequest,
  DomainError,
  publicationLimits,
  publicationShaSchema,
  publicationSourceSchema,
  repositoryTooLarge,
  SANDBOX_WORKDIR,
  type Sandbox,
  type TurnBundleSource,
} from '@repo/domain'

import { execBounded } from '@repo/snapshots'

/** The single ref of every base bundle. */
export const BASE_BUNDLE_REF = 'raditi-base'
const DESTINATION = '/tmp/raditi-base.bundle'

const failed = () =>
  new DomainError('GIT_OPERATION_FAILED', 'Trusted repository operation failed', 502)

/** The commit the sandbox starts from: the working-set commit when there is one (plan 53, Р11). */
export const bundleBase = (bundle: Pick<TurnBundleSource, 'baseSha' | 'sandboxBaseSha'>): string =>
  bundle.sandboxBaseSha ?? bundle.baseSha

const BUNDLE_HEADER_BYTES = 4096

/**
 * The commit the single ref of a base bundle points at, read from the bundle's own header (v2 or
 * v3: signature, capabilities, no prerequisites, exactly `refs/heads/raditi-base`); null for
 * anything else.
 */
export function bundleHead(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, BUNDLE_HEADER_BYTES)).toString('latin1')
  const end = head.indexOf('\n\n')
  if (end < 0) return null
  const [signature, ...lines] = head.slice(0, end).split('\n')
  if (signature !== '# v2 git bundle' && signature !== '# v3 git bundle') return null
  const refs = lines.filter((line) => !line.startsWith('@'))
  const match = refs.length === 1 ? /^([a-f0-9]{40}) (.+)$/.exec(refs[0]!) : null
  return match?.[2] === `refs/heads/${BASE_BUNDLE_REF}` ? match[1]! : null
}

/**
 * Imports the base bundle into /workspace/repo through exec stdin only, wherever the sandbox
 * runs (core's local executor or a runner). The whole bundle is read and checked against its
 * size and SHA-256 first; the clone runs without hooks, submodules or an origin. The bundle's ref
 * must be the commit the turn starts from: `sandboxBaseSha` with a working set, else `baseSha`.
 */
export async function importBaseBundle(sandbox: Sandbox, bundle: TurnBundleSource): Promise<void> {
  // The branch and SHA become git arguments: only the task branch and a full SHA-1 pass.
  if (
    !publicationShaSchema.safeParse(bundle.baseSha).success ||
    (bundle.sandboxBaseSha !== undefined &&
      !publicationShaSchema.safeParse(bundle.sandboxBaseSha).success) ||
    !publicationSourceSchema.shape.branch.safeParse(bundle.branch).success
  )
    throw badRequest('Invalid base bundle')
  const start = bundleBase(bundle)
  const bytes = await readBundle(bundle)
  if (bundleHead(bytes) !== start) throw failed()
  await sandboxExec(sandbox, ['test', '!', '-L', '/workspace'])
  // The runtime may already have made an empty work directory. Git clone itself rejects
  // existing nonempty directories; explicitly reject links before it touches the path.
  await sandboxExec(sandbox, ['test', '!', '-L', SANDBOX_WORKDIR])
  await sandboxExec(sandbox, ['test', '!', '-e', DESTINATION])
  await sandboxExec(sandbox, ['dd', `of=${DESTINATION}`, 'status=none', 'conv=excl'], bytes)
  try {
    await sandboxExec(sandbox, [
      'git',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'submodule.recurse=false',
      '-c',
      'protocol.file.allow=always',
      'clone',
      '--no-hardlinks',
      '--no-recurse-submodules',
      '--template=',
      '--branch',
      BASE_BUNDLE_REF,
      DESTINATION,
      SANDBOX_WORKDIR,
    ])
    await sandboxExec(sandbox, ['git', '-C', SANDBOX_WORKDIR, 'remote', 'remove', 'origin'])
    await sandboxExec(sandbox, [
      'git',
      '-C',
      SANDBOX_WORKDIR,
      'checkout',
      '-b',
      bundle.branch,
      start,
    ])
  } finally {
    await sandboxExec(sandbox, ['rm', '-f', '--', DESTINATION])
  }
}

async function readBundle(bundle: TurnBundleSource): Promise<Buffer> {
  if (!Number.isSafeInteger(bundle.sizeBytes) || bundle.sizeBytes < 1) throw failed()
  if (bundle.sizeBytes > publicationLimits.bundleBytes)
    throw repositoryTooLarge('Repository bundle is too large')
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of bundle.read()) {
    total += chunk.byteLength
    if (total > bundle.sizeBytes) throw failed()
    chunks.push(Buffer.from(chunk))
  }
  const bytes = Buffer.concat(chunks, total)
  if (
    total !== bundle.sizeBytes ||
    createHash('sha256').update(bytes).digest('hex') !== bundle.sha256
  )
    throw failed()
  return bytes
}

async function sandboxExec(sandbox: Sandbox, argv: string[], input?: Uint8Array): Promise<void> {
  await execBounded(sandbox, argv, {
    env: {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdin: input
      ? (async function* () {
          yield input
        })()
      : undefined,
    maxStdout: 64 * 1024,
    timeoutMs: publicationLimits.commandMs,
    failure: failed,
  })
}
