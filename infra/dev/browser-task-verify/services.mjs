// The services of the browser-task stand, each started and made ready here: the certificates,
// PostgreSQL, Redis, S3 and OpenBao (from the release stand, removed with the projects —
// docs/plan/83-remove-projects.md). Every container is labelled with the run; the caller removes
// them (verify-browser-task.mjs, cleanup). The probe of the host and the relays to the host serve
// a stand that runs on Linux as well (the projects stand, infra/dev/projects-verify).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'

import { bootstrapLocalVault, localVaultRequest } from '../../vault/bootstrap.mjs'
import {
  BUCKETS,
  HOST_NAME,
  bridgeGatewayOf,
  certificateConfigs,
  hostGatewayOf,
  hostOf,
  openbaoArgs,
  postgresArgs,
  postgresEnvFile,
  redisArgs,
  redisEnvFile,
  s3Args,
  s3Identities,
} from './stand.mjs'

const publishedPort = (output) => {
  const [, port] = /^127\.0\.0\.1:(\d+)$/m.exec(output.trim()) ?? []
  assert.ok(port, 'A container is not published on loopback only')
  return Number(port)
}

/** The stand's own CA (two days) and one server certificate: the synthetic Z.ai. */
export async function createCertificates(
  rt,
  directory,
  { names = [], subject = 'raditi-browser-task-verify CA' } = {},
) {
  const openssl = (...args) =>
    rt.run('openssl', args, { env: { PATH: process.env.PATH, HOME: directory }, timeoutMs: 30_000 })
  const file = (leaf) => join(directory, leaf)
  const configs = certificateConfigs(names)
  await writeFile(file('ca.ext'), configs.authority)
  await writeFile(file('server.ext'), configs.server)
  await mkdir(file('tls'), { mode: 0o755 })
  const key = (path) =>
    openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', path)
  await key(file('ca-key.pem'))
  await openssl(
    'req',
    '-new',
    '-key',
    file('ca-key.pem'),
    '-subj',
    `/CN=${subject}`,
    '-out',
    file('ca.csr'),
  )
  await openssl(
    ...['x509', '-req', '-in', file('ca.csr'), '-signkey', file('ca-key.pem'), '-days', '2'],
    ...['-sha256', '-extfile', file('ca.ext'), '-out', file('ca.pem')],
  )
  await key(file('tls/server-key.pem'))
  await openssl(
    'req',
    '-new',
    '-key',
    file('tls/server-key.pem'),
    '-subj',
    '/CN=localhost',
    '-out',
    file('server.csr'),
  )
  await openssl(
    ...[
      'x509',
      '-req',
      '-in',
      file('server.csr'),
      '-CA',
      file('ca.pem'),
      '-CAkey',
      file('ca-key.pem'),
    ],
    ...['-days', '2', '-sha256', '-set_serial', `0x${randomBytes(16).toString('hex')}`],
    ...['-extfile', file('server.ext'), '-out', file('tls/server.pem')],
  )
  await chmod(file('tls/server-key.pem'), 0o444)
  await chmod(file('tls/server.pem'), 0o444)
  return {
    caFile: file('ca.pem'),
    ca: await readFile(file('ca.pem')),
    key: await readFile(file('tls/server-key.pem')),
    cert: await readFile(file('tls/server.pem')),
    tlsDirectory: file('tls'),
  }
}

export async function startPostgres(rt, names, directory) {
  const password = rt.secret(randomBytes(24).toString('hex'))
  const envFile = join(directory, 'postgres.env')
  await writeFile(envFile, postgresEnvFile(password), { mode: 0o600 })
  await rt.docker(postgresArgs({ names, envFile }))
  const port = publishedPort(
    (await rt.docker(['port', names.containers.postgres, '5432/tcp'])).output,
  )
  await rt.until(
    'PostgreSQL accepts connections',
    async () =>
      (
        await rt.docker(
          [
            'exec',
            names.containers.postgres,
            'pg_isready',
            '-h',
            '127.0.0.1',
            '-U',
            'raditi',
            '-d',
            'raditi',
          ],
          { allowFailure: true },
        )
      ).code === 0,
    { timeoutMs: 60_000 },
  )
  // The entrypoint restarts the server once after its init scripts: wait past that.
  await rt.until(
    'PostgreSQL answers a query after its init',
    async () =>
      (
        await rt.docker(
          [
            'exec',
            names.containers.postgres,
            'psql',
            '-U',
            'raditi',
            '-d',
            'raditi',
            '-tAc',
            'SELECT 1',
          ],
          { allowFailure: true },
        )
      ).output.trim() === '1',
  )
  return { url: rt.secret(`postgresql://raditi:${password}@127.0.0.1:${port}/raditi`), port }
}

