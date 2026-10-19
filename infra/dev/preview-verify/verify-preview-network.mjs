// The network of a preview, measured on this machine (docs/plan/53-chat-preview-release.md, Р18,
// Р21): two previews and a browser built by the real Docker runtime (createDockerPreviewRuntime),
// then TCP and HTTP probes from the host, from inside the PHP container, from inside the browser
// container and from Chromium itself. Every «blocked» row has a control that reached the same
// target — from the default bridge, or from the host for what is published on its loopback — and
// a row that is not PASS fails the run: a probe that did not run, a name that resolves inside, a
// target nobody could reach anyway. Reachable rows from each side prove the probes themselves
// work. Preview A has the egress proxy of the client's variables (Р13): its rows prove that PHP
// reaches a listed public host through it, and nothing else — not a name that is not listed, not
// a listed name that resolves to a private, loopback or metadata address, not plain HTTP. No
// pulls, no .env, no real site.
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { connect, createServer, isIP } from 'node:net'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createDockerPreviewRuntime } from '../../../packages/sandbox-providers/src/preview/runtime.ts'
import {
  NODE_PROBE,
  PHP_CONNECT_PROBE,
  PHP_FRONTED_GET_PROBE,
  PHP_PROBE,
  PHP_PROXIED_GET_PROBE,
  passed,
  proxyOutcome,
  table,
  ustar,
  verdict,
} from './probes.mjs'

const images = {
  web: 'wordpress@sha256:8ae73d594a154e30b112e8d085afbc0895acf7651d8f53ef63aefb42e30822d5',
  cli: 'wordpress@sha256:2b5e9d4d3e51909dca1aaa4732e9f5e5bf0377c2114dbd8ff39f060bff202586',
}
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

/**
 * `host:port` preview A's variables lead to: one public host, and public names that resolve to
 * loopback, metadata, private and Docker bridge addresses (public wildcard DNS).
 */
const EGRESS_LISTED = {
  public: 'example.com:443',
  loopback: 'localtest.me:443',
  metadata: '169-254-169-254.nip.io:80',
  private: '10-0-0-1.nip.io:443',
  bridge: '172-17-0-1.nip.io:5432',
}

/** The client egress proxy (PREVIEW_EGRESS_IMAGE): infra/sandbox/Dockerfile, `client-egress`. */
async function buildEgress() {
  const tag = 'raditi-client-egress:local'
  if (!args.has('--no-build'))
    await docker(
      [
        'build',
        '-q',
        '-f',
        'infra/sandbox/Dockerfile',
        '--target',
        'client-egress',
        '-t',
        tag,
        '.',
      ],
      { timeoutMs: 900_000 },
    ).catch(() => {
      throw new Error(`docker build of the client egress image failed (run from ${repository})`)
    })
  return digestOf(tag)
}

