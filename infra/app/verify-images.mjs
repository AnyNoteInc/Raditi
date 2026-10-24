// The images of the apps no other stand builds (docs/plan/55-split-orchestrator.md): llm, mcp,
// preview, the runner of the sandbox VMs and the browser worker (docs/plan/57-browser-tasks.md).
// Each is built from this tree as production builds it (`docker build --target runtime`) and
// checked from the outside: it starts its own app and refuses an empty configuration in its own
// words, runs as uid 10001, carries no git, gitleaks or .env, no verification stand (plan 56 §6:
// they run from the repository), and the runner image carries no package of the platform's data
// (spec §8, §19: a sandbox VM holds no platform credentials) and the operator's runner-token
// command. core and web are built by verify:edge, the llm image is run for real by verify:llm-app.
//
//   pnpm verify:images [-- --no-build] [--keep] [--only <app>[,<app>…]]
import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const APPS = ['llm', 'mcp', 'preview', 'runner', 'browser']

/**
 * The workspace packages an image may not carry: what dependency-cruiser forbids the app to reach
 * (llm-, mcp-, preview- and browser-minimal-packages, runner-minimal-packages,
 * runner-no-platform-access). One exception is documented: browser-link lands in the browser image
 * through the browser app's own devDependencies (its contract tests run the client of core and mcp
 * against it) — turbo prune takes it, and no code of the app imports it.
 */
export const FORBIDDEN_PACKAGES = {
  llm: [
    'storage',
    'git-providers',
    'sandbox-providers',
    'browser-providers',
    'browser-link',
    'agent-drivers',
    'site-adapters',
    'site-connections',
    'site-content',
    'snapshots',
    'local-turns',
    'yookassa',
    'mail',
    'telegram',
    'auth',
    'notifications',
    'billing',
    'trpc',
    'ui',
  ],
  mcp: [
    'git-providers',
    'sandbox-providers',
    'agent-drivers',
    'llm-backends',
    'site-connections',
    'local-turns',
    'yookassa',
    'mail',
    'telegram',
    'auth',
    'notifications',
    'billing',
    'trpc',
    'ui',
  ],
  preview: [
    'storage',
    'vault',
    'git-providers',
    'sandbox-providers',
    'browser-providers',
    'agent-drivers',
    'llm-backends',
    'site-adapters',
    'site-connections',
    'turn-keys',
    'site-content',
    'snapshots',
    'local-turns',
    'yookassa',
    'mail',
    'telegram',
    'auth',
    'notifications',
    'billing',
    'trpc',
    'ui',
  ],
  browser: [
    'vault',
    'git-providers',
    'agent-drivers',
    'llm-backends',
    'site-connections',
    'snapshots',
    'local-turns',
    'turn-keys',
    'site-content',
    'yookassa',
    'mail',
    'telegram',
    'auth',
    'notifications',
    'billing',
    'trpc',
    'ui',
  ],
  runner: [
    'db',
    'service-runtime',
    'vault',
    'storage',
    'llm-backends',
    'yookassa',
    'billing',
    'turn-keys',
    'browser-link',
    'trpc',
    'ui',
  ],
}

/**
 * The installed npm packages of the runner that would be platform data access on a sandbox VM:
 * the Prisma client and engines, the PostgreSQL driver, the S3 SDK and BullMQ. ioredis is not
 * listed: it lands as the optional peer of @nestjs/microservices that pnpm resolves for
 * @nestjs/core in every app, and the runner never loads it (no package of the runner imports it,
 * the runner-no-platform-access rule).
 */
export const RUNNER_FORBIDDEN_MODULES = /^(@prisma\+|prisma@|pg@|pg-pool@|@aws-sdk\+|bullmq@)/

/**
 * The verification stands, their tests and fixtures: they run from the repository, never from an
 * image, and .dockerignore keeps them out of every build context (docs/plan/56-nest-modules.md §6).
 */
export const STAND_FILE =
  /(^|\/)verify-[^/]*\.mjs$|\/scripts\/[^/]*\.test\.mjs$|(^|\/)opencode-runner-fixture[^/]*\.mjs$/

