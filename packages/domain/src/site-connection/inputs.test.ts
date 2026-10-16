import { describe, expect, it } from 'vitest'

import {
  codeSourceInputSchema,
  databaseInputSchema,
  ftpSourceInputSchema,
  gitBranchSchema,
  gitRepositoryUrlSchema,
  gitSourceInputSchema,
  hasControlCharacter,
  hostKeySchema,
  sftpSourceInputSchema,
  siteHostSchema,
} from './inputs.ts'
import { siteConnectionLimits } from './limits.ts'

const hostKey = `ssh-ed25519 SHA256:${'A'.repeat(43)}`
const privateKey = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  '-----END OPENSSH PRIVATE KEY-----',
  '',
].join('\n')

const ftp = {
  kind: 'ftp',
  host: 'ftp.example.ru',
  port: 21,
  username: 'u123',
  password: 'secret',
  rootPath: '/www/example.ru',
  tls: 'verified',
} as const
const sftp = {
  kind: 'sftp',
  host: 'example.ru',
  port: 22,
  username: 'u123',
  auth: { method: 'password', password: 'secret' },
  rootPath: 'www/example.ru',
} as const
const git = {
  kind: 'git',
  url: 'https://github.com/owner/site.git',
  token: 'ghp_token',
} as const
const database = {
  engine: 'mysql',
  host: 'db.example.ru',
  port: 3306,
  database: 'u123_wp',
  username: 'u123_wp',
  password: 'secret',
  tls: 'verified',
} as const

describe('hasControlCharacter', () => {
  it.each(['\u0000', 'a\u0007b', 'a\tb', 'line\nbreak', 'a\rb', '\u001f', 'a\u007fb'])(
    'finds a C0 character or DEL in %j',
    (text) => {
      expect(hasControlCharacter(text)).toBe(true)
      expect(hasControlCharacter(text, { c1: true })).toBe(true)
    },
  )

  it.each(['\u0080', 'ф\u0098.jpg', '\u009f'])(
    'finds the C1 character of %j only when asked',
    (text) => {
      expect(hasControlCharacter(text)).toBe(false)
      expect(hasControlCharacter(text, { c1: false })).toBe(false)
      expect(hasControlCharacter(text, { c1: true })).toBe(true)
    },
  )

  it.each(['', ' ', 'foto.jpg', 'фото.jpg', '~', '\u00a0', 'ф\ufffd.jpg', '😀'])(
    'finds nothing in %j',
    (text) => {
      expect(hasControlCharacter(text, { c1: true })).toBe(false)
    },
  )
})

describe('siteHostSchema', () => {
  it.each([
    [' FTP.Example.RU. ', 'ftp.example.ru'],
    ['пример.рф', 'xn--e1afmkfd.xn--p1ai'],
    ['127.1', '127.0.0.1'],
    ['[::1]', '::1'],
    ['localhost', 'localhost'],
  ])('trims and normalises %j to %s', (text, host) => {
    expect(siteHostSchema.parse(text)).toBe(host)
  })

  it.each([
    '',
    '   ',
    'https://example.ru',
    'ftp://example.ru',
    'example.ru:21',
    'example.ru/www',
    'user@example.ru',
    'exa mple.ru',
    'example.ru..',
    // 254 characters.
    `${`${'a'.repeat(62)}.`.repeat(4)}ru`,
  ])('refuses %j, which is not a bare host', (text) => {
    expect(siteHostSchema.safeParse(text).success).toBe(false)
  })

  it('refuses anything but a string', () => {
    for (const value of [undefined, null, 21, ['example.ru'], { host: 'example.ru' }])
      expect(siteHostSchema.safeParse(value).success).toBe(false)
  })
})

