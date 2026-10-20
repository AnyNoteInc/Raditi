import { siteAccessPath, sshAccessSchema, type KvSecret } from '@repo/domain'
import { wordpressAdapter } from '@repo/site-adapters'
import { siteSource } from '@repo/site-connections'
import { databaseInspector } from '@repo/site-connections/databases'
import { startTestSftpServer, type TestSftpServer } from '@repo/site-connections/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPreviewSiteSources, type PreviewSiteSourcesDeps } from './site-sources.ts'

// The site as the connection wizard recorded it, read by a preview: wp-config.php over a real SFTP
// session to a server on loopback, and the database access by the row and its reference.

const SITE = '0190f0a0-0000-7000-8000-000000000001'
const WORKSPACE = '0190f0a0-0000-7000-8000-0000000000aa'
const WP_CONFIG = `<?php
define( 'DB_NAME', 'shop' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );
$table_prefix = 'shop_';
`

let server: TestSftpServer

beforeAll(async () => {
  server = await startTestSftpServer({
    files: { 'public_html/wp-config.php': WP_CONFIG, 'public_html/index.php': '<?php' },
    users: [{ username: 'site', password: 'p@ss word' }],
  })
})

afterAll(async () => {
  await server.close()
})

/** Vault that keeps every version, as KV v2 does: a reader that names one gets that one. */
class VersionedVault {
  readonly versions = new Map<string, Record<string, string>[]>()
  readonly reads: Array<{ path: string; version?: number }> = []
  write(path: string, data: Record<string, string>) {
    const list = this.versions.get(path) ?? []
    list.push(data)
    this.versions.set(path, list)
  }
  async kvRead(path: string, options: { version?: number } = {}): Promise<KvSecret | null> {
    this.reads.push({ path, ...options })
    const list = this.versions.get(path) ?? []
    const version = options.version ?? list.length
    const data = list[version - 1]
    return data ? ({ data, version } as KvSecret) : null
  }
}

const sshAccess = (overrides: Record<string, string> = {}) =>
  sshAccessSchema.parse({
    v: '1',
    host: '127.0.0.1',
    port: String(server.port),
    hostKey: server.hostKey,
    rootPath: 'public_html',
    username: 'site',
    auth: 'password',
    password: 'p@ss word',
    ...overrides,
  }) as Record<string, string>

const dbAccess = (overrides: Record<string, string> = {}) => ({
  v: '1',
  engine: 'mysql',
  host: 'db.example.test',
  port: '3306',
  tls: 'verified',
  database: 'shop',
  username: 'shop',
  password: 'secret',
  ...overrides,
})

const reference = (kind: string, keyVersion = 1, extra: Record<string, unknown> = {}) => ({
  kind,
  siteId: SITE,
  workspaceId: WORKSPACE,
  vaultPath: siteAccessPath(SITE, kind as 'ssh'),
  keyVersion,
  ...extra,
})

interface Rows {
  codeSource?: Record<string, unknown> | null
  database?: Record<string, unknown> | null
  dbReferences?: Array<ReturnType<typeof reference>>
}

function sources(rows: Rows, vault: VersionedVault) {
  const db = {
    site: {
      findUnique: async () => ({
        id: SITE,
        workspaceId: WORKSPACE,
        codeSource: rows.codeSource ?? null,
        database: rows.database ?? null,
      }),
    },
    credentialRef: { findMany: async () => rows.dbReferences ?? [] },
  } as unknown as PreviewSiteSourcesDeps['db']
  return createPreviewSiteSources({
    db,
    secrets: vault,
    sources: siteSource,
    databases: databaseInspector,
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    appEnv: 'test',
    readMs: 15_000,
  })
}

const sftpRow = (overrides: Record<string, unknown> = {}) => ({
  kind: 'sftp',
  host: '127.0.0.1',
  port: server.port,
  rootPath: 'public_html',
  repositoryUrl: null,
  branch: null,
  tls: null,
  hostKey: server.hostKey,
  credentialRef: reference('ssh'),
  ...overrides,
})

const databaseRow = (overrides: Record<string, unknown> = {}) => ({
  engine: 'mysql',
  host: 'db.example.test',
  port: 3306,
  databaseName: 'shop',
  tls: 'verified',
  credentialRef: reference('db'),
  ...overrides,
})

const settingsOf = (rows: Rows, vault: VersionedVault, signal = AbortSignal.timeout(20_000)) =>
  sources(rows, vault).withRoot(SITE, signal, (read) => wordpressAdapter.databaseSettings(read))

