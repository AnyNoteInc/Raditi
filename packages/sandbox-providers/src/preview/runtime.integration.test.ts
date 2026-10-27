import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { connect } from 'node:net'

import type { PreviewRuntimeSpec } from '@repo/domain'
import Docker from 'dockerode'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { previewRuntimeLimits } from './config.ts'
import { previewBridge } from './resources.ts'
import { createDockerPreviewRuntime } from './runtime.ts'

// Explicit opt-in (RADITI_PREVIEW_DOCKER_TESTS=1): the images of infra/preview/Dockerfile built
// and tagged as infra/preview/README.md says — `site` for PHP 8.3, `tools`, the browser's
// optional — and the image of the host rules (infra/sandbox/Dockerfile, `network-guard`, or
// SANDBOX_NETWORK_GUARD_IMAGE). Never pulls; only what this suite creates is removed. A preview
// is one container on a bridge of its own (docs/plan/58); its network is measured from every
// side by `pnpm verify:preview-network`, this suite reaches the internet once.
const enabled = process.env.RADITI_PREVIEW_DOCKER_TESTS === '1'
const socketPath = process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock'
const runtimeKind = process.env.PREVIEW_RUNTIME === 'runsc' ? 'runsc' : 'runc'
const docker = new Docker({ socketPath })
/** The digest of a local tag; null when it was not built. */
const pinned = (tag: string) =>
  docker
    .getImage(tag)
    .inspect()
    .then(
      (info) =>
        info.RepoDigests.find((digest) => digest.startsWith(`${tag.split(':')[0]}@`)) ?? null,
      () => null,
    )
let images = { preview: '', tools: '' }
let guard = ''
let browserImage: string | null = null
const apache = [
  'ServerRoot "/etc/apache2"',
  'PidFile /tmp/apache2/apache2.pid',
  'Mutex file:/tmp/apache2 default',
  'ErrorLog /proc/self/fd/2',
  'IncludeOptional mods-enabled/*.load',
  'IncludeOptional mods-enabled/*.conf',
  'Listen 127.0.0.1:8081',
  'ServerName localhost',
  'DocumentRoot /var/www/html',
  '<Directory /var/www/html/>',
  '  Require all granted',
  '</Directory>',
  '<FilesMatch \\.php$>',
  '  SetHandler application/x-httpd-php',
  '</FilesMatch>',
  'DirectoryIndex index.php',
].join('\n')
// The page reads the settings file and its database: what a stack's generated files do.
const page = `<?php
$s = json_decode(file_get_contents('/run/raditi/preview/settings.json'), true);
$d = $s['database'];
$db = new mysqli($d['host'], $d['user'], $d['password'], $d['name'], $d['port']);
$row = $db->query('SELECT a FROM t')->fetch_row();
echo $s['hostname'] . ' ' . $row[0] . ' ' . $s['env']['API_KEY'];
`

