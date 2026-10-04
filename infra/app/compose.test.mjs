// The app VM compose as Docker resolves it (spec §19): only Traefik is public, services are
// isolated by uid, network and secret directory. Needs the Docker CLI, not a daemon.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('./docker-compose.yml', import.meta.url))
const envFile = fileURLToPath(new URL('./env.example', import.meta.url))
const source = readFileSync(file, 'utf8')
const example = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, name, value]) => [name, value]),
)

// Only the CLI's own variables pass: the caller's environment must not override env.example.
const cliEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => ['PATH', 'HOME'].includes(name) || name.startsWith('DOCKER_'),
  ),
)
const resolveProfiles = (profiles, ...files) =>
  JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        ...files.flatMap((name) => ['-f', name]),
        '--env-file',
        envFile,
        'config',
        '--format',
        'json',
      ],
      { env: { ...cliEnv, COMPOSE_PROFILES: profiles }, encoding: 'utf8' },
    ),
  )
const resolve = (...files) => resolveProfiles('ops,llm', ...files)
const config = resolve(file)
const services = config.services
const names = Object.keys(services).sort()

const uids = {
  'volume-init': '0:0',
  traefik: '65532:65532',
  web: '10001:10001',
  core: '10002:10002',
  llm: '10008:10008',
  redis: '10003:10003',
  migrate: '10004:10004',
  seed: '10004:10004',
  postgres: '70:70',
}
const nodeServices = ['web', 'core', 'llm', 'migrate', 'seed']
// seed runs as migrate: the schema owner
const secretDirs = {
  web: 'web',
  core: 'core',
  llm: 'llm',
  migrate: 'migrate',
  seed: 'migrate',
  postgres: 'postgres',
  redis: 'redis',
}

const networksOf = (name) => Object.keys(services[name].networks ?? {})
const shared = (a, b) => networksOf(a).filter((network) => networksOf(b).includes(network))

test('every service of the stack is known', () => {
  assert.deepEqual(names, Object.keys(uids).sort())
})

test('only Traefik is public; core and llm publish one API each on the private IP', () => {
  for (const name of names) {
    const ports = services[name].ports ?? []
    if (name === 'traefik') {
      assert.deepEqual(ports.map((port) => port.target).sort(), [8000, 8443])
      for (const port of ports) assert.equal(port.host_ip, undefined)
    } else if (name === 'core' || name === 'llm') {
      assert.equal(ports.length, 1)
      assert.equal(ports[0].target, name === 'core' ? 8083 : 8084)
      assert.equal(ports[0].host_ip, example.APP_PRIVATE_IP)
    } else assert.deepEqual(ports, [], `${name} publishes a port`)
    assert.equal(services[name].expose, undefined, `${name} exposes a port`)
  }
})

test('llm is opt-in and does not become a dependency of the default stack', () => {
  assert.equal(resolveProfiles('ops', file).services.llm, undefined)
  assert.deepEqual(services.llm.profiles, ['llm'])
  assert.equal(services.llm.deploy.replicas, 1)
  assert.deepEqual(Object.keys(services.llm.depends_on), ['postgres'])
  for (const [name, service] of Object.entries(services))
    assert.ok(!service.depends_on?.llm, `${name} starts the optional llm service`)
})

test('llm gets only its own role, TLS files and private endpoints; health requires readiness', () => {
  const { environment: env } = services.llm
  assert.equal(env.APP_ENV, 'production')
  assert.equal(env.ORCHESTRATOR_ROLES, 'llm')
  for (const key of Object.keys(env)) assert.doesNotMatch(key, /^(REDIS_|S3_|RUNNER_|SANDBOX_)/)
  assert.equal(env.LLM_EGRESS_PROXY_URL, `https://${example.EGRESS_PROXY_IP}:443`)
  assert.equal(env.LLM_GATEWAY_CLIENTS, `127.0.0.1/32,${example.LLM_GATEWAY_CLIENTS}`)
  assert.equal(env.LLM_GATEWAY_HOSTS, `127.0.0.1:8084,${example.APP_PRIVATE_IP}:8084`)
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/run/raditi/vault-ca.pem')
  for (const [name, path] of Object.entries({
    LLM_EGRESS_CA_FILE: 'egress-ca.pem',
    LLM_EGRESS_CLIENT_CERT_FILE: 'egress-client.pem',
    LLM_EGRESS_CLIENT_KEY_FILE: 'egress-client-key.pem',
  }))
    assert.equal(env[name], `/run/raditi/${path}`)
  assert.equal(env.LLM_UPSTREAM_CA_FILE, undefined)
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined)
  assert.deepEqual(services.llm.dns, ['127.0.0.1'])
  assert.deepEqual(services.llm.extra_hosts, [`vault.raditi.internal=${example.VAULT_PRIVATE_IP}`])
  assert.equal(services.llm.sysctls['net.ipv6.conf.all.disable_ipv6'], '1')
  assert.equal(services.llm.sysctls['net.ipv6.conf.default.disable_ipv6'], '1')
  assert.ok(services.llm.healthcheck.test.at(-1).includes('r.status === 200'))
  assert.equal(services.core.environment.LLM_CONTROL_URL, `http://${example.APP_PRIVATE_IP}:8084`)
  assert.equal(services.llm.stop_grace_period, '40s')
})

