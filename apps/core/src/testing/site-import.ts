// A whole import without servers, for the tests of the site import: a fixture directory with the
// bare repositories of a fake provisioner (the local-test transport of git), a scripted gitleaks,
// an in-memory file source and Vault, and the in-memory stage store. Only for *.test.ts files.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  siteRepositoryName,
  SITE_REPOSITORY_OWNER,
  type FileSourceAdapter,
  type KvSecret,
  type SiteRepositoryProvisioner,
} from '@repo/domain'
import { getSiteAdapter } from '@repo/site-adapters'
import { databaseInspector } from '@repo/site-connections/databases'
import { vi } from 'vitest'
import { z } from 'zod'

import { InitialVersionGit } from '../site-provisioning/initial-version.ts'
import { importSite, type SiteImportDeps } from '../site-provisioning/site-import.ts'
import { fakeSession, type FakeNode } from './file-source.ts'
import { FakeSiteImportStore } from './site-import-store.ts'

const execute = promisify(execFile)

/** git of the test itself, never the trusted one: reads and writes the fixture repositories. */
export async function fixtureGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  })
  return stdout
}

/** Marks a file the scripted gitleaks reports; markers of its failure make it fail. */
export const LEAK_MARKER = 'synthetic-leak-marker'
export const SCANNER_ERROR_MARKER = 'synthetic-scanner-error'
export const FTP_PASSWORD = 'synthetic-ftp-password-7'
/** Low in entropy on purpose: gitleaks' generic rule would not find it, only the exact search. */
export const DATABASE_PASSWORD = 'Shop2024pass'

const ftpAccessSchema = z.strictObject({
  v: z.literal('1'),
  host: z.string(),
  port: z.string(),
  rootPath: z.string(),
  username: z.string(),
  password: z.string(),
})
type FakeAccess = z.infer<typeof ftpAccessSchema>

export interface SiteImportFixture {
  root: string
  siteId: string
  workspaceId: string
  store: FakeSiteImportStore
  deps: SiteImportDeps
  tree: Record<string, FakeNode>
  /** Where the provisioner keeps the bare repository of the site. */
  remote: string
  /** The source access in Vault at the version its reference names (2). */
  secret: KvSecret | null
  /** The other versions in-memory Vault keeps, by path: a newer write, the database access. */
  vault: Map<string, KvSecret[]>
  /** Gives the site a database row, its reference (version 1) and its access in Vault. */
  addDatabase: () => void
  /** Opened file sessions: a run that skips the fetch opens none. */
  opened: () => number
  provisioner: SiteRepositoryProvisioner & { ensureRepository: ReturnType<typeof vi.fn> }
  scannerLog: string
  /** Claims the stage and runs the import as the worker would, without its lifecycle. */
  run: (options?: { signal?: AbortSignal; afterClaim?: () => void }) => Promise<{
    commitSha: string
  }>
  cleanup: () => Promise<void>
}

/** A WordPress folder: core, a theme, media and what the rules leave out. */
export const sampleSite = (): Record<string, FakeNode> => ({
  'index.php': { type: 'file', content: '<?php require __DIR__ . "/wp-blog-header.php";\n' },
  'wp-config.php': {
    type: 'file',
    content: `<?php define('DB_PASSWORD', 'synthetic-db-password');\n`,
  },
  'wp-includes': {
    type: 'directory',
    children: { 'version.php': { type: 'file', content: '<?php $wp_version = "6.8";\n' } },
  },
  'wp-content': {
    type: 'directory',
    children: {
      themes: {
        type: 'directory',
        children: {
          site: {
            type: 'directory',
            children: { 'style.css': { type: 'file', content: 'body{}\n' } },
          },
        },
      },
      uploads: {
        type: 'directory',
        children: {
          'logo.png': { type: 'file', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]) },
        },
      },
    },
  },
})