async function build(target) {
  const tag = `raditi-preview-${target}:local`
  if (!args.has('--no-build'))
    await docker(
      [
        'build',
        '-q',
        '-f',
        'infra/preview/Dockerfile',
        '--target',
        target,
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
  'PidFile /run/apache2/apache2.pid',
  'Mutex file:/run/apache2 default',
  'DefaultRuntimeDir /run/apache2',
  'ErrorLog /proc/self/fd/2',
  'LogLevel warn',
  'IncludeOptional mods-enabled/*.load',
  'IncludeOptional mods-enabled/*.conf',
  'Listen 8080',
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

function specOf(name, gatewayPort) {
  const alias = name.repeat(6)
  const hostname = `site-${name.repeat(8)}-chat-${alias}.localhost`
  return {
    previewId: randomUUID(),
    siteId: randomUUID(),
    taskId: randomUUID(),
    runtime: runtimeKind,
    images: {
      web: images.web,
      db: null,
      cli: images.cli,
      forwarder: images.tools,
      egress: name === 'a' ? images.egress : null,
    },
    recipe: {
      runtime: 'php',
      runtimeVersions: ['8.3'],
      database: null,
      requiredPaths: [],
      generatedFiles: [],
      settings: { STAND: name },
      healthPath: '/',
      web: {
        command: ['apache2', '-DFOREGROUND', '-f', '/run/raditi/preview/httpd.conf'],
        env: {},
        port: 8080,
        user: '33:33',
        docroot: '/var/www/html',
        tmpfs: ['/run/apache2', '/tmp'],
        configFiles: [{ name: 'httpd.conf', content: apacheConfig }],
      },
    },
    limits: { cpu: 1, memoryMiB: 512, pids: 256 },
    egress: name === 'a' ? Object.values(EGRESS_LISTED).sort() : [],
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

async function main() {
  if (runtimeKind === 'runsc' && !process.env.SANDBOX_NETWORK_GUARD_IMAGE)
    throw new Error(
      '--runtime=runsc needs SANDBOX_NETWORK_GUARD_IMAGE (the network guard image, pinned)',
    )
  process.chdir(repository)
  stage = 'images'
  for (const image of Object.values(images))
    if ((await docker(['image', 'inspect', image], { allowFailure: true })).code !== 0)
      throw new Error('A pinned image is missing; docker pull it first (README)')
  images.tools = await build('tools')
  images.browser = await build('browser')
  images.egress = await buildEgress()

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
      'sleep',
      '900',
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
    ...(runtimeKind === 'runsc' ? { firewallImage: process.env.SANDBOX_NETWORK_GUARD_IMAGE } : {}),
  })
  const previewA = specOf('a', gatewayPort)
  const previewB = specOf('b', gatewayPort)
  const rows = []
  try {
    stage = 'previews'
    const upstreamA = await runtime.ensure(previewA, { env: {}, database: null })
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
    const webA = await containerOf(previewA.previewId, 'web')
    const webB = await containerOf(previewB.previewId, 'web')
    const forwarderA = await containerOf(previewA.previewId, 'forwarder')
    const forwarderB = await containerOf(previewB.previewId, 'forwarder')
    const relay = await containerOf(previewA.previewId, 'relay')
    const browser = await containerOf(previewA.previewId, 'browser')
    const onPreview = (networks) =>
      Object.entries(networks).find(([name]) => name.startsWith('raditi-preview-'))[1].IPAddress
    const ipWebA = onPreview(await addresses(webA))
    const ipWebB = onPreview(await addresses(webB))
    const ipForwarderA = (await addresses(forwarderA)).bridge.IPAddress
    const ipForwarderAInside = onPreview(await addresses(forwarderA))
    const ipForwarderB = (await addresses(forwarderB)).bridge.IPAddress
    const ipRelay = (await addresses(relay)).bridge.IPAddress
    const ipRelayInside = onPreview(await addresses(relay))
    const ipBrowser = onPreview(await addresses(browser))

    const probe = async (container, kind, host, port) => {
      const argv =
        kind === 'php'
          ? ['exec', '-u', '33:33', container, 'php', '-r', PHP_PROBE, '--', host, String(port)]
          : [
              'exec',
              '-u',
              '10001:10001',
              container,
              kind === 'browser' ? '/usr/bin/node' : '/usr/local/bin/node',
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
    const blocked = async (
      from,
      container,
      kind,
      label,
      host,
      port,
      controlProbe = () => fromControl(host, port),
    ) =>
      rows.push({
        from,
        to: label,
        expect: 'blocked',
        name: !isIP(host),
        actual: await probe(container, kind, host, port),
        control: await controlProbe(),
      })
    const reachable = async (from, container, kind, label, host, port) =>
      rows.push({
        from,
        to: label,
        expect: 'reachable',
        actual: await probe(container, kind, host, port),
      })

    stage = 'host probes'
    const hostA = `${previewA.hostname}:${gatewayPort}`
    const hostB = `${previewB.hostname}:${gatewayPort}`
    const answer = await httpGet(upstreamA.port, hostA)
    rows.push({
      from: 'host',
      to: `preview A via forwarder 127.0.0.1:${upstreamA.port}`,
      expect: 'reachable',
      actual: answer.body === `preview-a ${previewA.hostname}` ? 'open' : 'wrong answer',
    })
    // A caller holding a stale port of another preview: the forwarder refuses the foreign Host.
    const ownB = await httpGet(upstreamB.port, hostB)
    const foreign = await httpGet(upstreamB.port, hostA)
    rows.push({
      from: 'host',
      to: `B forwarder :${upstreamB.port} with the Host of A (421 expected)`,
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

    stage = 'php probes'
    // The probe works from PHP: its own server and its own entry, on the preview's network.
    await reachable('PHP of A', webA, 'php', 'own server 127.0.0.1:8080', '127.0.0.1', 8080)
    await reachable(
      'PHP of A',
      webA,
      'php',
      `A forwarder ${ipForwarderAInside}:8080 (preview side)`,
      ipForwarderAInside,
      8080,
    )
    for (const port of hostPorts) {
      await blocked(
        'PHP of A',
        webA,
        'php',
        `host.docker.internal:${port}`,
        'host.docker.internal',
        port,
      )
      await blocked('PHP of A', webA, 'php', `host ${hostAddress}:${port}`, hostAddress, port)
    }
    await blocked(
      'PHP of A',
      webA,
      'php',
      `gateway ${hostAddress}:${gatewayPort}`,
      hostAddress,
      gatewayPort,
    )
    await blocked('PHP of A', webA, 'php', 'internet 1.1.1.1:443', '1.1.1.1', 443)
    await blocked('PHP of A', webA, 'php', 'internet example.com:443', 'example.com', 443)
    await blocked(
      'PHP of A',
      webA,
      'php',
      `B forwarder via host ${hostAddress}:${upstreamB.port}`,
      hostAddress,
      upstreamB.port,
      () => fromHost(upstreamB.port),
    )
    await blocked('PHP of A', webA, 'php', `B forwarder ${ipForwarderB}:8080`, ipForwarderB, 8080)
    await blocked('PHP of A', webA, 'php', `B PHP ${ipWebB}:8080`, ipWebB, 8080, () =>
      fromControl(ipForwarderB, 8080),
    )
    await blocked(
      'PHP of A',
      webA,
      'php',
      `A forwarder ${ipForwarderA}:8080 (bridge side)`,
      ipForwarderA,
      8080,
    )
    await blocked(
      'PHP of A',
      webA,
      'php',
      `browser control via host ${hostAddress}:${controlPort}`,
      hostAddress,
      controlPort,
      () => fromHost(controlPort),
    )
    await blocked('PHP of A', webA, 'php', `relay ${ipRelay}:9333`, ipRelay, 9333)
    await blocked('PHP of A', webA, 'php', `browser ${ipBrowser}:9333`, ipBrowser, 9333, () =>
      fromControl(ipRelay, 9333),
    )

    stage = 'egress probes'
    // The egress proxy of A, as wp-config reaches it: the name `egress` of /etc/hosts.
    await reachable('PHP of A', webA, 'php', 'egress proxy egress:3128', 'egress', 3128)
    const connect = async (target) => {
      const { stdout } = await docker(
        [
          'exec',
          '-u',
          '33:33',
          webA,
          'php',
          '-r',
          PHP_CONNECT_PROBE,
          '--',
          'egress',
          '3128',
          target,
        ],
        { allowFailure: true, timeoutMs: 40_000 },
      )
      return stdout
    }
    rows.push({
      from: 'PHP of A',
      to: `CONNECT ${EGRESS_LISTED.public} (listed, public)`,
      expect: 'reachable',
      actual: proxyOutcome(await connect(EGRESS_LISTED.public)),
    })
    const get = async (url, tunnel) => {
      const { stdout } = await docker(
        [
          'exec',
          '-u',
          '33:33',
          webA,
          'php',
          '-r',
          PHP_PROXIED_GET_PROBE,
          '--',
          url,
          'http://egress:3128',
          tunnel ? '1' : '0',
        ],
        { allowFailure: true, timeoutMs: 40_000 },
      )
      return Number(stdout)
    }
    const https = await get('https://example.com/', true)
    rows.push({
      from: 'PHP of A',
      to: 'https://example.com/ through the proxy (TLS end to end)',
      expect: 'reachable',
      actual: https >= 200 && https < 400 ? 'open' : https ? 'closed' : 'error',
    })
    // The listed name with the TLS of another site: on a shared front end its address serves
    // that site as well. The proxy opens the tunnel and closes it at the ClientHello.
    const { stdout: fronted } = await docker(
      [
        'exec',
        '-u',
        '33:33',
        webA,
        'php',
        '-r',
        PHP_FRONTED_GET_PROBE,
        '--',
        'https://example.org/',
        'http://egress:3128',
        `example.org:443:${EGRESS_LISTED.public}`,
      ],
      { allowFailure: true, timeoutMs: 40_000 },
    )
    rows.push({
      from: 'PHP of A',
      to: `https://example.org/ in a tunnel to ${EGRESS_LISTED.public} (another name in TLS)`,
      expect: 'blocked',
      actual: fronted.trim() === 'closed' ? 'closed' : fronted.trim() === 'open' ? 'open' : 'error',
    })
    const plain = await get('http://example.com/', false)
    rows.push({
      from: 'PHP of A',
      to: 'http://example.com/ handed to the proxy (plain HTTP, 405 expected)',
      expect: 'blocked',
      actual: plain === 405 ? 'closed' : plain >= 200 && plain < 400 ? 'open' : 'error',
    })
    for (const [label, target, reason] of [
      ['not listed', 'example.org:443', 'forbidden_host'],
      ['listed host, another port', 'example.com:8443', 'forbidden_host'],
      ['IP literal', '93.184.215.14:443', 'forbidden_host'],
      ['host.docker.internal', 'host.docker.internal:5432', 'forbidden_host'],
      ['listed, resolves to 127.0.0.1', EGRESS_LISTED.loopback, 'forbidden_address'],
      ['listed, resolves to 169.254.169.254', EGRESS_LISTED.metadata, 'forbidden_address'],
      ['listed, resolves to 10.0.0.1', EGRESS_LISTED.private, 'forbidden_address'],
      ['listed, resolves to 172.17.0.1', EGRESS_LISTED.bridge, 'forbidden_address'],
    ])
      rows.push({
        from: 'PHP of A',
        to: `CONNECT ${target} (${label})`,
        expect: 'blocked',
        actual: proxyOutcome(await connect(target), reason),
      })
    // B has no variables: no proxy at all, and the name does not resolve there.
    await blocked('PHP of B', webB, 'php', 'egress:3128 (B has none)', 'egress', 3128, () =>
      probe(webA, 'php', 'egress', 3128),
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
    await blocked('browser', browser, 'browser', `A PHP ${ipWebA}:8080`, ipWebA, 8080, () =>
      fromControl(ipForwarderA, 8080),
    )
    await blocked(
      'browser',
      browser,
      'browser',
      `A forwarder ${ipForwarderA}:8080`,
      ipForwarderA,
      8080,
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
      const php = await visit(`http://${ipWebA}:8080/`)
      rows.push({
        from: 'Chromium',
        to: `A PHP http://${ipWebA}:8080/`,
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