test('web, core and llm reach Vault by its pinned name and trust its CA from their own secrets', () => {
  // core writes the turn keys llm reads: all three must talk to the same Vault, over TLS that
  // verifies. `.internal` has no public certificate and Node takes extra CAs only at start.
  for (const name of ['web', 'core', 'llm']) {
    const service = services[name]
    assert.equal(service.environment.VAULT_ADDR, example.VAULT_ADDR, name)
    assert.equal(service.environment.NODE_EXTRA_CA_CERTS, '/run/raditi/vault-ca.pem', name)
    assert.deepEqual(
      service.extra_hosts,
      [`vault.raditi.internal=${example.VAULT_PRIVATE_IP}`],
      name,
    )
  }
  for (const name of names.filter((name) => !['web', 'core', 'llm'].includes(name))) {
    assert.equal(services[name].environment?.NODE_EXTRA_CA_CERTS, undefined, name)
    assert.equal(services[name].extra_hosts, undefined, name)
  }
  // Without the address Compose must stop instead of pinning the name to a default.
  const directory = mkdtempSync(join(tmpdir(), 'raditi-compose-vault-'))
  try {
    const withoutVault = join(directory, 'compose.env')
    writeFileSync(
      withoutVault,
      readFileSync(envFile, 'utf8').replace(/^VAULT_PRIVATE_IP=.*\n/m, ''),
    )
    assert.throws(
      () =>
        execFileSync('docker', ['compose', '-f', file, '--env-file', withoutVault, 'config'], {
          env: cliEnv,
          stdio: 'pipe',
          encoding: 'utf8',
        }),
      /VAULT_PRIVATE_IP/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  for (const [service, uid] of [
    ['web', 10001],
    ['core', 10002],
  ])
    assert.match(
      readFileSync(new URL('./preflight.sh', import.meta.url), 'utf8'),
      new RegExp(`^check_secrets ${service} ${uid} app\\.env vault-ca\\.pem$`, 'm'),
    )
})

test('no Docker socket, no privileges, no host network; only volume-init adds capabilities', () => {
  for (const name of names) {
    const service = services[name]
    for (const volume of service.volumes ?? [])
      assert.doesNotMatch(`${volume.source}`, /docker\.sock/, `${name} mounts the Docker socket`)
    assert.notEqual(service.privileged, true, `${name} is privileged`)
    assert.notEqual(service.network_mode, 'host', `${name} uses the host network`)
    if (name === 'volume-init') {
      assert.deepEqual(service.cap_add.sort(), ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'])
      assert.equal(service.network_mode, 'none')
    } else {
      assert.equal(service.cap_add, undefined, `${name} adds capabilities`)
      assert.equal(service.network_mode, undefined)
    }
  }
})

test('every variable compose substitutes is described in env.example', () => {
  const used = new Set(
    source
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .flatMap((line) => [...line.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map(([, name]) => name)),
  )
  assert.ok(used.size > 0)
  for (const name of used) assert.ok(name in example, `${name} is missing from env.example`)
})

test('every image is pinned by digest and has no default', () => {
  for (const name of names)
    assert.match(services[name].image, /@sha256:[0-9a-f]{64}$/, `${name} image is not pinned`)
  const images = [...source.matchAll(/^\s+image: (.*)$/gm)].map(([, image]) => image)
  assert.ok(images.length > 0)
  for (const image of images) assert.match(image, /^\$\{[A-Z_]+_IMAGE:\?[^}]+\}$/)
})

test('core receives one digest-pinned stack image for every agent driver', () => {
  assert.equal(services.core.environment.SANDBOX_IMAGE, example.SANDBOX_IMAGE)
  assert.match(services.core.environment.SANDBOX_IMAGE, /@sha256:[0-9a-f]{64}$/)
  assert.equal(services.core.environment.SANDBOX_IMAGE_PREFIX, undefined)
})

test('no secret in the environment of any service', () => {
  for (const name of names)
    for (const variable of Object.keys(services[name].environment ?? {}))
      if (
        !['RUNNER_TOKENS', 'LLM_MAX_REQUESTS_PER_KEY'].includes(variable) &&
        !variable.endsWith('_FILE')
      )
        assert.doesNotMatch(
          variable,
          /(PASSWORD|SECRET|SECRET_ID|TOKEN|_KEY|DATABASE_URL|REDIS_URL)$/,
          `${name}: ${variable}`,
        )
  for (const name of names) assert.equal(services[name].env_file, undefined, `${name}: env_file`)
  assert.equal(services.llm.environment.LLM_MAX_REQUESTS_PER_KEY, '2')
})

test('web keeps PostgreSQL, Redis, S3 and Vault configured', () => {
  assert.deepEqual(Object.keys(services.web.depends_on), ['postgres', 'redis'])
  for (const name of ['S3_ENDPOINT', 'VAULT_ADDR'])
    assert.ok(services.web.environment[name], `web environment: ${name}`)
  const secrets = readFileSync(new URL('./secrets.example/web/app.env', import.meta.url), 'utf8')
  for (const name of [
    'REDIS_URL',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'VAULT_ROLE_ID',
    'VAULT_SECRET_ID',
  ])
    assert.match(secrets, new RegExp(`^${name}=`, 'm'))
})

const preflight = readFileSync(new URL('./preflight.sh', import.meta.url), 'utf8')

test("the server's .env holds no secret-like names either (preflight.sh refuses them)", () => {
  for (const name of Object.keys(example))
    assert.doesNotMatch(
      name,
      /(PASSWORD|SECRET|SECRET_ID|TOKEN|_KEY|DATABASE_URL|REDIS_URL)$/,
      name,
    )
  // preflight's own pattern, run by grep as on the VM.
  const pattern = /grep -Eq '(\^\[A-Z0-9_\]\*\([^']+\)=)'/.exec(preflight)?.[1]
  assert.ok(pattern)
  const refused = (name) => {
    try {
      execFileSync('grep', ['-Eq', pattern], { input: `${name}=value\n` })
      return true
    } catch {
      return false
    }
  }
  for (const name of ['METRICS_TOKEN', 'VAULT_SECRET_ID', 'S3_SECRET_ACCESS_KEY', 'DATABASE_URL'])
    assert.equal(refused(name), true, name)
  for (const name of Object.keys(example)) assert.equal(refused(name), false, name)
})

