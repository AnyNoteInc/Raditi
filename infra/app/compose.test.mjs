// The app VM compose as Docker resolves it (spec §19): only Traefik is public, services are
// isolated by uid, network and secret directory. Needs the Docker CLI, not a daemon.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
const config = JSON.parse(
  execFileSync(
    'docker',
    ['compose', '-f', file, '--env-file', envFile, 'config', '--format', 'json'],
    { env: { ...cliEnv, COMPOSE_PROFILES: 'ops' }, encoding: 'utf8' },
  ),
)
const services = config.services
const names = Object.keys(services).sort()

const uids = {
  'volume-init': '0:0',
  traefik: '65532:65532',
  web: '10001:10001',
  core: '10002:10002',
  redis: '10003:10003',
  migrate: '10004:10004',
  seed: '10004:10004',
  postgres: '70:70',
}
const nodeServices = ['web', 'core', 'migrate', 'seed']
// seed runs as migrate: the schema owner
const secretDirs = {
  web: 'web',
  core: 'core',
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

test('only Traefik is published on every interface; core only the runner API on the private IP', () => {
  for (const name of names) {
    const ports = services[name].ports ?? []
    if (name === 'traefik') {
      assert.deepEqual(ports.map((port) => port.target).sort(), [8000, 8443])
      for (const port of ports) assert.equal(port.host_ip, undefined)
    } else if (name === 'core') {
      assert.equal(ports.length, 1)
      assert.equal(ports[0].target, 8083)
      assert.equal(ports[0].host_ip, example.APP_PRIVATE_IP)
    } else assert.deepEqual(ports, [], `${name} publishes a port`)
    assert.equal(services[name].expose, undefined, `${name} exposes a port`)
  }
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

test('every image is pinned by digest and has no default', () => {
  for (const name of names)
    assert.match(services[name].image, /@sha256:[0-9a-f]{64}$/, `${name} image is not pinned`)
  const images = [...source.matchAll(/^\s+image: (.*)$/gm)].map(([, image]) => image)
  assert.ok(images.length > 0)
  for (const image of images) assert.match(image, /^\$\{[A-Z_]+_IMAGE:\?[^}]+\}$/)
})

test('no secret in the environment of any service', () => {
  for (const name of names)
    for (const variable of Object.keys(services[name].environment ?? {}))
      if (variable !== 'RUNNER_TOKENS' && !variable.endsWith('_FILE'))
        assert.doesNotMatch(
          variable,
          /(PASSWORD|SECRET|TOKEN|_KEY|DATABASE_URL|REDIS_URL)$/,
          `${name}: ${variable}`,
        )
  for (const name of names) assert.equal(services[name].env_file, undefined, `${name}: env_file`)
})

test("the server's .env holds no secret-like names either (preflight.sh refuses them)", () => {
  for (const name of Object.keys(example))
    assert.doesNotMatch(name, /(PASSWORD|SECRET|_KEY|DATABASE_URL|REDIS_URL)$/, name)
  const preflight = readFileSync(new URL('./preflight.sh', import.meta.url), 'utf8')
  assert.ok(preflight.includes('(PASSWORD|SECRET|_KEY|DATABASE_URL|REDIS_URL)='))
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
    'traefik postgres': [],
    'traefik redis': [],
    'traefik migrate': [],
    'web core': [],
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
  for (const network of ['edge', 'web-data', 'core-data', 'metrics-edge'])
    assert.equal(config.networks[network].internal, true, `${network} is not internal`)
  for (const network of ['web-egress', 'core-egress', 'public']) {
    assert.notEqual(config.networks[network].internal, true)
    const members = names.filter((name) => networksOf(name).includes(network))
    assert.equal(members.length, 1, `${network}: ${members}`)
  }
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
    assert.equal(bind.bind?.create_host_path, false)
    assert.equal(bind.source, `${example.SECRETS_DIR}/${secretDirs[name]}`)
    for (const volume of services[name].volumes ?? [])
      if (volume !== bind)
        assert.ok(!`${volume.source}`.startsWith(example.SECRETS_DIR), `${name}: ${volume.source}`)
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
    '--entrypoints.web.http.redirections.entrypoint.to=:443',
    '--entrypoints.web.observability.accesslogs=false',
    '--providers.file.directory=/etc/traefik/dynamic',
  ])
    assert.ok(command.includes(flag), flag)
  // A static config file would silently switch every flag off.
  for (const volume of volumes) assert.doesNotMatch(volume.target, /^\/etc\/traefik\/traefik\./)
  for (const variable of Object.keys(environment ?? {})) assert.doesNotMatch(variable, /^TRAEFIK_/)
})
