import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  importPolicyOf,
  siteReadBytes,
  siteReadEntries,
  type PreviewDatabasePasswords,
  type PreviewRecipe,
  type PreviewRuntimeSpec,
  type SiteAdapter,
  type SiteFacts,
  type SiteTree,
} from '@repo/domain'
import { createDockerPreviewRuntime } from '@repo/sandbox-providers'
import { createMysqlDatabaseCopier } from '@repo/site-connections/database-copy'
import { createHostLookup } from '@repo/site-connections/hosting'
import { previewRequest, type PreviewTarget } from '@repo/site-content'

import { TAR_END, tarFileHeader, tarPadding } from '../git-workspace/tree-tar.ts'
import { previewBootOf, type PreviewBoot } from '../previews/preview-checks.ts'
import {
  previewContainerLimits,
  writePreviewTree,
  type PreviewGit,
} from '../previews/preview-builder.ts'
import { readStack } from '../site-provisioning/stack-reading.ts'

// The harness of М2 (docs/plan/62-site-stacks.md, §5.5; docs/plan/62-slices/e3.md, Э3.8): a real
// release of a CMS on a synthetic production — a container of the image `site` as a hosting, the
// tree of the archive in its volume, its database inside — and a preview of it built by the stack's
// adapter, the real copier and the real runtime of previews, with the tree written by the helper of
// a build. What differs per stack is data only (the build, its install, its seed); this file names
// no stack. Imported by `*.test.ts` only; only synthetic data.
//
// Every container and volume of a production carries the label io.raditi.stand=stack-preview, and
// every preview the labels of the runtime of previews: after a run killed midway (a timeout of CI,
// Ctrl-C) they go with
//   docker rm -f -v $(docker ps -aq --filter label=io.raditi.stand=stack-preview)
//   docker volume rm $(docker volume ls -q --filter label=io.raditi.stand=stack-preview)
// and the same with --host unix://$SANDBOX_DOCKER_SOCKET and label=io.raditi.preview.role for the
// previews. Nothing sweeps them by itself: another suite may be running beside this one.

/** A build of a stand: a row of infra/dev/stack-verify/cms-archives.json and its PHP. */
export interface StackBuild {
  /** The id of the row of cms-archives.json. */
  archive: string
  /** The image `raditi-site-verify:<php>`. */
  php: string
  generation: string
  version: string
}

export interface StackProduction {
  /** A command in the production container as root; its stdout, or a throw on a failure. */
  exec(argv: readonly string[], input?: string): Promise<string>
  /** SQL to the site's database as root of the container. */
  sql(query: string): Promise<string>
  /** Where the database of the production answers on the loopback of this machine. */
  dbPort: number
  /** A file of the site root or null: `read` and `list`, as the import gives them. */
  tree: SiteTree
  remove(): Promise<void>
}

export interface StackPreview {
  request(
    path: string,
    headers?: Readonly<Record<string, string>>,
  ): Promise<{ status: number; header(name: string): string | undefined; body: string }>
  exec(argv: readonly string[]): Promise<{ code: number; output: string }>
  rootSql(query: string): Promise<string>
  /** The runtime Docker started the preview's container with (`HostConfig.Runtime`). */
  containerRuntime(): Promise<string>
  /** The text of the SQL seed, as it came out of the copier. */
  seed: string
  /** What passed the rules of the import. */
  treePaths: readonly string[]
  /** The recipe the preview runs, the host it answers at and its origin (scheme, host, port). */
  recipe: PreviewRecipe
  hostname: string
  origin: string
  /** What the import read of the production and a build keeps for the site (`sites.stack_facts`). */
  stackFacts: unknown
  /** The verdict of a build on the health page (`previewBootOf`). */
  boot(): Promise<PreviewBoot>
  /** The same helper of writing as a build's; without `platform` the tree stays without its files. */
  rewriteTree(input: { platform: boolean }): Promise<void>
  destroy(): Promise<void>
}

