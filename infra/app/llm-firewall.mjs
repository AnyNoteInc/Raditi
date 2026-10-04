/* global console, process */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

export const TABLE = 'raditi_llm'
const FAMILY = 'inet'
const NFT = '/usr/sbin/nft'
const SYSCTL = '/usr/sbin/sysctl'
const BRIDGE_SYSCTLS = ['net.bridge.bridge-nf-call-iptables', 'net.bridge.bridge-nf-call-ip6tables']
// The container port of the gateway: Docker rewrites the published destination before FORWARD.
const GATEWAY_PORT = 8084

const number = (ip) => ip.split('.').reduce((value, part) => value * 256 + Number(part), 0)
const inside = (ip, network, bits) =>
  Math.floor(number(ip) / 2 ** (32 - bits)) === Math.floor(number(network) / 2 ** (32 - bits))
const privateIp = (ip) =>
  isIP(ip) === 4 &&
  (inside(ip, '10.0.0.0', 8) || inside(ip, '172.16.0.0', 12) || inside(ip, '192.168.0.0', 16))
const publicIp = (ip) =>
  isIP(ip) === 4 &&
  ![
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 3],
  ].some(([network, bits]) => inside(ip, network, bits))

/** Compose settings are data. Never source the file or interpolate shell expressions. */
export function firewallConfig(source) {
  const settings = Object.create(null)
  const rejected = []
  source.split(/\r?\n/u).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const match = /^([A-Z][A-Z0-9_]*)=([^\r\n]*)$/u.exec(line)
    if (!match || Object.hasOwn(settings, match[1])) rejected.push({ number: index + 1, line })
    else settings[match[1]] = match[2]
  })
  const profileList = settings.COMPOSE_PROFILES ?? ''
  if (profileList && !/^[a-zA-Z0-9_-]+(?:,[a-zA-Z0-9_-]+)*$/u.test(profileList))
    throw new Error('Invalid COMPOSE_PROFILES')
  const profiles = profileList.split(',')
  // docker.service requires this helper on every start. With llm disabled the policy is
  // deny-all and reads nothing else from the file, so a line of another service that Compose
  // accepts must not keep dockerd down. A line that may spell the profile or the bridge prefix
  // another way stays fatal: the worst misreading left is deny-all for a running llm.
  const fatal = rejected.find(
    ({ line }) => profiles.includes('llm') || /COMPOSE_PROFILES|BRIDGE_PREFIX/u.test(line),
  )
  // The number only: a line may hold a value that does not belong in the journal.
  if (fatal) throw new Error(`Invalid env file: line ${fatal.number}`)
  const prefix = settings.BRIDGE_PREFIX || 'rd'
  // A renamed prefix plus a reboot would lose every reference to old restartable bridges.
  // Production names are immutable; synthetic Compose verifiers do not invoke this helper.
  if (prefix !== 'rd') throw new Error('Production BRIDGE_PREFIX must remain rd')
  const bridges = { out: `${prefix}-llmout`, db: `${prefix}-llmdb`, edge: `${prefix}-llmedge` }
  const core = `${prefix}-core`
  // Docker can restart old llm containers even with the profile disabled. On reboot there
  // is no prior ruleset to retain: install a strict boundary without needing proxy/Vault IPs.
  if (!profiles.includes('llm')) return { enabled: false, bridges, core }
  if (!privateIp(settings.APP_PRIVATE_IP)) throw new Error('Invalid APP_PRIVATE_IP')
  if (!privateIp(settings.VAULT_PRIVATE_IP)) throw new Error('Invalid VAULT_PRIVATE_IP')
  if (settings.APP_PRIVATE_IP === settings.VAULT_PRIVATE_IP)
    throw new Error('Vault must be on its own VM')
  if (!publicIp(settings.EGRESS_PROXY_IP)) throw new Error('Invalid EGRESS_PROXY_IP')
  const subnet = settings.LLM_OUT_SUBNET || '172.29.84.0/24'
  const gateway = settings.LLM_OUT_GATEWAY || '172.29.84.1'
  const [network, prefixLength, extra] = subnet.split('/')
  const bits = Number(prefixLength)
  if (
    extra !== undefined ||
    !privateIp(network) ||
    !/^\d{1,2}$/u.test(prefixLength ?? '') ||
    bits < 16 ||
    bits > 28 ||
    number(network) % 2 ** (32 - bits) !== 0 ||
    !privateIp(gateway) ||
    !inside(gateway, network, bits) ||
    number(gateway) === number(network) ||
    number(gateway) === number(network) + 2 ** (32 - bits) - 1 ||
    inside(settings.APP_PRIVATE_IP, network, bits) ||
    inside(settings.VAULT_PRIVATE_IP, network, bits)
  )
    throw new Error('Invalid LLM_OUT_SUBNET or LLM_OUT_GATEWAY')
  // The gateway/32 entry is the source llm sees after Docker's SNAT, for core and for every
  // other container of this VM alike. FORWARD still sees the source bridge: core is admitted
  // by it, so only the sandbox VM ranges remain as addresses.
  const clients = (settings.LLM_GATEWAY_CLIENTS ?? '').split(',')
  const sandbox = clients.filter((client) => client !== `${gateway}/32`)
  if (
    !sandbox.length ||
    new Set(clients).size !== clients.length ||
    sandbox.some((client) => {
      const [address, length, more] = client.split('/')
      const size = Number(length)
      return (
        more !== undefined ||
        !/^\d{1,2}$/u.test(length ?? '') ||
        size > 32 ||
        !privateIp(address) ||
        // A whole RFC 1918 block at most; canonical, so the listing equals what was written.
        size < (inside(address, '10.0.0.0', 8) ? 8 : inside(address, '172.16.0.0', 12) ? 12 : 16) ||
        number(address) % 2 ** (32 - size) !== 0 ||
        inside(settings.APP_PRIVATE_IP, address, size) ||
        inside(network, address, size) ||
        inside(address, network, bits)
      )
    })
  )
    throw new Error('Invalid LLM_GATEWAY_CLIENTS')
  return {
    enabled: true,
    bridges,
    core,
    proxy: settings.EGRESS_PROXY_IP,
    vault: settings.VAULT_PRIVATE_IP,
    subnet,
    gateway,
    sandbox,
  }
}

