import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const verifier = fileURLToPath(new URL('./verify-db.mjs', import.meta.url))
const options = { timeout: 15_000, skip: process.platform === 'win32' }
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`

// Executed only through the fixture PATH. Any unimplemented Docker command fails closed;
// no real Docker binary, daemon, database, Prisma command or repository .env is involved.
const fakeDocker = String.raw`
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const args = process.argv.slice(2)
const state = JSON.parse(readFileSync(configuration.state, 'utf8'))
const persist = () => {
  const temporary = configuration.state + '.' + process.pid
  writeFileSync(temporary, JSON.stringify(state))
  renameSync(temporary, configuration.state)
}
state.calls.push({ args, pid: process.pid })
persist()
if (args[0] === 'context' && args[1] === 'inspect') {
  console.log(JSON.stringify(configuration.mode === 'remote' ? 'ssh://fixture.invalid' : 'unix:///synthetic-docker.sock'))
} else if (args[0] === 'image' && args[1] === 'inspect') {
  console.log('sha256:synthetic-cached-image')
} else if (args[0] === 'run') {
  assert.ok(args.includes('--pull=never'))
  assert.equal(args[args.indexOf('-p') + 1], '127.0.0.1::5432')
  state.envFile = args[args.indexOf('--env-file') + 1]
  if (configuration.mode !== 'absent') {
    state.container = {
      name: args[args.indexOf('--name') + 1],
      label: configuration.mode === 'wrong-label' ? 'foreign-owner' : args[args.indexOf('--label') + 1].split('=').at(-1),
    }
  }
  if (configuration.mode === 'signal') {
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
    await new Promise((resolve, reject) => { descendant.once('spawn', resolve); descendant.once('error', reject) })
    state.descendant = descendant.pid
    state.running = process.pid
    persist()
    setInterval(() => {}, 1000)
  } else {
    persist()
    console.error('Synthetic Docker run failure')
    process.exitCode = 1
  }
} else if (args[0] === 'inspect') {
  if (state.container) {
    assert.equal(args[1], state.container.name)
    console.log(state.container.label)
  } else {
    console.error('Error: No such container: synthetic-missing')
    process.exitCode = 1
  }
} else if (args[0] === 'rm') {
  assert.ok(state.container)
  assert.ok(args.includes(state.container.name))
  state.removed = state.container
  state.container = null
  persist()
} else if (args[0] === 'ps') {
  if (state.container && args.at(-1).endsWith('=' + state.container.label)) console.log('synthetic-container-id')
} else {
  throw new Error('Unexpected fake Docker command: ' + JSON.stringify(args))
}
`

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

function kill(pid) {
  if (!pid) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

async function until(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(20)
  }
  assert.fail(message)
}

async function fixture(t, mode, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'raditi-db-verify-unit-'))
  const stateFile = join(directory, 'state.json')
  const bin = join(directory, 'bin')
  const temporary = join(directory, 'temporary')
  await mkdir(bin)
  await mkdir(temporary)
  await writeFile(stateFile, JSON.stringify({ calls: [], container: null }))
  const program = join(directory, 'fake-docker.mjs')
  await writeFile(
    program,
    `const configuration = ${JSON.stringify({ mode, state: stateFile })}\n${fakeDocker}`,
  )
  await writeFile(
    join(bin, 'docker'),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)} "$@"\n`,
    { mode: 0o700 },
  )

  const child = spawn(process.execPath, [verifier], {
    env: { PATH: bin, HOME: directory, TMPDIR: temporary, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => {
    output.stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    output.stderr += chunk
  })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, ...output }))
  })
  const state = async () => JSON.parse(await readFile(stateFile, 'utf8'))
  t.after(async () => {
    // A regression must fail without leaving even synthetic subprocesses behind.
    if (child.exitCode === null && child.signalCode === null) kill(child.pid)
    const recorded = await state()
    for (const pid of [recorded.descendant, ...recorded.calls.map((call) => call.pid)]) kill(pid)
    await done
    await rm(directory, { recursive: true, force: true })
  })
  return { child, done, state }
}

async function assertCleaned(result, recorded) {
  assert.equal(result.code, 1)
  assert.equal(result.signal, null)
  assert.equal(recorded.container, null)
  assert.match(result.stdout, /owned PostgreSQL container and data removed/)
  assert.doesNotMatch(result.stderr, /FAIL cleanup/)
  await assert.rejects(access(dirname(recorded.envFile)), { code: 'ENOENT' })
  await until(
    () =>
      [recorded.descendant, ...recorded.calls.map((call) => call.pid)].every((pid) => !alive(pid)),
    'The verifier left a synthetic subprocess running',
  )
}