/** The operator's commands an image keeps next to where the stands were (its scripts/). */
export const OPERATOR_SCRIPTS = {
  llm: ['subscription-login.mjs', 'subscription-retire.mjs', 'subscription-token.mjs'],
  mcp: [],
  preview: [],
  runner: ['runner-token.mjs'],
  browser: [],
}

/** The files of an image (outside node_modules) that are stands, their tests or fixtures. */
export function standFilesOf(paths) {
  return paths.filter((path) => STAND_FILE.test(path))
}

/** The operator's commands of the app that its image does not carry. */
export function missingOperatorScriptsOf(app, scripts) {
  return OPERATOR_SCRIPTS[app].filter((name) => !scripts.includes(name))
}

/** The names of the forbidden workspace packages an image carries. */
export function forbiddenPackagesOf(app, packages) {
  return packages.filter((name) => FORBIDDEN_PACKAGES[app].includes(name))
}

/** The entries of node_modules/.pnpm of the runner image that are platform data access. */
export function forbiddenModulesOf(entries) {
  return entries.filter((entry) => RUNNER_FORBIDDEN_MODULES.test(entry))
}

const tagOf = (app) => `raditi-verify-images/${app}:local`

function run(command, args, { input, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0 && !allowFailure)
        reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stderr.slice(-4000)}`))
      else resolve({ code, stdout, stderr })
    })
    child.stdin.end(input ?? '')
  })
}

const docker = (args, init) => run('docker', args, init)

let containers = 0
/**
 * A container of the image with no network and no settings, under a deadline: an app that
 * neither refuses nor exits is a failure of its check (code `timeout`), not a hung stand.
 */
async function container(tag, args, timeoutMs = 60_000) {
  containers += 1
  const name = `raditi-verify-images-${process.pid}-${containers}`
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void docker(['rm', '-f', name], { allowFailure: true })
  }, timeoutMs)
  try {
    const result = await docker(['run', '--rm', '--name', name, '--network', 'none', ...args], {
      allowFailure: true,
    })
    return timedOut ? { ...result, code: 'timeout' } : result
  } finally {
    clearTimeout(timer)
  }
}
/** A shell command inside the image, without its entrypoint. */
const inside = (tag, script) => container(tag, ['--entrypoint', 'sh', tag, '-c', script])

async function main() {
  const { values: options } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      'no-build': { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      only: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  })
  if (options.help) {
    process.stdout.write(
      'Usage: pnpm verify:images [-- --no-build] [--keep] [--only llm,runner,browser]\n',
    )
    return
  }
  const apps = options.only === undefined ? APPS : options.only.split(',')
  for (const app of apps) if (!APPS.includes(app)) throw new Error(`Unknown app ${app}`)
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const started = Date.now()
  let passed = 0
  const failures = []
  const check = (app, name, ok, detail = '') => {
    if (ok) {
      passed += 1
      process.stdout.write(`PASS ${app}: ${name}\n`)
    } else {
      failures.push(`${app}: ${name}`)
      process.stdout.write(`FAIL ${app}: ${name}${detail ? `\n  ${detail}` : ''}\n`)
    }
  }
  // Each image goes as soon as its checks are done, and in CI the build cache with it: five
  // images with a pruned workspace install in their layers do not fit a runner's disk at once.
  const drop = async (app) => {
    if (options.keep || options['no-build']) return
    await docker(['image', 'rm', '-f', tagOf(app)], { allowFailure: true })
    if (process.env.CI) await docker(['builder', 'prune', '--force'], { allowFailure: true })
  }
  for (const app of apps) {
    try {
      await verifyImage(app)
    } finally {
      await drop(app)
    }
  }
  async function verifyImage(app) {
    const tag = tagOf(app)
    if (!options['no-build']) {
      process.stdout.write(`build ${tag}\n`)
      await docker([
        'build',
        '-f',
        `${root}apps/${app}/Dockerfile`,
        '--target',
        'runtime',
        '-t',
        tag,
        root,
      ])
    }
    const [image] = JSON.parse((await docker(['image', 'inspect', tag])).stdout)
    const config = image.Config
    check(
      app,
      'runs node dist/main.js of its own app as uid 10001',
      config.User === '10001:10001' &&
        JSON.stringify(config.Entrypoint) === '["node"]' &&
        JSON.stringify(config.Cmd) === '["dist/main.js"]' &&
        config.WorkingDir === `/app/apps/${app}` &&
        (config.Env ?? []).includes('NODE_ENV=production'),
      JSON.stringify({ user: config.User, cmd: config.Cmd, dir: config.WorkingDir }),
    )
    // Every import of the built app resolves inside the image; the configuration it then
    // reads is empty, so the app refuses it in its own words and exits 1.
    const start = await container(tag, ['-e', 'APP_ENV=production', tag])
    const said = start.stdout + start.stderr
    check(
      app,
      `starts and refuses an empty configuration: «Invalid ${app} configuration» under its own logger`,
      start.code === 1 &&
        said.includes(`Invalid ${app} configuration`) &&
        said.includes(`[${app}]`) &&
        !/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(said),
      said.slice(0, 600),
    )
    const tools = await inside(tag, 'command -v git || command -v gitleaks || true')
    check(
      app,
      'carries no git and no gitleaks',
      tools.code === 0 && tools.stdout.trim() === '',
      tools.stdout.trim(),
    )
    const env = await inside(tag, 'find /app -maxdepth 3 -name .env -print')
    check(app, 'carries no .env', env.code === 0 && env.stdout.trim() === '', env.stdout.trim())
    const listed = await inside(tag, 'ls /app/packages')
    const packages = listed.stdout.split('\n').filter(Boolean)
    const forbidden = forbiddenPackagesOf(app, packages)
    check(
      app,
      `carries none of ${FORBIDDEN_PACKAGES[app].join(', ')}`,
      listed.code === 0 && packages.length > 0 && forbidden.length === 0,
      `packages: ${packages.join(' ')}`,
    )
    // .dockerignore drops the stands from the build context, never the operator's commands.
    const files = await inside(
      tag,
      'find /app -name node_modules -prune -o -type f -name "*.mjs" -print',
    )
    const own = await inside(tag, 'ls scripts 2>/dev/null || true')
    const stands = standFilesOf(files.stdout.split('\n').filter(Boolean))
    const missing = missingOperatorScriptsOf(app, own.stdout.split('\n').filter(Boolean))
    check(
      app,
      'carries no verification stand, stand test or fixture and keeps its operator commands',
      files.code === 0 && own.code === 0 && stands.length === 0 && missing.length === 0,
      `stands: ${stands.join(' ')}; missing: ${missing.join(' ')}`,
    )
    if (app !== 'runner') return
    const store = await inside(tag, 'ls /app/node_modules/.pnpm')
    const modules = forbiddenModulesOf(store.stdout.split('\n').filter(Boolean))
    check(
      app,
      'installs no Prisma, PostgreSQL driver, S3 SDK or BullMQ',
      store.code === 0 && modules.length === 0,
      modules.join(' '),
    )
    // The runbook issues the token of a sandbox VM with this image (infra/app/README.md).
    const token = await container(tag, ['--entrypoint', 'node', tag, 'scripts/runner-token.mjs'])
    check(
      app,
      'holds the runner-token command of the runbook (no arguments: its usage, exit 2)',
      token.code === 2 && token.stderr.includes('Usage: runner-token issue'),
      (token.stdout + token.stderr).slice(0, 400),
    )
  }
  const seconds = Math.round((Date.now() - started) / 1000)
  if (failures.length > 0) {
    process.stdout.write(
      `FAIL verify:images: ${failures.length} of ${passed + failures.length} checks failed in ${seconds} s\n`,
    )
    process.exitCode = 1
  } else
    process.stdout.write(
      `PASS verify:images: ${apps.join(', ')} — ${passed} checks in ${seconds} s\n`,
    )
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stdout.write(`FAIL verify:images: ${error.message}\n`)
    process.exitCode = 1
  }
}
