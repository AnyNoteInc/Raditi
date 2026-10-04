// Real WordPress foundation verification, not the unfinished Raditi product journey.
// No pulls, cloud, .env, real site credentials or LLM subscription are used.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { isForbiddenPath } from '../../../packages/domain/src/policies/diff-paths.ts'
import { wordpressAdapter } from '../../../packages/site-adapters/src/wordpress.ts'
import {
  isAdminUrlDenied,
  isProtectedOption,
  isRestRequestDenied,
  isWpCliCommandDenied,
} from '../../../packages/site-adapters/src/wordpress-mcp-policy.ts'

const images = {
  wordpress:
    'wordpress:7.1.2-php8.3-apache@sha256:8ae73d594a154e30b112e8d085afbc0895acf7651d8f53ef63aefb42e30822d5',
  database:
    'mariadb:11.4.13@sha256:70cc072b29b4a89ae07abb2d4da2c64678a7f2dfe092751bb51c87d67dc1338b',
  wpcli: 'wordpress:cli-2.12.0-php8.3',
  // The cached cli-php8.3 image was independently checked as WP-CLI 2.12.0.
  // Never execute that mutable tag: this exact fallback digest is checked again below.
  wpcliFallback:
    'wordpress@sha256:2b5e9d4d3e51909dca1aaa4732e9f5e5bf0377c2114dbd8ff39f060bff202586',
  forwarder: 'alpine/socat@sha256:68b28fed1e6f5dc5cc7574315284573d89a655b0bc528720be4164f36b998680',
}

const fixtureDirectory = fileURLToPath(new URL('./', import.meta.url))
const project = `raditi-site-verify-${randomUUID().slice(0, 8)}`
const controller = new AbortController()
const dockerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => ['PATH', 'HOME'].includes(name) || name.startsWith('DOCKER_'),
  ),
)
// Explicit --env-file also prevents Compose from discovering the repository .env.
dockerEnv.COMPOSE_DISABLE_ENV_FILE = '1'
let temporaryDirectory
let stackStarted = false
let stage = 'preflight'

const interrupt = () => controller.abort(new Error('Local verification interrupted'))

/** Capture output privately. Errors identify the stage, never arguments or response bodies. */
function command(args, { input, allowFailure = false, cleanup = false, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: dockerEnv, stdio: 'pipe' })
    const output = []
    let outputBytes = 0
    let overflow = false
    let timedOut = false
    const cancel = () => child.kill('SIGKILL')
    if (!cleanup) {
      controller.signal.addEventListener('abort', cancel, { once: true })
      if (controller.signal.aborted) cancel()
    }
    const timer = setTimeout(() => {
      timedOut = true
      cancel()
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > 8 * 1024 * 1024) {
        overflow = true
        cancel()
      } else output.push(chunk)
    })
    // Never forward Docker/WP errors: they may include installation arguments or site content.
    child.stderr.resume()
    child.once('error', () => reject(new Error(`Docker could not start during ${stage}`)))
    child.once('close', (code) => {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', cancel)
      if (overflow || timedOut || (!cleanup && controller.signal.aborted)) {
        reject(new Error(`Docker command interrupted or exceeded limits during ${stage}`))
      } else if (code !== 0 && !allowFailure) {
        reject(new Error(`Docker command failed during ${stage} (exit ${code ?? 'unknown'})`))
      } else resolve({ code, stdout: Buffer.concat(output).toString('utf8') })
    })
    child.stdin.end(input)
  })
}

const compose = (args, options) =>
  command(
    [
      'compose',
      '--project-directory',
      temporaryDirectory,
      '--env-file',
      join(temporaryDirectory, 'fixture.env'),
      '-p',
      project,
      '-f',
      join(fixtureDirectory, 'compose.yml'),
      ...args,
    ],
    options,
  )

const wp = (args, options) =>
  compose(['exec', '-T', 'wpcli', 'wp', '--path=/var/www/html', ...args], options)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const passed = (name) => console.log(`PASS ${name}`)

async function availableLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  // A conflicting process may bind after close; Docker then fails instead of replacing it.
  return port
}