export async function startRedis(rt, names, directory) {
  const password = rt.secret(randomBytes(24).toString('hex'))
  const envFile = join(directory, 'redis.env')
  await writeFile(envFile, redisEnvFile(password), { mode: 0o600 })
  await rt.docker(redisArgs({ names, envFile }))
  const port = publishedPort((await rt.docker(['port', names.containers.redis, '6379/tcp'])).output)
  await rt.until('Redis answers PING', async () =>
    (
      await rt.docker(
        [
          'exec',
          names.containers.redis,
          'sh',
          '-c',
          'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping',
        ],
        {
          allowFailure: true,
        },
      )
    ).output.includes('PONG'),
  )
  return { url: rt.secret(`redis://default:${password}@127.0.0.1:${port}`), port }
}

/** SeaweedFS with the buckets of the platform. */
export async function startS3(rt, names, directory, port) {
  const identity = {
    accessKey: rt.secret(`rv-${randomBytes(12).toString('hex')}`),
    secretKey: rt.secret(randomBytes(24).toString('hex')),
  }
  const config = join(directory, 's3')
  await mkdir(config, { mode: 0o755 })
  await writeFile(join(config, 's3.json'), s3Identities(identity), { mode: 0o644 })
  await rt.docker(s3Args({ names, port }))
  await rt.docker(['cp', config, `${names.containers.s3}:/stand`])
  await rt.docker(['start', names.containers.s3])
  const shell = async (command) =>
    (
      await rt.docker(['exec', names.containers.s3, 'sh', '-c', `echo '${command}' | weed shell`], {
        allowFailure: true,
      })
    ).output
  await rt.until(
    'S3 with the buckets of the platform',
    async () => {
      const listed = await shell('s3.bucket.list')
      const missing = Object.values(BUCKETS).filter((bucket) => !listed.includes(bucket))
      for (const bucket of missing) await shell(`s3.bucket.create -name ${bucket}`)
      if (missing.length > 0) return false
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) })
      return true
    },
    { timeoutMs: 120_000, intervalMs: 1000 },
  )
  return { endpoint: `http://127.0.0.1:${port}`, port, ...identity }
}

/**
 * OpenBao initialised and unsealed through its API, the mounts and policies of the platform
 * (infra/vault/bootstrap.mjs), an AppRole per process of the platform with the policies of its
 * service, and the scoped tokens of the trusted steps the stand plays: the operator's writer of
 * subscriptions, the writer of variables, the provisioner of workspace keys.
 */
