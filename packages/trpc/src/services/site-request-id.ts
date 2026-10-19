import { createHash } from 'node:crypto'

// What a site created by «Добавить проект» is called before it exists (docs/plan/39-site-connection-wizard.md,
// «Создание», step 1). The wizard sends one `requestKey` per opening; the id of the site is derived from it
// and from the user, so a repeated request — the answer was lost, the button was pressed twice — names the
// same site and finds it instead of making a second one. The prefix keeps these digests apart from any other
// use of SHA-256 over the same ids; bumping its version would give every request a new site id.
const PREFIX = 'raditi:site-create:v1\n'

/**
 * UUID version 8 (RFC 9562) from SHA-256 of the prefix, the user id and the request key, both in lower case:
 * the first 16 bytes of the digest with the version nibble set to 8 and the RFC 4122 variant. Lower-case hex,
 * as PostgreSQL prints a UUID and as `siteAccessPath` accepts one.
 */
export function siteIdForRequest(userId: string, requestKey: string): string {
  const digest = createHash('sha256')
    .update(`${PREFIX}${userId.toLowerCase()}\n${requestKey.toLowerCase()}`)
    .digest()
  const bytes = digest.subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x80
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