test('env.example writes values the way preflight.sh reads them: no quotes or comments', () => {
  // preflight's own pattern, run by grep as on the VM.
  const pattern = /if grep -Eq "(\^\[A-Z0-9_\]\+=[^"]*\\"[^"]*)" "\$env_file"; then/
    .exec(preflight)?.[1]
    .replace('\\"', '"')
  assert.ok(pattern)
  const refused = (line) => {
    try {
      execFileSync('grep', ['-Eq', pattern], { input: `${line}\n` })
      return true
    } catch {
      return false
    }
  }
  for (const line of ['APP_DOMAIN="raditi.ru"', "APP_DOMAIN='raditi.ru'", 'VOLUME_PREFIX=a # b'])
    assert.equal(refused(line), true, line)
  for (const [name, value] of Object.entries(example))
    assert.equal(refused(`${name}=${value}`), false, name)
})

test('preflight.sh requires a full revision and the journald limits of the runbook', () => {
  const revision = /setting APP_REVISION \| grep -Eqx '([^']+)'/.exec(preflight)?.[1]
  assert.ok(revision)
  const accepted = (value) => {
    try {
      execFileSync('grep', ['-Eqx', revision], { input: `${value}\n` })
      return true
    } catch {
      return false
    }
  }
  assert.equal(accepted('0123456789abcdef0123456789abcdef01234567'), true)
  for (const value of ['', 'verify', '0123456', `${'A'.repeat(40)}`])
    assert.equal(accepted(value), false)
  assert.equal(example.APP_REVISION, '')
  const lines = /^for line in (.+); do$/m.exec(preflight)?.[1].split(' ')
  assert.deepEqual(lines, [
    "'[Journal]'",
    'Storage=persistent',
    'SystemMaxUse=10G',
    'MaxRetentionSec=90day',
    'ForwardToSyslog=no',
  ])
  assert.ok(preflight.includes('grep -qxF "$line" "$journald"'))
})

