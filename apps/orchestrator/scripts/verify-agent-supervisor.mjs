/* global AbortController, AbortSignal, clearTimeout, console, fetch, setTimeout, URL */
// The supervisor stand of a driver: own disposable data services on Docker Desktop, the real
// runner on local Colima.
// Does not read .env, accept existing data-service credentials, pull images or use accounts.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const orchestrator = join(repository, 'apps/orchestrator')
const label = 'io.raditi.p4-supervisor-verification'
const digest = /^[^\s@]+@sha256:[a-f0-9]{64}$/u
export const serviceImages = Object.freeze({
  postgres:
    'postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24',
  s3: 'chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882',
  vault:
    'ghcr.io/openbao/openbao:2.7.0@sha256:71156a1c6623a5fa3f5e61b0c6a8ead0faf0df29a778339188443551995d1315',
})
const imageKeys = [
  'P2_SANDBOX_IMAGE',
  'P2_RUNNER_NODE_IMAGE',
  'SANDBOX_GATEWAY_IMAGE',
  'SANDBOX_NETWORK_GUARD_IMAGE',
]

/** No NODE_OPTIONS, dotenv settings, proxy, Docker overrides or service credentials survive. */
export function cleanEnvironment(environment) {
  return Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR'].flatMap((key) =>
      environment[key] === undefined ? [] : [[key, environment[key]]],
    ),
  )
}

export function runnerSettings(environment) {
  const selected = {}
  for (const key of imageKeys) {
    assert(digest.test(environment[key] ?? ''), `${key} must name a digest-pinned image`)
    selected[key] = environment[key]
  }
  for (const key of ['P2_RUNNER_DOCKER_SOCKET', 'P2_GITLEAKS_BINARY']) {
    assert(
      isAbsolute(environment[key] ?? '') && !/[\r\n\0]/u.test(environment[key]),
      `${key} must be an absolute local path`,
    )
    selected[key] = environment[key]
  }
  const host = environment.P2_RUNNER_HOST ?? '192.168.5.2'
  const octets = host.split('.').map(Number)
  assert(
    isIP(host) === 4 &&
      (octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168)),
    'P2_RUNNER_HOST must be a private IPv4 address of the local VM host',
  )
  return { ...selected, P2_RUNNER_HOST: host }
}

/**
 * Resolve local metadata once; all subsequent operations, including removal, use --host.
 * The supervisor stands keep their data services on Docker Desktop, apart from the runner's
 * daemon. `nativeLinux` is for a stand with one daemon on a Linux host (a CI runner): there is no
 * Desktop context there, so the current context names the engine, and any engine that answers
 * on a local Unix socket is accepted.
 */
