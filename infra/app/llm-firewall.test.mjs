/* global process, structuredClone, URL */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyLlmFirewall } from './verify-llm-firewall.mjs'
import { checkFirewall, firewallConfig, firewallRules, manageFirewall } from './llm-firewall.mjs'

const settings = [
  'COMPOSE_PROFILES=llm',
  'APP_PRIVATE_IP=10.10.0.10',
  'VAULT_PRIVATE_IP=10.10.0.20',
  'EGRESS_PROXY_IP=93.184.216.34',
  'LLM_GATEWAY_CLIENTS=10.10.1.0/24,10.10.2.7/32,172.29.84.1/32',
].join('\n')
const config = firewallConfig(settings)
const active = () => ({ nftables: structuredClone(firewallRules(config)) })
// The same process with the version of Ubuntu 24.04's own nodejs package.
const oldNode = [
  '--import',
  'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"18.19.1"})',
]

test('CLI invoked through a symlink still validates arguments instead of silently succeeding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'raditi-llm-firewall-symlink-'))
  try {
    const link = join(directory, 'llm-firewall.mjs')
    await symlink(fileURLToPath(new URL('./llm-firewall.mjs', import.meta.url)), link)
    // Missing arguments must fail before reading config or invoking any host firewall command.
    for (const flags of [[], ['--preserve-symlinks', '--preserve-symlinks-main']]) {
      const result = spawnSync(process.execPath, [...flags, link], {
        encoding: 'utf8',
        timeout: 10_000,
      })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /Usage: llm-firewall\.mjs apply\|check --env-file PATH/u)
      assert.equal(result.stdout, '')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('CLI refuses a runtime older than the pinned Node instead of exiting 0 with nothing done', async () => {
  const helper = fileURLToPath(new URL('./llm-firewall.mjs', import.meta.url))
  // Absent before Node 22.18 and 24.2: guarded by it, the distribution's /usr/bin/node loaded
  // the helper, skipped the whole CLI and reported success to systemd and preflight.
  const code = (await readFile(helper, 'utf8')).replace(/^\s*\/\/.*$/gmu, '')
  assert.doesNotMatch(code, /import\.meta\.main/u)
  const directory = await mkdtemp(join(tmpdir(), 'raditi-llm-firewall-node-'))
  try {
    const envFile = join(directory, '.env')
    await writeFile(envFile, 'COMPOSE_PROFILES=\n')
    for (const action of ['apply', 'check']) {
      const result = spawnSync(
        process.execPath,
        [...oldNode, helper, action, '--env-file', envFile],
        { encoding: 'utf8', timeout: 10_000 },
      )
      assert.equal(result.status, 1)
      assert.equal(result.stderr, 'llm-firewall: Node 26 or newer is required\n')
      assert.equal(result.stdout, '')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('llm firewall rejects unsafe configuration without evaluating the env file', () => {
  assert.equal(config.bridges.out, 'rd-llmout')
  assert.equal(config.gateway, '172.29.84.1')
  assert.throws(() => firewallConfig('COMPOSE_PROFILES=\nBRIDGE_PREFIX=other'))
  assert.throws(() => firewallConfig(`${settings}\nBRIDGE_PREFIX=other`))
  for (const replacement of [
    ['EGRESS_PROXY_IP=93.184.216.34', 'EGRESS_PROXY_IP=127.0.0.1'],
    ['EGRESS_PROXY_IP=93.184.216.34', 'EGRESS_PROXY_IP=169.254.169.254'],
    ['EGRESS_PROXY_IP=93.184.216.34', 'EGRESS_PROXY_IP=10.10.0.1'],
    ['EGRESS_PROXY_IP=93.184.216.34', 'EGRESS_PROXY_IP=$(touch /tmp/not-executed)'],
    ['EGRESS_PROXY_IP=93.184.216.34', 'EGRESS_PROXY_IP=93.184.216.34 # comment'],
    ['VAULT_PRIVATE_IP=10.10.0.20', 'VAULT_PRIVATE_IP=10.10.0.10'],
    ['APP_PRIVATE_IP=10.10.0.10', 'APP_PRIVATE_IP=93.184.216.34'],
    ['APP_PRIVATE_IP=10.10.0.10', 'APP_PRIVATE_IP=::1'],
  ])
    assert.throws(() => firewallConfig(settings.replace(...replacement)))
  for (const extra of [
    'EGRESS_PROXY_IP=1.1.1.1',
    'BRIDGE_PREFIX=waytoolong',
    'BRIDGE_PREFIX=rd";accept;',
    'LLM_OUT_SUBNET=10.10.0.0/24\nLLM_OUT_GATEWAY=10.10.0.1',
    'LLM_OUT_SUBNET=172.29.84.1/24',
    'LLM_OUT_SUBNET=172.29.84.0/32',
    'LLM_OUT_GATEWAY=172.29.84.0',
    'LLM_OUT_GATEWAY=172.29.84.255',
    'LLM_OUT_GATEWAY=172.29.85.1',
  ])
    assert.throws(() => firewallConfig(`${settings}\n${extra}`))
})

test('new connections into llm come only from the bridge of core and the sandbox ranges', () => {
  assert.equal(config.core, 'rd-core')
  // The gateway/32 entry is what llm sees after Docker's SNAT, for core and for every sibling
  // container alike: it is not a source the firewall can admit.
  assert.deepEqual(config.sandbox, ['10.10.1.0/24', '10.10.2.7/32'])
  const rules = firewallRules(config)
  const chain = (name) =>
    rules.filter((entry) => entry.rule?.chain === name).map((entry) => entry.rule.expr)
  const equals = (left, right) => ({ match: { op: '==', left, right } })
  const name = (key, value) => equals({ meta: { key } }, value)
  const port = equals({ payload: { protocol: 'tcp', field: 'dport' } }, 8084)
  const source = (right) => equals({ payload: { protocol: 'ip', field: 'saddr' } }, right)
  // Traffic leaving an llm bridge is judged first; what remains enters one.
  assert.deepEqual(chain('forward').slice(3), [
    [name('oifname', 'rd-llmout'), { jump: { target: 'to_llm' } }],
    [name('oifname', 'rd-llmdb'), { jump: { target: 'to_llm' } }],
    [name('oifname', 'rd-llmedge'), { jump: { target: 'to_llm' } }],
  ])
  const inbound = chain('to_llm')
  assert.deepEqual(inbound.slice(0, 3), chain('from_edge').slice(0, 3))
  assert.deepEqual(inbound.slice(3), [
    [name('oifname', 'rd-llmout'), name('iifname', 'rd-core'), port, { accept: null }],
    [
      name('oifname', 'rd-llmout'),
      source({ prefix: { addr: '10.10.1.0', len: 24 } }),
      port,
      { accept: null },
    ],
    [name('oifname', 'rd-llmout'), source('10.10.2.7'), port, { accept: null }],
    [{ drop: null }],
  ])
  assert.doesNotMatch(JSON.stringify(inbound), /172\.29\.84\.1|rd-web|rd-public/u)
  const disabled = firewallRules(firewallConfig('COMPOSE_PROFILES='))
  assert.deepEqual(
    disabled.filter((entry) => entry.rule?.chain === 'to_llm').map((entry) => entry.rule.expr),
    [[{ drop: null }]],
  )
  assert.equal(
    disabled.filter((entry) => entry.rule?.expr.at(-1).jump?.target === 'to_llm').length,
    3,
  )
  const clients = 'LLM_GATEWAY_CLIENTS=10.10.1.0/24,10.10.2.7/32,172.29.84.1/32'
  for (const value of [
    '',
    '172.29.84.1/32',
    '0.0.0.0/0',
    '10.0.0.0/7,172.29.84.1/32',
    '8.8.8.0/24,172.29.84.1/32',
    '10.10.1.1/24,172.29.84.1/32',
    '10.10.1.0/24,10.10.1.0/24',
    '10.10.0.0/16,172.29.84.1/32',
    '172.29.84.0/25,172.29.84.1/32',
    '172.29.0.0/16,172.29.84.1/32',
    '10.10.1.0/33',
    '10.10.1.0',
    '10.10.1.0/24/8',
    '10.10.1.0/24 accept',
    '::/0',
  ])
    assert.throws(() => firewallConfig(settings.replace(clients, `LLM_GATEWAY_CLIENTS=${value}`)), {
      message: 'Invalid LLM_GATEWAY_CLIENTS',
    })
  assert.throws(() => firewallConfig(settings.replace(`${clients}`, 'UNRELATED=1')), {
    message: 'Invalid LLM_GATEWAY_CLIENTS',
  })
})

test('with llm disabled a line of another service cannot keep Docker down; the bad line is named', () => {
  const denyAll = firewallConfig('COMPOSE_PROFILES=')
  // docker.service requires this helper on every start: Compose accepts all of these lines.
  for (const line of [
    'http_proxy=http://10.10.0.5:3128',
    'export EDGE_HTTP=80',
    'APP_DOMAIN=raditi.ru\nAPP_DOMAIN=raditi.ru',
    'ACME_EMAIL: ops@raditi.ru',
  ])
    assert.deepEqual(firewallConfig(`COMPOSE_PROFILES=\n${line}`), denyAll)
  // Another spelling of the two settings the deny-all policy depends on stays fatal.
  for (const [line, number] of [
    ['export COMPOSE_PROFILES=llm', 3],
    ['COMPOSE_PROFILES: llm', 3],
    ['COMPOSE_PROFILES=llm', 3],
    ['export BRIDGE_PREFIX=other', 3],
    ['BRIDGE_PREFIX = other', 3],
  ])
    assert.throws(() => firewallConfig(`COMPOSE_PROFILES=\n\n${line}`), {
      message: `Invalid env file: line ${number}`,
    })
  // An active profile reads addresses from the file: every line must be unambiguous. The
  // message carries the number only, never the text of a line.
  for (const line of [
    'http_proxy=http://10.10.0.5:3128',
    'export EDGE_HTTP=80',
    'APP_PRIVATE_IP=10.10.0.11',
  ])
    assert.throws(() => firewallConfig(`# header\n${settings}\n${line}`), {
      message: `Invalid env file: line ${settings.split('\n').length + 2}`,
    })
})

test('disabled profile denies all old llm containers, including after a ruleset-clearing reboot', () => {
  const disabled = firewallConfig('COMPOSE_PROFILES=monitoring')
  const rules = firewallRules(disabled)
  assert.equal(
    rules.filter((entry) => entry.rule?.expr.some((expr) => expr.accept === null)).length,
    0,
  )
  assert.equal(
    rules.filter((entry) => entry.rule?.expr.some((expr) => expr.drop === null)).length,
    5,
  )
  assert.throws(() => checkFirewall(disabled, active()))
  for (const before of [undefined, active()]) {
    let value = before
    let writes = 0
    const run = (binary, args, input) => {
      if (binary.endsWith('/modprobe')) return { status: 0, stdout: '' }
      if (binary.endsWith('/sysctl')) return { status: 0, stdout: '1' }
      if (args.includes('--file')) {
        writes++
        value = {
          nftables: JSON.parse(input)
            .nftables.filter((entry) => entry.add)
            .map((entry) => entry.add),
        }
        return { status: 0, stdout: '' }
      }
      if (args.includes('ruleset')) return { status: 0, stdout: '{"nftables":[]}' }
      return value ? { status: 0, stdout: JSON.stringify(value) } : { status: 1 }
    }
    assert.deepEqual(manageFirewall('apply', disabled, run), { enabled: false })
    checkFirewall(disabled, value)
    assert.deepEqual(manageFirewall('check', disabled, run), { enabled: false })
    assert.equal(writes, 1)
  }
})

test('active checker rejects weakened rules, missing bridge hooks and IPv6 bypasses', () => {
  checkFirewall(config, active())
  for (const mutate of [
    (value) => value.nftables.splice(1, 1),
    (value) => (value.nftables.find((entry) => entry.chain?.hook === 'input').chain.prio = 10),
    (value) => (value.nftables.find((entry) => entry.rule?.chain === 'input').rule.expr = []),
    (value) =>
      value.nftables.push({ rule: { ...value.nftables.at(-1).rule, expr: [{ accept: null }] } }),
    (value) =>
      (value.nftables.find((entry) => entry.rule?.chain === 'from_out').rule.expr.at(-1).drop =
        undefined),
    (value) => {
      const port = value.nftables.find((entry) =>
        entry.rule?.expr.some((expr) => expr.match?.right === 8200),
      )
      port.rule.expr[0].match.right = '10.10.0.30'
    },
    (value) =>
      value.nftables.push({ flowtable: { family: 'inet', table: 'raditi_llm', name: 'bypass' } }),
    // Every sibling bridge instead of core's, a wider sandbox range, a missing inbound hook.
    (value) =>
      value.nftables
        .find((entry) => entry.rule?.expr.some((expr) => expr.match?.right === 'rd-core'))
        .rule.expr.splice(1, 1),
    (value) =>
      (value.nftables.find((entry) =>
        entry.rule?.expr.some((expr) => expr.match?.right?.prefix),
      ).rule.expr[1].match.right.prefix.len = 16),
    (value) =>
      value.nftables.splice(
        value.nftables.findIndex((entry) => entry.rule?.expr.at(-1).jump?.target === 'to_llm'),
        1,
      ),
  ]) {
    const value = active()
    mutate(value)
    assert.throws(() => checkFirewall(config, value))
  }
})

test('apply is atomic, idempotent and scoped to its table; check never writes', () => {
  let value
  const calls = []
  const run = (binary, args, input) => {
    calls.push({ binary, args, input })
    if (binary.endsWith('/modprobe')) return { status: 0, stdout: '' }
    if (binary.endsWith('/sysctl')) return { status: 0, stdout: '1\n' }
    if (args.includes('--file')) {
      const batch = JSON.parse(input).nftables
      assert.equal(batch.filter((entry) => entry.delete).length, value ? 1 : 0)
      assert.ok(batch.every((entry) => entry.add || entry.delete?.table?.name === 'raditi_llm'))
      value = active()
      return { status: 0, stdout: '' }
    }
    if (args.includes('ruleset')) return { status: 0, stdout: '{"nftables":[]}' }
    return value ? { status: 0, stdout: JSON.stringify(value) } : { status: 1, stdout: '' }
  }
  manageFirewall('apply', config, run)
  manageFirewall('apply', config, run)
  assert.equal(calls.filter((call) => call.input).length, 2)
  calls.length = 0
  manageFirewall('check', config, run)
  assert.ok(calls.every((call) => call.args.includes('-n') || call.args.includes('list')))
  assert.throws(() =>
    manageFirewall('check', config, (binary, args) =>
      binary.endsWith('/sysctl') ? { status: 0, stdout: '0' } : run(binary, args),
    ),
  )
  assert.throws(() =>
    manageFirewall('apply', firewallConfig(`${settings}\nBRIDGE_PREFIX=other`), run),
  )
})

test('boot ordering installs and rechecks the policy before Docker restarts containers', async () => {
  const unit = await readFile(
    new URL('./systemd/raditi-llm-firewall.service', import.meta.url),
    'utf8',
  )
  const docker = await readFile(new URL('./systemd/docker-llm.conf', import.meta.url), 'utf8')
  assert.match(unit, /^Before=docker\.service$/mu)
  assert.match(unit, /^After=.*\bnftables\.service$/mu)
  // nftables.service flushes the whole ruleset on reload, restart and stop: follow it.
  assert.match(unit, /^PartOf=nftables\.service$/mu)
  assert.match(unit, /^ReloadPropagatedFrom=nftables\.service$/mu)
  assert.match(
    unit,
    /^ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/raditi\/llm-firewall\.mjs apply --env-file \/opt\/raditi\/app\/\.env$/mu,
  )
  assert.match(
    unit,
    /^ExecReload=\/usr\/bin\/node \/usr\/local\/lib\/raditi\/llm-firewall\.mjs apply --env-file \/opt\/raditi\/app\/\.env$/mu,
  )
  assert.doesNotMatch(unit, /^ExecStop=/mu)
  assert.match(docker, /^Requires=raditi-llm-firewall\.service$/mu)
  assert.match(docker, /^After=raditi-llm-firewall\.service$/mu)
  assert.match(
    docker,
    /^ExecStartPre=\/usr\/bin\/node \/usr\/local\/lib\/raditi\/llm-firewall\.mjs check --env-file \/opt\/raditi\/app\/\.env$/mu,
  )
  // Preflight checks the rules with the interpreter of the units, not with whatever PATH finds.
  const preflight = await readFile(new URL('./preflight.sh', import.meta.url), 'utf8')
  assert.match(
    preflight,
    /^ {2}\/usr\/bin\/node "\$firewall_helper" check --env-file "\$env_file" \|\|/mu,
  )
})

test('installed boot helper still applies and checks deny-all after a pre-llm release rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'raditi-llm-rollback-'))
  try {
    const release = join(directory, 'opt/raditi/app')
    const installedDirectory = join(directory, 'usr/local/lib/raditi')
    await mkdir(release, { recursive: true })
    await mkdir(installedDirectory, { recursive: true })
    const source = fileURLToPath(new URL('./llm-firewall.mjs', import.meta.url))
    await copyFile(source, join(release, 'llm-firewall.mjs'))
    const installed = join(installedDirectory, 'llm-firewall.mjs')
    await copyFile(source, installed)
    // Roll back the application directory to an older release without any LLM helper.
    // The deployment procedure preserves .env and disables llm before this step.
    await rm(release, { recursive: true })
    await mkdir(release)
    const envFile = join(release, '.env')
    await writeFile(envFile, 'COMPOSE_PROFILES=\nAPP_PRIVATE_IP=10.10.0.10\n')
    const boot = await import(pathToFileURL(installed).href)
    const disabled = boot.firewallConfig(await readFile(envFile, 'utf8'))
    let listed
    const run = (binary, args, input) => {
      if (binary.endsWith('/modprobe')) return { status: 0, stdout: '' }
      if (binary.endsWith('/sysctl')) return { status: 0, stdout: '1\n' }
      if (args.includes('--file')) {
        listed = { nftables: JSON.parse(input).nftables.map((entry) => entry.add) }
        return { status: 0, stdout: '' }
      }
      if (args.includes('ruleset')) return { status: 0, stdout: '{"nftables":[]}' }
      return listed ? { status: 0, stdout: JSON.stringify(listed) } : { status: 1 }
    }
    assert.deepEqual(boot.manageFirewall('apply', disabled, run), { enabled: false })
    assert.deepEqual(boot.manageFirewall('check', disabled, run), { enabled: false })
    assert.ok(listed.nftables.some((entry) => entry.rule?.expr.some((expr) => expr.drop === null)))
    assert.ok(
      listed.nftables.every((entry) => !entry.rule?.expr.some((expr) => expr.accept === null)),
    )
    await assert.rejects(readFile(join(release, 'llm-firewall.mjs')), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test(
  'real packets obey the llm boundary in a disposable Linux network namespace',
  {
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- Opt-in infra test, outside Turbo tasks.
    skip: process.env.RADITI_LLM_FIREWALL_PACKET_TEST !== '1',
    timeout: 240_000,
  },
  verifyLlmFirewall,
)