const match = (left, right) => ({ match: { op: '==', left, right } })
const meta = (key, value) => match({ meta: { key } }, value)
const state = (value) => match({ ct: { key: 'state' } }, value)
const payload = (protocol, field, value) => match({ payload: { protocol, field } }, value)
const accept = { accept: null }
const drop = { drop: null }

/** Exact objects expected from `nft --json list table inet raditi_llm`. */
export function firewallRules(config) {
  const table = { family: FAMILY, name: TABLE }
  const chain = (name, hook) => ({
    chain: {
      family: FAMILY,
      table: TABLE,
      name,
      ...(hook ? { type: 'filter', hook, prio: -10, policy: 'accept' } : {}),
    },
  })
  const rule = (name, ...expr) => ({
    rule: { family: FAMILY, table: TABLE, chain: name, expr },
  })
  const jump = (hook, bridge, target, key = 'iifname') =>
    rule(hook, meta(key, bridge), { jump: { target } })
  // nft lists a /32 as a plain address.
  const range = (cidr) => {
    const [addr, len] = cidr.split('/')
    return Number(len) === 32 ? addr : { prefix: { addr, len: Number(len) } }
  }
  const replies = (name) =>
    config.enabled
      ? [
          rule(name, meta('nfproto', 'ipv6'), drop),
          rule(name, state('invalid'), drop),
          rule(name, state({ set: ['established', 'related'] }), accept),
        ]
      : []
  return [
    { table },
    chain('input', 'input'),
    chain('forward', 'forward'),
    chain('from_host_bound'),
    chain('from_out'),
    chain('from_db'),
    chain('from_edge'),
    chain('to_llm'),
    ...Object.values(config.bridges).map((bridge) => jump('input', bridge, 'from_host_bound')),
    jump('forward', config.bridges.out, 'from_out'),
    jump('forward', config.bridges.db, 'from_db'),
    jump('forward', config.bridges.edge, 'from_edge'),
    // What did not leave an llm bridge above and enters one: the published gateway port (Docker
    // routes it into llm-out) and everything a sibling container or another host may try.
    ...Object.values(config.bridges).map((bridge) => jump('forward', bridge, 'to_llm', 'oifname')),
    ...replies('from_host_bound'),
    rule('from_host_bound', drop),
    ...replies('from_out'),
    ...(config.enabled
      ? [
          rule(
            'from_out',
            payload('ip', 'daddr', config.proxy),
            payload('tcp', 'dport', 443),
            accept,
          ),
          rule(
            'from_out',
            payload('ip', 'daddr', config.vault),
            payload('tcp', 'dport', 8200),
            accept,
          ),
        ]
      : []),
    rule('from_out', drop),
    ...replies('from_db'),
    ...(config.enabled
      ? [rule('from_db', meta('oifname', config.bridges.db), payload('tcp', 'dport', 5432), accept)]
      : []),
    rule('from_db', drop),
    ...replies('from_edge'),
    rule('from_edge', drop),
    ...replies('to_llm'),
    ...(config.enabled
      ? [
          rule(
            'to_llm',
            meta('oifname', config.bridges.out),
            meta('iifname', config.core),
            payload('tcp', 'dport', GATEWAY_PORT),
            accept,
          ),
          ...config.sandbox.map((cidr) =>
            rule(
              'to_llm',
              meta('oifname', config.bridges.out),
              payload('ip', 'saddr', range(cidr)),
              payload('tcp', 'dport', GATEWAY_PORT),
              accept,
            ),
          ),
        ]
      : []),
    rule('to_llm', drop),
  ]
}

