import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** KV v2 mounts whose settings this script owns. */
export const mounts = Object.freeze({
  turns: Object.freeze({ max_versions: 1, cas_required: true, delete_version_after: '25m' }),
  subs: Object.freeze({ max_versions: 1, cas_required: true, delete_version_after: '0s' }),
})

/**
 * Mounts that are enabled when absent and checked by type only. The settings of kv/ are not
 * decided yet (spec §15, P7) and Transit has none; workspace keys are not created here.
 */
export const plainMounts = Object.freeze({
  kv: Object.freeze({ type: 'kv', options: Object.freeze({ version: '2' }) }),
  transit: Object.freeze({ type: 'transit' }),
})

export const policyNames = Object.freeze([
  'core-turns',
  'llm-subscriptions',
  'subscriptions-writer',
  'subscriptions-admin',
  'mcp-content',
  'core-transit',
  'sites-writer',
  'workspace-provisioner',
  'core-site-import',
  'core-release',
])

export function localVaultAddress(address) {
  let url
  try {
    url = new URL(address)
  } catch {
    throw new Error('An explicit loopback OpenBao address is required')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Only a numeric loopback OpenBao address without credentials is allowed')
  }
  return url.origin
}

export async function localVaultRequest({ address, token, fetchImpl = fetch }, path, options = {}) {
  const origin = localVaultAddress(address)
  if (
    token !== undefined &&
    (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
  ) {
    throw new Error('Invalid OpenBao token input')
  }
  if (!/^[A-Za-z0-9_./?=&-]+$/.test(path) || path.includes('..') || path.startsWith('/')) {
    throw new Error('Invalid OpenBao API path')
  }
  let response
  try {
    response = await fetchImpl(`${origin}/v1/${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(token === undefined ? {} : { 'X-Vault-Token': token }),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    throw new Error('Local OpenBao request failed')
  }
  // Error bodies can contain private values; callers receive only parsed data in memory.
  let body = null
  try {
    const text = await response.text()
    if (text.length > 2_000_000) throw new Error('oversized')
    if (text !== '') body = JSON.parse(text)
  } catch {
    throw new Error('Invalid local OpenBao response')
  }
  return { status: response.status, body }
}

function requiredStatus(result, statuses, operation) {
  if (!statuses.includes(result.status)) {
    throw new Error(`${operation} failed (HTTP ${result.status})`)
  }
  return result.body
}

function durationSeconds(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value !== 'string') return null
  if (value === '' || value === '0') return 0
  const units = { h: 3600, m: 60, s: 1 }
  const pieces = [...value.matchAll(/(\d+)(h|m|s)/g)]
  if (pieces.map(([piece]) => piece).join('') !== value) return null
  return pieces.reduce((seconds, [, count, unit]) => seconds + Number(count) * units[unit], 0)
}

// What the server reports for a KV v2 mount that was enabled and never configured.
const unconfigured = Object.freeze({
  max_versions: 0,
  cas_required: false,
  delete_version_after: '0s',
})

const isKv2 = (mount) => mount?.type === 'kv' && String(mount.options?.version) === '2'
const engines = Object.freeze({
  kv: Object.freeze({ label: 'KV v2', matches: isKv2 }),
  transit: Object.freeze({ label: 'Transit', matches: (mount) => mount?.type === 'transit' }),
})

const sameConfig = (config, expected) =>
  config?.max_versions === expected.max_versions &&
  config?.cas_required === expected.cas_required &&
  durationSeconds(config?.delete_version_after) === durationSeconds(expected.delete_version_after)

/** Explicit operator setup only. Runtime clients never enable or reconfigure mounts. */
export async function bootstrapLocalVault(options) {
  localVaultAddress(options.address)
  if (!options.token) throw new Error('OpenBao operator token is required')
  const request = (path, init) => localVaultRequest(options, path, init)
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  // A KV v2 mount answers HTTP 400 for a short time after it is enabled, while it upgrades.
  const mountConfig = async (name, init) => {
    let result = await request(`${name}/config`, init)
    for (let attempt = 1; result.status === 400 && attempt < 20; attempt += 1) {
      await sleep(250)
      result = await request(`${name}/config`, init)
    }
    return result
  }
  const inventory = requiredStatus(await request('sys/mounts'), [200], 'Read mounts')?.data
  if (!inventory || typeof inventory !== 'object')
    throw new Error('Invalid OpenBao mount inventory')

  // Validate every pre-existing mount before changing any configuration.
  const pending = []
  for (const [name, expected] of Object.entries(mounts)) {
    const mount = inventory[`${name}/`]
    if (mount === undefined) {
      pending.push(name)
      continue
    }
    if (!isKv2(mount)) throw new Error(`Existing ${name}/ is not KV v2; no mount was reset`)
    const config = requiredStatus(await mountConfig(name), [200], 'Read KV configuration')?.data
    if (sameConfig(config, expected)) continue
    // An interrupted run enables a mount and stops before configuring it. Only that state is
    // finished here: the server defaults and not a single key.
    const unused =
      sameConfig(config, unconfigured) &&
      requiredStatus(await request(`${name}/metadata?list=true`), [200, 404], 'List keys')?.data ===
        undefined
    if (!unused) {
      throw new Error(
        `Existing ${name}/ configuration differs; explicit operator review is required`,
      )
    }
    pending.push(name)
  }
  const pendingPlain = []
  for (const [name, expected] of Object.entries(plainMounts)) {
    const mount = inventory[`${name}/`]
    if (mount === undefined) pendingPlain.push(name)
    else if (!engines[expected.type].matches(mount)) {
      throw new Error(
        `Existing ${name}/ is not ${engines[expected.type].label}; no mount was reset`,
      )
    }
  }

  const created = []
  for (const name of pending) {
    if (inventory[`${name}/`] === undefined) {
      requiredStatus(
        await request(`sys/mounts/${name}`, {
          method: 'POST',
          body: { type: 'kv', options: { version: '2' } },
        }),
        [200, 204],
        'Enable KV mount',
      )
      created.push(name)
    }
    requiredStatus(
      await mountConfig(name, { method: 'POST', body: mounts[name] }),
      [200, 204],
      'Configure KV mount',
    )
  }
  for (const name of pendingPlain) {
    requiredStatus(
      await request(`sys/mounts/${name}`, { method: 'POST', body: plainMounts[name] }),
      [200, 204],
      `Enable ${engines[plainMounts[name].type].label} mount`,
    )
    created.push(name)
  }
  for (const name of policyNames) {
    const policy = await readFile(new URL(`./policies/${name}.hcl`, import.meta.url), 'utf8')
    requiredStatus(
      await request(`sys/policies/acl/${name}`, { method: 'PUT', body: { policy } }),
      [200, 204],
      'Write policy',
    )
  }
  return {
    mounts: [...Object.keys(mounts), ...Object.keys(plainMounts)],
    policies: [...policyNames],
    created,
  }
}

/** What the operator reads after a run. A mount created now has lost everything it held. */
export function bootstrapSummary(result) {
  const lines = [
    `Local OpenBao ready: ${result.mounts.map((name) => `${name}/`).join(', ')}; ` +
      `${result.policies.length} policies`,
  ]
  if (result.created.length > 0) {
    // In-memory dev storage: a restarted server has lost every secret, not only the mounts.
    const lost = [
      ['subs', 'log subscription accounts in again'],
      ['kv', 'site access and contact maps have to be stored again'],
      ['transit', 'workspace keys have to be created again and what they wrapped is unreadable'],
    ].flatMap(([name, consequence]) => (result.created.includes(name) ? [consequence] : []))
    lines.push(
      `Created now: ${result.created.map((name) => `${name}/`).join(', ')}. ` +
        `Secrets stored there before are gone${lost.length > 0 ? `: ${lost.join('; ')}` : ''}.`,
    )
  }
  return lines
}

/** A server that was started a moment ago: wait until it is initialized, unsealed and active. */
export async function waitForLocalVault(options, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  localVaultAddress(options.address)
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  for (let waited = 0; ; waited += intervalMs) {
    try {
      const health = await localVaultRequest({ ...options, token: undefined }, 'sys/health')
      if (health.status === 200) return
    } catch {
      // Not listening yet.
    }
    if (waited >= timeoutMs) throw new Error('Local OpenBao did not become ready')
    await sleep(intervalMs)
  }
}

async function main() {
  const [flag, value, wait, ...rest] = process.argv.slice(2)
  if (
    flag !== '--address' ||
    value === undefined ||
    (wait !== undefined && wait !== '--wait') ||
    rest.length > 0
  ) {
    throw new Error(
      'Usage: node infra/vault/bootstrap.mjs --address http://127.0.0.1:8200 [--wait] < token',
    )
  }
  const address = localVaultAddress(value)
  let token = ''
  for await (const chunk of process.stdin) {
    token += chunk.toString('utf8')
    if (token.length > 8193) throw new Error('OpenBao token input is too long')
  }
  token = token.trim()
  // An empty pipe (the dev container is not running) needs no server to be reported.
  if (!token) throw new Error('OpenBao operator token is required')
  if (wait) await waitForLocalVault({ address })
  const result = await bootstrapLocalVault({ address, token })
  for (const line of bootstrapSummary(result)) process.stdout.write(`${line}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