test("preflight.sh requires a digest for every image of the server's .env", () => {
  const images = [...source.matchAll(/\$\{([A-Z_]+_IMAGE):\?/g)].map(([, name]) => name)
  const checked = /^for name in ([A-Z_ ]+); do$/m.exec(preflight)?.[1].split(' ')
  assert.deepEqual([...new Set(images)].sort(), checked?.sort())
  assert.ok(preflight.includes("grep -Eq '@sha256:[0-9a-f]{64}$'"))
})

test("preflight.sh refuses env.example's all-zero placeholder digests", () => {
  // preflight's own helper and image loop, run by sh as on the VM, against env.example.
  const setting = /^setting\(\) \{\n[^}]+\n\}$/m.exec(preflight)?.[0]
  const loop = /^for name in [A-Z_ ]+; do\n[\s\S]+?^done$/m.exec(preflight)?.[0]
  assert.ok(setting && loop)
  const directory = mkdtempSync(join(tmpdir(), 'raditi-preflight-images-'))
  try {
    const failures = (text) => {
      const env = join(directory, '.env')
      writeFileSync(env, text)
      const script = `set -eu\nenv_file="$1"\nfail() { echo "$*"; }\n${setting}\n${loop}\n`
      return execFileSync('sh', ['-c', script, 'sh', env], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
    }
    const text = readFileSync(envFile, 'utf8')
    const placeholders = Object.keys(example).filter(
      (name) => /_IMAGE$/.test(name) && /@sha256:0{64}$/.test(example[name]),
    )
    // The stack image reaches no pull before the first turn: core would start with it.
    assert.ok(placeholders.includes('SANDBOX_IMAGE'))
    assert.deepEqual(
      failures(text),
      placeholders.map((name) => `${name} still has the all-zero placeholder digest`),
    )
    assert.deepEqual(failures(text.replaceAll('0'.repeat(64), 'ab'.repeat(32))), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the stack unit waits for the clock and tries again until preflight passes', () => {
  const unit = readFileSync(new URL('./systemd/raditi-app.service', import.meta.url), 'utf8')
  const values = (name) =>
    [...unit.matchAll(new RegExp(`^${name}=(.*)$`, 'gm'))].flatMap(([, value]) =>
      value.split(/\s+/),
    )
  for (const name of ['After', 'Wants']) {
    assert.ok(values(name).includes('time-sync.target'), name)
    assert.ok(values(name).includes('raditi-secrets.service'), name)
  }
  // A failed dependency would end the job without a restart: the render is only wanted.
  assert.deepEqual(values('Requires'), ['docker.service'])
  assert.deepEqual(values('ExecStartPre'), ['/opt/raditi/app/preflight.sh'])
  assert.deepEqual(values('Restart'), ['on-failure'])
  assert.deepEqual(values('RestartSec'), ['30s'])
  // dockerd itself restarts the containers at boot: preflight checks that it waits for the clock.
  assert.ok(preflight.includes('systemctl show docker.service -p After --value'))
  assert.ok(preflight.includes('grep -qw time-sync.target'))
})

test('every service is read-only, drops all capabilities, cannot gain privileges, has limits', () => {
  for (const name of names) {
    const service = services[name]
    assert.equal(service.read_only, true, `${name}: read_only`)
    assert.deepEqual(service.cap_drop, ['ALL'], `${name}: cap_drop`)
    assert.deepEqual(service.security_opt, ['no-new-privileges:true'], `${name}: security_opt`)
    assert.ok(service.pids_limit > 0, `${name}: pids_limit`)
    if (name !== 'volume-init') {
      assert.ok(Number(service.cpus) > 0, `${name}: cpus`)
      assert.ok(Number(service.mem_limit) > 0, `${name}: mem_limit`)
    }
  }
  for (const name of nodeServices) assert.equal(services[name].init, true, `${name}: init`)
})

test('each service runs under its own uid', () => {
  for (const name of names) assert.equal(services[name].user, uids[name], `${name}: user`)
  const own = names.filter((name) => name !== 'seed').map((name) => uids[name])
  assert.equal(new Set(own).size, own.length)
})

test('networks: only Traefik reaches web, web and core never meet, data stays internal', () => {
  const pairs = {
    'traefik web': ['edge'],
    'traefik core': [],
    'traefik llm': [],
    'traefik postgres': [],
    'traefik redis': [],
    'traefik migrate': [],
    'web core': [],
    'web llm': [],
    'core llm': [],
    'llm redis': [],
    'llm postgres': ['llm-data'],
    'web postgres': ['web-data'],
    'web redis': ['web-data'],
    'core postgres': ['core-data'],
    'core redis': ['core-data'],
    'migrate postgres': ['core-data'],
    'seed redis': ['core-data'],
    'web migrate': [],
  }
  for (const [pair, expected] of Object.entries(pairs)) {
    const [a, b] = pair.split(' ')
    assert.deepEqual(shared(a, b), expected, pair)
  }
  for (const network of ['edge', 'web-data', 'core-data', 'llm-edge', 'llm-data', 'metrics-edge'])
    assert.equal(config.networks[network].internal, true, `${network} is not internal`)
  for (const network of ['web-egress', 'core-egress', 'llm-out', 'public']) {
    assert.notEqual(config.networks[network].internal, true)
    const members = names.filter((name) => networksOf(name).includes(network))
    assert.equal(members.length, 1, `${network}: ${members}`)
  }
  assert.equal(
    config.networks['llm-out'].driver_opts['com.docker.network.bridge.name'],
    `${example.BRIDGE_PREFIX}-llmout`,
  )
  assert.equal(
    config.networks['llm-data'].driver_opts['com.docker.network.bridge.name'],
    `${example.BRIDGE_PREFIX}-llmdb`,
  )
  assert.equal(
    config.networks['llm-edge'].driver_opts['com.docker.network.bridge.name'],
    `${example.BRIDGE_PREFIX}-llmedge`,
  )
  assert.equal(services.llm.networks['llm-out'].gw_priority, 1)
  assert.deepEqual(config.networks['llm-out'].ipam.config, [
    { subnet: example.LLM_OUT_SUBNET, gateway: example.LLM_OUT_GATEWAY },
  ])
  assert.deepEqual(
    names.filter((name) => networksOf(name).includes('metrics-edge')),
    ['traefik'],
  )
})

test('secrets: each service mounts only its own directory, read-only, never created empty', () => {
  for (const name of names) {
    const binds = (services[name].volumes ?? []).filter((volume) => volume.target === '/run/raditi')
    if (!(name in secretDirs)) {
      assert.deepEqual(binds, [], `${name} mounts secrets`)
      continue
    }
    assert.equal(binds.length, 1, name)
    const [bind] = binds
    assert.equal(bind.type, 'bind')
    assert.equal(bind.read_only, true)
    // Long syntax defaults to false; older Compose (GitHub runners) omits the default when rendering.
    assert.equal(bind.bind?.create_host_path ?? false, false)
    assert.equal(bind.source, `${example.SECRETS_DIR}/${secretDirs[name]}`)
    for (const volume of services[name].volumes ?? [])
      if (volume !== bind)
        assert.ok(!`${volume.source}`.startsWith(example.SECRETS_DIR), `${name}: ${volume.source}`)
  }
})

test('logs go to journald on the host: they outlive a recreated container', () => {
  for (const name of names) {
    assert.equal(services[name].logging?.driver, 'journald', `${name}: logging`)
    assert.equal(services[name].logging.options?.tag, '{{.Name}}', `${name}: tag`)
  }
})

test("verify-edge's fallback for a host without journald changes the logging driver only", () => {
  const local = resolve(
    file,
    fileURLToPath(new URL('./verify/compose.local-logs.yml', import.meta.url)),
  )
  assert.deepEqual(Object.keys(local.services).sort(), names)
  for (const name of names) {
    assert.deepEqual(local.services[name].logging, { driver: 'local' }, name)
    const { logging: _, ...rest } = local.services[name]
    const { logging: __, ...production } = services[name]
    assert.deepEqual(rest, production, name)
  }
})

test('core gets time to finish its shutdown', () => {
  const [, seconds] = /^(\d+)s$/.exec(services.core.stop_grace_period) ?? []
  assert.ok(Number(seconds) >= 40)
})

test('stateful volumes are external and survive `down -v`', () => {
  for (const volume of ['pgdata', 'redis-data', 'acme'])
    assert.equal(config.volumes[volume].external, true, volume)
})

test('nothing started by `up` depends on the ops profile', () => {
  const ops = names.filter((name) => services[name].profiles?.includes('ops'))
  assert.deepEqual(ops.sort(), ['migrate', 'seed'])
  for (const name of names.filter((name) => !ops.includes(name)))
    for (const dependency of Object.keys(services[name].depends_on ?? {}))
      assert.ok(!ops.includes(dependency), `${name} depends on ${dependency}`)
})

test('Traefik: static config only as flags, no dashboard or Docker provider, logs without secrets', () => {
  const { command, environment, volumes } = services.traefik
  const flags = command.join('\n')
  assert.doesNotMatch(flags, /--api\b/)
  assert.doesNotMatch(flags, /--providers\.docker/)
  assert.doesNotMatch(flags, /forwardedheaders/i)
  for (const flag of [
    '--accesslog.fields.headers.defaultmode=drop',
    '--accesslog.fields.queryparameters.defaultmode=drop',
    '--entrypoints.websecure.http.aliasheadersstrategy=delete',
    '--entrypoints.websecure.http.maxheaderbytes=32768',
    '--entrypoints.web.http.redirections.entrypoint.to=:443',
    '--entrypoints.web.observability.accesslogs=false',
    '--providers.file.directory=/etc/traefik/dynamic',
  ])
    assert.ok(command.includes(flag), flag)
  // A static config file would silently switch every flag off.
  for (const volume of volumes) assert.doesNotMatch(volume.target, /^\/etc\/traefik\/traefik\./)
  for (const variable of Object.keys(environment ?? {})) assert.doesNotMatch(variable, /^TRAEFIK_/)
})

// To refuse a body that declares no length (or is exactly the limit long) the buffering
// middleware opens a temporary file. It never fills it (mem = max in raditi.yml), but on a
// read-only root without /tmp the open fails and the answer is 500 instead of 413.
test('Traefik has a small /tmp of its own for the body limit', () => {
  assert.deepEqual(services.traefik.tmpfs, ['/tmp:size=1m,uid=65532,gid=65532,mode=0700'])
  assert.equal(services.traefik.user, '65532:65532')
  assert.equal(services.traefik.read_only, true)
  const dynamic = readFileSync(
    fileURLToPath(new URL('./traefik/dynamic/raditi.yml', import.meta.url)),
    'utf8',
  )
  const bytes = (name) => Number(new RegExp(`^ +${name}: (\\d+)$`, 'm').exec(dynamic)?.[1])
  // Nothing is ever written there: the whole body stays in memory.
  assert.ok(bytes('maxRequestBodyBytes') > 0)
  assert.equal(bytes('memRequestBodyBytes'), bytes('maxRequestBodyBytes'))
  assert.equal(bytes('memResponseBodyBytes'), bytes('maxResponseBodyBytes'))
})

// Traefik registers every configured challenge and lego tries tls-alpn-01, then http-01, then
// dns-01: DNS-01 added next to HTTP-01 is never used.
test('every ACME resolver has exactly one challenge type', () => {
  const challenges = new Map()
  for (const flag of services.traefik.command) {
    const [, resolver, type] =
      /^--certificatesresolvers\.([^.=]+)\.acme\.(?:(http|dns|tls)challenge(?:[.=]|$))?/i.exec(
        flag,
      ) ?? []
    if (!resolver) continue
    const types = challenges.get(resolver.toLowerCase()) ?? new Set()
    if (type) types.add(type.toLowerCase())
    challenges.set(resolver.toLowerCase(), types)
  }
  assert.ok(challenges.has('le'))
  for (const [resolver, types] of challenges)
    assert.equal(types.size, 1, `${resolver}: ${[...types].join(', ') || 'no challenge'}`)
})
