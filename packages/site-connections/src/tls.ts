import type { ConnectionTls, PinnedAddress } from '@repo/domain'
import { tlsIdentity } from '@repo/domain'

// The three modes of protection a client chooses (kinds.ts) as the TLS options of one connection.
// `verified` trusts what Node trusts by default — its bundled roots, plus NODE_EXTRA_CA_CERTS and
// the system store when the process was started to read them — and never a CA a caller hands in:
// the exported adapters take no `ca`. `unverified` encrypts without checking who answers. No mode
// ever falls back to another.

/** Only the tests of this package pass it, through the factories the adapters are built with. */
export interface TestTrust {
  /** PEM of a CA that `verified` trusts in place of the default store. */
  ca?: string
}

export interface ClientTlsOptions {
  rejectUnauthorized: boolean
  servername?: string
  host?: string
  ca?: string
}

/** null for `plain`. The identity is always explicit (tlsIdentity), so a ready socket is never checked against `localhost`. */
export function clientTlsOptions(
  mode: ConnectionTls,
  address: PinnedAddress,
  trust: TestTrust = {},
): ClientTlsOptions | null {
  if (mode === 'plain') return null
  const verified = mode === 'verified'
  return {
    ...tlsIdentity(address),
    rejectUnauthorized: verified,
    ...(verified && trust.ca ? { ca: trust.ca } : {}),
  }
}

/** The codes OpenSSL and Node give a certificate that does not verify for the name. */
const CERTIFICATE_CODES = new Set([
  'CERT_CHAIN_TOO_LONG',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REJECTED',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_FORMAT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'HOSTNAME_MISMATCH',
  'INVALID_CA',
  'INVALID_PURPOSE',
  'PATH_LENGTH_EXCEEDED',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const { code } = error as { code: unknown }
  return typeof code === 'string' ? code : undefined
}

/** A certificate that does not verify: never "no TLS", always `certificate_untrusted`. */
export function isCertificateError(error: unknown): boolean {
  const code = errorCode(error)
  return code !== undefined && CERTIFICATE_CODES.has(code)
}

/** A handshake that failed for another reason than the certificate: no TLS spoken there. */
export function isTlsProtocolError(error: unknown): boolean {
  const code = errorCode(error)
  if (code === undefined || isCertificateError(error)) return false
  return code === 'EPROTO' || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')
}
