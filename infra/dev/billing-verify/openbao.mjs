// The Vault that web writes the access of a new site to, for the billing stand (verify-billing.mjs)
// and for the browser billing run (apps/e2e/playwright.billing.config.ts). A customer's first site
// is what makes the workspace and grants the gift, and the product has one way to add a site:
// «Добавить проект» checks the files over the network and writes the secret of the access to Vault
// before it creates anything (docs/plan/39-site-connection-wizard.md, «Создание»). So both runs
// give web a disposable OpenBao: dev mode in a container on loopback, data in memory, the mounts
// and the policies of infra/vault/bootstrap.mjs, and an AppRole with the two policies web has:
// `sites-writer` — write with CAS, read the metadata, never read a secret back — and
// `workspace-provisioner` — make the Transit key of a workspace before its first task
// (docs/plan/57-browser-tasks.md, Б32), never read, use or remove one.
//
// As a process, for the browser run (the shop of the fake comes from the environment the same way):
//   VAULT_ROLE_ID=… VAULT_SECRET_ID=… node infra/dev/billing-verify/openbao.mjs --port 4210
// prints {"ready":true,"port":4210} once web can log in with that pair, and removes its container
// on SIGINT, SIGTERM or SIGHUP. The container is `raditi-billing-e2e-vault-<port>`, labelled
// `io.raditi.billing-e2e=<port>`; one left by a run that was killed outright is removed by the
// next one on the same port, by that label. Synthetic values only: the root token is random and
// never leaves this process and the container.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { bootstrapLocalVault, localVaultRequest } from '../../vault/bootstrap.mjs'
import { OPENBAO_IMAGE } from './stand.mjs'

/** The AppRole web logs in with, named after its first policy (infra/vault/policies). */
export const SITES_WRITER = 'sites-writer'
/** The policies of that AppRole, as web has them in production, and no other. */
export const WEB_POLICIES = Object.freeze([SITES_WRITER, 'workspace-provisioner'])

const expect = (result, statuses, what) => {
  if (!statuses.includes(result.status)) throw new Error(`${what} failed (HTTP ${result.status})`)
  return result.body
}

/** Until the server answers its health as initialized, unsealed and active. */
export async function openbaoReady(address, { timeoutMs = 30_000, signal } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const health = await localVaultRequest({ address }, 'sys/health').catch(() => null)
    if (health?.status === 200) return
    if (Date.now() > deadline) throw new Error(`OpenBao on ${address} did not become ready`)
    await sleep(200, undefined, { signal })
  }
}

/**
 * Makes the server what web expects of Vault: the mounts and the policies of
 * infra/vault/bootstrap.mjs (kv/ is KV v2), and the AppRole `sites-writer` with the policies of
 * WEB_POLICIES and no other, its tokens renewable for a day. `roleId` and `secretId` are taken as given (the
 * browser run names them in the environment of web) or made by the server. Resolves to the pair
 * web logs in with, after one login has proved it.
 */
export async function prepareSitesWriter({ address, token, roleId, secretId }) {
  await bootstrapLocalVault({ address, token })
  const root = { address, token }
  const post = (body = {}) => ({ method: 'POST', body })
  expect(
    await localVaultRequest(root, 'sys/auth/approle', post({ type: 'approle' })),
    [204],
    'AppRole',
  )
  const role = `auth/approle/role/${SITES_WRITER}`
  expect(
    await localVaultRequest(
      root,
      role,
      post({
        token_policies: [...WEB_POLICIES],
        token_no_default_policy: true,
        token_ttl: '1h',
        token_max_ttl: '24h',
        secret_id_num_uses: 0,
      }),
    ),
    [204],
    'The role of web',
  )
  if (roleId !== undefined)
    expect(
      await localVaultRequest(root, `${role}/role-id`, post({ role_id: roleId })),
      [204],
      'The role id of web',
    )
  const id = expect(await localVaultRequest(root, `${role}/role-id`), [200], 'The role id')?.data
    ?.role_id
  const secret =
    secretId === undefined
      ? expect(await localVaultRequest(root, `${role}/secret-id`, post()), [200], 'A secret id')
          ?.data?.secret_id
      : (expect(
          await localVaultRequest(root, `${role}/custom-secret-id`, post({ secret_id: secretId })),
          [200],
          'The secret id of web',
        ),
        secretId)
  if (typeof id !== 'string' || typeof secret !== 'string')
    throw new Error('The AppRole of web has no credentials')
  const login = expect(
    await localVaultRequest({ address }, 'auth/approle/login', {
      method: 'POST',
      body: { role_id: id, secret_id: secret },
    }),
    [200],
    'The login of web',
  )
  const held = Array.isArray(login?.auth?.token_policies) ? [...login.auth.token_policies] : []
  if (JSON.stringify(held.sort()) !== JSON.stringify([...WEB_POLICIES].sort()))
    throw new Error(`The login of web holds other policies than ${WEB_POLICIES.join(' and ')}`)
  return { roleId: id, secretId: secret }
}

