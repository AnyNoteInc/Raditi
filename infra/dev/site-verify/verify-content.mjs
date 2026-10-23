// Disposable WordPress + PostgreSQL + S3 + Vault. No .env, subscription, cloud or pulls.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  cleanEnvironment,
  localDesktop,
  ownedContainers,
  provisionServices,
  runCommand,
  serviceImages,
} from '../../../apps/core/scripts/verify-agent-supervisor.mjs'
import { workspaceTransitKey } from '../../../packages/domain/src/sessions/workspace-transit-key.ts'
import { bootstrapLocalVault, localVaultRequest } from '../../vault/bootstrap.mjs'
import { verifyContentFidelity } from './content-fidelity.mjs'
import { verifyContentPermissions } from './content-permissions.mjs'
import { verifySiteFoundation } from './verify-site.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const controller = new AbortController()
// Idempotent, and kept until the cleanup has ended: with `once` a second signal would find no
// listener and end the process in the middle of removing the containers.
const interrupt = () => controller.abort()
const command = (binary, args, options = {}) =>
  runCommand(binary, args, { signal: controller.signal, ...options })
let resources,
  directory,
  stage = 'preflight'
const progress = (value) => {
  stage = value
  console.log(`P6 ${value}`)
}
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)
try {
  assert.equal(
    process.argv.slice(2).filter((value) => value !== '--').length,
    0,
    'This fixture accepts no external target',
  )
  // On a Linux host (a CI runner) the engine is native; elsewhere Docker Desktop, as before.
  const connection = await localDesktop(process.env, command, {
    nativeLinux: process.platform === 'linux',
  })
  const docker = (args, options = {}) =>
    command('docker', [...connection.args, ...args], { env: connection.env, ...options })
  for (const image of Object.values(serviceImages))
    await docker(['image', 'inspect', image, '--format', '{{.Id}}'])
  const marker = randomBytes(16).toString('hex')
  directory = await mkdtemp(join(tmpdir(), 'raditi-p6-content-'))
  await chmod(directory, 0o700)
  resources = ownedContainers(docker, marker)
  const password = randomBytes(24).toString('hex'),
    token = randomBytes(24).toString('hex')
  const accessKey = `p6-${randomBytes(12).toString('hex')}`,
    secretKey = randomBytes(24).toString('hex')
  await writeFile(
    join(directory, 'postgres.env'),
    `POSTGRES_USER=raditi\nPOSTGRES_DB=raditi\nPOSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600 },
  )
  await writeFile(join(directory, 'vault.env'), `BAO_DEV_ROOT_TOKEN_ID=${token}\n`, { mode: 0o600 })
  progress('starting disposable data services')
  const names = {}
  names.postgres = await resources.start('postgres', [
    '--tmpfs',
    '/var/lib/postgresql/data:rw,size=768m',
    '-p',
    '127.0.0.1::5432',
    '--env-file',
    join(directory, 'postgres.env'),
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
            name: 'p6-fixture',
            credentials: [{ accessKey, secretKey }],
            actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
          },
        ],
      }),
    },
  )
  names.vault = await resources.start('vault', [
    '--tmpfs',
    '/tmp:rw,mode=1777,size=64m',
    '-p',
    '127.0.0.1::8200',
    '--env-file',
    join(directory, 'vault.env'),
    serviceImages.vault,
    'server',
    '-dev',
    '-dev-no-store-token',
    '-dev-listen-address=0.0.0.0:8200',
  ])
  const port = async (name, number) => {
    const value = (await docker(['port', name, `${number}/tcp`])).stdout.trim()
    assert.match(value, /^127\.0\.0\.1:[1-9]\d{0,4}$/u, 'Fixture endpoint must be loopback')
    return value
  }
  const env = {
    ...cleanEnvironment(process.env),
    NODE_ENV: 'test',
    APP_ENV: 'test',
    NO_COLOR: '1',
    RADITI_CONTENT_DISPOSABLE_ID: marker,
    DATABASE_URL: `postgresql://raditi:${password}@${await port(names.postgres, 5432)}/raditi`,
    S3_ENDPOINT: `http://${await port(names.s3, 8333)}`,
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: accessKey,
    S3_SECRET_ACCESS_KEY: secretKey,
    S3_BUCKET_SESSIONS: `raditi-p6-${marker}-sessions`,
    S3_BUCKET_ARTIFACTS: `raditi-p6-${marker}-artifacts`,
    VAULT_ADDR: `http://${await port(names.vault, 8200)}`,
    VAULT_DEV_ROOT_TOKEN: token,
  }
  await provisionServices({
    docker,
    names,
    directory,
    env,
    signal: controller.signal,
    stage: progress,
    command,
    buckets: ['sessions', 'artifacts'],
  })
  progress('OpenBao mounts, policies, AppRole mcp and the tokens of the connection step')
  // The operator token ends here: it prepares the server and never reaches the role.
  const vaultAs = (credential) => async (path, options) => {
    const result = await localVaultRequest({ address: env.VAULT_ADDR, token: credential }, path, {
      ...options,
    })
    // Only the status: an OpenBao error body may repeat what was sent.
    assert.ok([200, 204].includes(result.status), `OpenBao request failed (HTTP ${result.status})`)
    return result.body
  }
  const operator = vaultAs(token)
  await bootstrapLocalVault({ address: env.VAULT_ADDR, token })
  await operator('sys/auth/approle', { method: 'POST', body: { type: 'approle' } })
  await operator('auth/approle/role/mcp', {
    method: 'POST',
    body: {
      token_policies: ['mcp-content'],
      token_no_default_policy: true,
      token_ttl: '15m',
      token_max_ttl: '1h',
      secret_id_ttl: '1h',
    },
  })
  const appRole = {
    roleId: (await operator('auth/approle/role/mcp/role-id')).data.role_id,
    secretId: (await operator('auth/approle/role/mcp/secret-id', { method: 'POST', body: {} })).data
      .secret_id,
  }
  // What the stand looks at and the role may not: whether every version of a contact map is gone.
  await operator('sys/policies/acl/stand-content-observer', {
    method: 'PUT',
    body: { policy: 'path "kv/metadata/content-masks/*" {\n  capabilities = ["read"]\n}\n' },
  })
  const scoped = async (policy) =>
    (
      await operator('auth/token/create', {
        method: 'POST',
        body: { policies: [policy], no_default_policy: true, ttl: '1h', renewable: false },
      })
    ).auth.client_token
  const sitesWriter = vaultAs(await scoped('sites-writer'))
  const provisioner = vaultAs(await scoped('workspace-provisioner'))
  const observerToken = await scoped('stand-content-observer')
  progress('starting disposable WordPress and installing the bounded companion')
  await verifySiteFoundation({
    scenario: async ({ wp, compose, url, pageId, temporaryDirectory, signal }) => {
      const siteId = randomUUID()
      const plugin = await readFile(join(repository, 'infra/wordpress/raditi-content.php'))
      await compose(
        [
          'exec',
          '-T',
          'wpcli',
          'sh',
          '-c',
          'mkdir -p /var/www/html/wp-content/mu-plugins && cat > /var/www/html/wp-content/mu-plugins/raditi-content.php',
        ],
        { input: plugin },
      )
      await compose([
        'exec',
        '-T',
        'wpcli',
        'php',
        '-l',
        '/var/www/html/wp-content/mu-plugins/raditi-content.php',
      ])
      await wp(['option', 'update', 'raditi_content_site_id', siteId])
      progress('WordPress author and administrator content permissions')
      try {
        await verifyContentPermissions({ wp, url, siteId, signal })
        progress('WordPress stores exactly what its receipts and snapshots say')
        await verifyContentFidelity({ wp, url, siteId, signal })
      } catch (error) {
        if (error instanceof Error) error.verificationOutput ??= error.message
        throw error
      }
      const applicationPassword = (
        await wp([
          'user',
          'application-password',
          'create',
          'synthetic_admin',
          'Raditi P6 synthetic',
          '--porcelain',
        ])
      ).stdout.trim()
      assert(applicationPassword.length > 10, 'Fixture application password is missing')
      // Percent signs travel the whole MCP path: snapshot, edit, replay, restore and turn undo.
      const original = {
        title: 'Synthetic public content 100%',
        content: '<p>Скидка 20%</p><p>original contact@example.test +7 (999) 123-45-67</p>',
        excerpt: 'Описание: 50% предоплата',
      }
      await wp([
        'post',
        'update',
        pageId,
        ...Object.entries(original).map(([key, value]) => `--post_${key}=${value}`),
      ])
      const secondPageId = (
        await wp([
          'post',
          'create',
          '--post_type=page',
          '--post_status=publish',
          '--post_title=CAS fixture',
          '--post_content=<p>CAS original</p>',
          '--porcelain',
        ])
      ).stdout.trim()
      progress('trusted connection step: workspace key and site access in OpenBao')
      // What the connection of a site does in the product: the provisioner creates the key of
      // the workspace, the writer stores the access with CAS and cannot read it back.
      const workspaceId = randomUUID()
      await provisioner(`transit/keys/${workspaceTransitKey(workspaceId)}`, {
        method: 'POST',
        body: { type: 'aes256-gcm96' },
      })
      const accessVersion = (
        await sitesWriter(`kv/data/sites/${siteId}/wp`, {
          method: 'POST',
          body: {
            options: { cas: 0 },
            data: { v: '1', origin: url, username: 'synthetic_admin', applicationPassword },
          },
        })
      ).data.version
      assert.equal(accessVersion, 1, 'The site access must be the first version of its secret')
      const privateFile = join(temporaryDirectory, 'mcp-content-fixture.json')
      await writeFile(
        privateFile,
        JSON.stringify({
          siteId,
          workspaceId,
          origin: url,
          accessVersion,
          observerToken,
          pageId,
          secondPageId,
          original,
        }),
        { mode: 0o600 },
      )
      progress('MCP read, encrypted snapshot, edit, replay, undo, drift and recovery')
      // The role and its worker get the AppRole of the mcp service: neither the operator token
      // nor the password of the site is in their environment or files.
      const { VAULT_DEV_ROOT_TOKEN: _operator, ...roleEnv } = env
      const result = await command(process.execPath, ['scripts/verify-content-worker.mjs'], {
        cwd: join(repository, 'apps/mcp'),
        env: {
          ...roleEnv,
          VAULT_ROLE_ID: appRole.roleId,
          VAULT_SECRET_ID: appRole.secretId,
          RADITI_CONTENT_FIXTURE_FILE: privateFile,
        },
        signal: AbortSignal.any([controller.signal, signal]),
        timeoutMs: 120_000,
      })
      // Worker diagnostics stay private. Only its fixed PASS lines are printed.
      for (const line of result.stdout.split('\n'))
        if (/^PASS [a-zA-Z0-9 /→,:()._-]+$/.test(line)) console.log(line)
    },
  })
  console.log(
    'PASS real local MCP content, replacement undo, recovery and retention: production onboarding and product queue remain open',
  )
} catch (error) {
  // The only diagnostic is private; no WordPress content or fixture credentials reach stdout.
  if (directory) {
    const diagnostic = join(directory, 'failure.log')
    await writeFile(
      diagnostic,
      String(error.verificationOutput ?? error.message ?? 'Unknown failure').slice(-64 * 1024),
      { mode: 0o600 },
    )
    const copy = await mkdtemp(join(tmpdir(), 'raditi-p6-content-diagnostic-'))
    await chmod(copy, 0o700)
    await writeFile(join(copy, 'failure.log'), await readFile(diagnostic), { mode: 0o600 })
    console.error(`FAIL P6 at ${stage}; private diagnostic: ${join(copy, 'failure.log')}`)
  } else console.error(`FAIL P6 at ${stage}`)
  process.exitCode = 1
} finally {
  try {
    await resources?.close()
    console.log('PASS owned PostgreSQL, S3 and Vault resources removed')
  } catch {
    console.error('FAIL owned P6 resource cleanup')
    process.exitCode = 1
  }
  if (directory) await rm(directory, { recursive: true, force: true })
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}