export async function siteImportFixture(
  options: { tree?: Record<string, FakeNode>; scanner?: string | null } = {},
): Promise<SiteImportFixture> {
  const root = await mkdtemp(join(tmpdir(), 'raditi-site-import-test-'))
  const siteId = randomUUID()
  const workspaceId = randomUUID()
  const credentialRefId = randomUUID()
  const remotes = join(root, 'remote', SITE_REPOSITORY_OWNER)
  await mkdir(remotes, { recursive: true })
  const remote = join(remotes, `${siteRepositoryName(siteId)}.git`)

  const scanner = join(root, 'gitleaks.mjs')
  const scannerLog = join(root, 'gitleaks.log')
  // Like gitleaks 8: `version`, and `dir .` with a JSON report of the copies that hold a finding.
  await writeFile(
    scanner,
    `#!${process.execPath}
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === 'version') { console.log('8.30.1'); process.exit(0) }
const files = readdirSync('.')
appendFileSync(${JSON.stringify(scannerLog)}, JSON.stringify({ cwd: process.cwd(), args, files }) + '\\n')
const report = args[args.indexOf('--report-path') + 1]
const found = []
for (const name of files) {
  const text = readFileSync(name, 'latin1')
  if (!text.startsWith('GIF89a\\n')) process.exit(3)
  if (text.includes(${JSON.stringify(SCANNER_ERROR_MARKER)})) process.exit(2)
  if (text.includes(${JSON.stringify(LEAK_MARKER)})) found.push({ RuleID: 'synthetic', File: name, Secret: 'REDACTED' })
}
writeFileSync(report, JSON.stringify(found))
const exit = Number(args.find((arg) => arg.startsWith('--exit-code='))?.slice(12) ?? 1)
process.exit(found.length ? exit : 0)
`,
    { mode: 0o700 },
  )

  const store = new FakeSiteImportStore()
  store.add({ siteId, workspaceId })
  store.access.set(siteId, {
    siteStatus: 'onboarding',
    workspaceId,
    source: {
      kind: 'ftp',
      host: '127.0.0.1',
      port: 21,
      rootPath: '/www',
      repositoryUrl: null,
      branch: null,
      tls: 'verified',
      hostKey: null,
      credentialRefId,
    },
    reference: {
      kind: 'ftp',
      siteId,
      workspaceId,
      vaultPath: `kv/sites/${siteId}/ftp`,
      keyVersion: 2,
    },
    database: null,
  })

  let opened = 0
  const fixture = {} as SiteImportFixture
  const adapter: FileSourceAdapter<FakeAccess> = {
    kind: 'ftp',
    accessKind: 'ftp',
    transfer: 'files',
    accessSchema: ftpAccessSchema,
    defaultPort: 21,
    endpoint: () => ({ host: '127.0.0.1', port: 21 }),
    check: async () => {
      throw new Error('The worker never checks')
    },
    prepare: () => {
      throw new Error('The worker never prepares')
    },
    endpointOf: (stored) => ({ host: stored.host, port: Number(stored.port) }),
    matchesTarget: (stored, target) =>
      target.host === stored.host &&
      target.port === Number(stored.port) &&
      target.rootPath === stored.rootPath,
    scanValues: (stored) => [stored.password],
    open: async (_access, context) => {
      opened += 1
      return fakeSession(fixture.tree, { signal: context.signal })
    },
  }

  const provisioner = {
    ensureRepository: vi.fn(async (name: string) => {
      const path = join(remotes, `${name}.git`)
      try {
        await access(path)
      } catch {
        await fixtureGit(remotes, 'init', '--quiet', '--bare', '--initial-branch=main', path)
      }
      return {
        ref: { provider: 'gitea' as const, owner: SITE_REPOSITORY_OWNER, name },
        defaultBranch: 'main',
        cloneUrl: path,
        private: true,
      }
    }),
  }
  const provider = {
    issueCredentials: vi.fn(async () => {
      throw new Error('Local tests must not request real credentials')
    }),
  }

  const deps: SiteImportDeps = {
    appEnv: 'test',
    store,
    secrets: {
      // As KV v2: the newest version, or the one named; null for a version it does not keep.
      kvRead: vi.fn(async (path: string, options?: { version?: number }) => {
        const versions = [
          ...(path === `kv/sites/${siteId}/ftp` && fixture.secret ? [fixture.secret] : []),
          ...(fixture.vault.get(path) ?? []),
        ]
        if (options?.version !== undefined)
          return versions.find((secret) => secret.version === options.version) ?? null
        return versions.sort((a, b) => b.version - a.version)[0] ?? null
      }),
    },
    sources: () => adapter as FileSourceAdapter,
    databases: databaseInspector,
    stacks: getSiteAdapter,
    lookup: async () => {
      throw new Error('An IP literal is never looked up')
    },
    provisioner,
    git: {
      versions: new InitialVersionGit({ provider, transport: { kind: 'local-test', root } }),
      webRoot: 'https://gitea.raditi.test',
    },
    gitleaksBinary:
      options.scanner === undefined ? scanner : (options.scanner ?? join(root, 'none')),
    now: () => new Date('2026-10-17T10:00:00Z'),
  }

  Object.assign(fixture, {
    root,
    siteId,
    workspaceId,
    store,
    deps,
    tree: options.tree ?? sampleSite(),
    remote,
    vault: new Map(),
    addDatabase: () => {
      const reference = randomUUID()
      store.access.get(siteId)!.database = {
        row: {
          engine: 'mysql',
          host: '127.0.0.1',
          port: 3306,
          databaseName: 'wordpress',
          tls: 'verified',
          credentialRefId: reference,
        },
        reference: {
          kind: 'db',
          siteId,
          workspaceId,
          vaultPath: `kv/sites/${siteId}/db`,
          keyVersion: 1,
        },
      }
      fixture.vault.set(`kv/sites/${siteId}/db`, [
        {
          version: 1,
          data: {
            v: '1',
            engine: 'mysql',
            host: '127.0.0.1',
            port: '3306',
            tls: 'verified',
            database: 'wordpress',
            username: 'synthetic-db-user',
            password: DATABASE_PASSWORD,
          },
        },
      ])
    },
    secret: {
      version: 2,
      data: {
        v: '1',
        host: '127.0.0.1',
        port: '21',
        rootPath: '/www',
        username: 'synthetic-user',
        password: FTP_PASSWORD,
      },
    },
    opened: () => opened,
    provisioner,
    scannerLog,
    run: async ({ signal = new AbortController().signal, afterClaim } = {}) => {
      const claim = await store.claim(siteId)
      if (claim.kind !== 'claimed') throw new Error(`The stage was not claimed: ${claim.kind}`)
      afterClaim?.()
      return importSite(claim.stage, signal, fixture.deps)
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  } satisfies SiteImportFixture)
  return fixture
}
