import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'

import { trustCertificateAuthority } from './trusted-ca.ts'

const builtIn = getCACertificates('default')

function selfSignedCa(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raditi-ca-'))
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'ca.pem'), '-days', '1',
      '-subj', '/CN=Raditi test CA',
    ], { stdio: 'ignore' })
    return readFileSync(join(dir, 'ca.pem'), 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('trustCertificateAuthority', () => {
  afterEach(() => setDefaultCACertificates(builtIn))

  it('adds the CA to the default roots and keeps the built-in ones', () => {
    const ca = selfSignedCa()
    trustCertificateAuthority(ca)
    const roots = getCACertificates('default')
    expect(roots).toHaveLength(builtIn.length + 1)
    expect(roots.map((pem) => pem.trim())).toContain(ca.trim())
  })

  it('refuses what is not a PEM certificate', () => {
    expect(() => trustCertificateAuthority('not a certificate')).toThrow(/PEM certificate/)
    expect(getCACertificates('default')).toHaveLength(builtIn.length)
  })
})
