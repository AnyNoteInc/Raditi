import { describe, expect, it } from 'vitest'

import { epsvPort, pasvPort, rawFromTyped } from '../sources/ftp.ts'
import { modeOf } from './ftp-writer.ts'
import { ftpHostingWriter, hostingWriterOf, sftpHostingWriter } from './index.ts'

describe('the FTP(S) writer of a release', () => {
  it('takes only the port of a passive reply: the address is always the pinned one', () => {
    expect(epsvPort('229 Entering Extended Passive Mode (|||40123|)')).toBe(40123)
    expect(epsvPort('229 Extended Passive (!!!21!)')).toBe(21)
    expect(epsvPort('229 Entering Extended Passive Mode (|||70000|)')).toBeNull()
    expect(epsvPort('229 Entering Extended Passive Mode')).toBeNull()
    // The four numbers of the address are read past; 10.0.0.1 is never dialled.
    expect(pasvPort('227 Entering Passive Mode (10,0,0,1,156,123)')).toBe(156 * 256 + 123)
    expect(pasvPort('227 Entering Passive Mode (10,0,0,1,0,0)')).toBeNull()
    expect(pasvPort('227 Entering Passive Mode (10,0,0,1,300,1)')).toBeNull()
    expect(pasvPort('227 nothing')).toBeNull()
  })

  it('reads the permission bits a listing gives, and says when it gives none', () => {
    expect(modeOf({ permissions: { user: 6, group: 4, world: 0 } })).toBe(0o640)
    expect(modeOf({ permissions: { user: 7, group: 5, world: 5 } })).toBe(0o755)
    // A replaced file keeps a narrow mode: it is never widened to 0644 for want of knowing.
    expect(modeOf({ permissions: { user: 6, group: 0, world: 0 } })).toBe(0o600)
    expect(modeOf({ permissions: { user: 9, group: -1, world: 1.5 } })).toBe(0)
    expect(modeOf({})).toBeNull()
  })

  it('writes a name as the bytes of its UTF-8 on a latin1 control connection', () => {
    const raw = rawFromTyped('функции.php')
    expect(Buffer.from(raw, 'latin1').toString('utf8')).toBe('функции.php')
    expect(rawFromTyped('style.css')).toBe('style.css')
  })
})

describe('the writers by deploy method', () => {
  it('writes over SFTP and FTP, and over nothing else', () => {
    expect(hostingWriterOf('sftp')).toBe(sftpHostingWriter)
    expect(hostingWriterOf('ftp')).toBe(ftpHostingWriter)
    for (const method of ['rsync', 'git_ftp', 'docker'] as const)
      expect(hostingWriterOf(method)).toBeNull()
  })

  it('reads the host and the port of the access only from the access', () => {
    expect(
      sftpHostingWriter.endpointOf({
        v: '1',
        host: 'ssh.example.ru',
        port: '2222',
        hostKey: `ssh-ed25519 SHA256:${'A'.repeat(43)}`,
        rootPath: '/var/www',
        username: 'u',
        auth: 'password',
        password: 'password-long',
      }),
    ).toEqual({ host: 'ssh.example.ru', port: 2222 })
    expect(
      ftpHostingWriter.endpointOf({
        v: '1',
        host: 'ftp.example.ru',
        port: '21',
        tls: 'verified',
        rootPath: '/public_html',
        username: 'u',
        password: 'password-long',
      }),
    ).toEqual({ host: 'ftp.example.ru', port: 21 })
  })
})