function ustar(files: { path: string; content: string; type?: string }[]): Buffer {
  const blocks: Buffer[] = []
  for (const file of files) {
    const body = Buffer.from(file.content)
    const header = Buffer.alloc(512)
    header.write(file.path, 0, 'utf8')
    header.write('0000644\0', 100, 'latin1')
    header.write('0000000\0', 108, 'latin1')
    header.write('0000000\0', 116, 'latin1')
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
    header.write('00000000000\0', 136, 'latin1')
    header.write('        ', 148, 'latin1')
    header.write(file.type ?? '0', 156, 'latin1')
    header.write('ustar\0', 257, 'latin1')
    header.write('00', 263, 'latin1')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}
const once = async function* (bytes: Buffer) {
  yield bytes
}
/** What core keeps in Vault `kv/previews/<previewId>/db` and hands to every build. */
const passwords = {
  user: randomBytes(24).toString('base64url'),
  root: randomBytes(24).toString('base64url'),
}
const secrets = { env: { API_KEY: 'stand-secret-value' }, database: passwords }

function specOf(database = true): PreviewRuntimeSpec {
  const hostname = `site-0f3a9c1b-chat-${randomUUID().slice(0, 6)}.localhost`
  return {
    previewId: randomUUID(),
    siteId: randomUUID(),
    taskId: randomUUID(),
    runtime: runtimeKind,
    images,
    database,
    recipe: {
      runtime: 'php',
      runtimeVersions: ['8.3'],
      database: 'mysql',
      requiredPaths: [],
      generatedFiles: [],
      settings: {},
      healthPath: '/',
      web: {
        command: ['apache2-foreground', '-f', '/run/raditi/preview/httpd.conf'],
        env: { APACHE_RUN_DIR: '/tmp/apache2', APACHE_LOCK_DIR: '/tmp/apache2' },
        port: 8081,
        user: '33:33',
        docroot: '/var/www/html',
        tmpfs: ['/tmp'],
        configFiles: [{ name: 'httpd.conf', content: apache }],
      },
    },
    limits: { cpu: 2, memoryMiB: 2048, pids: 512 },
    upstreamHost: '127.0.0.1',
    hostname,
    origin: `http://${hostname}:8090`,
    productionOrigin: 'https://shop.example.ru',
    expiresAt: Date.now() + 60 * 60_000,
  }
}

/** GET through the entry forwarder with the Host the gateway sends: fetch() sends no Host of its own. */
const get = (upstream: { host: string; port: number }, host: string, path = '/') =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request(
      { host: upstream.host, port: upstream.port, path, headers: { host }, agent: false },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        )
      },
    )
    outgoing.on('error', reject)
    outgoing.end()
  })

/** The exit code of a command in the preview's container as `user`, found by its labels. */
async function codeIn(previewId: string, user: string, argv: string[]) {
  const [row] = await docker.listContainers({
    filters: { label: [`io.raditi.preview.id=${previewId}`, 'io.raditi.preview.role=preview'] },
  })
  const exec = await docker
    .getContainer(row!.Id)
    .exec({ Cmd: argv, User: user, AttachStdout: true })
  const stream = await exec.start({})
  stream.resume()
  await new Promise((resolve) => stream.on('end', resolve))
  return (await exec.inspect()).ExitCode
}

const listens = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: 2000 })
    socket.once('connect', () => (socket.destroy(), resolve(true)))
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => (socket.destroy(), resolve(false)))
  })

