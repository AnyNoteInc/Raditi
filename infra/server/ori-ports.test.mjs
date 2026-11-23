// The host's collector of the ports of the facts of the ORI (plan 88, 88.16а-2): it reads the
// edge's entries of journald after its cursor, gives core only those with web's header or a part of
// a long line, runs compose in the app directory, and moves the cursor only once core kept them.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const script = fileURLToPath(new URL('./host/ori-ports.sh', import.meta.url))

async function stand({ journal, coreFails = false }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ori-ports-')))
  const bin = join(dir, 'bin')
  await mkdir(bin)
  // journalctl: prints the journal and records its arguments.
  await writeFile(
    join(bin, 'journalctl'),
    `#!/bin/sh\nprintf '%s\\n' "$@" >"${dir}/journalctl.args"\ncat "${dir}/journal"\n`,
  )
  // docker: records where it ran and what core was given on stdin.
  await writeFile(
    join(bin, 'docker'),
    `#!/bin/sh\npwd >"${dir}/docker.cwd"\ncat >>"${dir}/core.stdin"\n${coreFails ? 'exit 1' : 'exit 0'}\n`,
  )
  await chmod(join(bin, 'journalctl'), 0o755)
  await chmod(join(bin, 'docker'), 0o755)
  await writeFile(join(dir, 'journal'), journal)
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ORI_PORTS_STATE: join(dir, 'state'),
    RADITI_APP_DIR: dir,
  }
  const read = async (name) => readFile(join(dir, name), 'utf8').catch(() => null)
  return { dir, env, read, done: () => rm(dir, { recursive: true, force: true }) }
}

// Entries of journald (-o json): the edge's line is in MESSAGE.
const entry = (message, extra = {}) => JSON.stringify({ MESSAGE: message, ...extra })
const fact = entry(
  '{"ClientPort":"59154","StartUTC":"2026-11-24T10:00:00Z","downstream_X-Raditi-Fact":"k"}',
)
const plain = entry('{"ClientPort":"59155","StartUTC":"2026-11-24T10:00:01Z","RequestPath":"/"}')
const part = entry('{"ClientPort":"1",', {
  CONTAINER_PARTIAL_MESSAGE: 'true',
  CONTAINER_PARTIAL_ID: 'p',
})

test('gives core the lines with the header and the parts of long ones, from the app directory', async () => {
  const s = await stand({ journal: `${plain}\n${part}\n${fact}\n-- cursor: s=abc\n` })
  try {
    await run('sh', [script], { env: s.env })
    assert.equal(await s.read('core.stdin'), `${part}\n${fact}\n`)
    // COMPOSE_FILE of the app's .env is relative to the working directory (deploy.sh).
    assert.equal((await s.read('docker.cwd')).trim(), s.dir)
    assert.match(await s.read('journalctl.args'), /^--output=json$/m)
    assert.equal(await s.read('state/cursor'), 's=abc\n')
    await run('sh', [script], { env: s.env })
    assert.match(await s.read('journalctl.args'), /^--after-cursor=s=abc$/m)
    assert.match(await s.read('journalctl.args'), /^CONTAINER_NAME=raditi-app-traefik-1$/m)
  } finally {
    await s.done()
  }
})

test('does not move the cursor when core failed, and calls no core without a fact', async () => {
  const failed = await stand({ journal: `${fact}\n-- cursor: s=abc\n`, coreFails: true })
  try {
    await assert.rejects(run('sh', [script], { env: failed.env }))
    assert.equal(await failed.read('state/cursor'), null)
  } finally {
    await failed.done()
  }
  const quiet = await stand({ journal: `${plain}\n-- cursor: s=def\n` })
  try {
    await run('sh', [script], { env: quiet.env })
    assert.equal(await quiet.read('core.stdin'), null)
    assert.equal(await quiet.read('state/cursor'), 's=def\n')
  } finally {
    await quiet.done()
  }
})

test('a release puts the collector on the host by itself: its helper, unit and timer', async () => {
  const deploy = await readFile(fileURLToPath(new URL('./deploy.sh', import.meta.url)), 'utf8')
  for (const file of ['raditi-ori-ports.service', 'raditi-ori-ports.timer', 'ori-ports.sh'])
    assert.match(deploy, new RegExp(`\\$app/server/host/(?:\\$unit|${file.replace('.', '\\.')})`))
  assert.match(deploy, /for unit in raditi-ori-ports\.service raditi-ori-ports\.timer/)
  assert.match(deploy, /systemctl enable -q --now raditi-ori-ports\.timer/)
})
