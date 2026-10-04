import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { bootstrapLocalVault, localVaultRequest } from '../../vault/bootstrap.mjs'
import { createVerificationCertificates } from './certificates.mjs'
import { CLI_IMAGE, removeMountedDirectory } from './cli.mjs'

export const repository = fileURLToPath(new URL('../../../', import.meta.url))
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => ['PATH', 'HOME', 'TMPDIR'].includes(key) || key.startsWith('DOCKER_'),
  ),
)
const controller = new AbortController()
export const abortVerification = () => controller.abort()

export function run(
  program,
  args,
  {
    input,
    env = {},
    timeoutMs = 180_000,
    allowFailure = false,
    cwd = repository,
    cleanup = false,
    infrastructureDiagnostics = false,
  } = {},
) {
  return new Promise((resolve, reject) => {
    if (!cleanup && controller.signal.aborted) return reject(new Error('Verification interrupted'))
    const child = spawn(program, args, { cwd, env: { ...baseEnv, ...env }, stdio: 'pipe' })
    const out = [],
      err = []
    let size = 0,
      exceeded = false
    const timer = setTimeout(() => {
      exceeded = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const cancel = () => {
      exceeded = true
      child.kill('SIGKILL')
    }
    if (!cleanup) controller.signal.addEventListener('abort', cancel, { once: true })
    const capture = (target) => (chunk) => {
      size += chunk.length
      if (size > 8 * 1024 * 1024) {
        exceeded = true
        child.kill('SIGKILL')
      } else target.push(chunk)
    }
    child.stdout.on('data', capture(out))
    child.stderr.on('data', capture(err))
    child.once('error', () => {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', cancel)
      reject(new Error(`Cannot start ${program}`))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', cancel)
      if (exceeded || (code !== 0 && !allowFailure))
        reject(
          Object.assign(new Error(`${program} failed (${exceeded ? 'limit' : code})`), {
            infrastructureDiagnostic: infrastructureDiagnostics
              ? Buffer.concat(err).toString().slice(-3000)
              : undefined,
          }),
        )
      else
        resolve({
          code,
          stdout: Buffer.concat(out).toString(),
          stderr: Buffer.concat(err).toString(),
        })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export async function eventually(work, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  do {
    if (controller.signal.aborted) throw new Error('Verification interrupted')
    try {
      const value = await work()
      if (value) return value
    } catch {
      /* Startup races are expected. */
    }
    await sleep(100)
  } while (Date.now() < end)
  throw new Error('Verification condition did not become ready')
}

export function chooseCliSubnet(taken) {
  const range = (cidr) => {
    const [address, prefix] = cidr.split('/')
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(address) || !/^\d+$/.test(prefix ?? '')) return null
    const bits = Number(prefix)
    if (bits < 0 || bits > 32) return null
    const ip = address.split('.').reduce((value, part) => value * 256 + Number(part), 0)
    const size = 2 ** (32 - bits),
      start = Math.floor(ip / size) * size
    return [start, start + size - 1]
  }
  const occupied = taken.map(range).filter(Boolean)
  for (let second = 30; second < 32; second++)
    for (let n = 120; n < 250; n++) {
      const prefix = `172.${second}.${n}`
      const [start, end] = range(`${prefix}.0/24`)
      if (!occupied.some(([left, right]) => start <= right && left <= end)) return prefix
    }
  throw new Error('No disposable CLI subnet available')
}

/**
 * Where sandbox-gw sends /mcp. The synthetic server of fake-subscriptions by default; with a port,
 * the real role mcp, a process on the host like the role llm.
 */
export function mcpUpstream(port) {
  if (port === undefined) return 'http://fake-subscriptions:8788'
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Invalid MCP port')
  return `http://host.docker.internal:${port}`
}

const S3_BUCKET = 'raditi-p3verify-artifacts'

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * Owns every resource it starts; accepts no external DB, Vault, token or .env input.
 * `content` is the agent-content stand: an S3 for content snapshots, a free host port for the
 * real role mcp behind sandbox-gw, the AppRole of the mcp service and the scoped tokens of the
 * site connection step. Without it the stack is what verify:llm-gateway always ran.
 */
export async function startVerificationStack({ onStage = () => {}, content = false } = {}) {
  onStage('local Docker preflight')
  const docker = (args, options) => run('docker', args, options)
  const context = (
    await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
  ).stdout.trim()
  const endpoint = baseEnv.DOCKER_CONTEXT ? context : (baseEnv.DOCKER_HOST ?? context)
  assert.match(
    endpoint,
    /^(unix:\/\/\/[^\s?#]+|npipe:\/\/\/[/\\][^\s?#]+)$/,
    'Local Docker is required',
  )
  const directory = await mkdtemp(join(tmpdir(), 'raditi-p3verify-'))
  const project = `raditi-p3verify-${randomBytes(6).toString('hex')}`
  const envFile = join(directory, 'compose.env')
  const composeArgs = [
    'compose',
    '--project-name',
    project,
    '--project-directory',
    repository,
    '--env-file',
    envFile,
    '--file',
    join(repository, 'infra/dev/llm-verify/compose.yml'),
    ...(content ? ['--profile', 'content'] : []),
  ]
  const compose = (args, options) => docker([...composeArgs, ...args], options)
  let started = false,
    closing
  const close = () =>
    (closing ??= (async () => {
      if (started) {
        await compose(['down', '--volumes', '--remove-orphans'], {
          timeoutMs: 60_000,
          cleanup: true,
        })
        const remaining = await docker(
          ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
          { cleanup: true },
        )
        assert.equal(remaining.stdout.trim(), '', 'Owned containers remain after cleanup')
        started = false
      }
      // The CLI session's files belong to container uid 10001; see removeMountedDirectory.
      await removeMountedDirectory(directory, {
        docker: (args) => docker(args, { cleanup: true }),
        image: CLI_IMAGE,
      })
    })())
  try {
    onStage('private files and certificates')
    // Pick an unused /24 instead of colliding with existing local projects.
    const ids = (await docker(['network', 'ls', '-q'])).stdout.trim().split(/\s+/).filter(Boolean)
    const networks = ids.length
      ? JSON.parse((await docker(['network', 'inspect', ...ids])).stdout)
      : []
    const taken = networks
      .flatMap((network) => network.IPAM.Config ?? [])
      .map((item) => item.Subnet ?? '')
    const subnet = chooseCliSubnet(taken)
    const llmPort = await unusedPort()
    const mcpPort = content ? await unusedPort() : undefined
    const s3Identity = {
      accessKey: `b13-${randomBytes(12).toString('hex')}`,
      secretKey: randomBytes(24).toString('hex'),
    }
    const passwords = {
      postgres: randomBytes(24).toString('hex'),
      raditi: randomBytes(24).toString('hex'),
    }
    await mkdir(join(directory, 'postgres'))
    await writeFile(join(directory, 'postgres/superuser-password'), passwords.postgres, {
      mode: 0o644,
    })
    await writeFile(join(directory, 'postgres/password'), passwords.raditi, { mode: 0o644 })
    await writeFile(
      join(directory, 'bao.hcl'),
      'disable_mlock = true\nstorage "inmem" {}\nlistener "tcp" {\n address = "0.0.0.0:8200"\n tls_disable = true\n}\naudit "file" "file" {\n options {\n  file_path = "/audit/audit.jsonl"\n }\n}\n',
      { mode: 0o644 },
    )
    if (content)
      await writeFile(
        join(directory, 's3.json'),
        JSON.stringify({
          identities: [
            {
              name: 'b13-content',
              credentials: [s3Identity],
              actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
            },
          ],
        }),
        { mode: 0o644 },
      )
    const certificates = await createVerificationCertificates(repository, directory)
    const values = {
      VERIFY_DIR: directory,
      VERIFY_ROOT: repository,
      VERIFY_NODE_IMAGE: CLI_IMAGE,
      VERIFY_CLI_SUBNET: `${subnet}.0/24`,
      VERIFY_CLI_IP: `${subnet}.10`,
      VERIFY_GATEWAY_IP: `${subnet}.2`,
      VERIFY_LLM_PORT: String(llmPort),
      VERIFY_MCP_UPSTREAM: mcpUpstream(mcpPort),
    }
    await writeFile(
      envFile,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
      { mode: 0o600 },
    )
    started = true
    onStage('compose up')
    await compose(['up', '-d'], { timeoutMs: 180_000, infrastructureDiagnostics: true })
    const port = async (service, number) => {
      onStage(`published ${service} port`)
      const value = (await compose(['port', service, String(number)])).stdout.trim()
      assert.match(value, /^127\.0\.0\.1:\d+$/, `Invalid published ${service} port: ${value}`)
      return value
    }
    const databaseUrl = `postgresql://raditi:${passwords.raditi}@${await port('postgres', 5432)}/raditi`
    onStage('PostgreSQL readiness and bootstrap')
    await eventually(
      async () =>
        (
          await compose(
            [
              'exec',
              '-T',
              'postgres',
              'pg_isready',
              '-h',
              '127.0.0.1',
              '-U',
              'postgres',
              '-d',
              'raditi',
            ],
            { allowFailure: true },
          )
        ).code === 0,
    )
    // Read the bootstrap before sending bytes to stdin.
    const bootstrapInput = await readFile(join(repository, 'infra/app/postgres/init-roles.sh'))
    await compose(['exec', '-T', 'postgres', 'sh', '-s'], { input: bootstrapInput })
    const prismaConfig = join(directory, 'prisma.config.ts')
    await writeFile(
      prismaConfig,
      `export default {schema:${JSON.stringify(join(repository, 'packages/db/prisma/schema.prisma'))},migrations:{path:${JSON.stringify(join(repository, 'packages/db/prisma/migrations'))}},datasource:{url:process.env.DATABASE_URL}}\n`,
    )
    onStage('Prisma migration')
    await run(
      'pnpm',
      ['--filter', '@repo/db', 'exec', 'prisma', 'migrate', 'deploy', '--config', prismaConfig],
      { env: { DATABASE_URL: databaseUrl, NODE_ENV: 'test', JITI_FS_CACHE: 'false' } },
    )
    await compose(['exec', '-T', 'postgres', 'sh', '-s'], { input: bootstrapInput })
    const vaultAddress = `http://${await port('vault', 8200)}`
    onStage('OpenBao readiness and initialization')
    await eventually(
      async () => (await localVaultRequest({ address: vaultAddress }, 'sys/health')).status === 501,
    )
    const initialized = await localVaultRequest({ address: vaultAddress }, 'sys/init', {
      method: 'POST',
      body: { secret_shares: 1, secret_threshold: 1 },
    })
    assert.equal(initialized.status, 200)
    await localVaultRequest({ address: vaultAddress }, 'sys/unseal', {
      method: 'POST',
      body: { key: initialized.body.keys_base64[0] },
    })
    const root = { address: vaultAddress, token: initialized.body.root_token }
    const request = async (path, options = {}) => {
      onStage(`OpenBao ${path}`)
      const result = await localVaultRequest(root, path, options)
      assert.ok([200, 204].includes(result.status), `Vault setup failed at ${path}`)
      return result.body
    }
    await bootstrapLocalVault(root)
    onStage('OpenBao policies and AppRoles')
    await request('sys/auth/approle', { method: 'POST', body: { type: 'approle' } })
    const roles = {}
    for (const [name, policy] of [
      ['core', 'core-turns'],
      ['llm', 'llm-subscriptions'],
      // The agent-content stand runs the regular role mcp under the AppRole of that service.
      ...(content ? [['mcp', 'mcp-content']] : []),
    ]) {
      await request(`auth/approle/role/${name}`, {
        method: 'POST',
        body: {
          token_policies: [policy],
          token_no_default_policy: true,
          token_ttl: '15m',
          token_max_ttl: '1h',
          secret_id_ttl: '1h',
        },
      })
      roles[name] = {
        roleId: (await request(`auth/approle/role/${name}/role-id`)).data.role_id,
        secretId: (
          await request(`auth/approle/role/${name}/secret-id`, { method: 'POST', body: {} })
        ).data.secret_id,
      }
    }
    const tokens = {}
    for (const policy of [
      'subscriptions-writer',
      'subscriptions-admin',
      // The connection step of the content stand (site access, workspace key) and the reader
      // of its snapshots: the stand itself opens no content with the operator token.
      ...(content ? ['sites-writer', 'workspace-provisioner', 'core-transit'] : []),
    ])
      tokens[policy] = (
        await request('auth/token/create', {
          method: 'POST',
          body: { policies: [policy], no_default_policy: true, ttl: '1h', renewable: false },
        })
      ).auth.client_token
    assert.ok((await request('sys/audit')).data['file/'], 'Declarative audit device is missing')
    const control = `http://${await port('fake-subscriptions', 8787)}`
    onStage('fake provider readiness')
    await eventually(async () => (await fetch(`${control}/state`)).ok)
    let s3
    if (content) {
      const endpoint = `http://${await port('s3', 8333)}`
      onStage('S3 readiness and the artifacts bucket')
      const shell = async (command) =>
        (
          await compose(['exec', '-T', 's3', 'sh', '-c', `echo '${command}' | weed shell`], {
            allowFailure: true,
          })
        ).stdout
      // Ready: the bucket is listed and the S3 port answers (any status: 403 unsigned).
      await eventually(async () => {
        if (!(await shell('s3.bucket.list')).includes(S3_BUCKET)) {
          await shell(`s3.bucket.create -name ${S3_BUCKET}`)
          return false
        }
        await fetch(`${endpoint}/`, { signal: AbortSignal.timeout(5000) })
        return true
      }, 90_000)
      s3 = { endpoint, region: 'us-east-1', ...s3Identity, buckets: { artifacts: S3_BUCKET } }
    }
    return {
      directory,
      project,
      network: `${project}_cli`,
      cliIp: `${subnet}.10`,
      gatewayIp: `${subnet}.2`,
      llmPort,
      ...(content ? { mcpPort, s3 } : {}),
      databaseUrl,
      vaultAddress,
      root,
      request,
      roles,
      tokens,
      certificates,
      control,
      egressUrl: `https://${await port('llm-egress', 8443)}`,
      compose,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
