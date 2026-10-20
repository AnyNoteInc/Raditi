// Test doubles of the manager of previews: a runtime that keeps what it was told, a database
// copier and its catalog, git of one repository, in-memory storage and Vault, the content of a
// preview and of production. Only for *.test.ts files.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { zstdCompressSync } from 'node:zlib'

import {
  type ContentWriteOutcome,
  type ContentWriteRequest,
  type DatabaseCopier,
  type KvSecret,
  type PreviewBrowserInput,
  type PreviewDatabasePasswords,
  type PreviewExecInput,
  type PreviewFilesInput,
  type PreviewRuntime,
  type PreviewRuntimeSecrets,
  type PreviewRuntimeSpec,
  type PreviewUpstream,
  type PublishedContentGateway,
  type PublishedContentState,
  type SiteContentAdapter,
} from '@repo/domain'
import { wordpressContentAccessSchema } from '@repo/site-adapters'
import type { DbPlanValueOwner, DbPlanValueReader } from '@repo/site-content'

import { TAR_END, tarFileHeader, tarPadding } from '../git-workspace/tree-tar.ts'
import type { PreviewSyncGit } from '../previews/preview-sync.ts'

export const hash = (c: string) => c.repeat(64)

/** A local HTTP server standing in for the entry forwarder of a preview. */
export async function upstreamServer(): Promise<{ server: Server; upstream: PreviewUpstream }> {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/broken')) response.end('<b>Fatal error</b>: x')
    else response.end('<html>ok</html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, upstream: { host: '127.0.0.1', port: (server.address() as AddressInfo).port } }
}

export class FakeRuntime implements PreviewRuntime {
  readonly calls: string[] = []
  readonly specs: PreviewRuntimeSpec[] = []
  readonly secrets: PreviewRuntimeSecrets[] = []
  readonly writes: Array<Omit<PreviewFilesInput, 'archive'> & { bytes: number }> = []
  readonly seeds: string[] = []
  readonly execs: PreviewExecInput[] = []
  readonly running = new Map<string, PreviewUpstream>()
  readonly extended = new Map<string, number>()
  objects = ['post:1', 'post:2', 'page:3']
  lintFailures: string[] = []

  constructor(private readonly upstream: PreviewUpstream) {}

  /** What the next `ensure` throws, once (a CONFLICT of what is left of a preview). */
  failNextEnsure: Error | null = null

  async ensure(spec: PreviewRuntimeSpec, secrets: PreviewRuntimeSecrets) {
    this.calls.push('ensure')
    const failure = this.failNextEnsure
    this.failNextEnsure = null
    if (failure) throw failure
    this.specs.push(spec)
    this.secrets.push(secrets)
    this.running.set(spec.previewId, this.upstream)
    this.stopped.delete(spec.previewId)
    return this.upstream
  }

  async extend(previewId: string, expiresAt: number) {
    this.calls.push('extend')
    this.extended.set(previewId, expiresAt)
  }

  readonly stopped = new Set<string>()

  async inspect(previewId: string) {
    const upstream = this.running.get(previewId)
    if (upstream) return { previewId, runtime: 'runc' as const, running: true, upstream }
    return this.stopped.has(previewId)
      ? { previewId, runtime: 'runc' as const, running: false, upstream: null }
      : null
  }

  async writeFiles(_previewId: string, input: PreviewFilesInput) {
    this.calls.push('writeFiles')
    let bytes = 0
    for await (const chunk of input.archive) bytes += chunk.byteLength
    const { archive: _archive, ...rest } = input
    this.writes.push({ ...rest, bytes })
  }

  readonly databasePasswords: PreviewDatabasePasswords[] = []

  async loadDatabase(
    _previewId: string,
    seed: AsyncIterable<Uint8Array>,
    passwords: PreviewDatabasePasswords,
  ) {
    this.calls.push('loadDatabase')
    this.databasePasswords.push(passwords)
    const parts: Buffer[] = []
    for await (const chunk of seed) parts.push(Buffer.from(chunk))
    this.seeds.push(Buffer.concat(parts).toString('utf8'))
  }

  async exec(_previewId: string, input: PreviewExecInput) {
    this.execs.push(input)
    const script = input.argv.join(' ')
    const out = (value: unknown) => ({
      code: 0,
      stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
      stderr: new Uint8Array(),
    })
    if (script.includes('WP_Application_Passwords'))
      return out({ v: '1', username: 'raditi-platform', applicationPassword: 'abcd efgh ijkl' })
    if (script.includes('post_status')) return out(this.objects)
    if (input.argv[0] === '/bin/sh')
      return out(
        input.argv
          .filter((arg) => this.lintFailures.includes(arg))
          .map((path) => `${path}\0`)
          .join(''),
      )
    return { code: 1, stdout: new Uint8Array(), stderr: new Uint8Array() }
  }

  readonly browsers: PreviewBrowserInput[] = []
  async startBrowser(previewId: string, input: PreviewBrowserInput) {
    this.calls.push('startBrowser')
    this.browsers.push(input)
    return { wsEndpoint: `ws://127.0.0.1:45555/${'s'.repeat(43)}` }
  }

  async stopBrowser() {
    this.calls.push('stopBrowser')
  }

  async stop(previewId: string) {
    this.calls.push('stop')
    this.running.delete(previewId)
    this.stopped.add(previewId)
  }

  async destroy(previewId: string) {
    this.calls.push('destroy')
    this.running.delete(previewId)
    this.stopped.delete(previewId)
  }

  async list() {
    return [...this.running.keys()]
  }
}

export const fakeCopier = (sql = 'INSERT INTO `wp_posts` VALUES (1);\n'): DatabaseCopier => ({
  async copy(_input, write) {
    await write(Buffer.from(sql))
    return {
      tables: 1,
      structureOnly: 0,
      rows: 1,
      bytes: sql.length,
      sha256: hash('5'),
      serverVersion: '11.4.13-MariaDB',
    }
  },
})

export const fakeCatalog = (prefix = 'wp_') => ({
  async tables() {
    return [
      'posts',
      'postmeta',
      'users',
      'terms',
      'term_taxonomy',
      'term_relationships',
      'termmeta',
      'options',
      'comments',
      'usermeta',
    ].map((name) => ({
      name: `${prefix}${name}`,
      collation: 'utf8mb4_unicode_ci',
      charset: 'utf8mb4',
    }))
  },
})

export class FakeGit implements PreviewSyncGit {
  readonly exports: Array<{ sha: string; paths?: readonly string[] }> = []
  missing: string[] = []
  constructor(public main: string) {}
  async readBranchHead() {
    return this.main
  }
  async exportTree<T>(
    input: { sha: string; paths?: readonly string[] },
    consume: (tree: {
      archive: AsyncIterable<Uint8Array>
      files: number
      bytes: number
    }) => Promise<T>,
  ) {
    this.exports.push({ sha: input.sha, ...(input.paths ? { paths: input.paths } : {}) })
    return consume({
      archive: (async function* () {
        yield Buffer.alloc(1024)
      })(),
      files: 0,
      bytes: 0,
    })
  }
  async missingPaths({ paths }: { paths: readonly string[] }) {
    return paths.filter((path) => this.missing.includes(path))
  }
  async changedPaths() {
    return { written: ['wp-content/themes/shop/style.css'], deleted: [] }
  }
  async sandboxBase() {
    return 'e'.repeat(40)
  }
}

export class MemoryStorage {
  readonly objects = new Map<string, Buffer>()
  async put(_bucket: string, key: string, body: Uint8Array | AsyncIterable<Uint8Array>) {
    if (body instanceof Uint8Array) {
      this.objects.set(key, Buffer.from(body))
      return
    }
    const parts: Buffer[] = []
    for await (const chunk of body) parts.push(Buffer.from(chunk))
    this.objects.set(key, Buffer.concat(parts))
  }
  async get(_bucket: string, key: string) {
    const body = this.objects.get(key)
    return body
      ? (async function* () {
          yield body
        })()
      : null
  }
  async delete(_bucket: string, key: string) {
    this.objects.delete(key)
  }
}

export class MemoryVault {
  readonly kv = new Map<string, KvSecret>()
  readonly destroyed: string[] = []
  readonly #keys = new Map<string, Buffer>()
  async kvRead(path: string) {
    return this.kv.get(path) ?? null
  }
  async kvWrite(path: string, data: Record<string, string>, options?: { cas?: number }) {
    const current = this.kv.get(path)
    if (options?.cas !== undefined && options.cas !== (current?.version ?? 0))
      throw new Error('cas mismatch')
    const version = (current?.version ?? 0) + 1
    this.kv.set(path, { data: { ...data }, version } as KvSecret)
    return { version }
  }
  async kvList(prefix: string) {
    return [...this.kv.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
  }
  async kvDestroyAll(path: string) {
    this.destroyed.push(path)
    this.kv.delete(path)
  }
  async transitDataKey(key: string) {
    const plaintext = Buffer.alloc(32, 7)
    const ciphertext = `vault:v1:${key}:${this.#keys.size}`
    this.#keys.set(ciphertext, Buffer.from(plaintext))
    return { plaintext, ciphertext }
  }
  async transitDecryptDataKey(_key: string, ciphertext: string) {
    const found = this.#keys.get(ciphertext)
    if (!found) throw new Error('unknown key')
    return Buffer.from(found)
  }
}

const contentState = (objectRef: string, stateHash: string): PublishedContentState => ({
  version: 1,
  objectRef,
  kind: objectRef.startsWith('page') ? 'page' : 'post',
  title: 'T',
  content: 'C',
  excerpt: '',
  stateHash,
})

/** A content gateway over a map of state hashes; writes commit when the precondition holds. */
export function contentGateway(
  states: Map<string, string>,
  writes: ContentWriteRequest[] = [],
): PublishedContentGateway {
  return {
    async read(ref) {
      const found = states.get(ref)
      if (!found) throw new Error('unavailable')
      return contentState(ref, found)
    },
    async conditionalWrite(request): Promise<ContentWriteOutcome> {
      writes.push(request)
      if (states.get(request.objectRef) !== request.expectedStateHash)
        return { version: 1, kind: 'rejected', code: 'conflict' }
      states.set(request.objectRef, hash('e'))
      return {
        version: 1,
        kind: 'committed',
        callId: request.callId,
        siteId: request.siteId,
        epoch: request.epoch,
        requestHash: request.requestHash,
        objectRef: request.objectRef,
        stateHash: hash('e'),
      }
    },
    operation: () => Promise.resolve(null),
    reconcileOperation: () => Promise.resolve({ version: 1, kind: 'unknown' }),
    forgetOperation: () => Promise.resolve(),
  } as PublishedContentGateway
}

/** The content adapter of the stack with its gateway replaced by `gateway`. */
export const contentAdapter = (gateway: PublishedContentGateway): SiteContentAdapter =>
  ({
    stack: 'wordpress',
    accessKind: 'wp',
    accessSchema: wordpressContentAccessSchema,
    createGateway: () => gateway,
  }) as unknown as SiteContentAdapter

/** The working tree of a turn as the sandbox helper exports it: a ustar tar in zstd. */
export function workingTreeArchive(files: Record<string, string | Buffer>): Uint8Array {
  const parts: Buffer[] = []
  for (const [path, content] of Object.entries(files)) {
    const bytes = Buffer.from(content)
    parts.push(tarFileHeader(path, bytes.byteLength, false), bytes, tarPadding(bytes.byteLength))
  }
  parts.push(TAR_END)
  return zstdCompressSync(Buffer.concat(parts))
}

/**
 * A reader of the values of a plan of records alone, from one `read`: the call of a value is a
 * fixed id (`readState`), the mark a replayed creation would carry.
 */
export function recordValues(
  read: (
    owner: DbPlanValueOwner,
    objectRef: string,
    side: 'before' | 'after',
  ) => Promise<PublishedContentState>,
): DbPlanValueReader {
  return {
    read: (owner, objectRef, side) => read(owner, objectRef, side),
    readState: async (owner, objectRef, side) => ({
      state: await read(owner, objectRef, side),
      callId: '00000000-0000-4000-8000-000000000001',
    }),
  }
}
