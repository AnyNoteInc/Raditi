import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hostFirewall, ipv4Cidr, NON_PUBLIC, parseArgs, parseRefuse } from './host-firewall.mjs'

const live = 'rdx0123456789ab'
const gone = 'rdxffffffffffff'
const preview = 'rpv0123456789ab'
const previewGone = 'rpvffffffffffff'

/**
 * In-memory iptables of one family: chains with their rules as `-A` lines, the way `-S` prints
 * them. Built-in chains print a policy line, user chains a `-N` line; `-S` of every chain lists
 * them in creation order. `docker: false` — a daemon without DOCKER-USER.
 */
function family({ docker = true } = {}) {
  const chains = new Map([
    ['INPUT', []],
    ['FORWARD', docker ? ['-A FORWARD -j DOCKER-USER', '-A FORWARD -j DOCKER-FORWARD'] : []],
    ['OUTPUT', []],
  ])
  const builtIn = new Set(['INPUT', 'FORWARD', 'OUTPUT'])
  if (docker) chains.set('DOCKER-USER', ['-A DOCKER-USER -i eth0 -j ACCEPT'])
  return { chains, builtIn }
}

function fakeTables({ fail = () => false, docker = true } = {}) {
  const families = new Map()
  const calls = []
  const of = (binary) => {
    if (!families.has(binary)) families.set(binary, family({ docker }))
    return families.get(binary)
  }
  const show = ({ chains, builtIn }, name) =>
    [builtIn.has(name) ? `-P ${name} ACCEPT` : `-N ${name}`, ...chains.get(name)].join('\n')
  const run = (binary, args) => {
    const name = binary.split('/').pop()
    calls.push([name, ...args.slice(2)])
    assert.deepEqual(args.slice(0, 2), ['--wait', '5'])
    const [op, chain, ...rest] = args.slice(2)
    const tables = of(binary)
    if (fail(op, name, chain)) return { status: 1, stdout: '' }
    const rules = tables.chains.get(chain)
    if (op === '-S') {
      if (chain === undefined)
        return {
          status: 0,
          stdout: [...tables.chains.keys()].map((c) => show(tables, c)).join('\n'),
        }
      return rules ? { status: 0, stdout: show(tables, chain) } : { status: 1, stdout: '' }
    }
    if (op === '-N') {
      if (rules) return { status: 1, stdout: '' }
      tables.chains.set(chain, [])
      return { status: 0, stdout: '' }
    }
    if (!rules) return { status: 1, stdout: '' }
    if (op === '-F') rules.splice(0)
    else if (op === '-X') {
      if (rules.length) return { status: 1, stdout: '' }
      tables.chains.delete(chain)
    } else {
      const position = op === '-I' && /^\d+$/.test(rest[0] ?? '') ? Number(rest.shift()) : 1
      const line = `-A ${chain} ${rest.join(' ')}`
      const index = rules.indexOf(line)
      if (op === '-C') return { status: index >= 0 ? 0 : 1, stdout: '' }
      if (op === '-I') rules.splice(position - 1, 0, line)
      else if (op === '-A') rules.push(line)
      else if (op === '-D' && index >= 0) rules.splice(index, 1)
      else return { status: 1, stdout: '' }
    }
    return { status: 0, stdout: '' }
  }
  const v4 = () => of('/usr/sbin/iptables').chains
  const v6 = () => of('/usr/sbin/ip6tables').chains
  return { run, calls, v4, v6 }
}
const bridgeExists = (name) => [live, preview, 'rpb0123456789ab'].includes(name)

// --- attempt and browser bridges: one INPUT DROP, as before plan 58 -----------------------------

test('install drops orphaned rules, then inserts the attempt rule once for IPv4 and IPv6', () => {
  const tables = fakeTables()
  tables.v4().get('INPUT').push(`-A INPUT -i ${gone} -j DROP`, `-A INPUT -i ${gone} -j DROP`)
  tables.v4().get('INPUT').push('-A INPUT -i eth0 -j ACCEPT')
  const firewall = hostFirewall({ run: tables.run, bridgeExists, ipv6: true })
  firewall.install(live)
  firewall.install(live)
  assert.deepEqual(tables.v4().get('INPUT'), [
    `-A INPUT -i ${live} -j DROP`,
    '-A INPUT -i eth0 -j ACCEPT',
  ])
  assert.deepEqual(tables.v6().get('INPUT'), [`-A INPUT -i ${live} -j DROP`])
})

