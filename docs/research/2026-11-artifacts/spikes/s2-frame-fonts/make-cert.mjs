// A throwaway self-signed certificate for the stand's names (*.spike.test). The browsers take it
// with ignoreHTTPSErrors; nothing here is trusted anywhere else. Writes certs/key.pem and
// certs/cert.pem next to this file; the key never leaves the work dir.
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'certs')
mkdirSync(dir, { recursive: true })
if (!existsSync(join(dir, 'cert.pem'))) {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    '-subj', '/CN=spike.test',
    '-addext', 'subjectAltName=DNS:spike.test,DNS:*.spike.test,DNS:*.pages.spike.test,DNS:xsite.test',
  ], { stdio: 'inherit' })
}
console.log('certs in', dir)
