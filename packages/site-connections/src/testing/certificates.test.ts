import { createPrivateKey, X509Certificate } from 'node:crypto'
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { type AddressInfo, isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createTestCertificates,
  type TestCertificate,
  type TestCertificates,
} from './certificates.ts'

const EXTRA_NAME = 'site.raditi.test'
// Null on a machine without openssl: the suite that needs the certificates is then skipped.
const created = await createTestCertificates({ names: [EXTRA_NAME] })

const directories: string[] = []
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'raditi-certificates-test-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

/** One handshake on loopback: `authorized`, or the code the client refused the server with. */
function handshake(server: TestCertificate, client: tls.ConnectionOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const listener = tls.createServer({ cert: server.cert, key: server.key }, (socket) => {
      socket.on('error', () => {})
      socket.end()
    })
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address() as AddressInfo
      const socket = tls.connect({ host: '127.0.0.1', port, ...client })
      const settle = (outcome: string) => {
        socket.destroy()
        listener.close(() => resolve(outcome))
      }
      socket.once('secureConnect', () => settle('authorized'))
      socket.on('error', (error: NodeJS.ErrnoException) => settle(error.code ?? error.message))
    })
  })
}

describe.skipIf(created === null)('createTestCertificates', () => {
  // Collected even when skipped: the certificates are read only inside the tests.
  const certificates = created as TestCertificates
  type Leaf = 'both' | 'ipOnly' | 'dnsOnly' | 'foreign'

  it.each<[Leaf, string, string]>([
    ['both', 'CN=raditi-test-both', `DNS:localhost, IP Address:127.0.0.1, DNS:${EXTRA_NAME}`],
    ['ipOnly', 'CN=raditi-test-ip', 'IP Address:127.0.0.1'],
    ['dnsOnly', 'CN=raditi-test-dns', 'DNS:localhost'],
    ['foreign', 'CN=raditi-test-foreign', `DNS:localhost, IP Address:127.0.0.1, DNS:${EXTRA_NAME}`],
  ])('the leaf %s is %s for %s', (leaf, subject, names) => {
    const { cert, key } = certificates[leaf]
    const certificate = new X509Certificate(cert)
    // Never a host name in the CN: Node matches a leaf without a DNS name by it.
    expect(certificate.subject).toBe(subject)
    expect(certificate.subjectAltName).toBe(names)
    expect(certificate.ca).toBe(false)
    expect(certificate.checkPrivateKey(createPrivateKey(key))).toBe(true)
  })

  it('signs the three leaves with one CA and the foreign leaf with another', () => {
    const authority = new X509Certificate(certificates.ca)
    const foreignAuthority = new X509Certificate(certificates.foreign.ca)
    expect([authority.subject, authority.ca]).toEqual(['CN=raditi-test-ca', true])
    expect([foreignAuthority.subject, foreignAuthority.ca]).toEqual([
      'CN=raditi-test-foreign-ca',
      true,
    ])
    for (const leaf of ['both', 'ipOnly', 'dnsOnly'] as const) {
      const certificate = new X509Certificate(certificates[leaf].cert)
      expect(certificate.verify(authority.publicKey), leaf).toBe(true)
      expect(certificate.verify(foreignAuthority.publicKey), leaf).toBe(false)
    }
    const foreign = new X509Certificate(certificates.foreign.cert)
    expect(foreign.verify(foreignAuthority.publicKey)).toBe(true)
    expect(foreign.verify(authority.publicKey)).toBe(false)
  })

  // The client always dials 127.0.0.1. Checked as a name: that name is the servername. Checked
  // as the literal: no servername, and Node checks the identity of the address it dialled.
  it.each<[Leaf, string, string]>([
    ['both', 'localhost', 'authorized'],
    ['both', '127.0.0.1', 'authorized'],
    ['both', EXTRA_NAME, 'authorized'],
    ['both', 'other.raditi.test', 'ERR_TLS_CERT_ALTNAME_INVALID'],
    ['ipOnly', '127.0.0.1', 'authorized'],
    ['ipOnly', 'localhost', 'ERR_TLS_CERT_ALTNAME_INVALID'],
    ['dnsOnly', 'localhost', 'authorized'],
    ['dnsOnly', '127.0.0.1', 'ERR_TLS_CERT_ALTNAME_INVALID'],
    ['foreign', 'localhost', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
    ['foreign', '127.0.0.1', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
  ])('a server with the leaf %s, checked as %s: %s', async (leaf, checked, outcome) => {
    const identity = isIP(checked) === 0 ? { servername: checked } : {}
    await expect(
      handshake(certificates[leaf], { ca: [certificates.ca], ...identity }),
    ).resolves.toBe(outcome)
  })

  it('the foreign leaf verifies for a client that trusts the foreign CA, and only for it', async () => {
    const client = { ca: [certificates.foreign.ca], servername: 'localhost' }
    await expect(handshake(certificates.foreign, client)).resolves.toBe('authorized')
    await expect(handshake(certificates.both, client)).resolves.toBe(
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    )
  })

  it('makes new keys on every call and leaves no file behind', async () => {
    const directory = await temporaryDirectory()
    vi.stubEnv('TMPDIR', directory)
    const again = await createTestCertificates()
    expect(again).not.toBeNull()
    const { both, ca } = again as TestCertificates
    expect(both.key).toMatch(/^-----BEGIN PRIVATE KEY-----\n/)
    expect(both.key).not.toBe(certificates.both.key)
    expect(ca).not.toBe(certificates.ca)
    // Without `names`: the two loopback identities and nothing else.
    expect(new X509Certificate(both.cert).subjectAltName).toBe(
      'DNS:localhost, IP Address:127.0.0.1',
    )
    expect(await readdir(directory)).toEqual([])
  })
})

describe('createTestCertificates and the openssl binary', () => {
  it('answers null where openssl is not installed', async () => {
    vi.stubEnv('PATH', await temporaryDirectory())
    await expect(createTestCertificates()).resolves.toBeNull()
  })

  async function fakeOpenssl(script: string): Promise<string> {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'openssl'), `#!/bin/sh\n${script}\n`)
    await chmod(join(directory, 'openssl'), 0o755)
    vi.stubEnv('PATH', directory)
    return directory
  }

  it('fails, and does not answer null, when openssl is there and broken', async () => {
    await fakeOpenssl('exit 1')
    await expect(createTestCertificates()).rejects.toMatchObject({ code: 1 })
  })

  it('removes its directory with the keys when openssl fails half-way', async () => {
    // Answers `version`; asked for a certificate, it notes beside itself what TMPDIR holds and fails.
    const bin = await fakeOpenssl(
      '[ "$1" = version ] && exit 0\necho "$TMPDIR"/* >> "${0%/*}/seen"\nexit 1',
    )
    const work = await temporaryDirectory()
    vi.stubEnv('TMPDIR', work)
    await expect(createTestCertificates()).rejects.toMatchObject({ code: 1 })
    expect(await readFile(join(bin, 'seen'), 'utf8')).toContain(
      join(work, 'raditi-test-certificates-'),
    )
    expect(await readdir(work)).toEqual([])
  })

  it.each(['a,IP:10.0.0.1', 'a\nsubjectAltName = DNS:b', 'a b', ''])(
    'refuses the name %j before it runs anything',
    async (name) => {
      // An empty PATH would give null: the refusal comes first.
      vi.stubEnv('PATH', await temporaryDirectory())
      await expect(createTestCertificates({ names: [name] })).rejects.toThrow(TypeError)
    },
  )
})