test('sweep keeps rules of live bridges and ignores foreign rules', () => {
  const tables = fakeTables()
  const rules = [`-A INPUT -i ${live} -j DROP`, '-A INPUT -i rdx-other -j DROP']
  tables
    .v4()
    .get('INPUT')
    .push(...rules)
  hostFirewall({ run: tables.run, bridgeExists, ipv6: false }).sweep()
  assert.deepEqual(tables.v4().get('INPUT'), rules)
  assert.ok(tables.calls.every(([binary]) => binary === 'iptables'))
})

test('install fails closed for unknown bridges and failed commands', () => {
  const firewall = hostFirewall({ run: fakeTables().run, bridgeExists, ipv6: false })
  for (const bridge of [gone, 'docker0', `${live}; true`, undefined])
    assert.throws(() => firewall.install(bridge), /Unknown sandbox bridge/)
  const failing = fakeTables({ fail: (op) => op === '-I' })
  assert.throws(() => hostFirewall({ run: failing.run, bridgeExists, ipv6: false }).install(live))
  const tables = fakeTables({ fail: (op, binary) => op === '-I' && binary === 'ip6tables' })
  assert.throws(() => hostFirewall({ run: tables.run, bridgeExists, ipv6: true }).install(live))
  // Refused subnets are a preview's: an attempt bridge takes none.
  assert.throws(() => firewall.install(live, ['192.0.2.0/24']), /preview bridges only/)
})

test('a failed sweep of other bridges does not block installing this rule', () => {
  const tables = fakeTables({ fail: (op, _binary, chain) => op === '-S' && chain === undefined })
  const firewall = hostFirewall({ run: tables.run, bridgeExists, ipv6: false })
  assert.throws(() => firewall.sweep())
  firewall.install(live)
  assert.deepEqual(tables.v4().get('INPUT'), [`-A INPUT -i ${live} -j DROP`])
})

test('concurrent sweeps: a rule deleted by the other one is not an error', () => {
  const tables = fakeTables()
  tables.v4().get('INPUT').push(`-A INPUT -i ${gone} -j DROP`)
  // The other sweep wins the race: the rule is gone by the time this -D runs.
  const run = (binary, args) => {
    if (args[2] !== '-D') return tables.run(binary, args)
    tables.v4().get('INPUT').splice(0)
    return { status: 1, stdout: '' }
  }
  hostFirewall({ run, bridgeExists, ipv6: false }).sweep()
  assert.deepEqual(tables.v4().get('INPUT'), [])
  // A -D that fails while the rule stays is still an error.
  const stuck = fakeTables({ fail: (op) => op === '-D' })
  stuck.v4().get('INPUT').push(`-A INPUT -i ${gone} -j DROP`)
  assert.throws(() => hostFirewall({ run: stuck.run, bridgeExists, ipv6: false }).sweep())
})

test('check requires the rule of a live attempt bridge in every family', () => {
  const tables = fakeTables()
  const firewall = hostFirewall({ run: tables.run, bridgeExists, ipv6: true })
  assert.throws(() => firewall.check(live), /missing/)
  firewall.install(live)
  firewall.check(live)
  tables.v6().set('INPUT', [])
  assert.throws(() => firewall.check(live), /missing/)
  assert.throws(() => firewall.check(gone), /Unknown sandbox bridge/)
})

test('browser bridges keep the single DROP; malformed names are refused', () => {
  const tables = fakeTables()
  const firewall = hostFirewall({ run: tables.run, bridgeExists, ipv6: false })
  firewall.install('rpb0123456789ab')
  assert.deepEqual(tables.v4().get('INPUT'), ['-A INPUT -i rpb0123456789ab -j DROP'])
  for (const bridge of ['rpx0123456789ab', 'rpv0123456789AB', 'rpv0123456789abc'])
    assert.throws(() => firewall.install(bridge), /Unknown sandbox bridge/)
  // A gone browser bridge is swept like a gone attempt bridge.
  tables.v4().get('INPUT').push('-A INPUT -i rpbffffffffffff -j DROP')
  firewall.sweep()
  assert.deepEqual(tables.v4().get('INPUT'), ['-A INPUT -i rpb0123456789ab -j DROP'])
})

// --- preview bridges: the boundary of the one container of a preview (plan 58) ----------------

const outChain = `RADITI-${preview}`
const inChain = `RADITI-IN-${preview}`
const expectedOut = (refuse = []) => [
  `-A ${outChain} -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN`,
  ...[...NON_PUBLIC, ...refuse].map((cidr) => `-A ${outChain} -d ${cidr} -j DROP`),
  `-A ${outChain} -j RETURN`,
]