const ROOT = '/var/www/html'
/** The container of each production this module started: what the tree of a preview is read from. */
const containers = new WeakMap<StackProduction, string>()
/** The files of the production container, copied into its /prod (the folder holds these only). */
const PROD_FILES = [
  fileURLToPath(new URL('../../../../infra/dev/stack-verify/prod/entry.sh', import.meta.url)),
  fileURLToPath(new URL('../../../../infra/dev/stack-verify/prod/apache.conf', import.meta.url)),
]
const STAND_LABEL = 'io.raditi.stand=stack-preview'
const archivesFile = new URL(
  '../../../../infra/dev/stack-verify/cms-archives.json',
  import.meta.url,
)
const previewSocket = process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock'
/** As the suite of the runtime reads it: stands under gVisor set PREVIEW_RUNTIME=runsc. */
const previewRuntimeKind = process.env.PREVIEW_RUNTIME === 'runsc' ? 'runsc' : 'runc'

interface Ran {
  code: number
  stdout: Buffer
  stderr: string
}

/** A command with its stdin, its whole output kept; never a shell of this machine. */
function command(
  file: string,
  args: readonly string[],
  input?: Uint8Array | string | NodeJS.ReadableStream,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8').slice(-2000),
      }),
    )
    child.stdin.on('error', () => {})
    if (input === undefined) child.stdin.end()
    else if (typeof input === 'string' || input instanceof Uint8Array) child.stdin.end(input)
    else input.pipe(child.stdin)
  })
}

async function checked(file: string, args: readonly string[], input?: string): Promise<Buffer> {
  const ran = await command(file, args, input)
  if (ran.code !== 0)
    throw new Error(`${file} ${args.slice(0, 3).join(' ')}… exited ${ran.code}: ${ran.stderr}`)
  return ran.stdout
}

/** The docker of the production: the default daemon, where the port of its database is local. */
const prodDocker = (args: readonly string[], input?: string) => checked('docker', args, input)
/** The docker of previews: the daemon the runtime of previews talks to. */
const previewDocker = (args: readonly string[], input?: string) =>
  checked('docker', ['--host', `unix://${previewSocket}`, ...args], input)

/** The repository digest of a local tag on the daemon of previews; null when it is not there. */
async function digestOf(tag: string): Promise<string | null> {
  try {
    const digests = JSON.parse(
      (
        await previewDocker(['image', 'inspect', tag, '--format', '{{json .RepoDigests}}'])
      ).toString(),
    ) as string[]
    return digests.find((value) => value.startsWith(`${tag.split(':')[0]}@`)) ?? null
  } catch {
    return null
  }
}

async function firstDigest(tags: readonly string[]): Promise<string | null> {
  for (const tag of tags) {
    const found = await digestOf(tag)
    if (found) return found
  }
  return null
}

/**
 * The tree of a build, downloaded and checked by fetch-cms.mjs. Its absence fails: a skip would hide
 * a download that was forgotten.
 */
export function stackTreeOf(build: StackBuild): string {
  const table = JSON.parse(readFileSync(archivesFile, 'utf8')) as Record<
    string,
    { php?: string; sha256?: string } | undefined
  >
  const row = table[build.archive]
  if (!row) throw new Error(`${build.archive} is not a row of cms-archives.json`)
  if (row.php !== build.php)
    throw new Error(`${build.archive}: the build runs PHP ${build.php}, the table says ${row.php}`)
  const directory = process.env.RADITI_CMS_DIR
  if (!directory) throw new Error('RADITI_CMS_DIR names the folder of the archives')
  const tree = join(directory, build.archive, 'tree')
  // The tree of this row only: fetch-cms.mjs writes beside it the sum of the archive it came from.
  const sum = join(directory, build.archive, 'tree.sha256')
  if (!existsSync(tree) || !existsSync(sum) || readFileSync(sum, 'utf8').trim() !== row.sha256)
    throw new Error(
      `No tree of ${build.archive} unpacked from the archive of its row: node infra/dev/stack-verify/fetch-cms.mjs ${build.archive}`,
    )
  return tree
}

