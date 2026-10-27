// The network of a preview, measured on this machine (docs/plan/58-preview-single-container.md;
// docs/plan/53-chat-preview-release.md, Р18, Р21): two previews — each one container on a bridge of
// its own — and the browser of preview A, built by the real Docker runtime
// (createDockerPreviewRuntime), then TCP and HTTP probes from the host, from inside the preview
// (as its PHP, as root of the container), from a container on A's bridge without the preview's
// init, from inside the browser container and from Chromium itself. A preview's internet is open
// (owner's answer of 26.10.2026): PHP reaches a public address and a public name, while the rules
// of its bridge (infra/sandbox/host-firewall.mjs) close the host, every address that is not public,
// the platform's subnets and the other preview. Every «blocked» row has a control that reached the
// same target — from the default bridge, from the host for what is published on its loopback, or
// from the target's own side — and a row that is not PASS fails the run: a probe that did not run,
// a target nobody could reach anyway. Reachable rows from each side prove the probes themselves
// work. No pulls, no .env, no real site.
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { connect, createServer, isIP } from 'node:net'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createDockerPreviewRuntime } from '../../../packages/sandbox-providers/src/preview/runtime.ts'
import { previewBridge } from '../../../packages/sandbox-providers/src/preview/resources.ts'
import { NODE_PROBE, PHP_PROBE, passed, table, ustar, verdict } from './probes.mjs'

/** The base of the site image (infra/preview/Dockerfile, `BASE`): wordpress:7.1.2-php8.3-apache. */
const WORDPRESS =
  'wordpress@sha256:8ae73d594a154e30b112e8d085afbc0895acf7651d8f53ef63aefb42e30822d5'
const images = {}
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const run = randomBytes(4).toString('hex')
const STAND_LABEL = `io.raditi.preview-verify=${run}`
const args = new Set(process.argv.slice(2))
const runtimeKind = args.has('--runtime=runsc') ? 'runsc' : 'runc'
const socketPath = process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock'
const dockerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => ['PATH', 'HOME'].includes(name) || name.startsWith('DOCKER_'),
  ),
)
let stage = 'preflight'

/** Docker CLI with a private output; a failure names the stage, never arguments or output. */
function docker(argv, { allowFailure = false, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', argv, { env: dockerEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.resume()
    child.once('error', () => reject(new Error(`Docker could not start during ${stage}`)))
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && !allowFailure)
        reject(new Error(`Docker command failed during ${stage} (exit ${code ?? 'killed'})`))
      else resolve({ code, stdout: Buffer.concat(out).toString('utf8').trim() })
    })
  })
}

const digestOf = async (tag) =>
  (await docker(['image', 'inspect', '--format', '{{index .RepoDigests 0}}', tag])).stdout

/** The image of the host rules (SANDBOX_NETWORK_GUARD_IMAGE): infra/sandbox/Dockerfile. */
async function buildGuard() {
  if (process.env.SANDBOX_NETWORK_GUARD_IMAGE) return process.env.SANDBOX_NETWORK_GUARD_IMAGE
  const tag = 'raditi-network-guard:local'
  if (!args.has('--no-build'))
    await docker(
      [
        'build',
        '-q',
        '-f',
        'infra/sandbox/Dockerfile',
        '--target',
        'network-guard',
        '-t',
        tag,
        '.',
      ],
      { timeoutMs: 900_000 },
    ).catch(() => {
      throw new Error(`docker build of the network guard image failed (run from ${repository})`)
    })
  return digestOf(tag)
}

async function build(target, buildArgs = [], version = 'local') {
  const tag = `raditi-preview-${target}:${version}`
  if (!args.has('--no-build'))
    await docker(
      [
        'build',
        '-q',
        '-f',
        'infra/preview/Dockerfile',
        '--target',
        target,
        ...buildArgs,
        '-t',
        tag,
        'infra/preview',
      ],
      { timeoutMs: 900_000 },
    ).catch(() => {
      throw new Error(`docker build of the ${target} image failed (run from ${repository})`)
    })
  return digestOf(tag)
}