describe('ftpSourceInputSchema', () => {
  it('accepts an FTP access and stores the host normalised', () => {
    expect(ftpSourceInputSchema.parse({ ...ftp, host: 'FTP.Example.ru.' })).toEqual(ftp)
    for (const tls of ['verified', 'unverified', 'plain'])
      expect(ftpSourceInputSchema.safeParse({ ...ftp, tls }).success).toBe(true)
  })

  it('refuses an unknown field and a field of another kind', () => {
    expect(ftpSourceInputSchema.safeParse({ ...ftp, siteId: 'x' }).success).toBe(false)
    expect(ftpSourceInputSchema.safeParse({ ...ftp, hostKey }).success).toBe(false)
    expect(ftpSourceInputSchema.safeParse({ ...ftp, secure: true }).success).toBe(false)
  })

  it('has no default: every field is typed', () => {
    for (const field of ['host', 'port', 'username', 'password', 'rootPath', 'tls'] as const) {
      const { [field]: _omitted, ...rest } = ftp
      expect(ftpSourceInputSchema.safeParse(rest).success).toBe(false)
    }
  })

  it('never trims a password: it may begin or end with a space', () => {
    for (const password of [' secret', 'secret ', '  ', '\tsecret', 'пароль', 'a'.repeat(1024)])
      expect(ftpSourceInputSchema.parse({ ...ftp, password }).password).toBe(password)
  })

  it.each(['', 'sec\u0000ret', 'secret\n', 'sec\rret', 'a'.repeat(1025)])(
    'refuses the password %j',
    (password) => {
      expect(ftpSourceInputSchema.safeParse({ ...ftp, password }).success).toBe(false)
    },
  )

  it.each(['', 'u\u0000', 'user\nname', 'user\u007f', 'a'.repeat(129)])(
    'refuses the user name %j',
    (username) => {
      expect(ftpSourceInputSchema.safeParse({ ...ftp, username }).success).toBe(false)
    },
  )

  it.each([
    '/',
    '/www',
    'www/site',
    'public_html',
    '/www/site..old',
    '/www/.hidden',
    '/папка/сайт',
  ])('accepts the folder %j', (rootPath) => {
    expect(ftpSourceInputSchema.parse({ ...ftp, rootPath }).rootPath).toBe(rootPath)
  })

  it.each([
    '',
    '..',
    '../www',
    '/www/../etc',
    '/www/..',
    'www\\site',
    '/www\nsite',
    'a'.repeat(1025),
  ])('refuses the folder %j', (rootPath) => {
    expect(ftpSourceInputSchema.safeParse({ ...ftp, rootPath }).success).toBe(false)
  })

  it.each([0, -1, 65_536, 21.5, Number.NaN, '21', null])('refuses the port %j', (port) => {
    expect(ftpSourceInputSchema.safeParse({ ...ftp, port }).success).toBe(false)
  })

  it('refuses a host with a scheme, a port or a path, and an unknown protection mode', () => {
    for (const host of ['ftp://ftp.example.ru', 'ftp.example.ru:21', 'ftp.example.ru/www'])
      expect(ftpSourceInputSchema.safeParse({ ...ftp, host }).success).toBe(false)
    for (const tls of ['implicit', 'none', '', true])
      expect(ftpSourceInputSchema.safeParse({ ...ftp, tls }).success).toBe(false)
  })
})

describe('sftpSourceInputSchema', () => {
  it('accepts a password or a private key, with the host key of an earlier check or without', () => {
    expect(sftpSourceInputSchema.parse(sftp)).toEqual(sftp)
    expect(sftpSourceInputSchema.parse({ ...sftp, hostKey })).toEqual({ ...sftp, hostKey })
    const key = { ...sftp, auth: { method: 'key', privateKey } }
    expect(sftpSourceInputSchema.parse(key)).toEqual(key)
    const protectedKey = { ...sftp, auth: { method: 'key', privateKey, passphrase: ' фраза ' } }
    expect(sftpSourceInputSchema.parse(protectedKey)).toEqual(protectedKey)
  })

  it('refuses unknown fields, also inside the authentication', () => {
    expect(sftpSourceInputSchema.safeParse({ ...sftp, tls: 'verified' }).success).toBe(false)
    for (const auth of [
      { method: 'password', password: 'secret', privateKey },
      { method: 'password', password: 'secret', passphrase: 'x' },
      { method: 'key', privateKey, password: 'secret' },
      { method: 'key' },
      { method: 'password' },
      { method: 'agent' },
      { method: 'keyboard-interactive', password: 'secret' },
      { password: 'secret' },
    ])
      expect(sftpSourceInputSchema.safeParse({ ...sftp, auth }).success).toBe(false)
  })

  it('takes a private key as ASCII text only', () => {
    const parse = (key: string) =>
      sftpSourceInputSchema.safeParse({ ...sftp, auth: { method: 'key', privateKey: key } }).success
    expect(parse(privateKey.replaceAll('\n', '\r\n'))).toBe(true)
    expect(parse(`Comment:\t"key"\n${privateKey}`)).toBe(true)
    expect(parse('k'.repeat(siteConnectionLimits.privateKeyChars))).toBe(true)
    expect(parse('k'.repeat(siteConnectionLimits.privateKeyChars + 1))).toBe(false)
    expect(parse('')).toBe(false)
    expect(parse(`${privateKey}ключ`)).toBe(false)
    expect(parse(`${privateKey}\u00a0`)).toBe(false)
    expect(parse(`${privateKey}\u0000`)).toBe(false)
    expect(parse(`${privateKey}\u007f`)).toBe(false)
    expect(parse(`\ufeff${privateKey}`)).toBe(false)
  })

  it('refuses a passphrase with a line break', () => {
    const auth = { method: 'key', privateKey, passphrase: 'two\nlines' }
    expect(sftpSourceInputSchema.safeParse({ ...sftp, auth }).success).toBe(false)
  })
})