describe('the configuration of the site on its hosting', () => {
  it('reads the prefix and the encoding from wp-config.php through the wizard’s file source', async () => {
    const vault = new VersionedVault()
    vault.write(siteAccessPath(SITE, 'ssh'), sshAccess())

    await expect(settingsOf({ codeSource: sftpRow() }, vault)).resolves.toEqual({
      tablePrefix: 'shop_',
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
    })
    expect(vault.reads).toEqual([{ path: siteAccessPath(SITE, 'ssh'), version: 1 }])
    expect(server.writeAttempts).toEqual([])
  })

  it('reads the version the reference names, not a newer one a failed request wrote', async () => {
    const vault = new VersionedVault()
    vault.write(siteAccessPath(SITE, 'ssh'), sshAccess())
    vault.write(siteAccessPath(SITE, 'ssh'), sshAccess({ password: 'not the one' }))

    await expect(settingsOf({ codeSource: sftpRow() }, vault)).resolves.toMatchObject({
      tablePrefix: 'shop_',
    })
  })

  it('has nothing to read without a file source: a site from before the wizard', async () => {
    const vault = new VersionedVault()
    await expect(settingsOf({ codeSource: null }, vault)).resolves.toBeNull()
    expect(vault.reads).toEqual([])
  })

  it('opens nothing when the reference, the secret or the row do not agree', async () => {
    const attempts = server.authAttempts.length
    const vault = new VersionedVault()
    vault.write(siteAccessPath(SITE, 'ssh'), sshAccess())
    // Another path than the one of the access.
    const elsewhere = sftpRow({ credentialRef: reference('ssh', 1, { vaultPath: 'kv/other' }) })
    await expect(settingsOf({ codeSource: elsewhere }, vault)).resolves.toBeNull()
    // A version Vault does not hold.
    const missing = sftpRow({ credentialRef: reference('ssh', 2) })
    await expect(settingsOf({ codeSource: missing }, vault)).resolves.toBeNull()
    // Another workspace.
    const foreign = sftpRow({ credentialRef: reference('ssh', 1, { workspaceId: SITE }) })
    await expect(settingsOf({ codeSource: foreign }, vault)).resolves.toBeNull()
    // The row pins another host key than the secret.
    const otherKey = sftpRow({ hostKey: `ssh-ed25519 SHA256:${'A'.repeat(43)}` })
    await expect(settingsOf({ codeSource: otherKey }, vault)).resolves.toBeNull()
    expect(server.authAttempts.length).toBe(attempts)
  })

  it('answers null when the hosting refuses the login: the catalog decides then', async () => {
    const vault = new VersionedVault()
    vault.write(siteAccessPath(SITE, 'ssh'), sshAccess({ password: 'wrong' }))
    await expect(settingsOf({ codeSource: sftpRow() }, vault)).resolves.toBeNull()
  })

  it('gives up with the build: an aborted build is not a missing configuration', async () => {
    const vault = new VersionedVault()
    vault.write(siteAccessPath(SITE, 'ssh'), sshAccess())
    const controller = new AbortController()
    controller.abort(new Error('the hold was lost'))
    await expect(settingsOf({ codeSource: sftpRow() }, vault, controller.signal)).rejects.toThrow(
      'the hold was lost',
    )
  })
})

describe('the access to the site’s database', () => {
  it('follows the row of the wizard and its reference, at the version it names', async () => {
    const vault = new VersionedVault()
    vault.write(siteAccessPath(SITE, 'db'), dbAccess())
    vault.write(siteAccessPath(SITE, 'db'), dbAccess({ password: 'newer, never referenced' }))

    await expect(sources({ database: databaseRow() }, vault).databaseAccess(SITE)).resolves.toEqual(
      { ok: true, access: dbAccess() },
    )
  })

  it('refuses a secret that does not agree with the row', async () => {
    const vault = new VersionedVault()
    vault.write(siteAccessPath(SITE, 'db'), dbAccess({ port: '3307' }))
    await expect(sources({ database: databaseRow() }, vault).databaseAccess(SITE)).resolves.toEqual(
      { ok: false, code: 'access_mismatch' },
    )
  })

  it('says the access is missing when Vault has no version the reference names', async () => {
    const vault = new VersionedVault()
    await expect(sources({ database: databaseRow() }, vault).databaseAccess(SITE)).resolves.toEqual(
      { ok: false, code: 'access_missing' },
    )
  })

  it('takes the one reference of kind db of a site connected before the wizard', async () => {
    const vault = new VersionedVault()
    vault.write(siteAccessPath(SITE, 'db'), dbAccess())
    const one = { dbReferences: [reference('db')] }
    await expect(sources(one, vault).databaseAccess(SITE)).resolves.toEqual({
      ok: true,
      access: dbAccess(),
    })
    const two = { dbReferences: [reference('db'), reference('db')] }
    await expect(sources(two, vault).databaseAccess(SITE)).resolves.toEqual({
      ok: false,
      code: 'access_mismatch',
    })
    await expect(sources({}, vault).databaseAccess(SITE)).resolves.toEqual({
      ok: false,
      code: 'access_missing',
    })
  })
})