/** Delete and recreate only our table, in one atomic nft transaction. */
export function renderFirewall(config, replace = false) {
  return JSON.stringify({
    nftables: [
      ...(replace ? [{ delete: { table: { family: FAMILY, name: TABLE } } }] : []),
      ...firewallRules(config).map((object) => ({ add: object })),
    ],
  })
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'handle')
        .map(([key, child]) => [key, normalize(child)]),
    )
  return value
}

export function checkFirewall(config, listed) {
  if (!listed || !Array.isArray(listed.nftables)) throw new Error('Missing llm firewall')
  const actual = normalize(listed.nftables.filter((entry) => !entry.metainfo))
  // nft lists each chain followed by its rules. Compare chains by name, preserve rule order
  // within a chain, and reject every unknown object, expression or extra rule.
  const grouped = (objects) =>
    Object.fromEntries(
      [...new Set(objects.map((entry) => Object.keys(entry)[0]))].sort().map((kind) => [
        kind,
        objects
          .filter((entry) => entry[kind])
          .map((entry) => entry[kind])
          .sort((a, b) => (a.name ?? a.chain).localeCompare(b.name ?? b.chain)),
      ]),
    )
  if (!isDeepStrictEqual(grouped(actual), grouped(firewallRules(config))))
    throw new Error('Llm firewall differs from the required policy')
}

/** Injectable commands keep tests in an owned container namespace, never the Docker host. */
export function manageFirewall(action, config, run) {
  if (!['apply', 'check'].includes(action)) throw new Error('Invalid action')
  const must = (binary, args, input) => {
    const result = run(binary, args, input)
    if (result.status !== 0) throw new Error(`Firewall command failed: ${binary}`)
    return result.stdout
  }
  const listed = () => run(NFT, ['--json', 'list', 'table', FAMILY, TABLE])
  if (action === 'apply') {
    must('/usr/sbin/modprobe', ['br_netfilter'])
    for (const name of BRIDGE_SYSCTLS) must(SYSCTL, ['-w', `${name}=1`])
    const old = listed()
    if (old.status !== 0) {
      // An absent table is expected only if listing the complete ruleset itself works.
      const all = JSON.parse(must(NFT, ['--json', 'list', 'ruleset']))
      if (
        all.nftables.some((entry) => entry.table?.family === FAMILY && entry.table?.name === TABLE)
      )
        throw new Error('Cannot read existing llm firewall')
    } else {
      const existing = JSON.parse(old.stdout)
      // Refuse a bridge rename while old containers may still use the previous boundary.
      const allowed = [...Object.values(config.bridges), config.core]
      for (const entry of existing.nftables)
        for (const expression of entry.rule?.expr ?? [])
          if (
            ['iifname', 'oifname'].includes(expression.match?.left?.meta?.key) &&
            !allowed.includes(expression.match.right)
          )
            throw new Error('Existing llm firewall protects different bridges')
    }
    must(NFT, ['--json', '--file', '-'], renderFirewall(config, old.status === 0))
  }
  for (const name of BRIDGE_SYSCTLS)
    if (must(SYSCTL, ['-n', name]).trim() !== '1')
      throw new Error('Bridge traffic does not enter the firewall')
  const current = listed()
  if (current.status !== 0) throw new Error('Missing llm firewall')
  checkFirewall(config, JSON.parse(current.stdout))
  return { enabled: config.enabled }
}

// Older nft versions reopen /dev/stdin for `--file -`; Node's child-process stdin is a
// socketpair and cannot be reopened that way. Use an owned mode-0600 regular file instead.
export function runFirewallCommand(binary, args, input) {
  let directory
  try {
    if (input !== undefined) {
      directory = mkdtempSync(join(tmpdir(), 'raditi-llm-rules-'))
      const path = join(directory, 'rules.json')
      writeFileSync(path, input, { mode: 0o600 })
      args = args.map((arg) => (arg === '-' ? path : arg))
    }
    return spawnSync(binary, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 })
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
}

// Not `import.meta.main`: it is absent before Node 22.18 and 24.2, where this file would load,
// skip the CLI and exit 0 — an "applied" boundary without a single rule. Both paths are
// resolved: the helper may be started through a symlink.
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  try {
    // The units name /usr/bin/node, where a distribution keeps its own older Node.
    if (!(Number(process.versions.node.split('.')[0]) >= 26))
      throw new Error('Node 26 or newer is required')
    const [action, flag, path, ...extra] = process.argv.slice(2)
    if (!['apply', 'check'].includes(action) || flag !== '--env-file' || !path || extra.length)
      throw new Error('Usage: llm-firewall.mjs apply|check --env-file PATH')
    const config = firewallConfig(readFileSync(path, 'utf8'))
    if (process.platform !== 'linux' || process.getuid?.() !== 0)
      throw new Error('The llm firewall requires Linux and root')
    const result = manageFirewall(action, config, runFirewallCommand)
    console.log(
      result.enabled
        ? `llm-firewall: ${action} ok`
        : `llm-firewall: ${action} ok; disabled profile denies all llm bridge traffic`,
    )
  } catch (error) {
    console.error(`llm-firewall: ${error.message}`)
    process.exitCode = 1
  }
}
