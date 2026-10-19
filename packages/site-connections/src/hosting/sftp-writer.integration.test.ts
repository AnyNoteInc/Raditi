import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

import {
  isHostingGuardError,
  isSiteConnectionError,
  resolvePinnedAddress,
  temporaryNameOf,
  type HostingSession,
  type SshAccess,
} from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSftpHostingWriter } from './sftp-writer.ts'
import { sshKeyFingerprint } from '../sources/host-key.ts'

// The SFTP writer of a release against a real OpenSSH server (linuxserver/openssh-server,
// internal-sftp, already pulled; nothing is pulled here). Runs with RADITI_HOSTING_DOCKER_TESTS=1.

const enabled = process.env.RADITI_HOSTING_DOCKER_TESTS === '1'
const run = promisify(execFile)
const SFTP_TEST_IMAGE =
  'linuxserver/openssh-server@sha256:96b9a4d3b5106746d08d43a6911650d4d21f7d5c7f2ac9660e792bdb5e63157c'
const ROOT = '/config/www'

const container = `raditi-r8c-sftp-${randomBytes(4).toString('hex')}`
const password = randomBytes(18).toString('base64url')
let port = 0
let hostKey = ''

const exec = async (...command: string[]) =>
  (await run('docker', ['exec', container, ...command])).stdout
const writer = createSftpHostingWriter({ idleMs: 10_000, readyTimeoutMs: 10_000 })

function access(overrides: Partial<SshAccess> = {}): SshAccess {
  return {
    v: '1',
    host: '127.0.0.1',
    port: String(port),
    hostKey,
    rootPath: ROOT,
    username: 'site',
    auth: 'password',
    password,
    ...overrides,
  } as SshAccess
}

