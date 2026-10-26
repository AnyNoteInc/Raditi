/* global console, process */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isIPv4, isIPv6 } from 'node:net'

// Trusted host-side rules for the bridges of sandboxes (spec §8). Runs briefly in the host network
// namespace with NET_ADMIN only and never sees the Docker socket.
//
// Attempt bridges (rdx…) and the browsers' bridges (rpb…, of previews and of browser sessions)
// under runsc: gVisor's netstack sends frames past the netfilter hooks of the sandbox's own
// namespace, so the host drops everything such a bridge sends to the host itself (`INPUT -i
// <bridge> -j DROP`). Bridged sandbox → gateway traffic does not pass INPUT.
//
// Preview bridges (rpv…, docs/plan/58-preview-single-container.md, §10): the one container of a
// preview stands on a bridge that is not internal — Docker publishes no port of an internal network
// — and its PHP reaches the open internet (owner's answer of 26.10.2026). These rules are its
// boundary, under runc and runsc alike: the host itself only answers connections it opened
// (`RADITI-IN-<bridge>` from INPUT), and forwarding out of the bridge goes on to Docker's own rules
// only towards public addresses (`RADITI-<bridge>` from DOCKER-USER): private, loopback,
// link-local, CGNAT, documentation, benchmark, multicast and reserved ranges and the platform's
// subnets (`--refuse`) are dropped. IPv6 of the bridge is dropped whole. The chains are rebuilt
// under a temporary DROP of the bridge, so a repair never leaves a moment without the boundary,
// and a rebuild that fails leaves that DROP in place: the bridge stays closed.
export const BRIDGE = /^r(?:dx|pv|pb)[0-9a-f]{12}$/
const PREVIEW_BRIDGE = /^rpv[0-9a-f]{12}$/
/** The single rule of attempt and browser bridges, of preview bridges before plan 58, of IPv6. */
const DROP_RULE = /^-A (INPUT|FORWARD|DOCKER-USER) -i (r(?:dx|pv|pb)[0-9a-f]{12}) -j DROP$/
const HOOK_RULE =
  /^-A (INPUT|DOCKER-USER) -i (rpv[0-9a-f]{12}) -j (RADITI-(?:IN-)?rpv[0-9a-f]{12})$/
const CHAIN = /^-N (RADITI-(?:IN-)?(rpv[0-9a-f]{12}))$/

/** Destinations a preview never reaches: everything that is not the public internet (IPv4). */
export const NON_PUBLIC = Object.freeze([
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
])
const MAX_REFUSE = 64

/** `a.b.c.d/n` with the host bits cleared, as iptables prints it; null for anything else. */
export function ipv4Cidr(value) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value ?? '')
  if (!match || !isIPv4(match[1]) || Number(match[2]) > 32) return null
  const bits = Number(match[2])
  const address = match[1].split('.').reduce((sum, octet) => sum * 256 + Number(octet), 0)
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  const network = (address & mask) >>> 0
  return `${[24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join('.')}/${bits}`
}

/**
 * The subnets of `--refuse`, comma-separated: IPv4 ones are dropped by the bridge's chain, IPv6
 * ones change nothing (IPv6 of the bridge is dropped whole). Anything else is an error.
 */
export function parseRefuse(value) {
  if (value === undefined || value === '') return []
  const items = value.split(',')
  if (items.length > MAX_REFUSE) throw new Error('Too many refused subnets')
  const ipv4 = []
  for (const item of items) {
    const cidr = ipv4Cidr(item)
    if (cidr) {
      if (!ipv4.includes(cidr)) ipv4.push(cidr)
      continue
    }
    const [address, bits] = item.split('/')
    if (!isIPv6(address ?? '') || !/^\d{1,3}$/.test(bits ?? '') || Number(bits) > 128)
      throw new Error('Invalid refused subnet')
  }
  return ipv4
}

