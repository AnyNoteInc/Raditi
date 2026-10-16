import { describe, expect, expectTypeOf, it } from 'vitest'

import type { SiteAccessKind } from '../ports/site-adapter.ts'
import {
  dbAccessSchema,
  ftpAccessSchema,
  gitAccessSchema,
  sshAccessSchema,
  type CodeSourceTarget,
  type DatabaseTarget,
  type DbAccess,
  type FtpAccess,
  type GitAccess,
  type PreparedAccess,
  type SshAccess,
} from './access.ts'
import type { CodeSourceInput, DatabaseInput } from './inputs.ts'
import { siteConnectionLimits } from './limits.ts'
import type {
  ConnectionContext,
  DatabaseInspector,
  FileSourceAdapter,
  GitSourceAdapter,
  SiteSourceAdapter,
  SourceCheckPassed,
} from './ports.ts'

const hostKey = `ssh-ed25519 SHA256:${'A'.repeat(43)}`

const ftp = {
  v: '1',
  host: 'ftp.example.ru',
  port: '21',
  tls: 'verified',
  rootPath: '/www/example.ru',
  username: 'u123',
  password: 'secret',
}
const sshPassword = {
  v: '1',
  host: 'example.ru',
  port: '22',
  hostKey,
  rootPath: 'www/example.ru',
  username: 'u123',
  auth: 'password',
  password: 'secret',
}
const sshKey = {
  v: '1',
  host: 'example.ru',
  port: '22',
  hostKey,
  rootPath: 'www/example.ru',
  username: 'u123',
  auth: 'key',
  privateKey:
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\n',
}
const git = {
  v: '1',
  url: 'https://github.com/owner/site.git',
  username: 'x-access-token',
  token: 'ghp_token',
}
const db = {
  v: '1',
  engine: 'mysql',
  host: 'db.example.ru',
  port: '3306',
  tls: 'verified',
  database: 'u123_wp',
  username: 'u123_wp',
  password: 'secret',
}

const accesses = [
  ['ftp', ftpAccessSchema, ftp],
  ['ssh with a password', sshAccessSchema, sshPassword],
  ['ssh with a key', sshAccessSchema, sshKey],
  ['git', gitAccessSchema, git],
  ['db', dbAccessSchema, db],
] as const

