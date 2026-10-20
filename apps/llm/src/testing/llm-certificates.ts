import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Disposable synthetic certificates; never a provider credential or platform CA. */
export function createLlmTestCertificates() {
  const directory = mkdtempSync(join(tmpdir(), 'raditi-egress-test-'))
  const certFile = join(directory, 'certificate.pem')
  const keyFile = join(directory, 'key.pem')
  const otherCertFile = join(directory, 'untrusted-certificate.pem')
  const otherKeyFile = join(directory, 'untrusted-key.pem')
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        keyFile,
        '-out',
        certFile,
        '-subj',
        '/CN=egress-1.raditi.internal',
        '-addext',
        'subjectAltName=DNS:egress-1.raditi.internal,DNS:localhost',
        '-addext',
        'extendedKeyUsage=serverAuth,clientAuth',
      ],
      { stdio: 'ignore' },
    )
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        otherKeyFile,
        '-out',
        otherCertFile,
        '-subj',
        '/CN=untrusted-client',
      ],
      { stdio: 'ignore' },
    )
    return {
      certFile,
      keyFile,
      otherCertFile,
      otherKeyFile,
      close: () => rmSync(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