describe('hostKeySchema', () => {
  it.each([
    hostKey,
    `ssh-rsa SHA256:${'a'.repeat(43)}`,
    `ecdsa-sha2-nistp256 SHA256:${'A1+/'.repeat(10)}abc`,
    `ecdsa-sha2-nistp521 SHA256:${'0'.repeat(43)}`,
  ])('accepts %s', (value) => {
    expect(hostKeySchema.parse(value)).toBe(value)
  })

  it.each([
    // 44 characters: the digest with its padding, or one character too many.
    `ssh-ed25519 SHA256:${'A'.repeat(43)}=`,
    `ssh-ed25519 SHA256:${'A'.repeat(44)}`,
    `ssh-ed25519 SHA256:${'A'.repeat(42)}`,
    // A signature algorithm is not a key type.
    `rsa-sha2-512 SHA256:${'A'.repeat(43)}`,
    `rsa-sha2-256 SHA256:${'A'.repeat(43)}`,
    `ssh-ed25519 sha256:${'A'.repeat(43)}`,
    `ssh-ed25519 MD5:${'A'.repeat(43)}`,
    `ssh-ed25519  SHA256:${'A'.repeat(43)}`,
    `SSH-ED25519 SHA256:${'A'.repeat(43)}`,
    `ssh- SHA256:${'A'.repeat(43)}`,
    `ssh-ed25519 SHA256:${'A'.repeat(42)}_`,
    `ssh-ed25519 SHA256:${'A'.repeat(43)}\n`,
    ` ssh-ed25519 SHA256:${'A'.repeat(43)}`,
    'A'.repeat(43),
    '',
  ])('refuses %j', (value) => {
    expect(hostKeySchema.safeParse(value).success).toBe(false)
  })

  it('is never longer than the column that stores it', () => {
    const digest = ` SHA256:${'A'.repeat(43)}`
    expect(hostKeySchema.safeParse(`ssh-${'a'.repeat(124 - digest.length)}${digest}`).success).toBe(
      true,
    )
    expect(hostKeySchema.safeParse(`ssh-${'a'.repeat(125 - digest.length)}${digest}`).success).toBe(
      false,
    )
  })
})

