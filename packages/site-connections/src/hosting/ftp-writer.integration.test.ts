import { execFile } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  isHostingGuardError,
  isSiteConnectionError,
  resolvePinnedAddress,
  temporaryNameOf,
  type FtpAccess,
  type HostingSession,
} from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestCertificates, type TestCertificates } from '../testing/certificates.ts'
import { createFtpHostingWriter } from './ftp-writer.ts'

// The FTP(S) writer of a release against real servers: vsftpd 3.0.5 (plain and AUTH TLS with
// `require_ssl_reuse`, no MLSD — LIST is read) and ProFTPD 1.3.9 with `AllowOverwrite off` (MLSD;
// RNTO over an existing file refused). The image is built once from alpine:3.22 with both pinned
// packages (it needs the network the first time). Runs with RADITI_HOSTING_DOCKER_TESTS=1.

const enabled = process.env.RADITI_HOSTING_DOCKER_TESTS === '1'
const run = promisify(execFile)
const IMAGE = 'raditi-test-ftp:alpine3.22-vsftpd3.0.5-proftpd1.3.9b'
/** The base image the pipeline stand pins too (infra/dev/pipeline-verify/stand.mjs). */
const DOCKERFILE = [
  'FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce',
  'RUN apk add --no-cache vsftpd=3.0.5-r2 proftpd=1.3.9b-r0',
  '',
].join('\n')
const ROOT = '/home/site/www'

const suffix = randomBytes(4).toString('hex')
const password = randomBytes(18).toString('base64url')
/** Ten passive ports per server, the same numbers inside and outside the container. */
const base = 40_000 + randomInt(0, 900) * 10
const servers = {
  vsftpd: { container: `raditi-r8c-vsftpd-${suffix}`, passive: base, port: 0 },
  proftpd: { container: `raditi-r8c-proftpd-${suffix}`, passive: base + 10_000, port: 0 },
}
let certificates: TestCertificates | null = null

const docker = async (...args: string[]) => (await run('docker', args)).stdout

const setup = (server: string) => `set -e
adduser -D -h /home/site site
echo "site:$FTP_PASSWORD" | chpasswd
mkdir -p ${ROOT} && chown site:site ${ROOT}
install -o root -m 600 /setup/${server}.conf /etc/raditi-${server}.conf
${
  server === 'vsftpd'
    ? `install -o root -m 600 /setup/key.pem /etc/raditi-key.pem
install -o root -m 644 /setup/cert.pem /etc/raditi-cert.pem
exec vsftpd /etc/raditi-vsftpd.conf`
    : `mkdir -p /run/proftpd
exec proftpd --nodaemon -c /etc/raditi-proftpd.conf`
}
`

const vsftpdConf = (passive: number) => `listen=YES
listen_ipv6=NO
background=NO
seccomp_sandbox=NO
anonymous_enable=NO
local_enable=YES
write_enable=YES
local_umask=022
chmod_enable=YES
pasv_enable=YES
pasv_min_port=${passive}
pasv_max_port=${passive + 9}
pasv_address=10.255.255.1
ssl_enable=YES
allow_anon_ssl=NO
force_local_logins_ssl=NO
force_local_data_ssl=NO
require_ssl_reuse=YES
ssl_ciphers=HIGH
rsa_cert_file=/etc/raditi-cert.pem
rsa_private_key_file=/etc/raditi-key.pem
`

const proftpdConf = (passive: number) => `ServerName "raditi-test"
ServerType standalone
DefaultServer on
Port 21
UseIPv6 off
Umask 022
User nobody
Group nobody
PassivePorts ${passive} ${passive + 9}
MasqueradeAddress 10.255.255.1
RequireValidShell off
UseReverseDNS off
WtmpLog off
AllowOverwrite off
<Directory ${ROOT}>
  AllowOverwrite off
</Directory>
`