export function hostFirewall({ run, bridgeExists, ipv6 }) {
  const iptables = '/usr/sbin/iptables'
  const ip6tables = '/usr/sbin/ip6tables'
  const binaries = [iptables, ...(ipv6 ? [ip6tables] : [])]
  const call = (binary, ...args) => run(binary, ['--wait', '5', ...args])
  const must = (result) => {
    if (result.status !== 0) throw new Error('Host firewall command failed')
    return result
  }
  const has = (binary, chain, rule) => call(binary, '-C', chain, ...rule).status === 0
  const lines = (binary, chain) =>
    must(call(binary, '-S', ...(chain ? [chain] : [])))
      .stdout.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  /** Removes every copy of a rule; a copy another sweep removed first is not an error. */
  const remove = (binary, chain, rule) => {
    for (let attempt = 0; attempt < 8 && has(binary, chain, rule); attempt++)
      call(binary, '-D', chain, ...rule)
    if (has(binary, chain, rule)) throw new Error('Host firewall rule is still present')
  }

  const dropRule = (bridge) => ['-i', bridge, '-j', 'DROP']
  const inChain = (bridge) => `RADITI-IN-${bridge}`
  const outChain = (bridge) => `RADITI-${bridge}`
  /** The rules of the two chains of a preview bridge, in order, as `iptables -S` prints them. */
  const previewChains = (bridge, refuse) => ({
    [inChain(bridge)]: [
      ['-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED', '-j', 'ACCEPT'],
      ['-j', 'DROP'],
    ],
    [outChain(bridge)]: [
      ['-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED', '-j', 'RETURN'],
      ...[...NON_PUBLIC, ...refuse.filter((cidr) => !NON_PUBLIC.includes(cidr))].map((cidr) => [
        '-d',
        cidr,
        '-j',
        'DROP',
      ]),
      ['-j', 'RETURN'],
    ],
  })
  const hooks = (bridge) => [
    ['INPUT', ['-i', bridge, '-j', inChain(bridge)]],
    ['DOCKER-USER', ['-i', bridge, '-j', outChain(bridge)]],
  ]
  /** IPv6 of a preview bridge: nothing to the host, nothing forwarded. */
  const ipv6Drops = (bridge) => [
    ['INPUT', dropRule(bridge)],
    ['FORWARD', dropRule(bridge)],
  ]

  const chainExists = (binary, chain) => call(binary, '-S', chain).status === 0
  const sameRules = (chain, rules) => {
    if (!chainExists(iptables, chain)) return false
    const shown = lines(iptables, chain).filter((line) => line.startsWith('-A '))
    return (
      shown.length === rules.length &&
      rules.every((rule, index) => shown[index] === ['-A', chain, ...rule].join(' '))
    )
  }
  /** Docker's own hook: DOCKER-USER exists and FORWARD sends every packet through it. */
  const dockerUser = () => {
    if (!chainExists(iptables, 'DOCKER-USER') || !has(iptables, 'FORWARD', ['-j', 'DOCKER-USER']))
      throw new Error("Docker's DOCKER-USER chain is missing: its iptables rules are required")
  }
  /**
   * A hook is in place when it is there once and nothing above it lets the bridge's packets by:
   * only hooks of other preview bridges and DROP rules of bridges may stand before it.
   */
  const hookFirst = (chain, bridge, rule) => {
    const shown = lines(iptables, chain).filter((line) => line.startsWith(`-A ${chain} `))
    const text = ['-A', chain, ...rule].join(' ')
    const at = shown.indexOf(text)
    if (at < 0 || shown.lastIndexOf(text) !== at) return false
    return shown.slice(0, at).every((line) => {
      const hook = HOOK_RULE.exec(line)
      return (hook !== null && hook[2] !== bridge) || DROP_RULE.test(line)
    })
  }
  const previewState = (bridge, refuse) =>
    Object.entries(previewChains(bridge, refuse)).every(([chain, rules]) =>
      sameRules(chain, rules),
    ) &&
    hooks(bridge).every(([chain, rule]) => hookFirst(chain, bridge, rule)) &&
    // The single DROP of a preview bridge before plan 58 would drop the host's own replies.
    !has(iptables, 'INPUT', dropRule(bridge)) &&
    !has(iptables, 'DOCKER-USER', dropRule(bridge)) &&
    (!ipv6 || ipv6Drops(bridge).every(([chain, rule]) => has(ip6tables, chain, rule)))

  /** Drops the rules and chains of bridges that are gone; a live bridge is never touched. */
  const sweep = () => {
    for (const binary of binaries) {
      const all = lines(binary)
      for (const line of all) {
        const drop = DROP_RULE.exec(line)
        if (drop && !bridgeExists(drop[2])) remove(binary, drop[1], dropRule(drop[2]))
        const hook = HOOK_RULE.exec(line)
        if (hook && !bridgeExists(hook[2])) remove(binary, hook[1], ['-i', hook[2], '-j', hook[3]])
      }
      for (const line of all) {
        const chain = CHAIN.exec(line)
        if (!chain || bridgeExists(chain[2])) continue
        // Another sweep may have removed it first.
        if (!chainExists(binary, chain[1])) continue
        must(call(binary, '-F', chain[1]))
        must(call(binary, '-X', chain[1]))
      }
    }
  }
  const known = (bridge) => {
    // The rules are keyed by interface name: they protect only if that bridge already exists.
    if (!BRIDGE.test(bridge ?? '') || !bridgeExists(bridge))
      throw new Error('Unknown sandbox bridge')
  }

  const installPreview = (bridge, refuse) => {
    dockerUser()
    if (ipv6)
      for (const [chain, rule] of ipv6Drops(bridge))
        if (!has(ip6tables, chain, rule)) must(call(ip6tables, '-I', chain, '1', ...rule))
    if (previewState(bridge, refuse)) return
    // While the chains are rebuilt the bridge reaches neither the host nor anything forwarded.
    const guards = [
      ['INPUT', dropRule(bridge)],
      ['DOCKER-USER', dropRule(bridge)],
    ]
    for (const [chain, rule] of guards) {
      remove(iptables, chain, rule)
      must(call(iptables, '-I', chain, '1', ...rule))
    }
    for (const [chain, rules] of Object.entries(previewChains(bridge, refuse))) {
      if (!chainExists(iptables, chain)) must(call(iptables, '-N', chain))
      must(call(iptables, '-F', chain))
      for (const rule of rules) must(call(iptables, '-A', chain, ...rule))
    }
    // The hooks go right under the guards, which leave next: above everything else.
    for (const [chain, rule] of hooks(bridge)) {
      remove(iptables, chain, rule)
      must(call(iptables, '-I', chain, '2', ...rule))
    }
    // Only now: a build that failed half-way leaves the bridge closed, and the next install
    // takes the guards away with the repair.
    for (const [chain, rule] of guards) remove(iptables, chain, rule)
    if (!previewState(bridge, refuse)) throw new Error('Host firewall rules did not take')
  }

  const check = (bridge, refuse = []) => {
    known(bridge)
    if (PREVIEW_BRIDGE.test(bridge)) {
      dockerUser()
      if (!previewState(bridge, refuse)) throw new Error('Host firewall rule is missing')
      return
    }
    for (const binary of binaries)
      if (!has(binary, 'INPUT', dropRule(bridge))) throw new Error('Host firewall rule is missing')
  }
  return {
    sweep,
    check,
    install(bridge, refuse = []) {
      known(bridge)
      try {
        sweep()
      } catch {
        // Leftovers of other bridges only concern bridges that no longer exist.
      }
      if (PREVIEW_BRIDGE.test(bridge)) {
        installPreview(bridge, refuse)
        return
      }
      if (refuse.length) throw new Error('Refused subnets are for preview bridges only')
      for (const binary of binaries)
        if (!has(binary, 'INPUT', dropRule(bridge)))
          must(call(binary, '-I', 'INPUT', ...dropRule(bridge)))
      check(bridge)
    },
  }
}