test(
  'refuses a remote Docker context before inspecting images or creating resources',
  options,
  async (t) => {
    const f = await fixture(t, 'remote')
    const result = await f.done
    const recorded = await f.state()
    assert.equal(result.code, 1)
    assert.match(result.stderr, /A local Docker socket is required/)
    assert.deepEqual(
      recorded.calls.map(({ args }) => args.slice(0, 2)),
      [['context', 'inspect']],
    )
    assert.equal(recorded.container, null)
    assert.equal(recorded.envFile, undefined)
  },
)

test('refuses an invalid test time limit before calling Docker', options, async (t) => {
  const f = await fixture(t, 'run-failure', { VERIFY_DB_TEST_TIMEOUT_MS: '15m' })
  const result = await f.done
  const recorded = await f.state()
  assert.equal(result.code, 1)
  assert.match(result.stderr, /FAIL local database verification at preflight/)
  assert.match(result.stderr, /VERIFY_DB_TEST_TIMEOUT_MS must be a whole number of milliseconds/)
  assert.deepEqual(recorded.calls, [])
  assert.equal(recorded.envFile, undefined)
})

test(
  'removes an owned container even when docker run fails after creating it',
  options,
  async (t) => {
    const f = await fixture(t, 'run-failure')
    const result = await f.done
    const recorded = await f.state()
    assert.match(result.stderr, /Synthetic Docker run failure/)
    assert.ok(recorded.removed)
    await assertCleaned(result, recorded)
  },
)

test(
  'treats an absent container as cleaned after docker run fails before creation',
  options,
  async (t) => {
    const f = await fixture(t, 'absent')
    const result = await f.done
    const recorded = await f.state()
    assert.equal(
      recorded.calls.some(({ args }) => args[0] === 'rm'),
      false,
    )
    await assertCleaned(result, recorded)
  },
)

test(
  'SIGTERM kills the Docker command group and removes its partially created container',
  options,
  async (t) => {
    const f = await fixture(t, 'signal')
    await until(
      async () => Boolean((await f.state()).descendant),
      'Fake Docker did not start its descendant',
    )
    const running = await f.state()
    assert.ok(alive(running.running))
    assert.ok(alive(running.descendant))
    f.child.kill('SIGTERM')
    const result = await f.done
    const recorded = await f.state()
    assert.match(result.stderr, /Command interrupted/)
    assert.ok(recorded.removed)
    await assertCleaned(result, recorded)
  },
)

test('refuses to remove a container whose ownership label does not match', options, async (t) => {
  const f = await fixture(t, 'wrong-label')
  const result = await f.done
  const recorded = await f.state()
  assert.equal(result.code, 1)
  assert.equal(recorded.container?.label, 'foreign-owner')
  assert.equal(
    recorded.calls.some(({ args }) => args[0] === 'rm'),
    false,
  )
  assert.match(result.stderr, /FAIL cleanup of owned fixture/)
  assert.doesNotMatch(result.stdout, /owned PostgreSQL container and data removed/)
  await assert.rejects(access(dirname(recorded.envFile)), { code: 'ENOENT' })
})

test('every workspace with tests gated on DATABASE_URL runs in the gate', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const source = readFileSync(verifier, 'utf8')
  const suites = [...source.matchAll(/^ {2}await suite\('([^']+)', '[^']+'\)$/gm)].map(
    ([, filter]) => filter,
  )
  assert.deepEqual(suites, ['@repo/db', 'core', 'llm', 'mcp', '@repo/billing', '@repo/trpc', 'web'])
  // Only @repo/db gets the empty database; the others read the seeded catalogue, as in CI.
  const seeded = source.indexOf("stage = 'reference data seed'")
  assert.ok(seeded > 0)
  for (const filter of suites)
    assert.equal(source.indexOf(`await suite('${filter}'`) > seeded, filter !== '@repo/db', filter)

  // A suite that skips itself without DATABASE_URL is skipped by `pnpm gates` too: this gate is
  // the only local run of it, so no workspace with such a suite may be missing from the list.
  const gated = new Set()
  for (const group of ['apps', 'packages'])
    for (const workspace of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue
      const directory = join(root, group, workspace.name)
      let files
      try {
        files = readdirSync(join(directory, 'src'), { recursive: true })
      } catch {
        continue
      }
      if (
        files
          .filter((file) => /\.test\.tsx?$/.test(file))
          .some((file) =>
            readFileSync(join(directory, 'src', file), 'utf8').includes('process.env.DATABASE_URL'),
          )
      )
        gated.add(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name)
    }
  assert.ok(gated.size >= 7, 'the database, core, llm, mcp, billing, tRPC and web suites exist')
  for (const name of gated) assert.ok(suites.includes(name), `${name} is outside verify:db`)
})