describe('site access secrets', () => {
  it.each(accesses)('reads the %s secret as a flat record of strings', (_name, schema, secret) => {
    const parsed = schema.parse(secret)
    expect(parsed).toEqual(secret)
    expect(Object.values(parsed).every((value) => typeof value === 'string')).toBe(true)
  })

  it.each(accesses)(
    'refuses an unknown field and another version of the %s secret',
    (_name, schema, secret) => {
      expect(schema.safeParse({ ...secret, origin: 'https://example.ru' }).success).toBe(false)
      expect(schema.safeParse({ ...secret, v: '2' }).success).toBe(false)
      expect(schema.safeParse({ ...secret, v: 1 }).success).toBe(false)
      const { v: _version, ...unversioned } = secret
      expect(schema.safeParse(unversioned).success).toBe(false)
    },
  )

  it.each([
    ['ftp', ftpAccessSchema, ftp],
    ['ssh', sshAccessSchema, sshPassword],
    ['db', dbAccessSchema, db],
  ] as const)('keeps the port of the %s secret as decimal text', (_name, schema, secret) => {
    for (const port of ['1', '21', '65535'])
      expect(schema.safeParse({ ...secret, port }).success).toBe(true)
    for (const port of [21, '', '0', '021', '-1', '21.0', ' 21', '123456', '0x15'])
      expect(schema.safeParse({ ...secret, port }).success).toBe(false)
  })

  // A secret says not only where the server is but how it may be reached: a row that lost or
  // changed one of these fields cannot make the worker connect another way.
  it.each([
    ['ftp', ftpAccessSchema, ftp, ['host', 'port', 'tls', 'rootPath', 'username', 'password']],
    [
      'ssh',
      sshAccessSchema,
      sshPassword,
      ['host', 'port', 'hostKey', 'rootPath', 'username', 'auth', 'password'],
    ],
    ['git', gitAccessSchema, git, ['url', 'username', 'token']],
    [
      'db',
      dbAccessSchema,
      db,
      ['engine', 'host', 'port', 'tls', 'database', 'username', 'password'],
    ],
  ] as const)('requires every field of the %s secret', (_name, schema, secret, fields) => {
    for (const field of fields) {
      const incomplete: Record<string, string> = { ...secret }
      delete incomplete[field]
      expect(schema.safeParse(incomplete).success, field).toBe(false)
    }
  })

  it('accepts only the three protection modes for ftp and a database', () => {
    for (const tls of ['verified', 'unverified', 'plain']) {
      expect(ftpAccessSchema.safeParse({ ...ftp, tls }).success).toBe(true)
      expect(dbAccessSchema.safeParse({ ...db, tls }).success).toBe(true)
    }
    for (const tls of ['', 'none', 'true', 'VERIFIED']) {
      expect(ftpAccessSchema.safeParse({ ...ftp, tls }).success).toBe(false)
      expect(dbAccessSchema.safeParse({ ...db, tls }).success).toBe(false)
    }
  })

  it('reads the ssh secret by its way of authentication', () => {
    expect(sshAccessSchema.parse({ ...sshKey, passphrase: ' фраза ' })).toMatchObject({
      auth: 'key',
      passphrase: ' фраза ',
    })
    expect(
      sshAccessSchema.safeParse({ ...sshPassword, privateKey: sshKey.privateKey }).success,
    ).toBe(false)
    expect(sshAccessSchema.safeParse({ ...sshKey, password: 'secret' }).success).toBe(false)
    expect(sshAccessSchema.safeParse({ ...sshPassword, auth: 'agent' }).success).toBe(false)
    expect(sshAccessSchema.safeParse({ ...sshKey, privateKey: 'ключ' }).success).toBe(false)
    // The key of the server is part of the access: a signature algorithm or a padded digest is not one.
    for (const key of [`rsa-sha2-512 SHA256:${'A'.repeat(43)}`, `${hostKey}=`, ''])
      expect(sshAccessSchema.safeParse({ ...sshPassword, hostKey: key }).success).toBe(false)
  })

  it('keeps the folder of a server as the wizard accepted it', () => {
    for (const rootPath of ['..', '/www/../etc', 'www\\site', '', '/www\nsite']) {
      expect(ftpAccessSchema.safeParse({ ...ftp, rootPath }).success).toBe(false)
      expect(sshAccessSchema.safeParse({ ...sshPassword, rootPath }).success).toBe(false)
    }
  })

  it('keeps the canonical address of a repository and, when one was chosen, its branch', () => {
    expect(gitAccessSchema.parse({ ...git, branch: 'release/2026.10' }).branch).toBe(
      'release/2026.10',
    )
    expect(gitAccessSchema.safeParse({ ...git, branch: '-main' }).success).toBe(false)
    expect(gitAccessSchema.safeParse({ ...git, branch: '' }).success).toBe(false)
    // Four characters more than the wizard accepts: the `.git` of the one allowed redirect.
    const longest = `https://github.com/${'a'.repeat(siteConnectionLimits.gitUrlChars - 19)}.git`
    expect(longest).toHaveLength(1024)
    expect(gitAccessSchema.safeParse({ ...git, url: longest }).success).toBe(true)
    expect(gitAccessSchema.safeParse({ ...git, url: `${longest}a` }).success).toBe(false)
    expect(gitAccessSchema.safeParse({ ...git, url: '' }).success).toBe(false)
  })

  it('names the engine of a database inside the one db secret', () => {
    expect(dbAccessSchema.safeParse({ ...db, engine: 'postgres' }).success).toBe(true)
    expect(dbAccessSchema.safeParse({ ...db, engine: 'mariadb' }).success).toBe(false)
  })

  it('never trims a password and refuses a line break in it', () => {
    expect(ftpAccessSchema.parse({ ...ftp, password: ' p ' }).password).toBe(' p ')
    expect(dbAccessSchema.parse({ ...db, password: ' p ' }).password).toBe(' p ')
    expect(gitAccessSchema.parse({ ...git, token: ' t ' }).token).toBe(' t ')
    expect(ftpAccessSchema.safeParse({ ...ftp, password: 'p\n' }).success).toBe(false)
    expect(sshAccessSchema.safeParse({ ...sshPassword, password: 'p\u0000' }).success).toBe(false)
  })
})