/** `install|check <bridge> [--refuse <cidr,…>]` or `sweep`; anything else is a usage error. */
export function parseArgs(argv) {
  const [action, bridge, ...rest] = argv
  if (action === 'sweep' && bridge === undefined) return { action }
  if ((action === 'install' || action === 'check') && typeof bridge === 'string') {
    if (rest.length === 0) return { action, bridge, refuse: [] }
    if (rest.length === 2 && rest[0] === '--refuse')
      return { action, bridge, refuse: parseRefuse(rest[1]) }
  }
  throw new Error('Usage: host-firewall.mjs install|check <bridge> [--refuse <cidr,…>] | sweep')
}

if (process.argv[1]?.endsWith('/host-firewall.mjs')) {
  const firewall = hostFirewall({
    run: (binary, args) =>
      spawnSync(binary, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 }),
    bridgeExists: (name) => BRIDGE.test(name) && existsSync(`/sys/class/net/${name}`),
    ipv6: existsSync('/proc/net/if_inet6'),
  })
  try {
    const { action, bridge, refuse } = parseArgs(process.argv.slice(2))
    if (action === 'sweep') firewall.sweep()
    else firewall[action](bridge, refuse)
  } catch {
    console.error('Host firewall update failed')
    process.exitCode = 1
  }
}