describe('gitRepositoryUrlSchema', () => {
  it.each([
    ['https://github.com/owner/site.git', 'https://github.com/owner/site.git'],
    ['https://github.com/owner/site', 'https://github.com/owner/site'],
    ['  https://github.com/owner/site/  ', 'https://github.com/owner/site'],
    ['https://github.com/owner/site//', 'https://github.com/owner/site'],
    ['HTTPS://GitHub.com:443/owner/site', 'https://github.com/owner/site'],
    [
      'https://gitlab.example.ru:8443/group/sub/site.git',
      'https://gitlab.example.ru:8443/group/sub/site.git',
    ],
    ['https://github.com./owner/site', 'https://github.com/owner/site'],
    [
      'https://пример.рф/owner/сайт.git',
      'https://xn--e1afmkfd.xn--p1ai/owner/%D1%81%D0%B0%D0%B9%D1%82.git',
    ],
    ['https://192.168.1.10/owner/site.git', 'https://192.168.1.10/owner/site.git'],
    ['https://[::1]:3000/owner/site.git', 'https://[::1]:3000/owner/site.git'],
    ['https://github.com/owner/../other/site', 'https://github.com/other/site'],
  ])('stores %j as %s', (text, url) => {
    expect(gitRepositoryUrlSchema.parse(text)).toBe(url)
  })

  it.each([
    '',
    'github.com/owner/site',
    'http://github.com/owner/site.git',
    'git://github.com/owner/site.git',
    'ssh://git@github.com/owner/site.git',
    'git@github.com:owner/site.git',
    'file:///srv/git/site.git',
    // Userinfo: a token belongs to its own field, never to an address that is stored and shown.
    'https://user@github.com/owner/site.git',
    'https://user:token@github.com/owner/site.git',
    'https://@github.com/owner/site.git',
    'https://github.com/owner/site.git?ref=main',
    'https://github.com/owner/site.git?',
    'https://github.com/owner/site.git#main',
    'https://github.com/owner/site.git#',
    // The address of a server, not of a repository.
    'https://github.com',
    'https://github.com/',
    'https://github.com//',
    'https://github.com/..',
    // Forms that URL would quietly repair.
    'https:github.com/owner/site',
    'https:/github.com/owner/site',
    'https:///github.com/owner/site',
    'https://github.com\\owner\\site',
    'https://github.com/owner\\site',
    'https://github.com/owner/my site',
    'https://github.com/owner/si\tte',
    'https://github.com/owner/si\u0000te',
    'https://./owner/site',
    'https:///owner/site',
    // More than the one dot of a root name: what is left is not a host.
    'https://github.com../owner/site',
    'https://github.com...:8443/owner/site',
    // Port 0 is no port: a client would dial its default instead.
    'https://github.com:0/owner/site',
    'https://127.0.0.1:00/owner/site',
    'https://github.com:65536/owner/site',
  ])('refuses %j', (text) => {
    expect(gitRepositoryUrlSchema.safeParse(text).success).toBe(false)
  })

  it('keeps a port only when it is one a connection can be made to', () => {
    for (const [text, port] of [
      ['https://github.com/owner/site', ''],
      ['https://github.com:443/owner/site', ''],
      ['https://github.com:000443/owner/site', ''],
      ['https://github.com:1/owner/site', '1'],
      ['https://github.com:65535/owner/site', '65535'],
    ] as const)
      expect(new URL(gitRepositoryUrlSchema.parse(text)).port).toBe(port)
  })

  it('accepts at most 1020 characters, as typed and as stored', () => {
    const limit = siteConnectionLimits.gitUrlChars
    expect(limit).toBe(1020)
    const prefix = 'https://github.com/owner/'
    const longest = `${prefix}${'a'.repeat(limit - prefix.length)}`
    expect(gitRepositoryUrlSchema.parse(longest)).toBe(longest)
    expect(gitRepositoryUrlSchema.safeParse(`${longest}a`).success).toBe(false)
    // Short as typed, too long once the Cyrillic path is percent-encoded: the column is VARCHAR(1024).
    const cyrillic = `${prefix}${'я'.repeat(200)}`
    expect(cyrillic.length).toBeLessThan(limit)
    expect(gitRepositoryUrlSchema.safeParse(cyrillic).success).toBe(false)
    expect(gitRepositoryUrlSchema.parse(`${prefix}${'я'.repeat(100)}`)).toHaveLength(
      prefix.length + 600,
    )
  })
})

describe('gitSourceInputSchema', () => {
  it('fills in the user name most services accept next to a token', () => {
    expect(gitSourceInputSchema.parse(git)).toEqual({ ...git, username: 'x-access-token' })
    expect(gitSourceInputSchema.parse({ ...git, username: 'oauth2', branch: 'main' })).toEqual({
      ...git,
      username: 'oauth2',
      branch: 'main',
    })
  })

  it.each(['user:name', ':', 'user name', 'user\tname', '', 'a'.repeat(129), 'user\u0000'])(
    'refuses the user name %j: a colon would break Basic authentication',
    (username) => {
      expect(gitSourceInputSchema.safeParse({ ...git, username }).success).toBe(false)
    },
  )

  it('never trims a token and refuses a line break in it', () => {
    expect(gitSourceInputSchema.parse({ ...git, token: ' token ' }).token).toBe(' token ')
    expect(gitSourceInputSchema.safeParse({ ...git, token: 'to\nken' }).success).toBe(false)
    expect(gitSourceInputSchema.safeParse({ ...git, token: '' }).success).toBe(false)
  })

  it('refuses unknown fields and an address that is not https', () => {
    expect(gitSourceInputSchema.safeParse({ ...git, password: 'x' }).success).toBe(false)
    expect(gitSourceInputSchema.safeParse({ ...git, host: 'github.com' }).success).toBe(false)
    expect(
      gitSourceInputSchema.safeParse({ ...git, url: 'http://github.com/owner/site.git' }).success,
    ).toBe(false)
  })
})