describe('the largest secret', () => {
  // What JSON makes longest of one UTF-16 unit: six bytes for a control character or a lone
  // surrogate (`\u0001`, `\ud800`), two for a quote inside ASCII text.
  const control = '\u0001'
  const surrogate = '\ud800'
  const longestHostKey = `ssh-${'a'.repeat(73)} SHA256:${'A'.repeat(43)}`
  const bytes = (secret: Record<string, string>) =>
    new TextEncoder().encode(JSON.stringify(secret)).byteLength

  const largest = {
    ftp: {
      schema: ftpAccessSchema,
      secret: {
        v: '1',
        host: surrogate.repeat(253),
        port: '65535',
        tls: 'unverified',
        rootPath: surrogate.repeat(1024),
        username: surrogate.repeat(128),
        password: control.repeat(1024),
      },
    },
    ssh: {
      schema: sshAccessSchema,
      secret: {
        v: '1',
        host: surrogate.repeat(253),
        port: '65535',
        hostKey: longestHostKey,
        rootPath: surrogate.repeat(1024),
        username: surrogate.repeat(128),
        auth: 'key',
        privateKey: '"'.repeat(siteConnectionLimits.privateKeyChars),
        passphrase: control.repeat(1024),
      },
    },
    git: {
      schema: gitAccessSchema,
      secret: {
        v: '1',
        url: surrogate.repeat(1024),
        branch: 'a'.repeat(200),
        username: surrogate.repeat(128),
        token: control.repeat(1024),
      },
    },
    db: {
      schema: dbAccessSchema,
      secret: {
        v: '1',
        engine: 'postgres',
        host: surrogate.repeat(253),
        port: '65535',
        tls: 'unverified',
        database: surrogate.repeat(64),
        username: surrogate.repeat(128),
        password: control.repeat(1024),
      },
    },
  } as const

  it.each(Object.entries(largest))(
    'of kind %s is accepted and its JSON stays under secretBytes',
    (_kind, { schema, secret }) => {
      expect(schema.safeParse(secret).success).toBe(true)
      expect(bytes(secret)).toBeLessThanOrEqual(siteConnectionLimits.secretBytes)
      // Every field is at its limit: one more character anywhere is refused, so nothing larger passes.
      for (const [field, value] of Object.entries(secret)) {
        if (['v', 'port', 'tls', 'auth', 'engine'].includes(field)) continue
        const longer = field === 'hostKey' ? `ssh-a${value.slice(4)}` : `${value}a`
        expect(schema.safeParse({ ...secret, [field]: longer }).success, field).toBe(false)
      }
    },
  )

  it('is the ssh key, and it leaves room under the request limit of the KV adapter', () => {
    const sizes = Object.values(largest).map(({ secret }) => bytes(secret))
    expect(Math.max(...sizes)).toBe(bytes(largest.ssh.secret))
    expect(bytes(largest.ssh.secret)).toBeGreaterThan(46 * 1024)
    expect(siteConnectionLimits.secretBytes).toBeLessThan(64 * 1024)
  })
})