export async function localDesktop(environment, command, { nativeLinux = false } = {}) {
  const env = cleanEnvironment(environment)
  let endpoint = environment.DOCKER_HOST
  if (environment.DOCKER_CONTEXT || !endpoint) {
    const context = environment.DOCKER_CONTEXT || (nativeLinux ? undefined : 'desktop-linux')
    const result = await command(
      'docker',
      [
        'context',
        'inspect',
        ...(context ? [context] : []),
        '--format',
        '{{.Endpoints.docker.Host}}',
      ],
      { env, timeoutMs: 20_000 },
    )
    endpoint = result.stdout.trim()
  }
  assert(/^unix:\/\/\/[^\s?#]+$/u.test(endpoint ?? ''), 'A local Unix Docker socket is required')
  const args = ['--host', endpoint]
  const result = await command('docker', [...args, 'info', '--format', '{{.OperatingSystem}}'], {
    env,
    timeoutMs: 20_000,
  })
  const system = result.stdout.trim()
  if (!(nativeLinux && system !== ''))
    assert.equal(system, 'Docker Desktop', 'Data services require local Docker Desktop')
  return { args, env, endpoint }
}

/** Bounded output stays private; failures never echo arguments, environment or child output. */
export function runCommand(binary, args, options = {}) {
  const {
    env,
    input,
    timeoutMs = 30_000,
    allowFailure = false,
    cleanup = false,
    abortGraceMs = 15_000,
    signal,
    cwd = repository,
  } = options
  return new Promise((resolve, reject) => {
    if (signal?.aborted && !cleanup) return reject(new Error('Verification interrupted'))
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    })
    const stdout = [],
      stderr = []
    let bytes = 0,
      stopped = false,
      forceTimer
    const stop = () => {
      if (stopped) return
      stopped = true
      // Give the scenario its finally block before killing a stuck process group.
      child.kill('SIGTERM')
      forceTimer = setTimeout(
        () => {
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
            else child.kill('SIGKILL')
          } catch {
            /* The child may have exited while the timer fired. */
          }
        },
        cleanup ? 1000 : abortGraceMs,
      )
    }
    const timer = setTimeout(stop, timeoutMs)
    if (!cleanup) signal?.addEventListener('abort', stop, { once: true })
    const capture = (chunks) => (value) => {
      bytes += value.length
      if (bytes > 8 * 1024 * 1024) stop()
      else chunks.push(value)
    }
    child.stdout.on('data', capture(stdout))
    child.stderr.on('data', capture(stderr))
    const detach = () => {
      clearTimeout(timer)
      clearTimeout(forceTimer)
      signal?.removeEventListener('abort', stop)
    }
    child.once('error', () => {
      detach()
      reject(new Error('Cannot start verification command'))
    })
    child.once('close', (code) => {
      detach()
      if (stopped || (code !== 0 && !allowFailure)) {
        const error = new Error('Verification command failed')
        // Kept only in a 0600 diagnostic after failure, never sent to the console.
        error.verificationOutput = Buffer.concat([...stdout, ...stderr]).toString()
        reject(error)
      } else
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/** Register intent before run: Docker may create a container even when its CLI fails. */
export function ownedContainers(docker, marker) {
  const names = []
  return {
    async start(service, args) {
      const name = `raditi-p4-supervisor-${marker}-${service}`
      names.push(name)
      await docker([
        'run',
        '-d',
        '--pull=never',
        '--name',
        name,
        '--label',
        `${label}=${marker}`,
        '--cpus',
        '1',
        '--memory',
        '1g',
        '--pids-limit',
        '256',
        '--dns',
        '127.0.0.1',
        ...args,
      ])
      return name
    },
    async diagnostics() {
      const result = []
      for (const name of names) {
        try {
          const actual = await docker(
            ['inspect', name, '--format', `{{index .Config.Labels "${label}"}}`],
            { cleanup: true, allowFailure: true, timeoutMs: 3000 },
          )
          if (actual.code !== 0 || actual.stdout.trim() !== marker) continue
          const logs = await docker(['logs', '--tail', '100', name], {
            cleanup: true,
            allowFailure: true,
            timeoutMs: 3000,
          })
          result.push(`${name}\n${logs.stdout}\n${logs.stderr}`)
        } catch {
          /* Diagnostics must not block cleanup or inspect another owner's logs. */
        }
      }
      return result.join('\n')
    },
    async close() {
      let failed = false
      for (const name of [...names].reverse()) {
        try {
          const actual = await docker(
            ['inspect', name, '--format', `{{index .Config.Labels "${label}"}}`],
            { cleanup: true, allowFailure: true, timeoutMs: 15_000 },
          )
          if (actual.code !== 0) {
            assert.match(actual.stderr, /No such (object|container)/u)
            continue
          }
          assert.equal(actual.stdout.trim(), marker, 'Fixture container ownership changed')
          await docker(['rm', '-fv', name], { cleanup: true, timeoutMs: 15_000 })
        } catch {
          failed = true
        }
      }
      try {
        const remaining = await docker(['ps', '-aq', '--filter', `label=${label}=${marker}`], {
          cleanup: true,
          timeoutMs: 15_000,
        })
        assert.equal(remaining.stdout.trim(), '')
      } catch {
        failed = true
      }
      if (failed) throw new Error('Disposable data-service cleanup failed')
    },
  }
}

async function eventually(action, signal) {
  const deadline = Date.now() + 60_000
  do {
    if (signal.aborted) throw new Error('Verification interrupted')
    try {
      if (await action()) return
    } catch {
      /* Startup races are expected. */
    }
    await sleep(250, undefined, { signal })
  } while (Date.now() < deadline)
  throw new Error('Disposable service did not become ready')
}

async function vaultRequest(address, token, path, body, signal) {
  const response = await fetch(`${address}/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  })
  // Never put OpenBao's body (which may contain a token) into diagnostics.
  await response.arrayBuffer()
  return response.ok
}

export async function provisionServices({
  docker,
  names,
  directory,
  env,
  signal,
  stage,
  command,
  buckets = ['sessions'],
}) {
  stage('PostgreSQL readiness')
  await eventually(
    async () =>
      (
        await docker(
          ['exec', names.postgres, 'pg_isready', '-h', '127.0.0.1', '-U', 'raditi', '-d', 'raditi'],
          { allowFailure: true, timeoutMs: 5000 },
        )
      ).code === 0,
    signal,
  )
  const config = join(directory, 'prisma.config.ts')
  await writeFile(
    config,
    `export default {schema:${JSON.stringify(join(repository, 'packages/db/prisma/schema.prisma'))},migrations:{path:${JSON.stringify(join(repository, 'packages/db/prisma/migrations'))}},datasource:{url:process.env.DATABASE_URL}}\n`,
    { mode: 0o600 },
  )
  stage('disposable database migrations')
  await command(
    'pnpm',
    ['--filter', '@repo/db', 'exec', 'prisma', 'migrate', 'deploy', '--config', config],
    {
      env: {
        ...cleanEnvironment(env),
        NODE_ENV: 'test',
        DATABASE_URL: env.DATABASE_URL,
        JITI_FS_CACHE: 'false',
      },
      signal,
      timeoutMs: 180_000,
    },
  )
  stage('disposable S3 sessions bucket')
  const { S3Client, CreateBucketCommand, HeadBucketCommand } = createRequire(
    join(repository, 'packages/storage/package.json'),
  )('@aws-sdk/client-s3')
  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  })
  try {
    for (const bucket of buckets)
      await eventually(async () => {
        const options = { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }
        try {
          await s3.send(
            new HeadBucketCommand({ Bucket: env[`S3_BUCKET_${bucket.toUpperCase()}`] }),
            options,
          )
        } catch {
          await s3.send(
            new CreateBucketCommand({ Bucket: env[`S3_BUCKET_${bucket.toUpperCase()}`] }),
            options,
          )
          await s3.send(
            new HeadBucketCommand({ Bucket: env[`S3_BUCKET_${bucket.toUpperCase()}`] }),
            options,
          )
        }
        return true
      }, signal)
  } finally {
    s3.destroy()
  }
  stage('disposable OpenBao transit')
  await eventually(
    () => vaultRequest(env.VAULT_ADDR, env.VAULT_DEV_ROOT_TOKEN, 'sys/health', undefined, signal),
    signal,
  )
  assert(
    await vaultRequest(
      env.VAULT_ADDR,
      env.VAULT_DEV_ROOT_TOKEN,
      'sys/mounts/transit',
      { type: 'transit' },
      signal,
    ),
    'Cannot mount disposable transit',
  )
}

export function scenarioEnvironment(environment, settings, fixture) {
  return {
    ...cleanEnvironment(environment),
    ...settings,
    NODE_ENV: 'test',
    APP_ENV: 'test',
    NO_COLOR: '1',
    P4_DISPOSABLE_ID: fixture.marker,
    DATABASE_URL: fixture.databaseUrl,
    S3_ENDPOINT: fixture.s3Endpoint,
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: fixture.accessKey,
    S3_SECRET_ACCESS_KEY: fixture.secretKey,
    S3_BUCKET_SESSIONS: `raditi-p4-${fixture.marker}-sessions`,
    VAULT_ADDR: fixture.vaultAddress,
    VAULT_DEV_ROOT_TOKEN: fixture.vaultToken,
  }
}

/** Dependencies are injectable only for tests; the CLI exposes no alternate service endpoints. */
export async function verifyAgentSupervisor({
  driverId = 'opencode',
  environment = process.env,
  command = runCommand,
  provision = provisionServices,
  signals = process,
  log = console.log,
} = {}) {
  const drivers = { opencode: ['OpenCode', 'G3'] }
  assert(Object.hasOwn(drivers, driverId), 'Unsupported verification driver')
  const [driverName, milestone] = drivers[driverId]
  const settings = runnerSettings(environment)
  const controller = new AbortController()
  const connection = await localDesktop(environment, (binary, args, options) =>
    command(binary, args, { ...options, signal: controller.signal }),
  )
  assert.notEqual(
    connection.endpoint,
    `unix://${settings.P2_RUNNER_DOCKER_SOCKET}`,
    'Data services and runner must use different Docker daemons',
  )
  assert(
    (await stat(settings.P2_RUNNER_DOCKER_SOCKET)).isSocket(),
    'Runner Docker socket is unavailable',
  )
  const binary = await stat(settings.P2_GITLEAKS_BINARY)
  assert(binary.isFile() && binary.mode & 0o111, 'Gitleaks must be a local executable file')
  const docker = (args, options = {}) =>
    command('docker', [...connection.args, ...args], {
      env: connection.env,
      signal: controller.signal,
      ...options,
    })
  for (const image of Object.values(serviceImages))
    await docker(['image', 'inspect', image, '--format', '{{.Id}}'])
  const marker = randomBytes(16).toString('hex')
  const resources = ownedContainers(docker, marker)
  let directory
  const interrupt = () => controller.abort()
  signals.on('SIGINT', interrupt)
  signals.on('SIGTERM', interrupt)
  const deadline = setTimeout(interrupt, 25 * 60_000)
  let currentStage = 'starting disposable data services'
  const stage = (value) => {
    currentStage = value
    log(`${milestone} ${value}`)
  }
  let failure
  try {
    directory = await mkdtemp(join(tmpdir(), 'raditi-p4-supervisor-'))
    const postgresPassword = randomBytes(24).toString('hex')
    const vaultToken = randomBytes(24).toString('hex')
    const accessKey = `p4-${randomBytes(12).toString('hex')}`
    const secretKey = randomBytes(24).toString('hex')
    const postgresEnv = join(directory, 'postgres.env'),
      vaultEnv = join(directory, 'vault.env')
    await writeFile(
      postgresEnv,
      `POSTGRES_USER=raditi\nPOSTGRES_DB=raditi\nPOSTGRES_PASSWORD=${postgresPassword}\n`,
      { mode: 0o600 },
    )
    await writeFile(vaultEnv, `BAO_DEV_ROOT_TOKEN_ID=${vaultToken}\n`, { mode: 0o600 })
    const names = {}
    names.postgres = await resources.start('postgres', [
      '--tmpfs',
      '/var/lib/postgresql/data:rw,size=768m',
      '-p',
      '127.0.0.1::5432',
      '--env-file',
      postgresEnv,
      serviceImages.postgres,
    ])
    names.s3 = await resources.start('s3', [
      '--tmpfs',
      '/data:rw,size=768m',
      '--tmpfs',
      '/config:rw,size=1m',
      '-p',
      '127.0.0.1::8333',
      '--entrypoint',
      '/bin/sh',
      serviceImages.s3,
      '-c',
      'while [ ! -f /config/s3.json ]; do sleep 0.1; done; exec weed server -dir=/data -s3 -s3.port=8333 -s3.config=/config/s3.json',
    ])
    await docker(
      [
        'exec',
        '-i',
        names.s3,
        'sh',
        '-c',
        'umask 077; cat > /config/s3.json.tmp && mv /config/s3.json.tmp /config/s3.json',
      ],
      {
        input: JSON.stringify({
          identities: [
            {
              name: 'p4-fixture',
              credentials: [{ accessKey, secretKey }],
              actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
            },
          ],
        }),
      },
    )
    names.vault = await resources.start('vault', [
      // Dev storage is in memory. The image's unprivileged entrypoint must keep ownership
      // of /openbao/logs and /openbao/file; root-owned tmpfs there prevents it from starting.
      '--tmpfs',
      '/tmp:rw,mode=1777,size=64m',
      '-p',
      '127.0.0.1::8200',
      '--env-file',
      vaultEnv,
      serviceImages.vault,
      'server',
      '-dev',
      '-dev-no-store-token',
      '-dev-listen-address=0.0.0.0:8200',
    ])
    const port = async (name, number) => {
      const binding = (await docker(['port', name, `${number}/tcp`])).stdout.trim()
      assert.match(
        binding,
        /^127\.0\.0\.1:[1-9]\d{0,4}$/u,
        'Fixture published an unexpected endpoint',
      )
      return binding
    }
    const env = scenarioEnvironment(environment, settings, {
      marker,
      accessKey,
      secretKey,
      vaultToken,
      databaseUrl: `postgresql://raditi:${postgresPassword}@${await port(names.postgres, 5432)}/raditi`,
      s3Endpoint: `http://${await port(names.s3, 8333)}`,
      vaultAddress: `http://${await port(names.vault, 8200)}`,
    })
    await provision({ docker, names, directory, env, signal: controller.signal, stage, command })
    stage(`${driverName} supervisor exec and native resume`)
    await command(process.execPath, ['scripts/verify-runner.mjs', `--${driverId}`], {
      cwd: orchestrator,
      env,
      signal: controller.signal,
      timeoutMs: 20 * 60_000,
      abortGraceMs: 75_000,
    })
    log(`PASS real ${driverName} supervisor exec/resume on gVisor, snapshots and publication`)
  } catch (error) {
    failure = new Error(`${milestone} supervisor verification failed at ${currentStage}`)
    // A failed run keeps one explicitly private diagnostic. Service secrets/configs below
    // still disappear. All inputs are disposable synthetic values, never account tokens.
    try {
      const diagnosticDirectory = await mkdtemp(join(tmpdir(), 'raditi-p4-supervisor-diagnostic-'))
      const path = join(diagnosticDirectory, 'failure.log')
      await writeFile(
        path,
        `${String(error.verificationOutput ?? error.message ?? 'Unknown error')}\n${await resources.diagnostics()}`.slice(
          -64 * 1024,
        ),
        { mode: 0o600 },
      )
      failure.message += `; private diagnostic: ${path}`
      failure.diagnosticPath = path
    } catch {
      /* Failure reporting must not prevent resource removal. */
    }
  } finally {
    clearTimeout(deadline)
    const cleanupFailure = (message) => {
      const diagnosticPath = failure?.diagnosticPath
      failure = new Error(
        message + (diagnosticPath ? `; private diagnostic: ${diagnosticPath}` : ''),
      )
      if (diagnosticPath) failure.diagnosticPath = diagnosticPath
    }
    try {
      await resources.close()
    } catch {
      cleanupFailure(`${milestone} disposable data-service cleanup failed`)
    }
    try {
      if (directory) await rm(directory, { recursive: true, force: true })
    } catch {
      cleanupFailure(`${milestone} private fixture directory cleanup failed`)
    }
    signals.removeListener('SIGINT', interrupt)
    signals.removeListener('SIGTERM', interrupt)
  }
  if (failure) throw failure
  log('PASS disposable PostgreSQL, S3, OpenBao and private files removed')
}