describe('gitBranchSchema', () => {
  it.each(['main', 'master', 'release/2026.10', 'feature/site_1-b', '1.x', 'a'.repeat(200)])(
    'accepts %s',
    (branch) => {
      expect(gitBranchSchema.parse(branch)).toBe(branch)
    },
  )

  it.each([
    '',
    '-main',
    '--upload-pack=touch',
    '-',
    '/main',
    '.hidden',
    'ma in',
    'main\n',
    'main:refs/heads/x',
    'main~1',
    'main^',
    'ma*n',
    '+main',
    'ветка',
    'a'.repeat(201),
  ])('refuses %j', (branch) => {
    expect(gitBranchSchema.safeParse(branch).success).toBe(false)
    expect(gitSourceInputSchema.safeParse({ ...git, branch }).success).toBe(false)
  })
})

describe('codeSourceInputSchema', () => {
  it('reads each kind by its own shape', () => {
    expect(codeSourceInputSchema.parse(ftp)).toEqual(ftp)
    expect(codeSourceInputSchema.parse(sftp)).toEqual(sftp)
    const parsed = codeSourceInputSchema.parse(git)
    expect(parsed.kind).toBe('git')
    // The type narrows by `kind`: no cast is needed to reach the fields of one source.
    if (parsed.kind === 'git') expect(parsed.username).toBe('x-access-token')
  })

  it('refuses an unknown kind and the fields of one kind under another', () => {
    for (const kind of ['ssh', 'ftps', 'rsync', 'local', '', undefined])
      expect(codeSourceInputSchema.safeParse({ ...ftp, kind }).success).toBe(false)
    expect(codeSourceInputSchema.safeParse({ ...ftp, kind: 'sftp' }).success).toBe(false)
    expect(codeSourceInputSchema.safeParse({ ...sftp, kind: 'ftp' }).success).toBe(false)
    expect(codeSourceInputSchema.safeParse({ ...git, kind: 'ftp' }).success).toBe(false)
    expect(codeSourceInputSchema.safeParse({ ...git, rootPath: '/www' }).success).toBe(false)
  })
})

describe('databaseInputSchema', () => {
  it('accepts both engines and stores the host normalised', () => {
    expect(databaseInputSchema.parse({ ...database, host: 'DB.Example.ru' })).toEqual(database)
    const postgres = { ...database, engine: 'postgres', port: 5432, tls: 'plain' }
    expect(databaseInputSchema.parse(postgres)).toEqual(postgres)
  })

  it('refuses unknown fields, an unknown engine and a host that is not bare', () => {
    expect(databaseInputSchema.safeParse({ ...database, ssl: true }).success).toBe(false)
    expect(
      databaseInputSchema.safeParse({ ...database, socketPath: '/tmp/mysql.sock' }).success,
    ).toBe(false)
    for (const engine of ['mariadb', 'postgresql', 'sqlite', 'mssql', ''])
      expect(databaseInputSchema.safeParse({ ...database, engine }).success).toBe(false)
    for (const host of ['mysql://db.example.ru', 'db.example.ru:3306', 'db.example.ru/wp'])
      expect(databaseInputSchema.safeParse({ ...database, host }).success).toBe(false)
  })

  it('bounds the database name and never trims the password', () => {
    expect(
      databaseInputSchema.parse({ ...database, database: 'a'.repeat(64) }).database,
    ).toHaveLength(64)
    for (const name of ['', 'a'.repeat(65), 'wp\u0000', 'wp\nx'])
      expect(databaseInputSchema.safeParse({ ...database, database: name }).success).toBe(false)
    expect(databaseInputSchema.parse({ ...database, password: ' p ' }).password).toBe(' p ')
    expect(databaseInputSchema.safeParse({ ...database, password: 'p\r\n' }).success).toBe(false)
  })
})