// Type tests. Nothing below can fail at run time: a broken contract shows in `tsc --noEmit`, which
// covers the tests of this package (`pnpm --filter @repo/domain typecheck`).
describe('PreparedAccess, by its types', () => {
  it('pairs one Vault record of strings with the public columns of one row', () => {
    type Secret = PreparedAccess<CodeSourceTarget>['secret']
    expectTypeOf<Secret>().toEqualTypeOf<Record<string, string>>()
    expectTypeOf<PreparedAccess<CodeSourceTarget>['accessKind']>().toEqualTypeOf<SiteAccessKind>()
    // Every parsed secret is such a record: a transport writes it without knowing the kind of the source.
    expectTypeOf<FtpAccess>().toExtend<Secret>()
    expectTypeOf<SshAccess>().toExtend<Secret>()
    expectTypeOf<GitAccess>().toExtend<Secret>()
    expectTypeOf<DbAccess>().toExtend<Secret>()
    // It is what a checked input becomes, with the row of its own table.
    expectTypeOf<SiteSourceAdapter['prepare']>().parameters.toEqualTypeOf<
      [CodeSourceInput, SourceCheckPassed]
    >()
    expectTypeOf<SiteSourceAdapter['prepare']>().returns.toEqualTypeOf<
      PreparedAccess<CodeSourceTarget>
    >()
    expectTypeOf<DatabaseInspector['prepare']>().parameters.toEqualTypeOf<[DatabaseInput]>()
    expectTypeOf<DatabaseInspector['prepare']>().returns.toEqualTypeOf<
      PreparedAccess<DatabaseTarget>
    >()
  })
})

describe('SiteSourceAdapter and DatabaseInspector, by their types', () => {
  it('are written against their own secret, read through their own schema', () => {
    expectTypeOf(ftpAccessSchema).toExtend<FileSourceAdapter<FtpAccess>['accessSchema']>()
    expectTypeOf(sshAccessSchema).toExtend<FileSourceAdapter<SshAccess>['accessSchema']>()
    expectTypeOf(gitAccessSchema).toExtend<GitSourceAdapter<GitAccess>['accessSchema']>()
    expectTypeOf(dbAccessSchema).toExtend<DatabaseInspector<DbAccess>['accessSchema']>()
    expectTypeOf<FileSourceAdapter<FtpAccess>['open']>().parameters.toEqualTypeOf<
      [FtpAccess, ConnectionContext]
    >()
    expectTypeOf<FileSourceAdapter<FtpAccess>['matchesTarget']>().parameters.toEqualTypeOf<
      [FtpAccess, CodeSourceTarget]
    >()
    expectTypeOf<GitSourceAdapter<GitAccess>['remote']>().parameters.toEqualTypeOf<[GitAccess]>()
    expectTypeOf<DatabaseInspector<DbAccess>['matchesTarget']>().parameters.toEqualTypeOf<
      [DbAccess, DatabaseTarget]
    >()
  })

  it('are held by a registry that knows neither that secret nor its kind', () => {
    expectTypeOf<FileSourceAdapter<FtpAccess>>().toExtend<SiteSourceAdapter>()
    expectTypeOf<FileSourceAdapter<SshAccess>>().toExtend<SiteSourceAdapter>()
    expectTypeOf<GitSourceAdapter<GitAccess>>().toExtend<SiteSourceAdapter>()
    expectTypeOf<DatabaseInspector<DbAccess>>().toExtend<DatabaseInspector>()
    // The worker hands over what the adapter's schema parsed, and nothing it could name a field of.
    expectTypeOf<ReturnType<SiteSourceAdapter['accessSchema']['parse']>>().toBeUnknown()
    expectTypeOf<SiteSourceAdapter['matchesTarget']>().parameters.toEqualTypeOf<
      [unknown, CodeSourceTarget]
    >()
    expectTypeOf<SiteSourceAdapter['scanValues']>().parameters.toEqualTypeOf<[unknown]>()
  })

  it('tell how the tree is obtained by the declared transfer, not by the kind', () => {
    // The union narrows on the capability: `open` exists on one side, `probe` and `remote` on the other.
    expectTypeOf<
      Extract<SiteSourceAdapter, { transfer: 'files' }>
    >().toEqualTypeOf<FileSourceAdapter>()
    expectTypeOf<
      Extract<SiteSourceAdapter, { transfer: 'git' }>
    >().toEqualTypeOf<GitSourceAdapter>()
    expectTypeOf<SiteSourceAdapter>().not.toHaveProperty('open')
    expectTypeOf<SiteSourceAdapter>().not.toHaveProperty('probe')
    expectTypeOf<SiteSourceAdapter>().not.toHaveProperty('remote')
  })
})
