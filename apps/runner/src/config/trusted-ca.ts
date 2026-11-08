import { getCACertificates, setDefaultCACertificates } from 'node:tls'

/**
 * Adds a private CA to the roots every TLS client of this process trusts by default, the global
 * fetch of the presigned transfers among them (RUNNER_S3_CA_FILE). The built-in roots stay.
 */
export function trustCertificateAuthority(pem: string): void {
  if (!/-----BEGIN CERTIFICATE-----/.test(pem))
    throw new Error('RUNNER_S3_CA_FILE: expected a PEM certificate')
  setDefaultCACertificates([...getCACertificates('default'), pem])
}
