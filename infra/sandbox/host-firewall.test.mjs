import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hostFirewall } from './host-firewall.mjs'

const live = 'rdx0123456789ab'
const gone = 'rdxffffffffffff'

/** In-memory iptables: one INPUT chain per binary, rules as `-A` lines. */
function fakeTables({ fail = () => false } = {}) {
  const chains = new Map()
  const calls = []
  const run = (binary, args) => {
    calls.push([binary.split('/').pop(), ...args.slice(2)])
    assert.deepEqual(args.slice(0, 2), ['--wait', '5'])
    const [op, ...spec] = args.slice(2)
    const rules = chains.get(binary) ?? []
    chains.set(binary, rules)
    if (fail(op, binary)) return { status: 1, stdout: '' }
    if (op === '-S') return { status: 0, stdout: ['-P INPUT ACCEPT', ...rules].join('\n') }
    const line = `-A ${spec.join(' ')}`
    const index = rules.indexOf(line)
    if (op === '-C') return { status: index >= 0 ? 0 : 1, stdout: '' }
    if (op === '-I') rules.unshift(line)
    else if (op === '-D' && index >= 0) rules.splice(index, 1)
    else return { status: 1, stdout: '' }
    return { status: 0, stdout: '' }
  }
  return { run, chains, calls }
}
const bridgeExists = (name) => name === live

test('install drops orphaned rules, then inserts the attempt rule once for IPv4 and IPv6', () => {
  const tables = fakeTables()
  tables.chains.set('/usr/sbin/iptables', [
    `-A INPUT -i ${gone} -j DROP`,
    `-A INPUT -i ${gone} -j DROP`,
    '-A INPUT -i eth0 -j ACCEPT',
  ])
  const firewall = hostFirewall({ run: tables.run, bridgeExists, ipv6: true })
  firewall.install(live)
  firewall.install(live)
  assert.deepEqual(tables.chains.get('/usr/sbin/iptables'), [
    `-A INPUT -i ${live} -j DROP`,
    '-A INPUT -i eth0 -j ACCEPT',
  ])
  assert.deepEqual(tables.chains.get('/usr/sbin/ip6tables'), [`-A INPUT -i ${live} -j DROP`])
})

test('sweep keeps rules of live bridges and ignores foreign rules', () => {
  const tables = fakeTables()
  const rules = [`-A INPUT -i ${live} -j DROP`, '-A INPUT -i rdx-other -j DROP']
  tables.chains.set('/usr/sbin/iptables', [...rules])
  hostFirewall({ run: tables.run, bridgeExists, ipv6: false }).sweep()
  assert.deepEqual(tables.chains.get('/usr/sbin/iptables'), rules)
  assert.ok(tables.calls.every(([binary]) => binary === 'iptables'))
})

test('install fails closed for unknown bridges and failed commands', () => {
  const firewall = hostFirewall({ ...fakeTables(), bridgeExists, ipv6: false })
  for (const bridge of [gone, 'docker0', `${live}; true`, undefined])
    assert.throws(() => firewall.install(bridge), /Unknown sandbox bridge/)
  for (const failing of ['-S', '-I']) {
    const tables = fakeTables({ fail: (op) => op === failing })
    assert.throws(() => hostFirewall({ run: tables.run, bridgeExists, ipv6: false }).install(live))
  }
  const tables = fakeTables({ fail: (op, binary) => op === '-I' && binary.endsWith('ip6tables') })
  assert.throws(() => hostFirewall({ run: tables.run, bridgeExists, ipv6: true }).install(live))
})