describe.skipIf(!enabled)('real Docker preview runtime', () => {
  let runtime: ReturnType<typeof createDockerPreviewRuntime>
  const owned: string[] = []
  beforeAll(async () => {
    images = {
      preview: (await pinned('raditi-preview-site:8.3-local')) ?? '',
      tools: (await pinned('raditi-preview-tools:local')) ?? '',
    }
    browserImage = await pinned('raditi-preview-browser:local')
    const firewallImage =
      process.env.SANDBOX_NETWORK_GUARD_IMAGE ?? (await pinned('raditi-network-guard:local'))
    guard = firewallImage ?? ''
    if (!images.preview || !images.tools || !firewallImage)
      throw new Error(
        'Build raditi-preview-site:8.3-local, raditi-preview-tools:local and raditi-network-guard:local first (infra/preview/README.md)',
      )
    runtime = createDockerPreviewRuntime({
      runtime: runtimeKind,
      socketPath,
      gatewayPort: 8090,
      firewallImage,
      dnsServers: ['77.88.8.8', '77.88.8.1'],
    })
  })
  afterAll(async () => {
    for (const id of owned) await runtime.destroy(id)
  }, 120_000)

  it('serves the tree with its database and settings, refuses links, loads only data', async () => {
    const spec = specOf()
    owned.push(spec.previewId)
    const upstream = await runtime.ensure(spec, secrets)
    await runtime.loadDatabase(
      spec.previewId,
      once(Buffer.from('CREATE TABLE t (a INT); INSERT INTO t VALUES (42);\n')),
      passwords,
    )
    // The passwords are files of the database's tmpfs: nothing Docker keeps shows them.
    const [row] = await docker.listContainers({
      all: true,
      filters: {
        label: [`io.raditi.preview.id=${spec.previewId}`, 'io.raditi.preview.role=preview'],
      },
    })
    const info = JSON.stringify(await docker.getContainer(row!.Id).inspect())
    expect(info).not.toContain(passwords.user)
    expect(info).not.toContain(passwords.root)
    await runtime.writeFiles(spec.previewId, {
      archive: once(
        ustar([
          { path: 'index.php', content: page },
          { path: 'old.txt', content: 'x' },
        ]),
      ),
      deletes: [],
      replace: true,
    })
    // Deletes go before the archive (infra/preview/files.mjs): a path of the old tree goes.
    await runtime.writeFiles(spec.previewId, {
      archive: once(ustar([])),
      deletes: ['old.txt'],
      replace: false,
    })
    const host = `${spec.hostname}:8090`
    expect((await get(upstream, host)).body).toBe(`${spec.hostname} 42 stand-secret-value`)
    expect((await get(upstream, host, '/old.txt')).status).toBe(404)
    // The port outlives the forwarder in a caller's row: another host never reaches this PHP.
    expect(await get(upstream, `site-0f3a9c1b-chat-ffffff.localhost:8090`)).toMatchObject({
      status: 421,
    })

    // A link planted by the site's own code is never written through.
    const planted = await runtime.exec(spec.previewId, {
      argv: ['ln', '-s', '/etc', '/var/www/html/escape'],
      timeoutMs: 30_000,
    })
    expect(planted.code).toBe(0)
    await expect(
      runtime.writeFiles(spec.previewId, {
        archive: once(ustar([{ path: 'escape/passwd', content: 'owned' }])),
        deletes: [],
        replace: false,
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('path_conflict'),
    })
    await expect(
      runtime.writeFiles(spec.previewId, {
        archive: once(ustar([{ path: 'link', content: '', type: '2' }])),
        deletes: [],
        replace: false,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('entry_type') })

    // Client commands of a seed never run: it is data, and this line is not.
    await expect(
      runtime.loadDatabase(
        spec.previewId,
        once(Buffer.from('\\! touch /tmp/pwned\nSELECT 1;\n')),
        passwords,
      ),
    ).rejects.toThrow()
    // Where the client ran: the preview's container, as the database's user.
    expect(await codeIn(spec.previewId, '999:999', ['test', '-d', '/tmp'])).toBe(0)
    expect(await codeIn(spec.previewId, '999:999', ['test', '-e', '/tmp/pwned'])).not.toBe(0)
    // A load replaces the database even when it fails: the next build loads the seed again.
    await runtime.loadDatabase(
      spec.previewId,
      once(Buffer.from('CREATE TABLE t (a INT); INSERT INTO t VALUES (42);\n')),
      passwords,
    )

    // The PHP of the preview: its database and its gateway on the loopback, the internet open
    // (docs/plan/58), the database's passwords not its own.
    const probe = await runtime.exec(spec.previewId, {
      argv: [
        'php',
        '-r',
        'foreach ([["127.0.0.1", 3306], ["127.0.0.1", 8080], ["1.1.1.1", 443]] as [$h, $p]) { $s = @fsockopen($h, $p, $c, $m, 5); echo $s ? "open " : "closed "; }',
      ],
      timeoutMs: 60_000,
    })
    expect(Buffer.from(probe.stdout).toString()).toBe('open open open ')
    expect(
      (
        await runtime.exec(spec.previewId, {
          argv: ['cat', '/run/raditi/db/root'],
          timeoutMs: 30_000,
        })
      ).code,
    ).not.toBe(0)
    // A command of the platform ends with every process it started.
    const lingering = await runtime.exec(spec.previewId, {
      argv: ['sh', '-c', 'sleep 300 & echo started'],
      timeoutMs: 30_000,
    })
    expect(lingering.code).toBe(0)
    const sleepsOfPhp =
      'for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = sleep ] && grep -q "^Uid:[[:space:]]*33[[:space:]]" "$p/status" 2>/dev/null && exit 0; done; exit 1'
    expect(await codeIn(spec.previewId, '0:0', ['sh', '-c', sleepsOfPhp])).not.toBe(0)

    // The rules of its bridge are whole; a reload of the host's firewall that took the jump to
    // them is seen, and the next build puts them back (docs/plan/58).
    await runtime.checkBoundary(spec.previewId)
    const bridge = previewBridge(spec.previewId)
    const hostRule = await docker.createContainer({
      Image: guard,
      User: '0:0',
      Entrypoint: ['/usr/sbin/iptables'],
      Cmd: ['--wait', '5', '-D', 'DOCKER-USER', '-i', bridge, '-j', `RADITI-${bridge}`],
      HostConfig: { NetworkMode: 'host', CapDrop: ['ALL'], CapAdd: ['NET_ADMIN'] },
    })
    await hostRule.start()
    expect(((await hostRule.wait()) as { StatusCode: number }).StatusCode).toBe(0)
    await hostRule.remove()
    await expect(runtime.checkBoundary(spec.previewId)).rejects.toMatchObject({
      code: 'SANDBOX_COMMAND_FAILED',
    })
    await runtime.ensure(spec, secrets)
    await runtime.checkBoundary(spec.previewId)

    // The PHP of the preview owns its docroot and may close it, to itself too: the next build and
    // the next write still go through.
    expect(
      (
        await runtime.exec(spec.previewId, {
          argv: ['chmod', '000', '/var/www/html'],
          timeoutMs: 30_000,
        })
      ).code,
    ).toBe(0)
    // Again: nothing replaced, the same entry.
    expect(await runtime.ensure(spec, secrets)).toEqual(upstream)
    await runtime.writeFiles(spec.previewId, {
      archive: once(ustar([{ path: 'index.php', content: page }])),
      deletes: [],
      replace: false,
    })
    expect((await get(upstream, host)).body).toBe(`${spec.hostname} 42 stand-secret-value`)
    await runtime.stop(spec.previewId)
    expect(await runtime.inspect(spec.previewId)).toMatchObject({ running: false })
    // A restart empties the tmpfs: the database waits for its passwords again, from the caller.
    const restarted = await runtime.ensure(spec, secrets)
    expect((await get(restarted, host)).body).toBe(`${spec.hostname} 42 stand-secret-value`)
    // Moved on without a build: a new lease only.
    await runtime.extend(spec.previewId, spec.expiresAt + 60_000)
    const leases = await docker.listContainers({
      all: true,
      filters: {
        label: [`io.raditi.preview.id=${spec.previewId}`, 'io.raditi.preview.role=lease'],
      },
    })
    expect(leases.map((lease) => Number(lease.Labels['io.raditi.preview.deadline']))).toEqual([
      spec.expiresAt + 60_000 + previewRuntimeLimits.deadlineGraceMs,
    ])

    await runtime.destroy(spec.previewId)
    expect(await runtime.list()).not.toContain(spec.previewId)
    expect(
      await docker.listVolumes({ filters: { label: [`io.raditi.preview.id=${spec.previewId}`] } }),
    ).toMatchObject({ Volumes: [] })
  }, 300_000)

  it('starts a browser whose control port answers on loopback', async (context) => {
    if (!browserImage) return context.skip()
    const spec = specOf(false)
    owned.push(spec.previewId)
    await runtime.ensure(spec, { env: {}, database: null })
    const endpoint = await runtime.startBrowser(spec.previewId, {
      image: browserImage!,
      hostname: spec.hostname,
    })
    const url = new URL(endpoint.wsEndpoint)
    expect(url.hostname).toBe('127.0.0.1')
    expect(await listens(Number(url.port))).toBe(true)
    expect(
      await runtime.startBrowser(spec.previewId, { image: browserImage!, hostname: spec.hostname }),
    ).toEqual(endpoint)
    await runtime.stopBrowser(spec.previewId)
    expect(await listens(Number(url.port))).toBe(false)
  }, 300_000)
})
