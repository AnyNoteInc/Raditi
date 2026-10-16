import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** A leaf certificate and its private key, PEM: the names `tls.createServer` takes. */
export interface TestCertificate {
  cert: string
  key: string
}

/** Disposable synthetic certificates for the fakes on loopback; never a platform CA. */
export interface TestCertificates {
  /** PEM of the CA that signed `both`, `ipOnly` and `dnsOnly`: what a test trusts. */
  ca: string
  /** DNS:localhost and IP:127.0.0.1, plus the `names` asked for. */
  both: TestCertificate
  /** IP:127.0.0.1 alone: verifies for the literal and not for the name. */
  ipOnly: TestCertificate
  /** DNS:localhost alone: verifies for the name and not for the literal. */
  dnsOnly: TestCertificate
  /** A second CA that no test trusts, and a leaf it signed for the names of `both`. */
  foreign: TestCertificate & { ca: string }
}

// The named curve and the digest are asked for explicitly: left to itself, LibreSSL (the openssl
// of macOS) writes the curve parameters out and signs with SHA-1, and Node refuses both.
const KEY = [
  ...['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'],
  ...['-pkeyopt', 'ec_param_enc:named_curve', '-nodes'],
]
const SIGNED = ['-sha256', '-days', '2']

const AUTHORITY_EXTENSIONS = [
  'basicConstraints = critical,CA:true',
  'keyUsage = critical,keyCertSign,cRLSign',
  'subjectKeyIdentifier = hash',
]
const leafExtensions = (names: readonly string[]) => [
  'basicConstraints = critical,CA:false',
  'keyUsage = critical,digitalSignature',
  'extendedKeyUsage = serverAuth',
  'subjectKeyIdentifier = hash',
  'authorityKeyIdentifier = keyid',
  `subjectAltName = ${names.join(',')}`,
]

/** The request section is spelled out, so the result does not depend on the machine's openssl.cnf. */
const config = (commonName: string, extensions: readonly string[]) =>
  ['[req]', 'distinguished_name = dn', 'prompt = no', '[dn]', `CN = ${commonName}`, '[ext]']
    .concat(extensions, '')
    .join('\n')

function subjectAltName(name: string): string {
  if (isIP(name) !== 0) return `IP:${name}`
  // A comma or a line break would add entries or directives to the extension file.
  if (!/^[a-z0-9.-]+$/i.test(name)) throw new TypeError(`not a host name or an IP literal: ${name}`)
  return `DNS:${name}`
}

const openssl = (args: readonly string[]) => run('openssl', args, { timeout: 30_000 })

/** False only when the binary is missing: any other failure of openssl is an error, not a skip. */
async function opensslInstalled(): Promise<boolean> {
  try {
    await openssl(['version'])
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

interface Authority {
  certFile: string
  keyFile: string
}

async function createAuthority(directory: string, name: string): Promise<Authority> {
  const file = (suffix: string) => join(directory, `${name}${suffix}`)
  await writeFile(file('.cnf'), config(`raditi-test-${name}`, AUTHORITY_EXTENSIONS))
  await openssl([
    ...['req', '-x509', ...KEY, ...SIGNED, '-config', file('.cnf'), '-extensions', 'ext'],
    ...['-keyout', file('-key.pem'), '-out', file('.pem')],
  ])
  return { certFile: file('.pem'), keyFile: file('-key.pem') }
}

/** The CN is `raditi-test-<name>`, never a host name: a leaf without a DNS name is matched by its CN. */
async function issue(
  directory: string,
  authority: Authority,
  name: string,
  serial: number,
  names: readonly string[],
): Promise<TestCertificate> {
  const file = (suffix: string) => join(directory, `${name}${suffix}`)
  await writeFile(file('.cnf'), config(`raditi-test-${name}`, leafExtensions(names)))
  await openssl([
    ...['req', '-new', ...KEY, '-config', file('.cnf')],
    ...['-keyout', file('-key.pem'), '-out', file('.csr')],
  ])
  await openssl([
    ...['x509', '-req', '-in', file('.csr'), ...SIGNED, '-set_serial', String(serial)],
    ...['-CA', authority.certFile, '-CAkey', authority.keyFile],
    ...['-extfile', file('.cnf'), '-extensions', 'ext', '-out', file('.pem')],
  ])
  const [cert, key] = await Promise.all([
    readFile(file('.pem'), 'utf8'),
    readFile(file('-key.pem'), 'utf8'),
  ])
  return { cert, key }
}

/**
 * Spawns openssl; null without it. One CA and three leaves: `both` (DNS:localhost and
 * IP:127.0.0.1, plus any `names`), `ipOnly` (IP:127.0.0.1) and `dnsOnly` (DNS:localhost); and a
 * second, foreign CA with a leaf for the names of `both`. Everything is returned as PEM: the files
 * live in a temporary directory that is gone when the promise settles.
 */
export async function createTestCertificates(
  options: { names?: readonly string[] } = {},
): Promise<TestCertificates | null> {
  const localhost = subjectAltName('localhost')
  const loopback = subjectAltName('127.0.0.1')
  const every = [localhost, loopback, ...(options.names ?? []).map(subjectAltName)]
  if (!(await opensslInstalled())) return null
  const directory = await mkdtemp(join(tmpdir(), 'raditi-test-certificates-'))
  try {
    const [authority, foreignAuthority] = await Promise.all([
      createAuthority(directory, 'ca'),
      createAuthority(directory, 'foreign-ca'),
    ])
    const [ca, both, ipOnly, dnsOnly, foreignCa, foreign] = await Promise.all([
      readFile(authority.certFile, 'utf8'),
      issue(directory, authority, 'both', 1, every),
      issue(directory, authority, 'ip', 2, [loopback]),
      issue(directory, authority, 'dns', 3, [localhost]),
      readFile(foreignAuthority.certFile, 'utf8'),
      issue(directory, foreignAuthority, 'foreign', 1, every),
    ])
    return { ca, both, ipOnly, dnsOnly, foreign: { ...foreign, ca: foreignCa } }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