export async function startOpenbao(rt, names, port) {
  await rt.docker(openbaoArgs({ names, port }))
  const address = `http://127.0.0.1:${port}`
  await rt.until('OpenBao answers', async () =>
    [200, 501, 503].includes((await localVaultRequest({ address }, 'sys/health')).status),
  )
  const init = await localVaultRequest({ address }, 'sys/init', {
    method: 'POST',
    body: { secret_shares: 1, secret_threshold: 1 },
  })
  assert.equal(init.status, 200, 'OpenBao initialisation failed')
  const rootToken = rt.secret(init.body.root_token)
  rt.secret(init.body.keys_base64[0])
  await localVaultRequest({ address }, 'sys/unseal', {
    method: 'POST',
    body: { key: init.body.keys_base64[0] },
  })
  const root = { address, token: rootToken }
  const request = async (path, options = {}) => {
    const result = await localVaultRequest(root, path, options)
    assert.ok([200, 204].includes(result.status), `OpenBao refused ${path} (${result.status})`)
    return result.body
  }
  await bootstrapLocalVault(root)
  await request('sys/auth/approle', { method: 'POST', body: { type: 'approle' } })
  const roles = {}
  for (const [name, policies] of [
    ['core', ['core-turns', 'core-transit', 'core-workspace-env', 'core-git', 'core-vk']],
    ['mcp', ['mcp-content']],
    ['llm', ['llm-subscriptions']],
    // As in production: web makes the Transit key of a workspace before its first task.
    ['web', ['sites-writer', 'workspace-provisioner']],
  ]) {
    await request(`auth/approle/role/${name}`, {
      method: 'POST',
      body: {
        token_policies: policies,
        token_no_default_policy: true,
        token_ttl: '15m',
        token_max_ttl: '2h',
        secret_id_ttl: '4h',
      },
    })
    roles[name] = {
      roleId: rt.secret((await request(`auth/approle/role/${name}/role-id`)).data.role_id),
      secretId: rt.secret(
        (await request(`auth/approle/role/${name}/secret-id`, { method: 'POST', body: {} })).data
          .secret_id,
      ),
    }
  }
  const tokens = {}
  for (const policy of ['subscriptions-writer', 'sites-writer', 'workspace-provisioner'])
    tokens[policy] = rt.secret(
      (
        await request('auth/token/create', {
          method: 'POST',
          body: { policies: [policy], no_default_policy: true, ttl: '4h', renewable: false },
        })
      ).auth.client_token,
    )
  return { address, root, request, roles, tokens }
}

/**
 * What the host is for containers (stand.mjs, `hostOf`): `docker info`, the gateway of the default
 * bridge and what `host-gateway` resolves to in a probe container on it — `image`, a pinned image
 * the stand has already (it is never pulled), which only prints its /etc/hosts. The probe carries
 * the label of the run.
 */
export async function probeHost(rt, names, image) {
  const info = await rt.docker(['info', '--format', '{{.OperatingSystem}}'])
  const bridge = await rt.docker([
    ...['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'],
  ])
  const probe = await rt.docker([
    ...['run', '--rm', '--pull', 'never', '--label', names.label, '--network', 'bridge'],
    ...['--add-host', `${HOST_NAME}:host-gateway`, '--read-only', '--cap-drop', 'ALL'],
    ...['--entrypoint', 'cat', image, '/etc/hosts'],
  ])
  return hostOf({
    operatingSystem: info.output.trim(),
    bridgeGateway: bridgeGatewayOf(bridge.output),
    hostGateway: hostGatewayOf(probe.output),
  })
}

/**
 * The relays of a run on Linux and in a VM (stand.mjs, `hostRelays`): a plain TCP forwarder in
 * this process per entry, `<listen>:<port>` → `<to>:<port>`. Resolves once every relay listens;
 * `close()` stops them and every open connection. A relay that cannot listen is refused in words
 * and leaves none behind.
 */
export async function startRelays(relays) {
  const servers = []
  const sockets = new Set()
  // Open connections first: a server closes only when the last of its connections did.
  const close = async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map((server) => new Promise((done) => server.close(() => done()))))
  }
  try {
    for (const relay of relays) {
      const server = createServer((inbound) => {
        const outbound = connect({ host: relay.to, port: relay.port })
        for (const end of [inbound, outbound]) {
          sockets.add(end)
          end.once('close', () => sockets.delete(end))
          end.on('error', () => {
            inbound.destroy()
            outbound.destroy()
          })
        }
        inbound.pipe(outbound).pipe(inbound)
      })
      servers.push(server)
      await new Promise((resolve, reject) => {
        server.once('error', (error) =>
          reject(
            new Error(
              `The relay of ${relay.role} cannot listen on ${relay.listen}:${relay.port}: ${error.message}`,
            ),
          ),
        )
        server.listen(relay.port, relay.listen, () => resolve())
      })
    }
  } catch (error) {
    await close()
    throw error
  }
  return { relays, close }
}