test('a preview bridge gets its two chains, hooked above everything, and IPv6 dropped whole', () => {
  const tables = fakeTables()
  const firewall = hostFirewall({ run: tables.run, bridgeExists, ipv6: true })
  firewall.install(preview, ['203.0.113.0/24', '81.0.0.0/8'])
  assert.deepEqual(tables.v4().get(inChain), [
    `-A ${inChain} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
    `-A ${inChain} -j DROP`,
  ])
  // A refused subnet that is already non-public is not repeated.
  assert.deepEqual(tables.v4().get(outChain), expectedOut(['81.0.0.0/8']))
  assert.deepEqual(tables.v4().get('INPUT'), [`-A INPUT -i ${preview} -j ${inChain}`])
  assert.deepEqual(tables.v4().get('DOCKER-USER'), [
    `-A DOCKER-USER -i ${preview} -j ${outChain}`,
    '-A DOCKER-USER -i eth0 -j ACCEPT',
  ])
  assert.deepEqual(tables.v6().get('INPUT'), [`-A INPUT -i ${preview} -j DROP`])
  assert.deepEqual(tables.v6().get('FORWARD').slice(0, 1), [`-A FORWARD -i ${preview} -j DROP`])
  firewall.check(preview, ['203.0.113.0/24', '81.0.0.0/8'])
  // Installed as it is: the next install changes nothing.
  const writes = tables.calls.length
  firewall.install(preview, ['203.0.113.0/24', '81.0.0.0/8'])
  assert.ok(
    tables.calls.slice(writes).every(([, op]) => ['-S', '-C'].includes(op)),
    'a second install only reads',
  )
})

test('check of a preview bridge sees every way the boundary can be off; install mends each', () => {
  const breakers = {
    'a rule deleted': (t) => t.v4().get(outChain).splice(3, 1),
    'a rule added': (t) => t.v4().get(outChain).push(`-A ${outChain} -j ACCEPT`),
    'the rules reordered': (t) => t.v4().get(outChain).reverse(),
    'the INPUT chain emptied': (t) => t.v4().get(inChain).splice(0),
    'the hook gone': (t) => t.v4().set('DOCKER-USER', ['-A DOCKER-USER -i eth0 -j ACCEPT']),
    'the hook below an ACCEPT': (t) => t.v4().get('DOCKER-USER').reverse(),
    'the hook twice': (t) => t.v4().get('INPUT').push(`-A INPUT -i ${preview} -j ${inChain}`),
    'a left-over guard': (t) => t.v4().get('INPUT').unshift(`-A INPUT -i ${preview} -j DROP`),
    'the IPv6 drop gone': (t) => t.v6().set('FORWARD', []),
    'the chain gone': (t) => {
      t.v4().set('INPUT', [])
      t.v4().delete(inChain)
    },
  }
  for (const [name, breakIt] of Object.entries(breakers)) {
    const tables = fakeTables()
    const firewall = hostFirewall({ run: tables.run, bridgeExists, ipv6: true })
    firewall.install(preview)
    breakIt(tables)
    assert.throws(() => firewall.check(preview), /missing/, name)
    firewall.install(preview)
    firewall.check(preview)
    assert.deepEqual(tables.v4().get(outChain), expectedOut(), name)
  }
})

test('check of a preview bridge holds it to the refused subnets it was installed with', () => {
  const tables = fakeTables()
  const firewall = hostFirewall({ run: tables.run, bridgeExists, ipv6: false })
  firewall.install(preview, ['81.0.0.0/8'])
  firewall.check(preview, ['81.0.0.0/8'])
  assert.throws(() => firewall.check(preview), /missing/)
  assert.throws(() => firewall.check(preview, ['82.0.0.0/8']), /missing/)
})

test('the single DROP of a preview bridge before plan 58 goes: it would drop the host’s replies', () => {
  const tables = fakeTables()
  tables.v4().get('INPUT').push(`-A INPUT -i ${preview} -j DROP`)
  const firewall = hostFirewall({ run: tables.run, bridgeExists, ipv6: false })
  firewall.install(preview)
  assert.deepEqual(tables.v4().get('INPUT'), [`-A INPUT -i ${preview} -j ${inChain}`])
})

test('a rebuild that fails half-way leaves the preview bridge closed; the next one mends it', () => {
  const tables = fakeTables()
  let failing = true
  const run = (binary, args) =>
    failing && args[2] === '-A' && args[3] === outChain && args.includes('10.0.0.0/8')
      ? { status: 1, stdout: '' }
      : tables.run(binary, args)
  const firewall = hostFirewall({ run, bridgeExists, ipv6: false })
  assert.throws(() => firewall.install(preview))
  // The guards stay: nothing of the bridge reaches the host or is forwarded.
  assert.equal(tables.v4().get('INPUT')[0], `-A INPUT -i ${preview} -j DROP`)
  assert.equal(tables.v4().get('DOCKER-USER')[0], `-A DOCKER-USER -i ${preview} -j DROP`)
  assert.throws(() => firewall.check(preview), /missing/)
  failing = false
  firewall.install(preview)
  firewall.check(preview)
  assert.deepEqual(tables.v4().get('INPUT'), [`-A INPUT -i ${preview} -j ${inChain}`])
})

test('a preview bridge needs Docker’s DOCKER-USER chain and the jump to it from FORWARD', () => {
  const missing = fakeTables({ docker: false })
  const firewall = hostFirewall({ run: missing.run, bridgeExists, ipv6: false })
  assert.throws(() => firewall.install(preview), /DOCKER-USER/)
  // Nothing was written: a chain of our own would never be jumped to.
  assert.equal(missing.v4().has(outChain), false)
  const unhooked = fakeTables()
  unhooked.v4().set('FORWARD', [])
  assert.throws(
    () => hostFirewall({ run: unhooked.run, bridgeExists, ipv6: false }).install(preview),
    /DOCKER-USER/,
  )
})

test('sweep removes the hooks, chains and guards of gone preview bridges, keeps live ones', () => {
  const tables = fakeTables()
  const firewall = hostFirewall({
    run: tables.run,
    bridgeExists: (name) => [preview, previewGone].includes(name),
    ipv6: true,
  })
  firewall.install(previewGone)
  firewall.install(preview)
  tables.v4().get('INPUT').push(`-A INPUT -i ${previewGone} -j DROP`)
  const swept = hostFirewall({ run: tables.run, bridgeExists, ipv6: true })
  swept.sweep()
  for (const [chain, rules] of [...tables.v4(), ...tables.v6()])
    assert.ok(
      !rules.some((rule) => rule.includes(previewGone)) && !chain.includes(previewGone),
      chain,
    )
  swept.check(preview)
})

test('sweep: a chain another sweep removed meanwhile is skipped, a stuck one is an error', () => {
  const tables = fakeTables()
  tables.v4().set(`RADITI-${previewGone}`, [])
  // The other sweep removed it between the listing and this one's look at it.
  let listed = false
  const racing = (binary, args) => {
    const result = tables.run(binary, args)
    if (args[2] === '-S' && args[3] === undefined && !listed) {
      listed = true
      tables.v4().delete(`RADITI-${previewGone}`)
    }
    return result
  }
  hostFirewall({ run: racing, bridgeExists, ipv6: false }).sweep()
  const stuck = fakeTables({ fail: (op) => op === '-X' })
  stuck.v4().set(`RADITI-${previewGone}`, [])
  assert.throws(() => hostFirewall({ run: stuck.run, bridgeExists, ipv6: false }).sweep())
})

// --- the command line ---------------------------------------------------------------------------

test('arguments: install and check take one bridge and an optional refuse list, sweep none', () => {
  assert.deepEqual(parseArgs(['sweep']), { action: 'sweep' })
  assert.deepEqual(parseArgs(['install', preview]), {
    action: 'install',
    bridge: preview,
    refuse: [],
  })
  assert.deepEqual(parseArgs(['check', preview, '--refuse', '81.2.3.4/8,fd00::/8']), {
    action: 'check',
    bridge: preview,
    refuse: ['81.0.0.0/8'],
  })
  for (const argv of [
    [],
    ['sweep', preview],
    ['install'],
    ['install', preview, '--refuse'],
    ['install', preview, '--refuse 81.0.0.0/8'],
    ['install', preview, '--other', '81.0.0.0/8'],
    ['remove', preview],
  ])
    assert.throws(() => parseArgs(argv), /Usage/, argv.join(' '))
})

test('refused subnets: IPv4 networks as iptables prints them, IPv6 taken and left aside', () => {
  assert.equal(ipv4Cidr('10.1.2.3/8'), '10.0.0.0/8')
  assert.equal(ipv4Cidr('81.9.9.9/32'), '81.9.9.9/32')
  assert.equal(ipv4Cidr('81.9.9.9/0'), '0.0.0.0/0')
  assert.equal(ipv4Cidr('255.255.255.255/31'), '255.255.255.254/31')
  for (const bad of ['10.0.0.0', '10.0.0.0/33', '300.0.0.0/8', '10.0.0/8', '', undefined])
    assert.equal(ipv4Cidr(bad), null, String(bad))
  assert.deepEqual(parseRefuse(''), [])
  assert.deepEqual(parseRefuse('81.0.0.0/8,81.1.0.0/8,2001:db8::/32'), ['81.0.0.0/8'])
  for (const bad of ['81.0.0.0', 'example.com/8', '2001:db8::/129', '81.0.0.0/8;true'])
    assert.throws(() => parseRefuse(bad), /Invalid refused subnet/, bad)
  assert.throws(() => parseRefuse(Array(65).fill('81.0.0.0/8').join(',')), /Too many/)
})
