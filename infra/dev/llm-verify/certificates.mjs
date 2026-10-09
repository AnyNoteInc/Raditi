import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Only disposable test CA material is copied into the owned Docker mounts. */
export async function createVerificationCertificates(root, directory) {
  const authority = join(directory, 'authority')
  const script = join(root, 'infra/egress/make-ca.sh')
  const issue = (...args) =>
    execFileSync('sh', [script, ...args], { stdio: 'pipe', timeout: 30_000 })
  issue('ca', authority)
  issue('server', authority, 'egress-1.raditi.internal')
  issue('client', authority, 'b13-llm')
  const fake = join(directory, 'fake-tls')
  const egress = join(directory, 'egress-tls')
  await mkdir(fake, { mode: 0o755 })
  await mkdir(egress, { mode: 0o755 })
  const extensions = join(authority, 'fake.ext')
  await writeFile(
    extensions,
    'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:chatgpt.com,DNS:auth.openai.com,DNS:api.kimi.ai,DNS:api.z.ai,DNS:localhost\n',
  )
  const openssl = (...args) => execFileSync('openssl', args, { stdio: 'pipe', timeout: 30_000 })
  openssl(
    'req',
    '-new',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-subj',
    '/CN=chatgpt.com',
    '-keyout',
    join(fake, 'server-key.pem'),
    '-out',
    join(authority, 'fake.csr'),
  )
  openssl(
    'x509',
    '-req',
    '-in',
    join(authority, 'fake.csr'),
    '-CA',
    join(authority, 'root.pem'),
    '-CAkey',
    join(authority, 'root-key.pem'),
    '-set_serial',
    '713',
    '-days',
    '2',
    '-extfile',
    extensions,
    '-out',
    join(fake, 'server.pem'),
  )
  for (const [from, to] of [
    ['server/egress-1.raditi.internal.pem', 'server.pem'],
    ['server/egress-1.raditi.internal-key.pem', 'server-key.pem'],
    ['root.pem', 'root.pem'],
    ['client-ca.pem', 'client-ca.pem'],
  ])
    await copyFile(join(authority, from), join(egress, to))
  // The stand's proxy admits the llm role's certificate by its pin, as egress-1 does.
  const client = new X509Certificate(await readFile(join(authority, 'clients/b13-llm.pem')))
  await writeFile(
    join(egress, 'client-pins.txt'),
    `${client.fingerprint256.replaceAll(':', '').toLowerCase()}\n`,
  )
  // Synthetic private keys must be readable by the non-root disposable service user.
  for (const file of [
    'server.pem',
    'server-key.pem',
    'root.pem',
    'client-ca.pem',
    'client-pins.txt',
  ])
    await chmod(join(egress, file), 0o444)
  await chmod(join(fake, 'server-key.pem'), 0o444)
  return { authority, fake, egress }
}