/** The metadata of one KV v2 path, as the operator reads it: its current version, or null. */
export async function kvVersion({ address, token }, path) {
  const [mount, ...rest] = path.split('/')
  const result = await localVaultRequest({ address, token }, `${mount}/metadata/${rest.join('/')}`)
  if (result.status === 404) return null
  return expect(result, [200], 'Read the metadata')?.data?.current_version ?? null
}

// ─── As a process: the Vault of the browser billing run ───────────────────────

const E2E_LABEL = 'io.raditi.billing-e2e'

/** A short docker command; its output, or a failure that names the command only. */
function docker(args, env = process.env) {
  return new Promise((done, reject) => {
    const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      done({ code, output: output.trim() })
    })
  })
}

function portOf(argv) {
  const [flag, value, ...rest] = argv.filter((arg) => arg !== '--')
  const port = Number(value)
  if (
    flag !== '--port' ||
    rest.length > 0 ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535
  )
    throw new Error('Usage: node infra/dev/billing-verify/openbao.mjs --port <1024–65535>')
  return port
}

async function main() {
  const port = portOf(process.argv.slice(2))
  const { VAULT_ROLE_ID: roleId, VAULT_SECRET_ID: secretId } = process.env
  if (!roleId || !secretId)
    throw new Error('VAULT_ROLE_ID and VAULT_SECRET_ID name the AppRole web logs in with')
  const name = `raditi-billing-e2e-vault-${port}`
  const ours = async () =>
    (await docker(['inspect', name, '--format', `{{index .Config.Labels "${E2E_LABEL}"}}`]))
      .output === String(port)
  // A container of a run that was killed outright: removed by its label, never by its name alone.
  if (await ours()) await docker(['rm', '-fv', name])
  const rootToken = randomBytes(24).toString('hex')
  let started = false
  const stop = async () => {
    if (started && (await ours())) await docker(['rm', '-fv', name])
    started = false
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, () => {
      void stop().finally(() => process.exit(0))
    })
  try {
    started = true
    // The token is read by docker from its own environment: it is never an argument.
    const run = await docker(
      [
        ...['run', '-d', '--rm', '--pull=never', '--name', name],
        ...['--label', `${E2E_LABEL}=${port}`, '-p', `127.0.0.1:${port}:8200`],
        ...['-e', 'BAO_DEV_ROOT_TOKEN_ID', '-e', 'BAO_DEV_LISTEN_ADDRESS=0.0.0.0:8200'],
        OPENBAO_IMAGE,
      ],
      { ...process.env, BAO_DEV_ROOT_TOKEN_ID: rootToken },
    )
    if (run.code !== 0) throw new Error(`OpenBao did not start: ${run.output.slice(-500)}`)
    const address = `http://127.0.0.1:${port}`
    await openbaoReady(address)
    await prepareSitesWriter({ address, token: rootToken, roleId, secretId })
    process.stdout.write(`${JSON.stringify({ ready: true, port })}\n`)
  } catch (error) {
    await stop()
    throw error
  }
  // Up until a signal: the timer keeps the process alive and does nothing else.
  setInterval(() => {}, 60_000)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