async function publicPage(url) {
  const target = new URL(url)
  assert.equal(target.protocol, 'http:')
  assert.equal(target.hostname, '127.0.0.1')
  assert.equal(target.username, '')
  assert.equal(target.password, '')
  const response = await fetch(target, {
    redirect: 'manual',
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  })
  assert.equal(response.status, 200, 'Local page did not respond with 200')
  assert.match(response.headers.get('content-type') ?? '', /^text\/html/i)
  return response.text()
}

function verifyRepositoryPolicy(site) {
  const protectedPaths = wordpressAdapter.protectedPaths(site)
  for (const path of [
    'wp-config.php',
    'wp-admin/index.php',
    'wp-includes/version.php',
    'wp-content/uploads/2026/09/image.jpg',
    '.github/workflows/deploy.yml',
    '../wp-config.php',
  ]) {
    assert.equal(isForbiddenPath(path, protectedPaths), true, 'Protected path accepted')
  }
  assert.equal(isForbiddenPath('wp-content/themes/example/style.css', protectedPaths), false)
  for (const args of [
    ['user', 'list'],
    ['eval', 'echo 1;'],
    ['post', 'delete', '1'],
    ['option', 'get', 'admin_email'],
    ['post', 'update', '1', '--path=/tmp/other'],
  ]) {
    assert.equal(isWpCliCommandDenied(args), true, 'Denied WP-CLI command accepted')
  }
  assert.equal(isWpCliCommandDenied(['post', 'get', '1', '--format=json']), false)
  assert.equal(isWpCliCommandDenied(['post', 'update', '1', '--post_content=synthetic']), false)
  assert.equal(isProtectedOption('woocommerce_gateway_order'), true)
  assert.equal(isRestRequestDenied('GET', '/wp/v2/users'), true)
  assert.equal(isRestRequestDenied('DELETE', '/wp/v2/pages/1'), true)
  assert.equal(isRestRequestDenied('GET', '/wp/v2/pages/1'), false)
  assert.equal(isAdminUrlDenied(`${site.url}/wp-admin/users.php`), true)
  // Comments and form entries hold personal data of site visitors (spec §11).
  assert.equal(isWpCliCommandDenied(['comment', 'list', '--format=json']), true)
  assert.equal(isWpCliCommandDenied(['post', 'list', '--post_type=flamingo_inbound']), true)
  assert.equal(isRestRequestDenied('GET', '/wp/v2/comments'), true)
  assert.equal(isAdminUrlDenied(`${site.url}/wp-admin/edit-comments.php`), true)
  assert.equal(isAdminUrlDenied(`${site.url}/wp-admin/admin.php?page=flamingo_inbound`), true)
  passed('repository WordPress denylist and protected diff paths')
}

// A deliberately narrow fixture allowlist, layered over the real adapter denylist.
// P6/P10 must implement the complete product allowlist and per-object checks.
async function contentCommand(args) {
  const allowed = args[0] === 'post' && ['get', 'update'].includes(args[1])
  if (!allowed || isWpCliCommandDenied(args)) {
    throw new Error('Fixture refused a WordPress content command')
  }
  return wp(args)
}

