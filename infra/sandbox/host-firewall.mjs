/* global console, process */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

// Trusted host-side backstop for runsc sandboxes (spec §8). gVisor's netstack sends frames past
// the netfilter hooks of the sandbox's own namespace, so the host drops everything an attempt
// bridge sends to the host itself. Runs briefly in the host network namespace with NET_ADMIN
// only and never sees the Docker socket. Bridged sandbox → gateway traffic does not pass INPUT.
export const BRIDGE = /^rdx[0-9a-f]{12}$/
const RULE = /^-A INPUT -i (rdx[0-9a-f]{12}) -j DROP$/

export function hostFirewall({ run, bridgeExists, ipv6 }) {
  const binaries = ['/usr/sbin/iptables', ...(ipv6 ? ['/usr/sbin/ip6tables'] : [])]
  const call = (binary, ...args) => run(binary, ['--wait', '5', ...args])
  const rule = (bridge) => ['INPUT', '-i', bridge, '-j', 'DROP']
  const has = (binary, bridge) => call(binary, '-C', ...rule(bridge)).status === 0
  const must = (result) => {
    if (result.status !== 0) throw new Error('Host firewall command failed')
    return result
  }
  const remove = (binary, bridge) => {
    // A rule may have been inserted twice by an interrupted install; remove every copy. A
    // concurrent sweep may delete it first, so a failed -D counts only if the rule is still there.
    for (let attempt = 0; attempt < 8 && has(binary, bridge); attempt++)
      call(binary, '-D', ...rule(bridge))
    if (has(binary, bridge)) throw new Error('Host firewall rule is still present')
  }
  /** Drops rules whose bridge is gone; a live attempt's rule is never touched. */
  const sweep = () => {
    for (const binary of binaries)
      for (const line of must(call(binary, '-S', 'INPUT')).stdout.split('\n')) {
        const bridge = RULE.exec(line.trim())?.[1]
        if (bridge && !bridgeExists(bridge)) remove(binary, bridge)
      }
  }
  const known = (bridge) => {
    // The rule is keyed by interface name: it protects only if that bridge already exists.
    if (!BRIDGE.test(bridge ?? '') || !bridgeExists(bridge))
      throw new Error('Unknown sandbox bridge')
  }
  const check = (bridge) => {
    known(bridge)
    for (const binary of binaries)
      if (!has(binary, bridge)) throw new Error('Host firewall rule is missing')
  }
  return {
    sweep,
    check,
    install(bridge) {
      known(bridge)
      try {
        sweep()
      } catch {
        // Leftovers of other attempts only drop traffic of bridges that no longer exist.
      }
      for (const binary of binaries)
        if (!has(binary, bridge)) must(call(binary, '-I', ...rule(bridge)))
      check(bridge)
    },
  }
}

if (process.argv[1]?.endsWith('/host-firewall.mjs')) {
  const [action, bridge, ...rest] = process.argv.slice(2)
  const firewall = hostFirewall({
    run: (binary, args) =>
      spawnSync(binary, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 }),
    bridgeExists: (name) => BRIDGE.test(name) && existsSync(`/sys/class/net/${name}`),
    ipv6: existsSync('/proc/net/if_inet6'),
  })
  try {
    if (action === 'install' && rest.length === 0) firewall.install(bridge)
    else if (action === 'sweep' && bridge === undefined) firewall.sweep()
    else throw new Error('Usage: host-firewall.mjs install <bridge> | sweep')
  } catch {
    console.error('Host firewall update failed')
    process.exitCode = 1
  }
}
