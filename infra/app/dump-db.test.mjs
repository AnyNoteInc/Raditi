// dump-db.sh, the dump before a migration (README.md, «Обычная выкладка»), against a fake docker:
// what it runs, where the dump goes, what it records and when it refuses. verify:edge dumps and
// restores the real stack.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./dump-db.sh', import.meta.url))
const ARCHIVE = 'PGDMP fake archive'
const RECORD = '2026-09-28T10:00:00+03:00\nAPP_REVISION=0ld\nWEB_IMAGE=r/web@sha256:1\n'

// Answers like the stack: pg_dump writes an archive, pg_restore -l lists the data it holds.
const fakeDocker = `#!/bin/sh
printf '%s: %s\\n' "$(pwd)" "$*" >>"$FAKE_CALLS"
case "$*" in
*' pg_dump '*)
  [ "$FAKE" = dump-fails ] && { printf 'PGDMP part'; exit 1; }
  printf '${ARCHIVE}' ;;
*' pg_restore -l')
  [ "$(cat)" = '${ARCHIVE}' ] || exit 1
  [ "$FAKE" = empty ] || echo '3456; 0 16390 TABLE DATA public _prisma_migrations raditi' ;;
*) exit 2 ;;
esac
`

let root
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** The app directory with the script and its .env, a fake docker on PATH, a releases.log. */
function setup({ env = 'APP_REVISION=4b1d2c3\n', log = RECORD } = {}) {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'raditi-dump-db-')))
  const app = join(root, 'app')
  const bin = join(root, 'bin')
  mkdirSync(app)
  mkdirSync(bin)
  copyFileSync(script, join(app, 'dump-db.sh'))
  writeFileSync(join(app, '.env'), `APP_DOMAIN=raditi.ru\n${env}`)
  writeFileSync(join(bin, 'docker'), fakeDocker, { mode: 0o755 })
  const paths = {
    app,
    dumps: join(root, 'backups'),
    log: join(root, 'releases.log'),
    calls: join(root, 'calls'),
  }
  if (log !== null) writeFileSync(paths.log, log)
  const run = (fake = '') =>
    spawnSync('sh', [join(app, 'dump-db.sh')], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        DUMP_DIR: paths.dumps,
        RELEASES_LOG: paths.log,
        FAKE: fake,
        FAKE_CALLS: paths.calls,
      },
    })
  const calls = () => (existsSync(paths.calls) ? readFileSync(paths.calls, 'utf8') : '')
  return { ...paths, run, calls }
}

test('dumps as the superuser over the socket, checks the archive and records it for rollback', () => {
  const vm = setup()
  const result = vm.run()
  assert.equal(result.status, 0, result.stderr)
  const [name] = readdirSync(vm.dumps)
  assert.match(name, /^\d{8}T\d{6}Z-4b1d2c3\.dump$/)
  const file = join(vm.dumps, name)
  assert.equal(readFileSync(file, 'utf8'), ARCHIVE)
  // Personal data and sessions: nobody but the owner reads the dumps
  assert.equal(statSync(vm.dumps).mode & 0o777, 0o700)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(readFileSync(vm.log, 'utf8'), `${RECORD}dump=${file}\n`)
  assert.equal(result.stdout, `dump-db: ${file}\n`)
  assert.equal(
    vm.calls(),
    `${vm.app}: compose exec -T postgres pg_dump -U postgres -Fc raditi\n` +
      `${vm.app}: compose exec -T postgres pg_restore -l\n`,
  )
})

test('keeps the last five dumps and never removes a file it did not name', () => {
  const vm = setup()
  mkdirSync(vm.dumps)
  const old = [0, 1, 2, 3, 4, 5].map((day) => `2026090${day + 1}T120000Z-0ld${day}.dump`)
  for (const name of [...old, 'manual.dump', 'notes.txt']) writeFileSync(join(vm.dumps, name), '')
  const result = vm.run()
  assert.equal(result.status, 0, result.stderr)
  const left = readdirSync(vm.dumps).sort()
  const fresh = left.find((name) => name.endsWith('-4b1d2c3.dump'))
  assert.ok(fresh)
  assert.deepEqual(left, [...old.slice(2), fresh, 'manual.dump', 'notes.txt'].sort())
})

test('removes dumps older than 30 days, like the backups of the platform', () => {
  const vm = setup()
  mkdirSync(vm.dumps)
  const day = 24 * 60 * 60
  const now = Date.now() / 1000
  for (const [name, age] of [
    ['20260801T120000Z-0ld1.dump', 31],
    ['20260830T120000Z-0ld2.dump', 29],
    ['manual.dump', 60],
  ]) {
    writeFileSync(join(vm.dumps, name), '')
    utimesSync(join(vm.dumps, name), now - age * day, now - age * day)
  }
  const result = vm.run()
  assert.equal(result.status, 0, result.stderr)
  const left = readdirSync(vm.dumps).sort()
  const fresh = left.find((name) => name.endsWith('-4b1d2c3.dump'))
  assert.deepEqual(left, ['20260830T120000Z-0ld2.dump', fresh, 'manual.dump'])
})

for (const [fake, what] of [
  ['dump-fails', 'pg_dump fails midway'],
  ['empty', 'the archive holds no platform data'],
])
  test(`no usable dump (${what}): no file, no record, exit 1`, () => {
    const vm = setup()
    const result = vm.run(fake)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /do not migrate/)
    assert.deepEqual(readdirSync(vm.dumps), [])
    assert.equal(readFileSync(vm.log, 'utf8'), RECORD)
  })

for (const [what, options, message] of [
  ['before the record for rollback', { log: null }, /write the record for rollback first/],
  ['without APP_REVISION', { env: '' }, /APP_REVISION .* is missing or not a revision/],
  ['with a revision that is a path', { env: 'APP_REVISION=../x\n' }, /not a revision/],
])
  test(`refuses to dump ${what}`, () => {
    const vm = setup(options)
    const result = vm.run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, message)
    assert.equal(vm.calls(), '')
    assert.equal(existsSync(vm.dumps), false)
  })