async function open(overrides: Partial<SshAccess> = {}): Promise<HostingSession> {
  const signal = AbortSignal.timeout(30_000)
  const pinned = await resolvePinnedAddress(
    { lookup: async () => [], appEnv: 'development' },
    '127.0.0.1',
    signal,
  )
  if (!pinned.ok) throw new Error('loopback refused')
  return writer.open(access(overrides), { address: pinned.address, signal })
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

beforeAll(async () => {
  if (!enabled) return
  await run('docker', [
    'run',
    '--detach',
    '--rm',
    '--pull',
    'never',
    '--name',
    container,
    '--publish',
    '127.0.0.1::2222',
    '--env',
    'PUID=1000',
    '--env',
    'PGID=1000',
    '--env',
    'USER_NAME=site',
    '--env',
    'PASSWORD_ACCESS=true',
    '--env',
    `USER_PASSWORD=${password}`,
    SFTP_TEST_IMAGE,
  ])
  const { stdout } = await run('docker', ['port', container, '2222/tcp'])
  port = Number(/:(\d+)\s*$/m.exec(stdout)?.[1])
  for (let attempt = 0; ; attempt += 1) {
    try {
      const line = await exec('cat', '/config/ssh_host_keys/ssh_host_ed25519_key.pub')
      const blob = Buffer.from(line.trim().split(/\s+/)[1] ?? '', 'base64')
      hostKey = sshKeyFingerprint(blob) ?? ''
      await exec('sh', '-c', `mkdir -p ${ROOT} && chown 1000:1000 ${ROOT}`)
      const session = await open()
      await session.close()
      return
    } catch (error) {
      if (attempt > 120) throw error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}, 120_000)

afterAll(async () => {
  if (enabled) await run('docker', ['rm', '--force', container]).catch(() => {})
})

describe.skipIf(!enabled)('the SFTP writer of a release against OpenSSH', () => {
  it('accepts exactly the host key of the access and the password of it', async () => {
    expect(hostKey).toMatch(/^ssh-ed25519 SHA256:/)
    expect(await failure(open({ hostKey: `ssh-ed25519 SHA256:${'A'.repeat(43)}` }))).toBe(
      'connection:host_key_changed',
    )
    expect(await failure(open({ password: 'not-the-password' }))).toBe('connection:auth_failed')
    expect(await failure(open({ rootPath: '/config/absent' }))).toBe('connection:not_found')
  })

  it('writes a file under a temporary name, replaces it in one rename, and leaves no temporary', async () => {
    const session = await open()
    try {
      expect(await session.stat(['theme', 'style.css'])).toBeNull()
      await session.mkdirp(['theme', 'parts'])
      await session.writeAtomic(['theme', 'style.css'], Buffer.from('body{}\n'), {
        replace: false,
        mode: 0o644,
      })
      expect(await session.stat(['theme', 'style.css'])).toEqual({
        type: 'file',
        size: 7,
        mode: 0o644,
      })
      await session.writeAtomic(['theme', 'style.css'], Buffer.from('body{color:red}\n'), {
        replace: true,
        mode: 0o640,
      })
      expect(Buffer.from(await session.read(['theme', 'style.css'], 1024)).toString()).toBe(
        'body{color:red}\n',
      )
      expect((await session.stat(['theme', 'style.css']))?.mode).toBe(0o640)
      // An addition never overwrites.
      expect(
        await failure(
          session.writeAtomic(['theme', 'style.css'], Buffer.from('x'), {
            replace: false,
            mode: 0o644,
          }),
        ),
      ).toBe('guard:exists')
      expect(Buffer.from(await session.read(['theme', 'style.css'], 1024)).toString()).toBe(
        'body{color:red}\n',
      )
      const listing = await exec('ls', '-a', `${ROOT}/theme`)
      expect(listing.split('\n').filter((name) => name.startsWith('.raditi-'))).toEqual([])
      expect((await exec('stat', '-c', '%u %a', `${ROOT}/theme/style.css`)).trim()).toBe('1000 640')
    } finally {
      await session.close()
    }
  })

  it('carries large files, names in UTF-8 and executable modes', async () => {
    const session = await open()
    try {
      const bytes = randomBytes(1024 * 1024 + 17)
      await session.writeAtomic(['big.bin'], bytes, { replace: false, mode: 0o644 })
      expect(Buffer.from(await session.read(['big.bin'], bytes.byteLength)).equals(bytes)).toBe(
        true,
      )
      expect(await failure(session.read(['big.bin'], bytes.byteLength - 1))).toBe('guard:bytes')
      await session.writeAtomic(['функции.php'], Buffer.from('<?php\n'), {
        replace: false,
        mode: 0o755,
      })
      expect(await session.stat(['функции.php'])).toMatchObject({ type: 'file', mode: 0o755 })
      await session.remove(['функции.php'])
      expect(await session.stat(['функции.php'])).toBeNull()
      await session.remove(['функции.php'])
    } finally {
      await session.close()
    }
    // A closed session sends nothing and answers at once: no request waits on a dead channel.
    expect(await failure(session.stat(['big.bin']))).toBe('connection:transfer_failed')
  })

  it('never goes through a link: not to read, write or remove', async () => {
    await exec(
      'sh',
      '-c',
      `ln -sfn /etc ${ROOT}/etc-link && ln -sf /etc/passwd ${ROOT}/passwd-link`,
    )
    const session = await open()
    try {
      expect(await session.stat(['etc-link'])).toMatchObject({ type: 'link' })
      expect(await failure(session.read(['etc-link', 'passwd'], 1024))).toBe(
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
      expect(await failure(session.mkdirp(['etc-link', 'x']))).toBe('guard:not_a_directory')
      expect(await failure(session.read(['passwd-link'], 1024))).toBe('guard:not_a_file')
      expect(await failure(session.remove(['passwd-link']))).toBe('guard:not_a_file')
      expect(
        await failure(
          session.writeAtomic(['passwd-link'], Buffer.from('x'), { replace: true, mode: 0o644 }),
        ),
      ).toBe('guard:not_a_file')
      expect(await failure(session.stat(['..', 'x']))).toBe('guard:path')
    } finally {
      await session.close()
    }
    // Nothing reached through the links.
    expect((await exec('sh', '-c', 'test -e /etc/raditi.txt && echo yes || echo no')).trim()).toBe(
      'no',
    )
    expect((await exec('sh', '-c', 'test -L /config/www/passwd-link && echo link')).trim()).toBe(
      'link',
    )
  })

  it('removes a folder only when it is empty, and never through a link', async () => {
    await exec('sh', '-c', `ln -sfn /etc ${ROOT}/etc-dir-link`)
    const session = await open()
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
      // Absent: nothing to do; a folder made again after its removal is a folder again.
      await session.removeEmptyDirectory(['made'])
      await session.mkdirp(['made'])
      expect(await session.stat(['made'])).toMatchObject({ type: 'directory' })
      await session.removeEmptyDirectory(['made'])
      expect(await failure(session.removeEmptyDirectory(['etc-dir-link']))).toBe(
        'guard:not_a_directory',
      )
      expect(await failure(session.removeEmptyDirectory(['etc-dir-link', 'ssl']))).toBe(
        'guard:not_a_directory',
      )
    } finally {
      await session.close()
    }
    expect((await exec('sh', '-c', 'test -d /etc/ssl && echo kept')).trim()).toBe('kept')
  })

  it('clears a temporary of the same key that a broken connection left', async () => {
    const key = 'cd'.repeat(16)
    await exec(
      'sh',
      '-c',
      `printf half > ${ROOT}/${temporaryNameOf(key)} && chown 1000:1000 ${ROOT}/${temporaryNameOf(key)}`,
    )
    const session = await open()
    try {
      await session.writeAtomic(['keyed.txt'], Buffer.from('whole\n'), {
        replace: false,
        mode: 0o644,
        temporaryKey: key,
      })
      expect(Buffer.from(await session.read(['keyed.txt'], 64)).toString()).toBe('whole\n')
      expect(await session.stat([temporaryNameOf(key)])).toBeNull()
    } finally {
      await session.close()
    }
  })
})