async function main(scenario) {
  if (process.argv.slice(2).filter((arg) => arg !== '--').length > 0) {
    throw new Error('This local fixture accepts no options or external site URL')
  }
  const context = await command([
    'context',
    'inspect',
    '--format',
    '{{json .Endpoints.docker.Host}}',
  ])
  const contextEndpoint = JSON.parse(context.stdout)
  const endpoint = dockerEnv.DOCKER_CONTEXT
    ? contextEndpoint
    : (dockerEnv.DOCKER_HOST ?? contextEndpoint)
  if (typeof endpoint !== 'string' || !/^(unix|npipe):\/\//.test(endpoint)) {
    throw new Error(
      'This fixture requires a local Docker socket; remote Docker endpoints are refused',
    )
  }
  await command(['info', '--format', '{{.ServerVersion}}'])
  for (const image of [images.wordpress, images.database, images.forwarder]) {
    const found = await command(['image', 'inspect', image], { allowFailure: true })
    if (found.code !== 0)
      throw new Error(
        'Pinned local WordPress/MariaDB/forwarder image is missing; no image was pulled',
      )
  }
  let wpcliImage = images.wpcli
  const cli = await command(['image', 'inspect', wpcliImage], { allowFailure: true })
  if (cli.code !== 0) {
    wpcliImage = images.wpcliFallback
    const fallback = await command(['image', 'inspect', wpcliImage], { allowFailure: true })
    if (fallback.code !== 0)
      throw new Error('Pinned local WP-CLI image is missing; no image was pulled')
  }
  const cliVersion = await command([
    'run',
    '--rm',
    '--pull',
    'never',
    '--network',
    'none',
    wpcliImage,
    'cli',
    'version',
  ])
  assert.equal(cliVersion.stdout.trim(), 'WP-CLI 2.12.0', 'Unexpected local WP-CLI version')
  console.log(
    `Local WordPress foundation: WordPress 7.1.2, MariaDB 11.4.13, WP-CLI 2.12.0 (${wpcliImage === images.wpcli ? 'exact tag' : 'verified cached digest'})`,
  )

  temporaryDirectory = await mkdtemp(join(tmpdir(), 'raditi-site-verify-'))
  await chmod(temporaryDirectory, 0o700)
  const databasePassword = randomBytes(24).toString('hex')
  const databaseRootPassword = randomBytes(24).toString('hex')
  await writeFile(
    join(temporaryDirectory, 'fixture.env'),
    [
      `VERIFY_WORDPRESS_IMAGE=${images.wordpress}`,
      `VERIFY_DATABASE_IMAGE=${images.database}`,
      `VERIFY_WPCLI_IMAGE=${wpcliImage}`,
      `VERIFY_FORWARDER_IMAGE=${images.forwarder}`,
      `VERIFY_HTTP_PORT=${await availableLoopbackPort()}`,
      `VERIFY_DATABASE_PASSWORD=${databasePassword}`,
      `VERIFY_DATABASE_ROOT_PASSWORD=${databaseRootPassword}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  stage = 'starting isolated fixture'
  // Set before up so partial starts are cleaned too.
  stackStarted = true
  await compose(['up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '90'])
  const databaseVersion = await compose(['exec', '-T', 'database', 'mariadbd', '--version'])
  assert.match(databaseVersion.stdout, /\b11\.4\.13-MariaDB\b/, 'Unexpected MariaDB version')
  const binding = (await compose(['port', 'forwarder', '8080'])).stdout.trim()
  assert.match(binding, /^127\.0\.0\.1:\d+$/, 'Fixture is not published on loopback only')
  const url = `http://${binding}`

  stage = 'installing synthetic WordPress'
  await wp([
    'core',
    'install',
    `--url=${url}`,
    '--title=Raditi synthetic local fixture',
    '--admin_user=synthetic_admin',
    `--admin_password=${randomBytes(24).toString('hex')}`,
    '--admin_email=synthetic-admin@example.test',
    '--skip-email',
  ])
  assert.equal((await wp(['core', 'version'])).stdout.trim(), '7.1.2')
  const site = { stack: 'wordpress', url, docroot: '/var/www/html', version: '7.1.2', extras: {} }
  verifyRepositoryPolicy(site)
  passed('isolated WordPress installed with synthetic data on loopback')

  const originalMarker = `raditi-original-${randomUUID()}`
  const changedMarker = `raditi-changed-${randomUUID()}`
  const page = await wp([
    'post',
    'create',
    '--post_type=page',
    '--post_status=publish',
    '--post_title=Synthetic local test page',
    '--post_name=synthetic-local-test',
    `--post_content=<p>${originalMarker}</p>`,
    '--porcelain',
  ])
  const pageId = page.stdout.trim()
  assert.match(pageId, /^\d+$/, 'WordPress did not create the fixture page')
  const pageUrl = `${url}/?page_id=${pageId}`
  const before = await publicPage(pageUrl)
  assert.equal(before.includes(originalMarker), true, 'Initial content is not publicly visible')
  assert.equal(before.includes(changedMarker), false, 'Changed content appeared before the edit')
  passed('real published WordPress page responds over HTTP')

  stage = 'capturing content snapshot'
  const fields = ['ID', 'post_title', 'post_content', 'post_excerpt', 'post_status', 'post_name']
  const getPage = () =>
    contentCommand(['post', 'get', pageId, `--fields=${fields.join(',')}`, '--format=json'])
  const snapshot = JSON.parse((await getPage()).stdout)
  const snapshotPath = join(temporaryDirectory, 'content-snapshot.json')
  const snapshotBytes = JSON.stringify(snapshot)
  await writeFile(snapshotPath, snapshotBytes, { mode: 0o600 })
  const snapshotHash = hash(snapshotBytes)
  passed('content snapshot saved before mutation')

  stage = 'editing and verifying public content'
  await contentCommand(['post', 'update', pageId, `--post_content=<p>${changedMarker}</p>`])
  const after = await publicPage(pageUrl)
  assert.equal(after.includes(changedMarker), true, 'Changed content is not publicly visible')
  assert.equal(after.includes(originalMarker), false, 'Original content remained after the edit')
  passed('WordPress content edit visible on the actual HTTP page')

  stage = 'restoring and verifying content snapshot'
  const restoreBytes = await readFile(snapshotPath, 'utf8')
  assert.equal(hash(restoreBytes), snapshotHash, 'Content snapshot integrity check failed')
  const restored = JSON.parse(restoreBytes)
  assert.equal(String(restored.ID), pageId, 'Snapshot refers to another page')
  await contentCommand([
    'post',
    'update',
    pageId,
    ...fields.filter((field) => field !== 'ID').map((field) => `--${field}=${restored[field]}`),
  ])
  assert.equal(
    hash(JSON.stringify(JSON.parse((await getPage()).stdout))),
    snapshotHash,
    'Restored content fields differ from their snapshot',
  )
  const undone = await publicPage(pageUrl)
  assert.equal(undone.includes(originalMarker), true, 'Restored content is not publicly visible')
  assert.equal(undone.includes(changedMarker), false, 'Changed content remained after restore')
  passed('snapshot restore matches content fields and the public HTTP page')
  if (scenario) {
    stage = 'scenario of the calling stand'
    await scenario({ wp, compose, url, pageId, temporaryDirectory, signal: controller.signal })
  }
  console.log(
    'PASS local real-site foundation; full agent → apply → backup → verify → rollback gate remains open',
  )
}

export async function verifySiteFoundation({ scenario } = {}) {
  // Kept until the cleanup has ended (the abort is idempotent): with `once` a second signal
  // would find no listener and end the process while the fixture is being removed.
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  let failure
  try {
    await main(scenario)
  } catch (error) {
    // Do not print assertion actual/expected, stacks, WP output or arbitrary error messages.
    console.error(
      `FAIL local real-site foundation at ${stage} (${error instanceof assert.AssertionError ? 'assertion' : 'setup or command'})`,
    )
    if (stage === 'preflight' && error instanceof Error && !controller.signal.aborted)
      console.error(error.message)
    failure = new Error(`Local WordPress verification failed at ${stage}`)
    failure.verificationOutput = error.verificationOutput
  } finally {
    stage = 'cleanup'
    if (stackStarted) {
      try {
        await compose(['down', '--volumes', '--remove-orphans', '--timeout', '10'], {
          cleanup: true,
          timeoutMs: 60_000,
        })
        const remaining = await Promise.all(
          [
            ['ps', '-aq'],
            ['network', 'ls', '-q'],
            ['volume', 'ls', '-q'],
          ].map((args) =>
            command([...args, '--filter', `label=com.docker.compose.project=${project}`], {
              cleanup: true,
            }),
          ),
        )
        for (const resource of remaining)
          assert.equal(resource.stdout.trim(), '', 'Fixture resources survived cleanup')
        passed('owned fixture containers, network and volumes removed')
      } catch {
        console.error(`FAIL cleanup of owned local fixture ${project}`)
        failure = new Error(`Cleanup of owned local fixture ${project} failed`)
      }
    }
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
  if (failure) throw failure
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifySiteFoundation().catch(() => {
    process.exitCode = 1
  })
}