async function startServer(name: keyof typeof servers): Promise<void> {
  const server = servers[name]
  const directory = await mkdtemp(join(tmpdir(), 'raditi-ftp-'))
  try {
    await writeFile(join(directory, 'setup.sh'), setup(name))
    await writeFile(
      join(directory, `${name}.conf`),
      name === 'vsftpd' ? vsftpdConf(server.passive) : proftpdConf(server.passive),
    )
    if (name === 'vsftpd') {
      await writeFile(join(directory, 'cert.pem'), certificates!.both.cert)
      await writeFile(join(directory, 'key.pem'), certificates!.both.key)
    }
    const range = `${server.passive}-${server.passive + 9}`
    await docker(
      // An init as PID 1: vsftpd, made PID 1 itself, dies reaping the processes of a session.
      ...['create', '--init', '--name', server.container, '--pull', 'never'],
      ...['--publish', '127.0.0.1::21', '--publish', `127.0.0.1:${range}:${range}`],
      ...['--env', `FTP_PASSWORD=${password}`],
      IMAGE,
      ...['sh', '/setup/setup.sh'],
    )
    await docker('cp', `${directory}/.`, `${server.container}:/setup`)
    await docker('start', server.container)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  const { stdout } = await run('docker', ['port', server.container, '21/tcp'])
  server.port = Number(/:(\d+)\s*$/m.exec(stdout)?.[1])
}

const exec = async (name: keyof typeof servers, ...command: string[]) =>
  (await run('docker', ['exec', servers[name].container, ...command])).stdout

function writer() {
  return createFtpHostingWriter({
    idleMs: 10_000,
    loginTimeoutMs: 10_000,
    ...(certificates ? { trustedCa: certificates.ca } : {}),
  })
}

async function open(
  name: keyof typeof servers,
  overrides: Partial<FtpAccess> = {},
): Promise<HostingSession> {
  const signal = AbortSignal.timeout(60_000)
  const pinned = await resolvePinnedAddress(
    { lookup: async () => [], appEnv: 'development' },
    '127.0.0.1',
    signal,
  )
  if (!pinned.ok) throw new Error('loopback refused')
  return writer().open(
    {
      v: '1',
      host: '127.0.0.1',
      port: String(servers[name].port),
      tls: 'plain',
      rootPath: ROOT,
      username: 'site',
      password,
      ...overrides,
    },
    { address: pinned.address, signal },
  )
}

const failure = async (work: Promise<unknown>) => {
  try {
    await work
  } catch (error) {
    if (isHostingGuardError(error)) return `guard:${error.guard}`
    if (isSiteConnectionError(error)) return `connection:${error.reason}`
    throw error
  }
  return 'none'
}

const text = async (session: HostingSession, path: string[]) =>
  Buffer.from(await session.read(path, 1024 * 1024)).toString('utf8')

beforeAll(async () => {
  if (!enabled) return
  certificates = await createTestCertificates()
  if (!certificates) throw new Error('openssl is needed for the certificates of the FTPS server')
  const known = await run('docker', ['image', 'inspect', IMAGE]).then(
    () => true,
    () => false,
  )
  if (!known)
    await new Promise<void>((resolve, reject) => {
      const child = execFile('docker', ['build', '-q', '-t', IMAGE, '-'], (error) =>
        error ? reject(error) : resolve(),
      )
      child.stdin?.end(DOCKERFILE)
    })
  await Promise.all([startServer('vsftpd'), startServer('proftpd')])
  for (const name of ['vsftpd', 'proftpd'] as const)
    for (let attempt = 0; ; attempt += 1) {
      try {
        await (await open(name)).close()
        break
      } catch (error) {
        if (attempt > 60) throw error
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
}, 300_000)

afterAll(async () => {
  if (!enabled) return
  for (const { container } of Object.values(servers))
    await run('docker', ['rm', '--force', container]).catch(() => {})
})

describe.skipIf(!enabled)('the FTP(S) writer of a release against vsftpd and ProFTPD', () => {
  it('writes under a temporary name, replaces in one rename, keeps modes, leaves no temporary', async () => {
    for (const [name, tls] of [
      ['vsftpd', 'plain'],
      ['vsftpd', 'verified'],
      ['proftpd', 'plain'],
    ] as const) {
      const session = await open(name, { tls })
      try {
        const folder = [`theme-${tls}`]
        expect(await session.stat([...folder, 'style.css'])).toBeNull()
        await session.mkdirp([...folder, 'parts'])
        await session.writeAtomic([...folder, 'style.css'], Buffer.from('body{}\n'), {
          replace: false,
          mode: 0o644,
        })
        expect(await session.stat([...folder, 'style.css'])).toEqual({
          type: 'file',
          size: 7,
          mode: 0o644,
        })
        // ProFTPD refuses RNTO over the file (AllowOverwrite off): DELE, then RNTO.
        await session.writeAtomic([...folder, 'style.css'], Buffer.from('body{color:red}\n'), {
          replace: true,
          mode: 0o640,
        })
        expect(await text(session, [...folder, 'style.css'])).toBe('body{color:red}\n')
        expect((await session.stat([...folder, 'style.css']))?.mode).toBe(0o640)
        // An addition never overwrites.
        expect(
          await failure(
            session.writeAtomic([...folder, 'style.css'], Buffer.from('x'), {
              replace: false,
              mode: 0o644,
            }),
          ),
        ).toBe('guard:exists')
        expect(await text(session, [...folder, 'style.css'])).toBe('body{color:red}\n')
      } finally {
        await session.close()
      }
      const listing = await exec(name, 'ls', '-a', `${ROOT}/theme-${tls}`)
      expect(listing.split('\n').filter((entry) => entry.startsWith('.raditi-'))).toEqual([])
      expect((await exec(name, 'stat', '-c', '%a', `${ROOT}/theme-${tls}/style.css`)).trim()).toBe(
        '640',
      )
    }
  }, 120_000)

  it('verifies the certificate of an FTPS server, and reuses the TLS session for data', async () => {
    // vsftpd `require_ssl_reuse`: a data connection with a fresh TLS session is refused.
    const session = await open('vsftpd', { tls: 'verified' })
    try {
      await session.writeAtomic(['tls.txt'], Buffer.from('over TLS\n'), {
        replace: false,
        mode: 0o644,
      })
      expect(await text(session, ['tls.txt'])).toBe('over TLS\n')
    } finally {
      await session.close()
    }
    // A server whose certificate the trusted CA did not sign is refused at the login.
    const strict = createFtpHostingWriter({ idleMs: 10_000, loginTimeoutMs: 10_000 })
    const signal = AbortSignal.timeout(30_000)
    const pinned = await resolvePinnedAddress(
      { lookup: async () => [], appEnv: 'development' },
      '127.0.0.1',
      signal,
    )
    if (!pinned.ok) throw new Error('loopback refused')
    expect(
      await failure(
        strict.open(
          {
            v: '1',
            host: '127.0.0.1',
            port: String(servers.vsftpd.port),
            tls: 'verified',
            rootPath: ROOT,
            username: 'site',
            password,
          },
          { address: pinned.address, signal },
        ),
      ),
    ).toMatch(/^connection:/)
  }, 60_000)

  it('carries large files and names in UTF-8, and bounds a read', async () => {
    for (const name of ['vsftpd', 'proftpd'] as const) {
      const session = await open(name)
      try {
        const bytes = randomBytes(1024 * 1024 + 17)
        await session.writeAtomic(['big.bin'], bytes, { replace: false, mode: 0o644 })
        expect(Buffer.from(await session.read(['big.bin'], bytes.byteLength)).equals(bytes)).toBe(
          true,
        )
        expect(await failure(session.read(['big.bin'], bytes.byteLength - 1))).toBe('guard:bytes')
        await session.mkdirp(['папка'])
        await session.writeAtomic(['папка', 'функции.php'], Buffer.from('<?php\n'), {
          replace: false,
          mode: 0o755,
        })
        expect(await session.stat(['папка', 'функции.php'])).toMatchObject({
          type: 'file',
          mode: 0o755,
        })
        await session.remove(['папка', 'функции.php'])
        expect(await session.stat(['папка', 'функции.php'])).toBeNull()
        await session.remove(['папка', 'функции.php'])
        await session.removeEmptyDirectory(['папка'])
        expect(await session.stat(['папка'])).toBeNull()
        await session.remove(['big.bin'])
      } finally {
        await session.close()
      }
      // A closed session answers at once.
      expect(await failure(session.stat(['big.bin']))).toBe('connection:transfer_failed')
    }
  }, 120_000)

  it('removes a folder only when it is empty, and never through a link', async () => {
    await exec('vsftpd', 'sh', '-c', `ln -sfn /etc ${ROOT}/etc-link`)
    const session = await open('vsftpd')
    try {
      await session.mkdirp(['made', 'below'])
      await session.writeAtomic(['made', 'below', 'x.txt'], Buffer.from('x'), {
        replace: false,
        mode: 0o644,
      })
      expect(await failure(session.removeEmptyDirectory(['made', 'below']))).toBe('guard:not_empty')
      await session.remove(['made', 'below', 'x.txt'])
      await session.removeEmptyDirectory(['made', 'below'])
      await session.removeEmptyDirectory(['made'])
      expect(await session.stat(['made'])).toBeNull()
      // Absent: nothing to do.
      await session.removeEmptyDirectory(['made'])

      expect(await session.stat(['etc-link'])).toMatchObject({ type: 'link' })
      expect(await failure(session.removeEmptyDirectory(['etc-link']))).toBe(
        'guard:not_a_directory',
      )
      expect(
        await failure(
          session.writeAtomic(['etc-link', 'raditi.txt'], Buffer.from('x'), {
            replace: false,
            mode: 0o644,
          }),
        ),
      ).toBe('guard:not_a_directory')
      expect(await failure(session.read(['etc-link', 'passwd'], 1024))).toBe(
        'guard:not_a_directory',
      )
    } finally {
      await session.close()
    }
    expect(
      (await exec('vsftpd', 'sh', '-c', 'test -e /etc/raditi.txt && echo yes || echo no')).trim(),
    ).toBe('no')
  }, 60_000)

  it('clears a temporary of the same key that a broken connection left', async () => {
    const key = 'ab'.repeat(16)
    for (const name of ['vsftpd', 'proftpd'] as const) {
      await exec(
        name,
        'sh',
        '-c',
        `printf half > ${ROOT}/${temporaryNameOf(key)} && chown site:site ${ROOT}/${temporaryNameOf(key)}`,
      )
      const session = await open(name)
      try {
        await session.writeAtomic(['keyed.txt'], Buffer.from('whole\n'), {
          replace: false,
          mode: 0o644,
          temporaryKey: key,
        })
        expect(await text(session, ['keyed.txt'])).toBe('whole\n')
        expect(await session.stat([temporaryNameOf(key)])).toBeNull()
        await session.remove(['keyed.txt'])
      } finally {
        await session.close()
      }
    }
  }, 60_000)

  it('runs the calls of one session one after another on its control connection', async () => {
    const session = await open('proftpd')
    try {
      await session.mkdirp(['parallel'])
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          session.writeAtomic(['parallel', `${index}.txt`], Buffer.from(`${index}\n`), {
            replace: false,
            mode: 0o644,
          }),
        ),
      )
      const read = await Promise.all(
        Array.from({ length: 8 }, (_, index) => text(session, ['parallel', `${index}.txt`])),
      )
      expect(read).toEqual(Array.from({ length: 8 }, (_, index) => `${index}\n`))
    } finally {
      await session.close()
    }
  }, 60_000)
})