const listening = (host, port) =>
  new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1000 })
    socket.once('connect', () => (socket.destroy(), resolve(true)))
    socket.once('timeout', () => (socket.destroy(), resolve(false)))
    socket.once('error', () => resolve(false))
  })

/** GET from the host with a Host header of its own: fetch() would not send one. */
const httpGet = (port, host, path = '/') =>
  new Promise((resolve) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port, path, headers: { host }, agent: false, timeout: 10_000 },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    outgoing.on('timeout', () => outgoing.destroy())
    outgoing.on('error', () => resolve({ status: 0, body: '' }))
    outgoing.end()
  })

/** A host service of the probe: answers nothing, only accepts. */
async function standListener(host, port) {
  const server = createServer((socket) => socket.end())
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  return server
}

async function freePort(host) {
  const server = await standListener(host, 0)
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

const containerOf = async (previewId, role) =>
  (
    await docker([
      'ps',
      '-a',
      '-q',
      '--no-trunc',
      '--filter',
      `label=io.raditi.preview.id=${previewId}`,
      '--filter',
      `label=io.raditi.preview.role=${role}`,
    ])
  ).stdout
const addresses = async (id) =>
  JSON.parse(
    (await docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', id])).stdout,
  )

function lanAddress() {
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? [])
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
  return null
}

const apacheConfig = [
  'ServerRoot "/etc/apache2"',
  'PidFile /tmp/apache2/apache2.pid',
  'Mutex file:/tmp/apache2 default',
  'DefaultRuntimeDir /tmp/apache2',
  'ErrorLog /proc/self/fd/2',
  'LogLevel warn',
  'IncludeOptional mods-enabled/*.load',
  'IncludeOptional mods-enabled/*.conf',
  'Listen 127.0.0.1:8081',
  'ServerName localhost',
  'ServerTokens Prod',
  'ServerSignature Off',
  'TraceEnable Off',
  '<Directory />',
  '  Options None',
  '  AllowOverride None',
  '  Require all denied',
  '</Directory>',
  '<Directory /var/www/html/>',
  '  Options SymLinksIfOwnerMatch',
  '  Require all granted',
  '</Directory>',
  'DocumentRoot /var/www/html',
  '<FilesMatch \\.php$>',
  '  SetHandler application/x-httpd-php',
  '</FilesMatch>',
  'DirectoryIndex index.php',
].join('\n')

/** A preview of one container (docs/plan/58); A has its database, B none. */
function specOf(name, gatewayPort) {
  const alias = name.repeat(6)
  const hostname = `site-${name.repeat(8)}-chat-${alias}.localhost`
  const database = name === 'a'
  return {
    previewId: randomUUID(),
    siteId: randomUUID(),
    taskId: randomUUID(),
    runtime: runtimeKind,
    images: { preview: images.site, tools: images.tools },
    database,
    recipe: {
      runtime: 'php',
      runtimeVersions: ['8.3'],
      database: database ? 'mysql' : null,
      requiredPaths: [],
      generatedFiles: [],
      settings: { STAND: name },
      healthPath: '/',
      web: {
        command: ['apache2-foreground', '-f', '/run/raditi/preview/httpd.conf'],
        env: { APACHE_RUN_DIR: '/tmp/apache2', APACHE_LOCK_DIR: '/tmp/apache2' },
        port: 8081,
        user: '33:33',
        docroot: '/var/www/html',
        tmpfs: ['/tmp'],
        configFiles: [{ name: 'httpd.conf', content: apacheConfig }],
      },
    },
    limits: { cpu: 2, memoryMiB: 2048, pids: 512 },
    upstreamHost: '127.0.0.1',
    hostname,
    origin: `http://${hostname}:${gatewayPort}`,
    productionOrigin: 'https://shop.example.ru',
    expiresAt: Date.now() + 60 * 60_000,
  }
}

const page = (name) =>
  `<?php $s = json_decode(file_get_contents('/run/raditi/preview/settings.json'), true); ` +
  `echo 'preview-${name} ' . $s['hostname'];\n`

/** A public address this run refuses as a subnet of the platform: its neighbour stays open. */
const REFUSED = { subnet: '1.0.0.0/24', address: '1.0.0.1', port: 443 }
const PUBLIC = { address: '1.1.1.1', port: 443 }

async function main() {
  process.chdir(repository)
  stage = 'images'
  if ((await docker(['image', 'inspect', WORDPRESS], { allowFailure: true })).code !== 0)
    throw new Error('The pinned WordPress image is missing; docker pull it first (README)')
  images.tools = await build('tools')
  images.browser = await build('browser')
  images.site = await build('site', ['--build-arg', `BASE=${WORDPRESS}`], '8.3-local')
  images.guard = await buildGuard()

  // The control: the default bridge, like any trusted platform container. It also tells where
  // containers see the host (`host-gateway`).
  stage = 'control'
  const control = (
    await docker([
      'run',
      '-d',
      '--rm',
      '--network',
      'bridge',
      '--add-host',
      'host.docker.internal:host-gateway',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '10001:10001',
      '--label',
      STAND_LABEL,
      images.tools,
      'node',
      '-e',
      "require('net').createServer((s) => s.end()).listen(7000); setTimeout(() => {}, 900000)",
    ])
  ).stdout
  const servers = []
  try {
    await measure(control, servers)
  } finally {
    if (!args.has('--keep')) await docker(['rm', '-f', control], { allowFailure: true })
    for (const server of servers) server?.close()
  }
}

/** Builds the previews, probes every path and prints the table; `servers` are closed by main. */
async function measure(control, servers) {
  const hostGateway = (
    await docker(['exec', control, 'getent', 'ahostsv4', 'host.docker.internal'])
  ).stdout.split(/\s+/)[0]
  // The stand's host services listen where containers see the host: on Docker Desktop the host
  // loopback (vpnkit carries host-gateway there), on Linux the host-gateway address itself. A
  // daemon whose host-gateway is another machine (Colima: the Mac) gets them on the default
  // bridge's address, and the relay is pointed there by address (`gatewayHost`).
  stage = 'host services'
  const linux = process.platform === 'linux'
  const local = Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry?.family === 'IPv4')
    .map((entry) => entry.address)
  const hostHere = !linux || local.includes(hostGateway)
  const bridgeGateway = linux
    ? (
        await docker([
          'network',
          'inspect',
          'bridge',
          '--format',
          '{{(index .IPAM.Config 0).Gateway}}',
        ])
      ).stdout
    : null
  const hostListen = !linux ? '127.0.0.1' : hostHere ? hostGateway : bridgeGateway
  /** The host's services as a container addresses them. */
  const hostAddress = linux ? hostListen : hostGateway
  const gatewayHost = hostHere ? 'host.docker.internal' : hostListen
  if (!hostHere)
    console.log(
      `host-gateway of this daemon (${hostGateway}) is not this machine: host services and the gateway listen on ${hostListen}`,
    )
  const gatewayPort = (await listening(hostListen, 8090)) ? await freePort(hostListen) : 8090
  const seenByGateway = []
  const gateway = createHttpServer((request, response) => {
    seenByGateway.push({ method: request.method, url: request.url, host: request.headers.host })
    const host = request.headers.host ?? ''
    const ours = host === `${previewA.hostname}:${gatewayPort}`
    response.writeHead(ours ? 200 : 421, { 'content-type': 'text/plain' })
    response.end(ours ? `gateway ${run}` : 'unknown host')
  })
  gateway.on('connect', (request, socket) => {
    seenByGateway.push({ method: 'CONNECT', url: request.url, host: request.headers.host })
    socket.end('HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\n\r\n')
  })
  await new Promise((resolve, reject) => {
    gateway.once('error', reject)
    gateway.listen(gatewayPort, hostListen, resolve)
  })
  servers.push(gateway)
  const hostPorts = [5432, 8200, 8085, 8090]
  for (const port of hostPorts)
    if (port !== gatewayPort && !(await listening(hostListen, port)))
      servers.push(await standListener(hostListen, port).catch(() => null))

  const runtime = createDockerPreviewRuntime({
    runtime: runtimeKind,
    socketPath,
    gatewayHost,
    gatewayPort,
    firewallImage: images.guard,
    refusedSubnets: [REFUSED.subnet],
    dnsServers: ['77.88.8.8', '77.88.8.1'],
  })
  const previewA = specOf('a', gatewayPort)
  const previewB = specOf('b', gatewayPort)
  const passwords = {
    user: randomBytes(24).toString('base64url'),
    root: randomBytes(24).toString('base64url'),
  }
  const rows = []
  try {
    stage = 'previews'
    const upstreamA = await runtime.ensure(previewA, { env: {}, database: passwords })
    const upstreamB = await runtime.ensure(previewB, { env: {}, database: null })
    for (const [spec, name] of [
      [previewA, 'a'],
      [previewB, 'b'],
    ])
      await runtime.writeFiles(spec.previewId, {
        archive: [ustar([{ path: 'index.php', content: page(name) }])],
        deletes: [],
        replace: true,
      })
    stage = 'browser'
    const endpoint = await runtime.startBrowser(previewA.previewId, {
      image: images.browser,
      hostname: previewA.hostname,
    })
    const controlPort = Number(new URL(endpoint.wsEndpoint).port)

    stage = 'addresses'
    const boxA = await containerOf(previewA.previewId, 'preview')
    const boxB = await containerOf(previewB.previewId, 'preview')
    const relay = await containerOf(previewA.previewId, 'relay')
    const browser = await containerOf(previewA.previewId, 'browser')
    const onPreview = (networks) =>
      Object.entries(networks).find(([name]) => name.startsWith('raditi-preview-'))[1].IPAddress
    const ipA = onPreview(await addresses(boxA))
    const ipB = onPreview(await addresses(boxB))
    const ipRelay = (await addresses(relay)).bridge.IPAddress
    const ipRelayInside = onPreview(await addresses(relay))
    const ipBrowser = onPreview(await addresses(browser))
    const ipControl = (await addresses(control)).bridge.IPAddress

    /** `php` — as the preview's PHP; `root` — as root of the preview's container. */
    const probe = async (container, kind, host, port) => {
      const node = { browser: '/usr/bin/node', root: '/usr/local/bin/node' }[kind] ?? 'node'
      const argv =
        kind === 'php'
          ? ['exec', '-u', '33:33', container, 'php', '-r', PHP_PROBE, '--', host, String(port)]
          : [
              'exec',
              '-u',
              kind === 'root' ? '0:0' : '10001:10001',
              container,
              node,
              '-e',
              NODE_PROBE,
              host,
              String(port),
            ]
      const { stdout } = await docker(argv, { allowFailure: true, timeoutMs: 30_000 })
      return ['open', 'closed', 'dns'].includes(stdout) ? stdout : `error`
    }
    const fromControl = (host, port) => probe(control, 'node', host, port)
    /** Published on the host's loopback: only the host itself can be the control. */
    const fromHost = async (port) => ((await listening('127.0.0.1', port)) ? 'open' : 'closed')
    // A name that does not resolve inside reaches nothing, whatever its port: its control has to
    // resolve it only. One that resolves — the resolvers of a preview answer the internet's
    // names — must find no way, as an address does, against a control that reached it.
    const blocked = async (
      from,
      container,
      kind,
      label,
      host,
      port,
      controlProbe = () => fromControl(host, port),
    ) => {
      const actual = await probe(container, kind, host, port)
      rows.push({
        from,
        to: label,
        expect: 'blocked',
        name: !isIP(host) && actual === 'dns',
        actual,
        control: await controlProbe(),
      })
    }
    const reachable = async (from, container, kind, label, host, port) =>
      rows.push({
        from,
        to: label,
        expect: 'reachable',
        actual: await probe(container, kind, host, port),
      })
    /** Exit 0 of a command in a container as a user: `open`, otherwise `closed`. */
    const runsAs = async (container, user, argv) =>
      (await docker(['exec', '-u', user, container, ...argv], { allowFailure: true })).code === 0
        ? 'open'
        : 'closed'

    stage = 'host probes'
    const hostA = `${previewA.hostname}:${gatewayPort}`
    const hostB = `${previewB.hostname}:${gatewayPort}`
    const answer = await httpGet(upstreamA.port, hostA)
    rows.push({
      from: 'host',
      to: `preview A via its gateway 127.0.0.1:${upstreamA.port}`,
      expect: 'reachable',
      actual: answer.body === `preview-a ${previewA.hostname}` ? 'open' : 'wrong answer',
    })
    // A caller holding a stale port of another preview: the gateway refuses the foreign Host.
    const ownB = await httpGet(upstreamB.port, hostB)
    const foreign = await httpGet(upstreamB.port, hostA)
    rows.push({
      from: 'host',
      to: `B gateway :${upstreamB.port} with the Host of A (421 expected)`,
      expect: 'blocked',
      actual: foreign.status === 421 ? 'closed' : foreign.status ? 'open' : 'error',
      control: ownB.body === `preview-b ${previewB.hostname}` ? 'open' : 'closed',
    })
    rows.push({
      from: 'host',
      to: `browser control 127.0.0.1:${controlPort}`,
      expect: 'reachable',
      actual: (await listening('127.0.0.1', controlPort)) ? 'open' : 'closed',
    })
    const lan = lanAddress()
    if (lan)
      rows.push({
        from: 'host',
        to: `browser control ${lan}:${controlPort} (LAN)`,
        expect: 'blocked',
        actual: (await listening(lan, controlPort)) ? 'open' : 'closed',
      })
    // The rules of A's bridge are in place and whole, as the runtime put them (host-firewall.mjs).
    const check = await docker(
      [
        'run',
        '--rm',
        '--runtime',
        'runc',
        '--network',
        'host',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'NET_ADMIN',
        '--read-only',
        '--tmpfs',
        '/run',
        '--security-opt',
        'no-new-privileges',
        '--label',
        STAND_LABEL,
        '--entrypoint',
        'tini',
        images.guard,
        '--',
        '/usr/local/bin/node',
        '/usr/local/lib/raditi/host-firewall.mjs',
        'check',
        previewBridge(previewA.previewId),
        '--refuse',
        REFUSED.subnet,
      ],
      { allowFailure: true },
    )
    rows.push({
      from: 'host',
      to: `rules of A's bridge ${previewBridge(previewA.previewId)} (check)`,
      expect: 'reachable',
      actual: check.code === 0 ? 'open' : 'closed',
    })

    stage = 'php probes'
    // Its own server and its own gateway, on the loopback and on its bridge.
    await reachable('PHP of A', boxA, 'php', 'own server 127.0.0.1:8081', '127.0.0.1', 8081)
    await reachable('PHP of A', boxA, 'php', 'own gateway 127.0.0.1:8080', '127.0.0.1', 8080)
    await reachable('PHP of A', boxA, 'php', 'own database 127.0.0.1:3306', '127.0.0.1', 3306)
    // The internet is open (owner's answer of 26.10.2026), names resolve.
    await reachable(
      'PHP of A',
      boxA,
      'php',
      `internet ${PUBLIC.address}:${PUBLIC.port}`,
      PUBLIC.address,
      PUBLIC.port,
    )
    await reachable('PHP of A', boxA, 'php', 'internet example.com:443', 'example.com', 443)
    // A subnet of the platform (--refuse), next to an open public address.
    await blocked(
      'PHP of A',
      boxA,
      'php',
      `refused subnet ${REFUSED.address}:${REFUSED.port}`,
      REFUSED.address,
      REFUSED.port,
    )
    for (const port of hostPorts) {
      await blocked(
        'PHP of A',
        boxA,
        'php',
        `host.docker.internal:${port}`,
        'host.docker.internal',
        port,
      )
      await blocked('PHP of A', boxA, 'php', `host ${hostAddress}:${port}`, hostAddress, port)
    }
    await blocked(
      'PHP of A',
      boxA,
      'php',
      `gateway ${hostAddress}:${gatewayPort}`,
      hostAddress,
      gatewayPort,
    )
    await blocked(
      'PHP of A',
      boxA,
      'php',
      `container on the default bridge ${ipControl}:7000`,
      ipControl,
      7000,
      () => probe(control, 'node', '127.0.0.1', 7000),
    )
    await blocked(
      'PHP of A',
      boxA,
      'php',
      `B gateway via host ${hostAddress}:${upstreamB.port}`,
      hostAddress,
      upstreamB.port,
      () => fromHost(upstreamB.port),
    )
    // B on its own bridge: its own PHP reaches it, A's does not.
    await blocked('PHP of A', boxA, 'php', `B ${ipB}:8080`, ipB, 8080, () =>
      probe(boxB, 'php', ipB, 8080),
    )
    await blocked('PHP of B', boxB, 'php', `A ${ipA}:8080`, ipA, 8080, () =>
      probe(boxA, 'php', ipA, 8080),
    )
    await blocked(
      'PHP of A',
      boxA,
      'php',
      `browser control via host ${hostAddress}:${controlPort}`,
      hostAddress,
      controlPort,
      () => fromHost(controlPort),
    )
    await blocked('PHP of A', boxA, 'php', `relay ${ipRelay}:9333`, ipRelay, 9333)
    await blocked('PHP of A', boxA, 'php', `browser ${ipBrowser}:9333`, ipBrowser, 9333, () =>
      fromControl(ipRelay, 9333),
    )

    stage = 'users inside'
    // The services of the container are users of their own (infra/preview/init.sh).
    rows.push({
      from: 'PHP of A',
      to: 'the root password of its database (/run/raditi/db/root)',
      expect: 'blocked',
      actual: await runsAs(boxA, '33:33', ['cat', '/run/raditi/db/root']),
      control: await runsAs(boxA, '999:999', ['cat', '/run/raditi/db/root']),
    })
    const gatewayPid = (
      await docker(['exec', '-u', '0:0', boxA, 'cat', '/run/raditi/ready/forward.pid'], {
        allowFailure: true,
      })
    ).stdout
    rows.push({
      from: 'PHP of A',
      to: `a signal to its gateway (pid ${gatewayPid || '?'})`,
      expect: 'blocked',
      actual: /^\d+$/.test(gatewayPid)
        ? await runsAs(boxA, '33:33', ['kill', '-0', gatewayPid])
        : 'error',
      control: /^\d+$/.test(gatewayPid)
        ? await runsAs(boxA, '10001:10001', ['kill', '-0', gatewayPid])
        : 'error',
    })
    const asRoot = ['mariadb', '--no-defaults', '--socket=/run/mysqld/mysqld.sock', '--user=root']
    rows.push({
      from: 'PHP of A',
      to: 'root of its database on the socket',
      expect: 'blocked',
      actual: await runsAs(boxA, '33:33', [...asRoot, '--execute=SELECT 1']),
      control: await runsAs(boxA, '0:0', [...asRoot, '--execute=SELECT 1']),
    })

    stage = 'root of the container'
    // The rules are the host's: root of the preview's container is held as its PHP is.
    await reachable(
      'root of A',
      boxA,
      'root',
      `internet ${PUBLIC.address}:${PUBLIC.port}`,
      PUBLIC.address,
      PUBLIC.port,
    )
    await blocked('root of A', boxA, 'root', `host ${hostAddress}:5432`, hostAddress, 5432)
    await blocked(
      'root of A',
      boxA,
      'root',
      `refused subnet ${REFUSED.address}:${REFUSED.port}`,
      REFUSED.address,
      REFUSED.port,
    )
    await blocked(
      'root of A',
      boxA,
      'root',
      `container on the default bridge ${ipControl}:7000`,
      ipControl,
      7000,
      () => probe(control, 'node', '127.0.0.1', 7000),
    )
    await blocked('root of A', boxA, 'root', `B ${ipB}:8080`, ipB, 8080, () =>
      probe(boxB, 'php', ipB, 8080),
    )

    stage = 'browser probes'
    rows.push({
      from: 'browser',
      to: `relay ${ipRelayInside}:3128 (proxy)`,
      expect: 'reachable',
      actual: await probe(browser, 'browser', ipRelayInside, 3128),
    })
    await blocked(
      'browser',
      browser,
      'browser',
      'host.docker.internal:5432',
      'host.docker.internal',
      5432,
    )
    await blocked('browser', browser, 'browser', `host ${hostAddress}:5432`, hostAddress, 5432)
    await blocked(
      'browser',
      browser,
      'browser',
      `gateway ${hostAddress}:${gatewayPort} directly`,
      hostAddress,
      gatewayPort,
    )
    await blocked('browser', browser, 'browser', 'internet 1.1.1.1:443', '1.1.1.1', 443)
    await blocked('browser', browser, 'browser', 'internet example.com:443', 'example.com', 443)
    await blocked('browser', browser, 'browser', `A ${ipA}:8080`, ipA, 8080, () =>
      probe(boxA, 'php', ipA, 8080),
    )
    await blocked(
      'browser',
      browser,
      'browser',
      `relay ${ipRelay}:9333 (bridge side)`,
      ipRelay,
      9333,
    )

    stage = 'chromium'
    const require = createRequire(
      new URL('../../../packages/browser-providers/package.json', import.meta.url),
    )
    const { chromium } = require('playwright-core')
    const wrongPath = new URL(endpoint.wsEndpoint)
    wrongPath.pathname = `/${randomBytes(32).toString('base64url')}`
    const refused = await chromium.connect(wrongPath.href, { timeout: 10_000 }).then(
      (other) => (other.close(), 'open'),
      () => 'closed',
    )
    rows.push({
      from: 'host',
      to: 'browser control, wrong secret path',
      expect: 'blocked',
      actual: refused,
    })
    const remote = await chromium.connect(endpoint.wsEndpoint, { timeout: 30_000 })
    try {
      const context = await remote.newContext()
      const tab = await context.newPage()
      const visit = async (url) => {
        const before = seenByGateway.length
        const response = await tab.goto(url, { timeout: 15_000 }).catch(() => null)
        const body = response ? await response.text().catch(() => '') : ''
        return { response, body, gateway: seenByGateway.slice(before) }
      }
      const own = await visit(`${previewA.origin}/`)
      rows.push({
        from: 'Chromium',
        to: `${previewA.origin}/ (through relay)`,
        expect: 'reachable',
        actual:
          own.body === `gateway ${run}` &&
          own.gateway.some((seen) => seen.host === `${previewA.hostname}:${gatewayPort}`)
            ? 'open'
            : 'closed',
      })
      const php = await visit(`http://${ipA}:8080/`)
      rows.push({
        from: 'Chromium',
        to: `A http://${ipA}:8080/`,
        expect: 'blocked',
        actual: php.body.startsWith('preview-a') ? 'open' : 'closed',
      })
      const outside = await visit('https://example.com/')
      rows.push({
        from: 'Chromium',
        to: 'https://example.com/ (only a CONNECT to the gateway)',
        expect: 'blocked',
        actual: outside.response ? 'open' : 'closed',
      })
      const proxied = [...php.gateway, ...outside.gateway]
      rows.push({
        from: 'Chromium',
        to: 'every other request went to the gateway',
        expect: 'reachable',
        actual: proxied.length >= 2 ? 'open' : 'closed',
      })
    } finally {
      await remote.close()
    }
  } catch (error) {
    error.stage ??= stage
    throw error
  } finally {
    stage = 'cleanup'
    if (!args.has('--keep')) {
      await runtime
        .destroy(previewA.previewId)
        .catch(() => console.error('cleanup of preview A failed'))
      await runtime
        .destroy(previewB.previewId)
        .catch(() => console.error('cleanup of preview B failed'))
    }
  }

  console.log(`\nPreview network on ${process.platform}, runtime ${runtimeKind}\n`)
  console.log(table(rows))
  const failed = rows.filter((row) => verdict(row) === 'FAIL')
  const vacuous = rows.filter((row) => verdict(row) === 'VACUOUS')
  console.log(
    `\n${rows.length} probes: ${rows.length - failed.length - vacuous.length} passed, ${failed.length} failed, ${vacuous.length} without a reachable control`,
  )
  if (!passed(rows)) process.exitCode = 1
}

main().catch((error) => {
  console.error(`preview network stand failed during ${error.stage ?? stage}: ${error.message}`)
  process.exitCode = 1
})
