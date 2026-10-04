#!/usr/bin/env node
// Read-only deployment checks. Inputs are data; neither env file is sourced or evaluated.
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isIP } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { createSecureContext } from 'node:tls'
import { fileURLToPath } from 'node:url'

const secretNames = ['DATABASE_URL', 'VAULT_ROLE_ID', 'VAULT_SECRET_ID', 'METRICS_TOKEN']
const tlsOverrides =
  /^(?:NODE_|LLM_(?:BACKEND_|AUTH_|UPSTREAM_|EGRESS_|GATEWAY_HOSTS|GATEWAY_PORT|GATEWAY_LISTEN_HOST)|LLM_CONTROL_URL$)/
class PreflightError extends Error {}
const fail = (message) => {
  throw new PreflightError(message)
}

export function parseSettings(text, { secret = false } = {}) {
  const settings = Object.create(null)
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw)
    if (!match) fail(`env file contains an invalid line: line ${index + 1}`)
    const [, name, written] = match
    if (Object.hasOwn(settings, name))
      fail(`env file contains a duplicate setting: line ${index + 1}`)
    let value = written
    if (secret && /^"[^"\r\n\\]*"$/.test(written)) value = written.slice(1, -1)
    else if (/[\s'"#\\]/.test(written)) fail('env file contains unsupported quoting or whitespace')
    if (/[\x00-\x1f\x7f]/.test(value) || /\$\{|`|\$\(/.test(value))
      fail('env file contains unsupported interpolation')
    settings[name] = value
  }
  return settings
}

export function llmEnabled(settings) {
  const profiles = settings.COMPOSE_PROFILES ?? ''
  if (profiles && !/^[a-zA-Z0-9_-]+(?:,[a-zA-Z0-9_-]+)*$/.test(profiles))
    fail('COMPOSE_PROFILES must be a comma-separated list without whitespace')
  return profiles.split(',').includes('llm')
}

const ipv4 = (value) => isIP(value ?? '') === 4
const number = (value) => value.split('.').reduce((total, part) => total * 256 + Number(part), 0)
const privateIp = (value) =>
  ipv4(value) &&
  (value.startsWith('10.') ||
    value.startsWith('192.168.') ||
    (value.startsWith('172.') &&
      Number(value.split('.')[1]) >= 16 &&
      Number(value.split('.')[1]) <= 31))

function cidr(value) {
  const [ip, prefix, ...extra] = (value ?? '').split('/')
  if (!ipv4(ip) || !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(prefix ?? '') || extra.length) return null
  const size = 2 ** (32 - Number(prefix))
  const start = number(ip)
  if (start % size) return null
  return { ip, prefix: Number(prefix), start, end: start + size - 1 }
}

const privateRange = (range) =>
  range &&
  privateIp(range.ip) &&
  ((range.ip.startsWith('10.') && range.prefix >= 8) ||
    (range.ip.startsWith('172.') && range.prefix >= 12) ||
    (range.ip.startsWith('192.168.') && range.prefix >= 16))
const overlaps = (a, b) => a.start <= b.end && b.start <= a.end

export function validateSettings(settings) {
  const enabled = llmEnabled(settings)
  // Stable names protect Docker's previously created containers after a reboot as well.
  // Isolated Compose verifiers may choose other names, but never use this host preflight.
  if ((settings.BRIDGE_PREFIX || 'rd') !== 'rd')
    fail('BRIDGE_PREFIX must remain rd for the production llm firewall')
  if (!enabled) return { enabled: false }
  for (const name of Object.keys(settings))
    if (tlsOverrides.test(name)) fail('Compose settings contain a forbidden runtime override')
  for (const name of ['APP_PRIVATE_IP', 'VAULT_PRIVATE_IP'])
    if (!privateIp(settings[name])) fail(`${name} must be a private IPv4 address`)
  if (settings.APP_PRIVATE_IP === settings.VAULT_PRIVATE_IP)
    fail('VAULT_PRIVATE_IP must identify the separate Vault host')
  if (settings.VAULT_ADDR !== 'https://vault.raditi.internal:8200')
    fail('VAULT_ADDR must use the pinned Vault TLS name and port')
  if ((settings.LLM_GATEWAY_PUBLISH || '8084') !== '8084') fail('LLM_GATEWAY_PUBLISH must be 8084')
  const proxy = settings.EGRESS_PROXY_IP
  // Reject every special-use range relevant to an Internet proxy, including documentation IPs.
  const excluded = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.0.2.0/24',
    '192.88.99.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '198.51.100.0/24',
    '203.0.113.0/24',
    '224.0.0.0/4',
    '240.0.0.0/4',
  ].map(cidr)
  if (
    !ipv4(proxy) ||
    excluded.some((range) => number(proxy) >= range.start && number(proxy) <= range.end)
  )
    fail('EGRESS_PROXY_IP must be a public unicast IPv4 address')
  const subnet = cidr(settings.LLM_OUT_SUBNET || '172.29.84.0/24')
  const gateway = settings.LLM_OUT_GATEWAY || '172.29.84.1'
  if (!privateRange(subnet) || subnet.prefix < 16 || subnet.prefix > 28)
    fail('LLM_OUT_SUBNET must be a canonical private IPv4 subnet with prefix 16 to 28')
  if (!ipv4(gateway) || number(gateway) <= subnet.start || number(gateway) >= subnet.end)
    fail('LLM_OUT_GATEWAY must be a usable address inside LLM_OUT_SUBNET')
  for (const name of ['APP_PRIVATE_IP', 'VAULT_PRIVATE_IP'])
    if (number(settings[name]) >= subnet.start && number(settings[name]) <= subnet.end)
      fail('LLM_OUT_SUBNET must not overlap the app or Vault network address')
  const written = (settings.LLM_GATEWAY_CLIENTS ?? '').split(',')
  const clients = written.map(cidr)
  if (
    !clients.length ||
    clients.some((range) => !privateRange(range)) ||
    new Set(written).size !== written.length
  )
    fail('LLM_GATEWAY_CLIENTS must contain distinct canonical private IPv4 CIDRs')
  // After Docker's SNAT this address is the source of core and of every other container of
  // the VM alike: the CIDR list cannot tell them apart. The host firewall can, by the source
  // bridge, and admits only core's (llm-firewall.mjs, chain to_llm).
  if (!written.includes(`${gateway}/32`))
    fail('LLM_GATEWAY_CLIENTS must explicitly include LLM_OUT_GATEWAY/32 for core hairpin traffic')
  const sandbox = clients.filter((range) => range.ip !== gateway || range.prefix !== 32)
  if (!sandbox.length || sandbox.some((range) => overlaps(range, subnet)))
    fail('LLM_GATEWAY_CLIENTS must include sandbox ranges outside LLM_OUT_SUBNET')
  // A range covering the VM's own address would describe the VM, not the sandbox VMs.
  if (
    sandbox.some(
      (range) =>
        number(settings.APP_PRIVATE_IP) >= range.start &&
        number(settings.APP_PRIVATE_IP) <= range.end,
    )
  )
    fail('LLM_GATEWAY_CLIENTS sandbox ranges must exclude APP_PRIVATE_IP')
  return { enabled: true, gateway, subnet: settings.LLM_OUT_SUBNET || '172.29.84.0/24' }
}

function readRegular(path) {
  const stat = lstatSync(path)
  if (!stat.isFile()) fail('a required secret must be a regular file, not a symlink')
  if (!stat.size || stat.size > 64 * 1024) fail('a required secret file has an invalid size')
  const contents = readFileSync(path, 'utf8')
  if (!contents || Buffer.byteLength(contents) > 64 * 1024)
    fail('a required secret file has an invalid size')
  return contents
}

function certificates(pem, now) {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  if (
    !blocks.length ||
    pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()
  )
    fail('a certificate file must contain certificates only')
  return blocks.map((block) => {
    const cert = new X509Certificate(block)
    if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now)
      fail('a TLS certificate is expired or not yet valid')
    return cert
  })
}

export function validateSecrets(settings, { now = Date.now() } = {}) {
  const base = settings.SECRETS_DIR || '/run/raditi'
  if (!isAbsolute(base)) fail('SECRETS_DIR must be an absolute path')
  const directory = join(base, 'llm')
  if (!lstatSync(directory).isDirectory()) fail('the llm secret directory must not be a symlink')
  const env = parseSettings(readRegular(join(directory, 'app.env')), { secret: true })
  if (
    Object.keys(env).some((name) => !secretNames.includes(name)) ||
    secretNames.some((name) => !env[name] || /[<>]/.test(env[name]))
  )
    fail(
      'llm/app.env must contain exactly DATABASE_URL, VAULT_ROLE_ID, VAULT_SECRET_ID and METRICS_TOKEN',
    )
  const database = URL.parse(env.DATABASE_URL)
  if (
    !database ||
    database.protocol !== 'postgresql:' ||
    database.username !== 'raditi' ||
    !database.password ||
    database.hostname !== 'postgres' ||
    database.port !== '5432' ||
    database.pathname !== '/raditi' ||
    database.search ||
    database.hash
  )
    fail('llm DATABASE_URL must use raditi at postgres:5432/raditi without connection overrides')
  if (env.METRICS_TOKEN.length < 32) fail('METRICS_TOKEN must contain at least 32 characters')
  const core = parseSettings(readRegular(join(base, 'core', 'app.env')), { secret: true })
  const coreDatabase = URL.parse(core.DATABASE_URL ?? '')
  if (
    !coreDatabase ||
    ['protocol', 'username', 'hostname', 'port', 'pathname'].some(
      (field) => coreDatabase[field] !== database[field],
    ) ||
    coreDatabase.search ||
    coreDatabase.hash ||
    decodeURIComponent(coreDatabase.password) !== decodeURIComponent(database.password)
  )
    fail('core and llm DATABASE_URL must use the same raditi connection and PostgreSQL password')
  if (
    !core.VAULT_ROLE_ID ||
    !core.VAULT_SECRET_ID ||
    core.VAULT_ROLE_ID === env.VAULT_ROLE_ID ||
    core.VAULT_SECRET_ID === env.VAULT_SECRET_ID
  )
    fail('llm must have an AppRole and SecretID separate from core')
  if (core.METRICS_TOKEN !== env.METRICS_TOKEN)
    fail('core and llm METRICS_TOKEN must match for the private control endpoint')
  // web faces the Internet. The firewall keeps its bridge away from :8084; its token must not
  // open the control endpoint or the gateway metrics either, should that boundary ever fail.
  const web = parseSettings(readRegular(join(base, 'web', 'app.env')), { secret: true })
  if (!web.METRICS_TOKEN || web.METRICS_TOKEN === env.METRICS_TOKEN)
    fail('web METRICS_TOKEN must differ from the control token of core and llm')
  if (Object.keys(core).some((name) => name.startsWith('LLM_') || name.startsWith('NODE_')))
    fail('core/app.env must not override the static LLM control configuration or Node runtime')
  const caPem = readRegular(join(directory, 'egress-ca.pem'))
  const ca = certificates(caPem, now)
  if (ca.length !== 1 || !ca[0].ca || !ca[0].checkIssued(ca[0]) || !ca[0].verify(ca[0].publicKey))
    fail('egress-ca.pem must contain the self-signed egress root CA')
  const certPem = readRegular(join(directory, 'egress-client.pem'))
  const chain = certificates(certPem, now)
  if (
    chain[0].ca ||
    !chain[0].keyUsage?.includes('1.3.6.1.5.5.7.3.2') ||
    chain[0].keyUsage?.includes('1.3.6.1.5.5.7.3.1')
  )
    fail('the egress client certificate must have clientAuth only')
  const complete = [...chain, ca[0]]
  for (let index = 0; index < complete.length - 1; index++) {
    const issuer = complete[index + 1]
    if (
      !issuer.ca ||
      !complete[index].checkIssued(issuer) ||
      !complete[index].verify(issuer.publicKey)
    )
      fail('the egress client chain must verify against egress-ca.pem')
  }
  const keyPem = readRegular(join(directory, 'egress-client-key.pem'))
  if (!chain[0].checkPrivateKey(createPrivateKey(keyPem)))
    fail('the egress client certificate and private key do not match')
  createSecureContext({ cert: certPem, key: keyPem, ca: caPem, minVersion: 'TLSv1.3' })
  // core issues the turn keys llm reads, web checks Vault in its health: each trusts the CA
  // file of its own directory (docker-compose.yml), so each file is checked.
  for (const service of ['llm', 'core', 'web']) {
    const vault = certificates(readRegular(join(base, service, 'vault-ca.pem')), now)
    if (vault.some((cert) => !cert.ca))
      fail(`${service}/vault-ca.pem must contain CA certificates only`)
  }
}

export function checkLlmPreflight(envFile, { environment = {}, now } = {}) {
  const settings = parseSettings(readRegular(envFile))
  // Compose environment variables take precedence over .env. Reject differences rather than
  // checking one configuration while Docker starts another (including profile enablement).
  const names = [
    'COMPOSE_PROFILES',
    'SECRETS_DIR',
    'APP_PRIVATE_IP',
    'VAULT_ADDR',
    'VAULT_PRIVATE_IP',
    'LLM_GATEWAY_PUBLISH',
    'LLM_GATEWAY_CLIENTS',
    'EGRESS_PROXY_IP',
    'LLM_OUT_SUBNET',
    'LLM_OUT_GATEWAY',
    'BRIDGE_PREFIX',
  ]
  for (const name of names)
    if (Object.hasOwn(environment, name) && environment[name] !== (settings[name] ?? ''))
      fail('the shell environment overrides a checked Compose setting')
  const result = validateSettings(settings)
  if (result.enabled) validateSecrets(settings, { now })
  return result
}

// Not `import.meta.main`: it is absent before Node 22.18 and 24.2, where this file would load,
// skip every check and exit 0, and preflight.sh would print ok. Both paths are resolved: the
// helper may be started through a symlink.
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  try {
    if (!(Number(process.versions.node.split('.')[0]) >= 26)) fail('Node 26 or newer is required')
    if (process.argv.length !== 4 || process.argv[2] !== '--env-file')
      fail('usage: node llm-preflight.mjs --env-file PATH')
    const result = checkLlmPreflight(process.argv[3], { environment: process.env })
    process.stdout.write(`llm-preflight: ${result.enabled ? 'ok' : 'profile disabled'}\n`)
  } catch (error) {
    // Only our fixed messages are safe; OpenSSL, filesystem and URL errors may contain input.
    const message =
      error instanceof PreflightError ? error.message : 'configuration or TLS validation failed'
    process.stderr.write(`llm-preflight: ${message}\n`)
    process.exitCode = 1
  }
}