/** A relative path of the site root, ASCII, `/` separators, no way out of the root. */
function rootPath(path: string): string {
  if (path === '') return ROOT
  if (!/^[\x21-\x7e]+$/.test(path) || path.startsWith('/') || path.split('/').includes('..'))
    throw new Error(`Not a path of the site root: ${path}`)
  return `${ROOT}/${path}`
}

async function waitFor(check: () => Promise<boolean>, what: string, ms: number): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`${what}: not in ${ms / 1000} s`)
}

/** The container `site` as a production: prod/entry.sh, the tree of the archive in a volume, the database inside, ports on the loopback. */
export async function startStackProduction(input: {
  build: StackBuild
  treeFolder: string
}): Promise<StackProduction> {
  const name = `raditi-stack-prod-${randomBytes(4).toString('hex')}`
  const volumes = { files: `${name}-files`, db: `${name}-db` }
  const remove = async () => {
    await command('docker', ['rm', '-f', '-v', name])
    await command('docker', ['volume', 'rm', '-f', volumes.files, volumes.db])
  }
  try {
    // Created by name and labelled, so that a killed run leaves nothing a label does not find.
    for (const volume of Object.values(volumes))
      await prodDocker(['volume', 'create', '--label', STAND_LABEL, volume])
    await prodDocker([
      'create',
      '--name',
      name,
      '--label',
      STAND_LABEL,
      '-p',
      '127.0.0.1::3306',
      '-v',
      `${volumes.files}:${ROOT}`,
      '-v',
      `${volumes.db}:/var/lib/mysql`,
      '--entrypoint',
      '/prod/entry.sh',
      `raditi-site-verify:${input.build.php}`,
    ])
    for (const file of PROD_FILES)
      if (!existsSync(file)) throw new Error(`No file of the production: ${file}`)
    await prodDocker(['cp', `${dirname(PROD_FILES[0]!)}/.`, `${name}:/prod`])
    await prodDocker(['start', name])
    // The password reaches the container on its stdin only: no argument, no file of this machine.
    const password = randomBytes(18).toString('base64url').replace(/[-_]/g, 'x')
    await prodDocker(
      [
        'exec',
        '-i',
        name,
        'sh',
        '-c',
        'umask 077 && mkdir -p /prod-secrets && cat > /prod-secrets/db',
      ],
      password,
    )
    await waitFor(
      async () =>
        (await command('docker', ['exec', name, 'test', '-f', '/tmp/prod-ready'])).code === 0,
      'the production database',
      90_000,
    )
    // The tree of the archive into the volume; it runs only in the container.
    const packed = spawn('tar', ['-C', input.treeFolder, '-cf', '-', '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const unpacked = await command(
      'docker',
      ['exec', '-i', name, 'tar', '-C', ROOT, '-xf', '-'],
      packed.stdout,
    )
    if (unpacked.code !== 0)
      throw new Error(`The tree did not reach the production: ${unpacked.stderr}`)
    await prodDocker(['exec', name, 'chown', '-R', '33:33', ROOT])
    const port = /:(\d+)\s*$/m.exec((await prodDocker(['port', name, '3306/tcp'])).toString())?.[1]
    if (!port) throw new Error('The production database has no port on the loopback')

    const run = async (argv: readonly string[], stdin?: string) =>
      command('docker', ['exec', ...(stdin === undefined ? [] : ['-i']), name, ...argv], stdin)
    const exec = async (argv: readonly string[], stdin?: string) => {
      const ran = await run(argv, stdin)
      if (ran.code !== 0)
        throw new Error(`${argv.join(' ').slice(0, 120)} exited ${ran.code}: ${ran.stderr}`)
      return ran.stdout.toString('utf8')
    }
    const tree: SiteTree = {
      read: async (path) => {
        const file = rootPath(path)
        const size = await run(['stat', '-c', '%s', file])
        if (size.code !== 0 || Number(size.stdout.toString()) > siteReadBytes) return null
        const ran = await run(['cat', '--', file])
        return ran.code === 0 ? new Uint8Array(ran.stdout) : null
      },
      list: async (path) => {
        const ran = await run([
          'find',
          rootPath(path),
          '-mindepth',
          '1',
          '-maxdepth',
          '1',
          '-printf',
          '%y\t%f\n',
        ])
        if (ran.code !== 0) return null
        const kinds = { f: 'file', d: 'directory', l: 'link' } as const
        return ran.stdout
          .toString('utf8')
          .split('\n')
          .filter(Boolean)
          .flatMap((line) => {
            const [kind, entry] = line.split('\t') as [keyof typeof kinds, string]
            return kinds[kind] ? [{ name: entry, type: kinds[kind] }] : []
          })
          .slice(0, siteReadEntries)
      },
    }
    const production: StackProduction = {
      exec,
      sql: (query) =>
        exec(
          [
            'mariadb',
            '--no-defaults',
            '--socket=/run/mysqld/mysqld.sock',
            '--user=root',
            '--default-character-set=utf8mb4',
            '--batch',
            '--skip-column-names',
            'site',
          ],
          query,
        ),
      dbPort: Number(port),
      tree,
      remove,
    }
    containers.set(production, name)
    return production
  } catch (error) {
    await remove()
    throw error
  }
}

/** Every entry under `root`, `/`-separated and relative, in a stable order. */
async function walk(
  root: string,
  decide: (path: string, type: 'file' | 'directory') => boolean,
): Promise<string[]> {
  const found: string[] = []
  const visit = async (relative: string) => {
    const entries = await readdir(join(root, relative), { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      // A link is never taken: the import walks files and folders only.
      if (entry.isDirectory()) {
        if (decide(path, 'directory')) await visit(path)
      } else if (entry.isFile() && decide(path, 'file')) found.push(path)
    }
  }
  await visit('')
  return found
}

/** A tar of the files `paths` of `root`, as a git export gives the docroot of a preview. */
async function* archiveOf(root: string, paths: readonly string[]): AsyncIterable<Uint8Array> {
  for (const path of paths) {
    const bytes = await readFile(join(root, path))
    const executable = ((await lstat(join(root, path))).mode & 0o111) !== 0
    yield tarFileHeader(path, bytes.byteLength, executable)
    yield bytes
    yield tarPadding(bytes.byteLength)
  }
  yield TAR_END
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}

/** The import by the adapter, the real copier, the real runtime, the tree and the seed written. */
export async function buildStackPreview(input: {
  adapter: SiteAdapter
  production: StackProduction
  build: StackBuild
  productionOrigin: string
}): Promise<StackPreview> {
  const { adapter, production, build } = input
  const signal = AbortSignal.timeout(30 * 60_000)

  // What a build reads of the hosting: the version, the layout, the settings of the database.
  const reading = await readStack(adapter, production.tree)
  if (!reading.layoutRead || reading.refused)
    throw new Error(`The layout of the production was not read: ${JSON.stringify(reading.patch)}`)
  if (reading.patch.cmsVersion !== build.version || reading.patch.generation !== build.generation)
    throw new Error(
      `The production reads as ${reading.patch.cmsVersion} (${reading.patch.generation}), the build is ${build.version}`,
    )
  const database = await adapter.databaseSettings(production.tree.read)
  if (!database) throw new Error('The configuration of the production states no database settings')
  const site: SiteFacts = {
    stack: adapter.stack,
    url: input.productionOrigin,
    docroot: '/',
    extras: { ...(reading.patch.extras ?? {}) },
    version: build.version,
    generation: build.generation,
    database,
  }
  const recipe = adapter.previewRecipe(site)
  if (recipe.runtimeVersions[0] !== build.php)
    throw new Error(
      `The recipe runs PHP ${recipe.runtimeVersions.join(', ')} first, the image is ${build.php}`,
    )

  const previewId = randomUUID()
  const scratch = await mkdtemp(join(tmpdir(), 'raditi-stack-preview-'))
  let runtime: ReturnType<typeof createDockerPreviewRuntime> | null = null
  try {
    // The seed, filtered at the source by the stack's policy.
    const chunks: Uint8Array[] = []
    await createMysqlDatabaseCopier({ lookup: createHostLookup(), appEnv: 'test' }).copy(
      {
        access: {
          v: '1',
          engine: 'mysql',
          host: '127.0.0.1',
          port: String(production.dbPort),
          tls: 'plain',
          database: 'site',
          username: 'site',
          password: (await production.exec(['cat', '/prod-secrets/db'])).trim(),
        },
        tablePrefix: database.tablePrefix,
        charset: database.charset,
        collation: database.collation,
        policy: adapter.databaseCopyPolicy(site, { previewId }),
      },
      async (chunk) => {
        chunks.push(chunk)
      },
      signal,
    )
    const seedBytes = Buffer.concat(chunks)

    // The tree of the production as the import takes it: by the adapter's rules, files only.
    const copy = join(scratch, 'tree')
    const name = containers.get(production)
    if (!name) throw new Error('Not a production of startStackProduction')
    await mkdir(copy)
    const packed = spawn('docker', ['exec', name, 'tar', '-C', ROOT, '-cf', '-', '.'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const unpacked = await command('tar', ['-xf', '-', '-C', copy], packed.stdout)
    if (unpacked.code !== 0) throw new Error(`The tree of the production: ${unpacked.stderr}`)
    const policy = importPolicyOf(adapter.importRules(site))
    const treePaths = await walk(copy, (path, type) => policy.decide(path, type) === 'take')

    // The runtime of previews, as core configures it. The tools and the rules of the host: first
    // the tags `pnpm verify:site-images` builds from this tree with the image `site` of the same
    // run, then the tags of preview.yml; SANDBOX_NETWORK_GUARD_IMAGE is above both.
    const toolsTags = ['raditi-site-verify-tools:local', 'raditi-preview-tools:local']
    const guardTags = ['raditi-site-verify-guard:local', 'raditi-network-guard:local']
    const images = {
      preview: await digestOf(`raditi-site-verify:${build.php}`),
      tools: await firstDigest(toolsTags),
    }
    const firewallImage = process.env.SANDBOX_NETWORK_GUARD_IMAGE ?? (await firstDigest(guardTags))
    if (!images.preview || !images.tools || !firewallImage)
      throw new Error(
        `Build raditi-site-verify:${build.php} with ${toolsTags[0]} and ${guardTags[0]} (pnpm verify:site-images -- --build-only --only ${build.php}), or ${toolsTags[1]} and ${guardTags[1]} as preview.yml does (infra/preview/README.md), on the daemon of SANDBOX_DOCKER_SOCKET`,
      )
    runtime = createDockerPreviewRuntime({
      runtime: previewRuntimeKind,
      socketPath: previewSocket,
      gatewayPort: 8090,
      firewallImage,
      dnsServers: ['77.88.8.8', '77.88.8.1'],
    })
    const hostname = `site-${randomBytes(4).toString('hex')}-chat-${randomBytes(3).toString('hex')}.localhost`
    const origin = `http://${hostname}:8090`
    const spec: PreviewRuntimeSpec = {
      previewId,
      siteId: randomUUID(),
      taskId: randomUUID(),
      runtime: previewRuntimeKind,
      images: { preview: images.preview, tools: images.tools },
      database: true,
      recipe,
      limits: previewContainerLimits,
      upstreamHost: '127.0.0.1',
      hostname,
      origin,
      productionOrigin: new URL(input.productionOrigin).origin,
      expiresAt: Date.now() + 2 * 60 * 60_000,
    }
    const passwords: PreviewDatabasePasswords = {
      user: randomBytes(24).toString('base64url'),
      root: randomBytes(24).toString('base64url'),
    }
    const upstream = await runtime.ensure(spec, { env: {}, database: passwords }, signal)
    const target: PreviewTarget = { upstream, hostname }
    const git: PreviewGit = {
      readBranchHead: () => Promise.reject(new Error('no repository in a stand')),
      missingPaths: () => Promise.reject(new Error('no repository in a stand')),
      changedPaths: () => Promise.resolve(null),
      exportTree: async (request, consume) => {
        const left = new Set(request.exclude ?? [])
        const paths = treePaths.filter((path) => !left.has(path))
        return consume({ archive: archiveOf(copy, paths), files: paths.length, bytes: 0 })
      },
    }
    const live = runtime
    const rewriteTree = ({ platform }: { platform: boolean }) =>
      writePreviewTree(live, git, {
        repo: { provider: 'gitea', owner: 'stand', name: 'stand' },
        previewId,
        from: null,
        synced: [],
        to: 'stand',
        recipe: {
          generatedFiles: platform ? recipe.generatedFiles : [],
          writableFolders: recipe.writableFolders,
        },
        signal,
      })
    await rewriteTree({ platform: true })
    await runtime.loadDatabase(previewId, once(seedBytes), passwords, signal)

    const containerId = async () => {
      const id = (
        await previewDocker([
          'ps',
          '-q',
          '--filter',
          `label=io.raditi.preview.id=${previewId}`,
          '--filter',
          'label=io.raditi.preview.role=preview',
        ])
      )
        .toString()
        .trim()
      if (!/^[0-9a-f]{12,64}$/.test(id)) throw new Error('The preview has no running container')
      return id
    }
    return {
      seed: seedBytes.toString('utf8'),
      treePaths,
      recipe,
      hostname,
      origin,
      stackFacts: reading.patch,
      request: async (path, headers = {}) => {
        const response = await previewRequest(target, {
          method: 'GET',
          path,
          headers,
          timeoutMs: 120_000,
          maxResponseBytes: 16 * 1024 * 1024,
        })
        const header = (name: string) => {
          const value = response.headers[name.toLowerCase()]
          return Array.isArray(value) ? value.join(', ') : value
        }
        return {
          status: response.status,
          header,
          body: Buffer.from(response.body).toString('utf8'),
        }
      },
      exec: async (argv) => {
        const result = await live.exec(previewId, { argv: [...argv], timeoutMs: 10 * 60_000 })
        return {
          code: result.code,
          output: `${Buffer.from(result.stdout).toString('utf8')}${Buffer.from(result.stderr).toString('utf8')}`,
        }
      },
      // Root of the preview's database is root of its container on the socket (infra/preview/init.sh).
      rootSql: async (query) =>
        (
          await previewDocker(
            [
              'exec',
              '-i',
              '-u',
              '0:0',
              await containerId(),
              'mariadb',
              '--no-defaults',
              '--socket=/run/mysqld/mysqld.sock',
              '--user=root',
              '--default-character-set=utf8mb4',
              '--batch',
              '--skip-column-names',
              'preview',
            ],
            query,
          )
        ).toString('utf8'),
      containerRuntime: async () =>
        (await previewDocker(['inspect', '-f', '{{.HostConfig.Runtime}}', await containerId()]))
          .toString('utf8')
          .trim(),
      boot: () =>
        previewBootOf(
          target,
          { healthPath: recipe.healthPath, ready: recipe.ready! },
          AbortSignal.timeout(5 * 60_000),
        ),
      rewriteTree,
      destroy: async () => {
        await live.destroy(previewId)
        await rm(scratch, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (runtime) await runtime.destroy(previewId).catch(() => {})
    await rm(scratch, { recursive: true, force: true })
    throw error
  }
}
