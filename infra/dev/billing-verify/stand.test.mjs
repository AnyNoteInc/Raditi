// The contract of the billing stand: what its containers, builds and processes are given, how
// it tells a build copy from the tree and a dead run from a live one, which scenarios it runs,
// in what order it cleans up, and which changes start its workflow. Text and pure functions,
// and the lock of the build copy in a temporary directory: `pnpm verify:billing` is what runs
// the stand.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The readers web and core parse their settings with (Node strips the types): an environment
// the stand builds must be one the product accepts.
import { webEnvFromEnv } from '../../../apps/web/src/server/web-env.ts'
import { authConfigFromEnv } from '../../../packages/auth/src/config.ts'
import {
  attemptStepCredits,
  minStartCredits,
  signupGiftCredits,
  tasksPerDayWithoutTariff,
} from '../../../packages/domain/src/billing/credit-numbers.ts'
import { creditAccountUnits } from '../../../packages/domain/src/billing/credits.ts'
import { addBillingMonths, nextBillingPeriod } from '../../../packages/domain/src/billing/period.ts'
import { mailerConfigFromEnv } from '../../../packages/mail/src/mailer.ts'
import {
  formatCount,
  formatMoscowDate,
  formatRubles,
} from '../../../packages/mail/src/templates/billing-format.ts'
import { storageConfigFromEnv } from '../../../packages/storage/src/config.ts'
import { vaultConfigFromEnv } from '../../../packages/vault/src/config.ts'
import { yookassaConfigFromEnv } from '../../../packages/yookassa/src/config.ts'
import {
  CREDITS,
  CREDIT_RATE,
  ON_SALE,
  counted,
  creditsCount,
  giftGrant,
  giftKey,
  journalRow,
  moscowDate,
  rubles,
} from './scenario-kit.mjs'
import { scenarioIds } from './scenarios.mjs'
import {
  BUILD_OUTPUT,
  BUILD_STAMP,
  BUILD_STEPS,
  CLEANUP_ORDER,
  COPY_MARKER,
  EXTRA_ROWS,
  LETTER_MIRROR,
  LETTER_MIRROR_SQL,
  LETTER_READER,
  PAST_DUE_DAYS,
  POSTGRES_IMAGE,
  REDIS_IMAGE,
  RENEWAL_NOTICE_DAYS,
  RUN_RECORD,
  RUN_STAGING_PREFIX,
  SCENARIOS,
  SHOP_ID,
  STAND_LABEL,
  TICK_SECONDS,
  buildDirectory,
  buildEnvironment,
  buildStamp,
  containerName,
  cookieHeader,
  copyablePath,
  coreEnvironment,
  databaseEnvironment,
  isRunDirectory,
  letterReaderEnvironment,
  lettersOf,
  logDirectory,
  manifestDuringCopy,
  metricValue,
  moscowMonthLater,
  operatorEnvironment,
  outside,
  periodEndingAt,
  postgresContainerArgs,
  postgresEnvFile,
  publishedPort,
  readBuildStamp,
  readRunRecord,
  redisContainerArgs,
  redisEnvFile,
  runDirectoryName,
  runRecord,
  staleCopy,
  staleCopyAllowed,
  staleFiles,
  standOptions,
  sweepLine,
  sweepOf,
  treeChanges,
  treeDigest,
  treeEntry,
  trpcOutcome,
  trpcQueryUrl,
  webEnvironment,
} from './stand.mjs'
import { lockCopy } from './verify-billing.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')
/** The files the scenarios are written in: the kit, the four groups and the runner. */
const scenarioFiles = readdirSync(join(root, 'infra/dev/billing-verify'))
  .filter((name) => /^scenario(s|s-[a-z]+|-kit)\.mjs$/.test(name))
  .sort()
const scenarioSource = scenarioFiles
  .map((name) => read(`infra/dev/billing-verify/${name}`))
  .join('\n')
const RUN = '0123abcd'
const values = (args, flag) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []))
const secrets = {
  auth: 'synthetic-auth-secret-of-at-least-32-characters',
  metrics: 'synthetic-metrics-token',
  shopKey: 'test_synthetic-shop-key',
  unused: 'synthetic-unused-value',
}
const shared = {
  path: '/usr/bin:/bin',
  directory: '/tmp/raditi-billing-verify-run-x',
  ports: { web: 43_100 },
  databaseUrl: 'postgresql://raditi:synthetic@127.0.0.1:45432/raditi',
  redisUrl: 'redis://default:synthetic@127.0.0.1:46379',
  fakeApiUrl: 'http://127.0.0.1:44110/v3',
  secrets,
}

// ─── Options ──────────────────────────────────────────────────────────────────

test('the stand takes --no-build, --keep and --only, and nothing that names a database or a shop', () => {
  assert.deepEqual(standOptions([]), { build: true, keep: false, only: null })
  assert.deepEqual(standOptions(['--', '--no-build', '--keep']), {
    build: false,
    keep: true,
    only: null,
  })
  assert.deepEqual(standOptions(['--only', 'checkout,refund']).only, ['checkout', 'refund'])
  assert.deepEqual(standOptions(['--only=two-ticks']).only, ['two-ticks'])
  for (const argv of [
    ['--database-url', 'postgresql://raditi@localhost/raditi'],
    ['postgresql://raditi@localhost/raditi'],
    ['--shop', '123456'],
    ['--only'],
    ['--only', 'no-such-scenario'],
    ['--only', 'checkout,no-such-scenario'],
    ['--only='],
  ])
    assert.throws(() => standOptions(argv), /--no-build, --keep|--only takes/, argv.join(' '))
  // A refusal of --only names every scenario there is.
  assert.throws(
    () => standOptions(['--only', 'nope']),
    (error) => SCENARIOS.every(({ id }) => error.message.includes(id)),
  )
})

// ─── Containers ───────────────────────────────────────────────────────────────

test('PostgreSQL and Redis are the images of the app VM and of the other stands, by digest', () => {
  for (const image of [POSTGRES_IMAGE, REDIS_IMAGE])
    assert.match(image, /^[a-z]+:[\w.-]+@sha256:[a-f0-9]{64}$/)
  // infra/app/env.example names the same digests behind the mirror of the platform registry.
  const app = read('infra/app/env.example')
  assert.ok(app.includes(`POSTGRES_IMAGE=git.raditi.ru/mirror/${POSTGRES_IMAGE}\n`))
  assert.ok(app.includes(`REDIS_IMAGE=git.raditi.ru/mirror/${REDIS_IMAGE}\n`))
  assert.ok(read('infra/dev/db-verify/verify-db.mjs').includes(`'${POSTGRES_IMAGE}'`))
  const edge = read('infra/app/verify-edge.mjs')
  assert.ok(edge.includes(`'${POSTGRES_IMAGE}'`) && edge.includes(`'${REDIS_IMAGE}'`))
  // The stand pulls nothing: the README gives the two commands that load exactly these.
  const readme = read('infra/dev/billing-verify/README.md')
  assert.deepEqual(
    [...readme.matchAll(/^ {2}docker pull (\S+)$/gm)].map(([, image]) => image),
    [POSTGRES_IMAGE, REDIS_IMAGE],
  )
})

test('a container is the run’s own: its name, its label, loopback only, nothing pulled, no host path', () => {
  const postgres = postgresContainerArgs({ run: RUN, envFile: '/tmp/run/postgres.env' })
  const redis = redisContainerArgs({ run: RUN, envFile: '/tmp/run/redis.env' })
  for (const [args, service, port] of [
    [postgres, 'postgres', '5432'],
    [redis, 'redis', '6379'],
  ]) {
    assert.deepEqual(args.slice(0, 3), ['run', '-d', '--pull=never'])
    assert.deepEqual(values(args, '--name'), [`raditi-billing-verify-${RUN}-${service}`])
    assert.deepEqual(values(args, '--label'), [`${STAND_LABEL}=${RUN}`])
    // A random port of loopback: two runs, or a run and the dev infrastructure, never collide.
    assert.deepEqual(values(args, '-p'), [`127.0.0.1::${port}`])
    for (const flag of ['-v', '--volume', '--network', '--mount', '-e', '--env', '--privileged'])
      assert.ok(!args.includes(flag), `${service}: ${flag}`)
    assert.deepEqual(values(args, '--env-file'), [`/tmp/run/${service}.env`])
  }
  assert.equal(postgres.at(-1), POSTGRES_IMAGE)
  // The data of the stand lives in memory and goes with the container.
  assert.deepEqual(values(postgres, '--tmpfs'), ['/var/lib/postgresql/data:rw'])
  assert.equal(redis[redis.indexOf(REDIS_IMAGE) + 1], 'sh')
  const server = redis.at(-1)
  assert.match(server, /^exec redis-server /)
  // As in infra/dev and infra/app: BullMQ must never lose a key to eviction.
  assert.match(server, /--maxmemory-policy noeviction/)
  assert.match(server, /--save "" --appendonly no/)
})

test('no password is an argument of a process: both come from an env file of the run', () => {
  const password = 'synthetic-password-0123456789abcdef'
  const postgres = postgresContainerArgs({ run: RUN, envFile: '/tmp/run/postgres.env' })
  const redis = redisContainerArgs({ run: RUN, envFile: '/tmp/run/redis.env' })
  assert.equal(
    postgresEnvFile(password),
    `POSTGRES_USER=raditi\nPOSTGRES_DB=raditi\nPOSTGRES_PASSWORD=${password}\n`,
  )
  assert.equal(redisEnvFile(password), `REDIS_PASSWORD=${password}\n`)
  // The shell of the container reads the variable; the host only ever sees its name.
  assert.match(redis.at(-1), /--requirepass "\$REDIS_PASSWORD"$/)
  for (const args of [postgres, redis]) assert.ok(!args.join(' ').includes(password))
  for (const envFile of ['postgres.env', './redis.env', '', undefined]) {
    assert.throws(() => postgresContainerArgs({ run: RUN, envFile }), /absolute path/)
    assert.throws(() => redisContainerArgs({ run: RUN, envFile }), /absolute path/)
  }
})

test('a name that is not the stand’s own, and a port that is not on loopback, are refused', () => {
  for (const run of ['', '0123abc', '0123ABCD', '0123abcd-x', '../x', undefined])
    assert.throws(() => containerName(run, 'postgres'), /run id/)
  for (const service of ['web', 'raditi-dev-postgres-1', ''])
    assert.throws(() => containerName(RUN, service), /service/)
  assert.equal(publishedPort('127.0.0.1:59616\n'), 59_616)
  for (const output of ['0.0.0.0:5432', '127.0.0.1:5432\n[::]:5432', ':::5432', ''])
    assert.throws(() => publishedPort(output), /loopback only/)
})

// ─── The private copy and its builds ──────────────────────────────────────────

test('web and core are built in a copy outside the repository, never in the repository', () => {
  const repo = '/home/dev/raditi'
  assert.equal(buildDirectory({}, '/var/tmp', repo), '/var/tmp/raditi-billing-verify-build')
  // No trailing separator: the lock lies beside the copy (`<copy>.lock`), never inside it.
  assert.equal(
    buildDirectory({ BILLING_VERIFY_BUILD_DIR: '/srv/build//copy/' }, '/var/tmp', repo),
    '/srv/build/copy',
  )
  assert.throws(
    () => buildDirectory({ BILLING_VERIFY_BUILD_DIR: 'build' }, '/var/tmp', repo),
    /BILLING_VERIFY_BUILD_DIR must be an absolute path/,
  )
  // Inside the repository `next build` would write under the tree another session's `next dev`
  // watches, and the next listing of the tree would hold the copy itself.
  for (const inside of [
    repo,
    `${repo}/`,
    `${repo}/.billing-build`,
    `${repo}/apps/web/../../build`,
    `${repo}/../raditi/build`,
  ])
    assert.throws(
      () => buildDirectory({ BILLING_VERIFY_BUILD_DIR: inside }, '/var/tmp', repo),
      /BILLING_VERIFY_BUILD_DIR must be outside the repository/,
      inside,
    )
  // A temporary directory that lies in the repository is no place for the copy either.
  assert.throws(() => buildDirectory({}, `${repo}/tmp`, repo), /outside the repository/)
  for (const beside of [`${repo}-build`, `${repo}/../build`, '/home/dev', '/'])
    assert.equal(outside(repo, beside), true, beside)
  for (const within of [repo, `${repo}/x`, `${repo}/..x`, `${repo}/a/../b`])
    assert.equal(outside(repo, within), false, within)
  // The logs of a failed run follow the same rule; by default they carry the id of the run.
  assert.equal(
    logDirectory({}, '/var/tmp', RUN, repo),
    `/var/tmp/raditi-billing-verify-logs-${RUN}`,
  )
  assert.equal(
    logDirectory({ BILLING_VERIFY_LOG_DIR: '/runner/_temp/billing-logs/' }, '/var/tmp', RUN, repo),
    '/runner/_temp/billing-logs',
  )
  assert.throws(
    () => logDirectory({ BILLING_VERIFY_LOG_DIR: `${repo}/logs` }, '/var/tmp', RUN, repo),
    /BILLING_VERIFY_LOG_DIR must be outside the repository/,
  )
  assert.throws(
    () => logDirectory({ BILLING_VERIFY_LOG_DIR: 'logs' }, '/var/tmp', RUN, repo),
    /absolute/,
  )
  assert.throws(() => logDirectory({}, '/var/tmp', '../x', repo), /run id/)
  // The stand itself decides where a build goes: nothing of it may write apps/web/.next of the
  // tree, where another session's `next dev` holds the lock of Next.
  const stand = read('infra/dev/billing-verify/verify-billing.mjs')
  assert.match(stand, /const copy = buildDirectory\(process\.env, tmpdir\(\), root\)/)
  assert.match(stand, /owned\.logDirectory = logDirectory\(process\.env, tmpdir\(\), runId, root\)/)
  for (const [, cwd] of stand.matchAll(/command\('pnpm',[^)]*?cwd: (\w+)/gs))
    assert.equal(cwd, 'copy', 'pnpm runs in the copy only')
  assert.equal([...stand.matchAll(/command\('pnpm'/g)].length, 2)
  assert.doesNotMatch(stand, /--env-file|loadEnvFile|dotenv/)
})

test('the copy takes what git does not ignore, and forgets what the tree has lost', () => {
  for (const path of ['package.json', 'apps/web/src/app/page.tsx', '.nvmrc', '.env.example'])
    assert.equal(copyablePath(path), true, path)
  for (const path of [
    '',
    '/etc/passwd',
    '../outside',
    'apps/../../outside',
    'apps//web',
    './package.json',
    '.git/config',
    `${COPY_MARKER}/manifest`,
    undefined,
  ])
    assert.equal(copyablePath(path), false, String(path))
  assert.deepEqual(
    staleFiles(
      ['package.json', 'apps/web/src/app/old/page.tsx', 'packages/x/src/gone.ts', '../escape'],
      ['package.json', 'apps/web/src/app/new/page.tsx'],
    ),
    ['apps/web/src/app/old/page.tsx', 'packages/x/src/gone.ts'],
  )
  // `.env` is ignored by git, so `git ls-files -co --exclude-standard` never lists it.
  assert.match(read('.gitignore'), /^\.env$/m)
  const stand = read('infra/dev/billing-verify/verify-billing.mjs')
  assert.match(stand, /'ls-files', '-co', '--exclude-standard', '-z'/)
  assert.match(stand, /!present\.includes\('\.env'\)/)
})

test('a run that dies while it copies leaves a manifest of everything it may have copied', () => {
  // What the copy held and what is coming, each once: the next run removes what the tree has
  // lost, whether the run before it got as far as its own manifest or not.
  assert.deepEqual(
    manifestDuringCopy(
      ['package.json', 'packages/x/src/old.ts', '../escape'],
      ['package.json', 'packages/x/src/new.ts'],
    ),
    ['package.json', 'packages/x/src/old.ts', 'packages/x/src/new.ts'],
  )
  // The run after a death: `new.ts` has left the tree meanwhile and goes from the copy.
  assert.deepEqual(
    staleFiles(
      manifestDuringCopy(
        ['package.json', 'packages/x/src/old.ts'],
        ['package.json', 'packages/x/src/new.ts'],
      ),
      ['package.json'],
    ),
    ['packages/x/src/old.ts', 'packages/x/src/new.ts'],
  )
  // Written before the rsync, and again — the listing alone — after it.
  const stand = read('infra/dev/billing-verify/verify-billing.mjs')
  const [, sync] = /async function syncCopy\(copy\) \{\n([^]*?)\n\}\n/.exec(stand) ?? []
  assert.ok(sync, 'verify-billing.mjs has syncCopy')
  const at = (text) => {
    const index = sync.indexOf(text)
    assert.notEqual(index, -1, text)
    return index
  }
  const during = at("writeFile(manifest, manifestDuringCopy(previous, present).join('\\0'))")
  const rsync = at("command('rsync'")
  assert.ok(during < rsync && rsync < at("writeFile(manifest, present.join('\\0'))"))
  // The stamp of the build before goes first of all: a copy that is being written is no build.
  assert.ok(at('rm(stampOf(copy)') < during)
})

test('--no-build runs only on a copy that was built of the tree as it is now', () => {
  const file = (path, size, mtimeMs) => treeEntry(path, { size, mtimeMs })
  const tree = [
    file('package.json', 2_000, 1_791_572_828_123.5),
    file('packages/billing/src/renewal.ts', 51_000, 1_791_572_900_000),
    file('packages/db/prisma/migrations/1/migration.sql', 900, 1_791_000_000_000),
  ]
  // The digest is of the files, whatever order they are listed in, and of nothing else.
  assert.match(treeDigest(tree), /^[a-f0-9]{64}$/)
  assert.equal(treeDigest([...tree].reverse()), treeDigest(tree))
  assert.notEqual(treeDigest(tree.slice(1)), treeDigest(tree))
  // A path, a size or a time of writing that differs is another tree; a path cannot be made
  // to look like two fields of another entry.
  assert.notEqual(treeDigest([file('a', 1, 2)]), treeDigest([file('a', 1, 3)]))
  assert.notEqual(treeDigest([file('a', 1, 2)]), treeDigest([file('a', 2, 2)]))
  assert.notEqual(treeDigest([file('a', 12, 3)]), treeDigest([file('a\x0012', 3, 3)]))

  const builtAt = '2026-10-10T00:10:00.000Z'
  const stamp = readBuildStamp(buildStamp({ builtAt, entries: tree }))
  assert.deepEqual(stamp, { builtAt, digest: treeDigest(tree), entries: [...tree].sort() })
  // The copy holds the same files: rsync keeps their size, and their time to the second.
  const second = (entry) => {
    const [path, size, mtimeMs] = entry.split('\0')
    return file(path, Number(size), Math.floor(Number(mtimeMs) / 1000) * 1000)
  }
  const held = tree.map(second)
  assert.notDeepEqual(held, tree)
  assert.equal(staleCopy(stamp, [...tree].reverse(), held), null)
  assert.equal(staleCopy(stamp, tree, tree), null)

  // A source that was edited, a migration that was added, a file that was deleted: refused,
  // with the time of the build, how many files differ and the first of them.
  const edited = [
    tree[0],
    file('packages/billing/src/renewal.ts', 51_020, 1_791_580_000_000),
    tree[2],
  ]
  assert.deepEqual(treeChanges(stamp.entries, edited), ['packages/billing/src/renewal.ts'])
  assert.equal(
    staleCopy(stamp, edited, held),
    `the tree has changed since the copy was built at ${builtAt}: 1 file (first: packages/billing/src/renewal.ts)`,
  )
  const touched = [
    tree[0],
    file('packages/billing/src/renewal.ts', 51_000, 1_791_580_000_000),
    tree[2],
  ]
  assert.match(
    staleCopy(stamp, touched, held),
    /1 file \(first: packages\/billing\/src\/renewal\.ts\)$/,
  )
  const grown = [
    ...tree,
    file('packages/db/prisma/migrations/2/migration.sql', 400, 1_791_580_000_000),
    file('a.ts', 1, 1),
    file('b.ts', 1, 1),
    file('c.ts', 1, 1),
  ]
  assert.match(staleCopy(stamp, grown, held), /: 4 files \(first: a\.ts, b\.ts, c\.ts, …\)$/)
  assert.deepEqual(treeChanges(stamp.entries, tree.slice(1)), ['package.json'])
  // The tree is as it was, and a file of the COPY was edited — the product broken there on
  // purpose, or by a slip — or is gone: the copy is not that build any more.
  const broken = [
    held[0],
    file('packages/billing/src/renewal.ts', 51_040, 1_791_590_000_000),
    held[2],
  ]
  assert.equal(
    staleCopy(stamp, tree, broken),
    `the copy itself has been changed since it was built at ${builtAt}: 1 file (first: packages/billing/src/renewal.ts)`,
  )
  assert.match(
    staleCopy(stamp, tree, held.slice(0, 2)),
    /the copy itself has been changed .*migration\.sql\)$/,
  )
  // The same size a second later is another file all the same.
  assert.match(
    staleCopy(stamp, tree, [
      held[0],
      file('packages/billing/src/renewal.ts', 51_000, 1_791_572_901_000),
      held[2],
    ]),
    /the copy itself has been changed/,
  )
  // No stamp — the build before was interrupted, or the copy is of an older stand —, a torn
  // one, or one whose entries are not the ones its digest was made of: no finished build.
  const text = buildStamp({ builtAt, entries: tree })
  for (const broken of [
    '',
    '{',
    'null',
    text.slice(0, -40),
    text.replace('renewal.ts', 'renewal.tsx'),
    JSON.stringify({ digest: treeDigest(tree), entries: tree }),
    JSON.stringify({ builtAt: 'yesterday', digest: treeDigest(tree), entries: tree }),
  ])
    assert.equal(readBuildStamp(broken), null, broken.slice(0, 40))
  assert.match(staleCopy(null, tree, []), /holds no stamp of a finished build/)

  // The stand writes the stamp after the last build step and removes it before it copies;
  // `--no-build` reads it against a fresh listing of the tree and is refused on a difference.
  const stand = read('infra/dev/billing-verify/verify-billing.mjs')
  assert.equal(BUILD_STAMP, 'built')
  assert.match(stand, /const stampOf = \(copy\) => join\(copy, COPY_MARKER, BUILD_STAMP\)/)
  const [, build] =
    /async function build\(copy, options, allowStale\) \{\n([^]*?)\n\}\n/.exec(stand) ?? []
  assert.ok(build, 'verify-billing.mjs has build')
  const lastStep = build.lastIndexOf('BUILD_OUTPUT.webStaticServed')
  assert.ok(lastStep !== -1 && lastStep < build.indexOf('writeFile(stampOf(copy), buildStamp('))
  assert.match(
    build,
    /const stale = staleCopy\(\s+stamp,\s+\(await treeListing\(\)\)\.entries,\s+stamp === null \? \[\] : await copyListing\(copy, stamp\),\s+\)/,
  )
  assert.match(build, /if \(!allowStale\)\s+throw new Error\(`--no-build is refused: \$\{stale\}/)
  // The one way past the refusal says so in capitals, here and in the last line of the run.
  assert.match(
    build,
    /console\.log\(\s+`WARNING BILLING_VERIFY_STALE_COPY=allow: THE COPY IS NOT THE TREE/,
  )
  assert.match(
    stand,
    /owned\.staleCopy\s+\? ' — ON A STALE COPY \(BILLING_VERIFY_STALE_COPY=allow\)/,
  )
})

test('a stale copy is let through by one variable, for mutation checks of the stand only', () => {
  const noBuild = { build: false }
  assert.equal(staleCopyAllowed({}, noBuild), false)
  assert.equal(staleCopyAllowed({ BILLING_VERIFY_STALE_COPY: '' }, noBuild), false)
  assert.equal(staleCopyAllowed({ BILLING_VERIFY_STALE_COPY: 'allow' }, noBuild), true)
  for (const value of ['1', 'true', 'yes', 'ALLOW', 'allow '])
    assert.throws(
      () => staleCopyAllowed({ BILLING_VERIFY_STALE_COPY: value }, noBuild),
      /takes one value, `allow`/,
      value,
    )
  // A run that builds copies the tree first: there the variable would only mislead.
  assert.throws(
    () => staleCopyAllowed({ BILLING_VERIFY_STALE_COPY: 'allow' }, { build: true }),
    /goes with --no-build only/,
  )
  assert.equal(staleCopyAllowed({}, { build: true }), false)
  const readme = read('infra/dev/billing-verify/README.md')
  assert.match(readme, /`BILLING_VERIFY_STALE_COPY=allow`[^\n]*мутационн/)
  // Never set by the workflow.
  assert.doesNotMatch(read('.github/workflows/billing.yml'), /STALE_COPY/)
})

test('the lock of the copy appears with its pid, holds a live run off and is taken from a dead one', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'raditi-billing-verify-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const copy = join(directory, 'copy')
  const pidIn = (lock) => readFileSync(join(lock, 'pid'), 'utf8')
  const beside = () => readdirSync(directory).sort()

  const lock = await lockCopy(copy, { pid: 4242, holderAlive: () => true })
  assert.equal(lock, `${copy}.lock`)
  assert.equal(pidIn(lock), '4242')
  // Nothing else is left beside the copy: what the lock was made in became the lock.
  assert.deepEqual(beside(), ['copy.lock'])

  // A second run while the first is alive: refused by the pid, and the lock is untouched.
  await assert.rejects(
    lockCopy(copy, { pid: 4343, holderAlive: (pid) => pid === 4242 }),
    /Another run of the stand \(pid 4242\) is using the build copy/,
  )
  assert.equal(pidIn(lock), '4242')
  assert.deepEqual(beside(), ['copy.lock'])

  // The holder is gone: its lock is taken over.
  await lockCopy(copy, { pid: 4343, holderAlive: () => false })
  assert.equal(pidIn(lock), '4343')
  assert.deepEqual(beside(), ['copy.lock'])

  // Twenty runs at once on a free copy: one takes the lock, and every other one finds a pid
  // in it — a lock is never seen without its pid, so none is taken for an abandoned one.
  rmSync(lock, { recursive: true })
  const alive = new Set()
  const outcomes = await Promise.allSettled(
    Array.from({ length: 20 }, (_, index) => {
      alive.add(5000 + index)
      return lockCopy(copy, { pid: 5000 + index, holderAlive: (pid) => alive.has(pid) })
    }),
  )
  const taken = outcomes.filter(({ status }) => status === 'fulfilled')
  assert.equal(taken.length, 1)
  const holder = pidIn(lock)
  for (const { status, reason } of outcomes)
    if (status === 'rejected')
      assert.equal(
        reason.message.startsWith(`Another run of the stand (pid ${holder}) is using`),
        true,
        reason.message,
      )
  assert.deepEqual(beside(), ['copy.lock'])

  // The stand never makes the lock in place and writes the pid afterwards.
  const stand = read('infra/dev/billing-verify/verify-billing.mjs')
  const [, source] = /export async function lockCopy[^]*?\{\n([^]*?)\n\}\n/.exec(stand) ?? []
  assert.ok(source, 'verify-billing.mjs has lockCopy')
  assert.doesNotMatch(source, /mkdir\(lock/)
  assert.match(source, /await rename\(made, lock\)/)
  assert.ok(source.indexOf("writeFile(join(made, 'pid')") < source.indexOf('rename(made, lock)'))
  assert.equal(existsSync(copy), false, 'taking the lock does not make the copy')
})

test('a build reads nothing of the caller but PATH and HOME', () => {
  assert.deepEqual(buildEnvironment({ path: '/usr/bin', home: '/home/dev' }), {
    PATH: '/usr/bin',
    HOME: '/home/dev',
    CI: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  })
  // Nothing of a stand can be baked into a bundle: the repository has no NEXT_PUBLIC_ variable.
  for (const file of ['.env.example', 'turbo.json', 'apps/web/next.config.ts'])
    assert.doesNotMatch(read(file), /NEXT_PUBLIC_[A-Z]/, file)
})

test('the builds are the steps of the two Dockerfiles, in their order', () => {
  assert.deepEqual(
    BUILD_STEPS.map(({ args }) => `pnpm ${args.join(' ')}`),
    [
      'pnpm install --frozen-lockfile --prefer-offline',
      'pnpm --filter @repo/db db:generate',
      'pnpm --filter orchestrator build',
      'pnpm --filter web build',
    ],
  )
  const web = read('apps/web/Dockerfile')
  const orchestrator = read('apps/orchestrator/Dockerfile')
  const generate =
    'DATABASE_URL=postgresql://build@localhost/build pnpm --filter @repo/db db:generate'
  assert.ok(web.includes(`RUN ${generate} \\\n && pnpm --filter web build`))
  assert.ok(orchestrator.includes(`RUN ${generate} \\\n && pnpm --filter orchestrator build`))
  assert.deepEqual(BUILD_STEPS[1].env, { DATABASE_URL: 'postgresql://build@localhost/build' })
  for (const index of [0, 2, 3]) assert.deepEqual(BUILD_STEPS[index].env, {})
  // What runs afterwards is what the images run.
  assert.match(web, /^COPY --from=build \/repo\/apps\/web\/\.next\/standalone \.\/$/m)
  assert.match(web, /^CMD \["apps\/web\/server\.js"\]$/m)
  assert.equal(BUILD_OUTPUT.web, 'apps/web/.next/standalone/apps/web/server.js')
  assert.match(
    web,
    /^COPY --from=build \/repo\/apps\/web\/\.next\/static \.\/apps\/web\/\.next\/static$/m,
  )
  assert.equal(BUILD_OUTPUT.webStaticServed, 'apps/web/.next/standalone/apps/web/.next/static')
  assert.equal(
    JSON.parse(read('apps/orchestrator/package.json')).scripts.start,
    'node dist/main.js',
  )
  assert.equal(BUILD_OUTPUT.core, 'apps/orchestrator/dist/main.js')
  assert.match(read('apps/web/next.config.ts'), /output: 'standalone'/)
})

// ─── Processes ────────────────────────────────────────────────────────────────

const SYSTEM = ['PATH', 'HOME', 'TMPDIR', 'NODE_ENV', 'NO_COLOR', 'HOSTNAME', 'PORT', 'CI']

test('web gets the stand’s database and the fake, a synthetic HOME, and nothing else', () => {
  const env = webEnvironment(shared)
  assert.deepEqual(env, {
    PATH: '/usr/bin:/bin',
    HOME: '/tmp/raditi-billing-verify-run-x/home',
    TMPDIR: '/tmp/raditi-billing-verify-run-x/tmp',
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    HOSTNAME: '127.0.0.1',
    PORT: '43100',
    APP_ENV: 'test',
    APP_URL: 'http://127.0.0.1:43100',
    BETTER_AUTH_URL: 'http://127.0.0.1:43100',
    BETTER_AUTH_SECRET: secrets.auth,
    DATABASE_URL: shared.databaseUrl,
    METRICS_TOKEN: secrets.metrics,
    YOOKASSA_SHOP_ID: SHOP_ID,
    YOOKASSA_SECRET_KEY: secrets.shopKey,
    YOOKASSA_API_URL: shared.fakeApiUrl,
    YOOKASSA_WEBHOOK_ALLOWLIST: '127.0.0.1,::1',
    BILLING_PAST_DUE_DAYS: '7',
  })
  // The product's own readers take it.
  assert.deepEqual(webEnvFromEnv(env), {
    appEnv: 'test',
    appUrl: 'http://127.0.0.1:43100',
    metricsToken: secrets.metrics,
    redisUrl: undefined,
    pastDueDays: PAST_DUE_DAYS,
  })
  // No captcha: a customer of the stand signs up over HTTP.
  assert.equal(authConfigFromEnv(env).captcha, null)
  assert.deepEqual(yookassaConfigFromEnv(env), {
    shopId: SHOP_ID,
    secretKey: secrets.shopKey,
    baseUrl: shared.fakeApiUrl,
    webhookAllowlist: ['127.0.0.1', '::1'],
    // YOOKASSA_AUTOPAYMENTS is not given: outside production the switch is on, and the stand
    // runs with it on — the scenario `autopayments-not-approved` is about a shop that is not.
    autopayments: true,
  })
  assert.equal('YOOKASSA_AUTOPAYMENTS' in env, false)
})

test('core gets PostgreSQL and Redis of the stand; S3 and Vault are throwaway values it only parses', () => {
  const env = coreEnvironment({ ...shared, port: 43_200 })
  assert.deepEqual(Object.keys(env).sort(), [
    'APP_ENV',
    'APP_URL',
    'BILLING_PAST_DUE_DAYS',
    'BILLING_RENEWAL_NOTICE_DAYS',
    'BILLING_TICK_SECONDS',
    'DATABASE_URL',
    'HOME',
    'METRICS_TOKEN',
    'NODE_ENV',
    'NO_COLOR',
    'ORCHESTRATOR_PORT',
    'ORCHESTRATOR_ROLES',
    'PATH',
    'REDIS_URL',
    'S3_ACCESS_KEY_ID',
    'S3_ENDPOINT',
    'S3_SECRET_ACCESS_KEY',
    'TMPDIR',
    'TURN_EXECUTOR',
    'VAULT_ADDR',
    'VAULT_DEV_ROOT_TOKEN',
    'YOOKASSA_API_URL',
    'YOOKASSA_SECRET_KEY',
    'YOOKASSA_SHOP_ID',
  ])
  assert.equal(env.ORCHESTRATOR_ROLES, 'core')
  assert.equal(env.ORCHESTRATOR_PORT, '43200')
  assert.equal(env.DATABASE_URL, shared.databaseUrl)
  assert.equal(env.REDIS_URL, shared.redisUrl)
  // The letters of core link to web, and web tells the day an overdue tariff ends by the same
  // number of days core ends it by.
  assert.equal(env.APP_URL, webEnvironment(shared).APP_URL)
  assert.equal(env.BILLING_PAST_DUE_DAYS, webEnvironment(shared).BILLING_PAST_DUE_DAYS)
  assert.deepEqual(
    [env.BILLING_TICK_SECONDS, env.BILLING_RENEWAL_NOTICE_DAYS, env.BILLING_PAST_DUE_DAYS],
    [String(TICK_SECONDS), String(RENEWAL_NOTICE_DAYS), String(PAST_DUE_DAYS)],
  )
  // NODE_ENV=production: core looks for no `.env` (load-env.ts); APP_ENV is what decides
  // everything else, and it is not production.
  assert.equal(env.NODE_ENV, 'production')
  assert.match(read('apps/orchestrator/src/env-file.ts'), /if \(nodeEnv === 'production'\) return/)
  assert.equal(env.APP_ENV, 'test')
  // The tick is the lower bound the settings of core allow, and the days are its defaults.
  const config = read('apps/orchestrator/src/config/config.ts')
  assert.match(config, /BILLING_TICK_SECONDS: envVar\(z\.coerce\.number\(\)\.int\(\)\.min\(1\)/)
  assert.equal(TICK_SECONDS, 1)
  assert.match(config, /BILLING_RENEWAL_NOTICE_DAYS: envVar\(.*\.default\(3\)\)/)
  assert.match(config, /BILLING_PAST_DUE_DAYS: envVar\(.*\.default\(7\)\)/)
  // The sections core parses at start: each of its readers takes the throwaway values.
  assert.equal(storageConfigFromEnv(env).endpoint, 'http://127.0.0.1:9')
  assert.deepEqual(vaultConfigFromEnv(env), { addr: 'http://127.0.0.1:9', token: secrets.unused })
  // No SENDSAY_API_KEY: the mailer logs each letter, which is where the scenarios read them.
  assert.deepEqual(mailerConfigFromEnv(env), { sendsayApiKey: undefined })
  assert.equal(yookassaConfigFromEnv(env).baseUrl, shared.fakeApiUrl)
  // As web: the switch of autopayments is on.
  assert.equal(yookassaConfigFromEnv(env).autopayments, true)
  // The discard port of loopback: nothing listens there, and nothing of a developer is named.
  for (const name of ['S3_ENDPOINT', 'VAULT_ADDR']) assert.equal(env[name], 'http://127.0.0.1:9')
})

test('an operator command gets what its header asks for, given explicitly', () => {
  const env = operatorEnvironment(shared)
  assert.deepEqual(env, {
    PATH: '/usr/bin:/bin',
    HOME: '/tmp/raditi-billing-verify-run-x/home',
    TMPDIR: '/tmp/raditi-billing-verify-run-x/tmp',
    APP_ENV: 'test',
    APP_URL: 'http://127.0.0.1:43100',
    DATABASE_URL: shared.databaseUrl,
    YOOKASSA_SHOP_ID: SHOP_ID,
    YOOKASSA_SECRET_KEY: secrets.shopKey,
    YOOKASSA_API_URL: shared.fakeApiUrl,
  })
  // The five commands the scenarios run exist under these names: every command of billing.
  const scripts = readdirSync(join(root, BUILD_OUTPUT.operatorScripts))
  const used = [...scenarioSource.matchAll(/'(billing-[a-z-]+)'/g)]
  assert.deepEqual([...new Set(used.map(([, name]) => name))].sort(), [
    'billing-rates',
    'billing-refund',
    'billing-refunds-needed',
    'billing-settle-payment',
    'billing-stop-renewal',
  ])
  for (const [, name] of used) assert.ok(scripts.includes(`${name}.mjs`), name)
  assert.deepEqual(
    scripts.filter((name) => name.startsWith('billing-')).sort(),
    [...new Set(used.map(([, name]) => `${name}.mjs`))].sort(),
    'a command of billing no scenario runs',
  )
  // The file a command is given by its path is written into the directory of the run.
  assert.match(
    read('infra/dev/billing-verify/verify-billing.mjs'),
    /async operatorFile\(name, value\) \{\n\s+const path = join\(directory, 'tmp', name\)\n\s+await writeFile\(path, JSON\.stringify\(value, null, 2\), \{ mode: 0o600 \}\)/,
  )
  assert.deepEqual(databaseEnvironment({ path: '/usr/bin', home: '/home/dev', databaseUrl: 'x' }), {
    PATH: '/usr/bin',
    HOME: '/home/dev',
    CI: '1',
    DATABASE_URL: 'x',
  })
})

test('every process of the stand is given only variables the repository documents', () => {
  const documented = read('.env.example')
  const names = new Set([
    ...Object.keys(webEnvironment(shared)),
    ...Object.keys(coreEnvironment({ ...shared, port: 43_200 })),
    ...Object.keys(operatorEnvironment(shared)),
  ])
  for (const name of names) {
    if (SYSTEM.includes(name) || name === 'NEXT_TELEMETRY_DISABLED') continue
    assert.match(documented, new RegExp(`^#? ?${name}=`, 'm'), `${name} is not in .env.example`)
  }
  // No process is handed the caller's environment.
  const stand = read('infra/dev/billing-verify/verify-billing.mjs')
  assert.doesNotMatch(stand, /\.\.\.process\.env/)
  assert.match(stand, /env: webEnvironment\(shared\)/)
  assert.match(stand, /env: coreEnvironment\(\{ \.\.\.shared, port \}\)/)
  assert.match(stand, /env: operatorEnvironment\(shared\)/)
  // The reader of letters is given no address of anything: a synthetic HOME and TMPDIR.
  assert.match(stand, /env: letterReaderEnvironment\(shared\)/)
  assert.deepEqual(letterReaderEnvironment(shared), {
    PATH: '/usr/bin:/bin',
    HOME: '/tmp/raditi-billing-verify-run-x/home',
    TMPDIR: '/tmp/raditi-billing-verify-run-x/tmp',
  })
})

// ─── Cleanup ──────────────────────────────────────────────────────────────────

test('the cleanup stops writers first, the containers after them, and frees the copy last', () => {
  const at = (name) => {
    const index = CLEANUP_ORDER.indexOf(name)
    assert.notEqual(index, -1, name)
    return index
  }
  // Whoever writes to the database or calls the shop stops before the fake and the database go.
  for (const process of ['second core', 'core', 'web']) {
    assert.ok(at(process) < at('fake'), process)
    assert.ok(at(process) < at('postgres container'), process)
    assert.ok(at(process) < at('redis container'), process)
  }
  // The clients of the stand itself let go of the containers before those are removed.
  assert.ok(at('database client') < at('postgres container'))
  assert.ok(at('queue client') < at('redis container'))
  // The logs of the run are removed after the processes that write them have stopped; those
  // of a failed run are kept aside in between: whole, and before their directory goes.
  assert.ok(at('web') < at('run directory') && at('core') < at('run directory'))
  for (const process of ['second core', 'core', 'web'])
    assert.ok(at(process) < at('logs of a failed run'), process)
  assert.ok(at('logs of a failed run') < at('run directory'))
  assert.equal(CLEANUP_ORDER.at(-1), 'build lock')
  assert.equal(new Set(CLEANUP_ORDER).size, CLEANUP_ORDER.length)
  // The stand has a step for every name, and runs them in this order.
  const stand = read('infra/dev/billing-verify/verify-billing.mjs')
  const [, steps] = /const steps = \{\n((?: {4}.*\n)+?) {2}\}/.exec(stand) ?? []
  assert.ok(steps, 'verify-billing.mjs lists its cleanup steps')
  assert.deepEqual(
    [...steps.matchAll(/^ {4}'?([a-z][a-z 0-9]*?)'?: /gm)].map(([, name]) => name),
    [...CLEANUP_ORDER],
  )
  assert.match(stand, /assert\.deepEqual\(Object\.keys\(steps\), \[\.\.\.CLEANUP_ORDER\]\)/)
  assert.match(stand, /for \(const name of CLEANUP_ORDER\)/)
  // A container is removed only by its random name and after its label was read back.
  assert.match(stand, /assert\.equal\(label\.output, runId, /)
  // The signals stay handled until the cleanup has ended. SIGHUP is one of them: a terminal
  // or an SSH session that closes must not leave containers and web behind.
  assert.match(stand, /const SIGNALS = \['SIGINT', 'SIGTERM', 'SIGHUP'\]/)
  assert.match(stand, /for \(const signal of SIGNALS\) process\.on\(signal, interrupt\)/)
  const handled = stand.indexOf('for (const signal of SIGNALS) process.on(signal, interrupt)')
  const cleaned = stand.indexOf('const left = await cleanup(owned)')
  const released = stand.indexOf(
    'for (const signal of SIGNALS) process.removeListener(signal, interrupt)',
  )
  assert.ok(handled !== -1 && handled < cleaned && cleaned < released)
  assert.doesNotMatch(stand, /process\.once\('SIG/)
  // A service that is told to stop leaves no timer behind: the stand ends when it is done.
  assert.doesNotMatch(stand, /sleep\(15_000\)/)
  assert.match(stand, /const overdue = setTimeout\([^]*?await exited\n\s+clearTimeout\(overdue\)/)
  // The logs of a failed run are kept with the secrets of the run blanked, and their place
  // is printed; an interrupt keeps none.
  assert.match(stand, /owned\.keepLogs = !interrupted/)
  assert.match(
    stand,
    /if \(owned\.keepLogs && owned\.directory\) owned\.logs = await keepLogs\(owned\)/,
  )
  assert.match(stand, /redact\(await readFile\(join\(from, name\), 'utf8'\)\)/)
  assert.match(
    stand,
    /console\.error\(`LOGS of the failed run, whole \(web, core\): \$\{owned\.logs\}`\)/,
  )
  // The second core is watched while it runs, like web and core.
  assert.match(stand, /const watch = \[web, core\]/)
  assert.match(stand, /watch\.push\(second\)/)
})

test('a run is on record from its first file to its last process', () => {
  const copy = '/var/tmp/raditi-billing-verify-build'
  assert.equal(runDirectoryName(RUN), `raditi-billing-verify-run-${RUN}`)
  for (const run of ['', '0123abc', '0123ABCD', '../x', undefined])
    assert.throws(() => runDirectoryName(run), /run id/)
  const text = runRecord({
    run: RUN,
    pid: 4242,
    copy,
    // Whatever else a service object holds, the record takes its name and its pid.
    services: [
      { name: 'web', pid: 4250, log: () => 'secret' },
      { name: 'core', pid: 4251 },
    ],
  })
  assert.deepEqual(JSON.parse(text), {
    run: RUN,
    pid: 4242,
    copy,
    services: [
      { name: 'web', pid: 4250 },
      { name: 'core', pid: 4251 },
    ],
  })
  assert.deepEqual(readRunRecord(runDirectoryName(RUN), text), JSON.parse(text))
  // A record is read in the directory of its own run, or in one that has no name yet.
  assert.deepEqual(readRunRecord(`${RUN_STAGING_PREFIX}Ab3dE9`, text), JSON.parse(text))
  assert.equal(readRunRecord(runDirectoryName('ffffffff'), text), null)
  assert.equal(readRunRecord('raditi-dev-postgres-1', text), null)
  assert.equal(isRunDirectory(runDirectoryName(RUN)), true)
  assert.equal(isRunDirectory(`${RUN_STAGING_PREFIX}Ab3dE9`), true)
  for (const name of [
    'raditi-billing-verify-build',
    'raditi-billing-verify-build.lock',
    `raditi-billing-verify-logs-${RUN}`,
    undefined,
  ])
    assert.equal(isRunDirectory(name), false, String(name))
  for (const broken of [
    '',
    '{',
    'null',
    text.slice(0, -20),
    JSON.stringify({ ...JSON.parse(text), pid: 0 }),
    JSON.stringify({ ...JSON.parse(text), pid: 1 }),
    JSON.stringify({ ...JSON.parse(text), pid: '4242' }),
    JSON.stringify({ ...JSON.parse(text), run: 'nope' }),
    JSON.stringify({ ...JSON.parse(text), copy: 'relative/copy' }),
    JSON.stringify({ ...JSON.parse(text), services: [{ name: 'web', pid: -1 }] }),
    JSON.stringify({ ...JSON.parse(text), services: 'web' }),
  ])
    assert.equal(readRunRecord(runDirectoryName(RUN), broken), null, broken.slice(0, 60))
  for (const bad of [
    { run: 'nope', pid: 4242, copy },
    { run: RUN, pid: 0, copy },
    { run: RUN, pid: 4242, copy: 'copy' },
    { run: RUN, pid: 4242, copy, services: [{ name: 'web' }] },
  ])
    assert.throws(() => runRecord(bad), /Invalid/)

  // The stand: the directory appears with its record in it, before any container exists, and
  // the record is rewritten — whole, by a rename — with every process the run starts.
  const stand = read('infra/dev/billing-verify/verify-billing.mjs')
  assert.equal(RUN_RECORD, 'run.json')
  const at = (text) => {
    const index = stand.indexOf(text)
    assert.notEqual(index, -1, text)
    return index
  }
  const staged = at('await mkdtemp(join(tmpdir(), RUN_STAGING_PREFIX))')
  const written = at('await writeFile(join(staging, RUN_RECORD), recorded(), { mode: 0o600 })')
  const named = at('await rename(staging, directory)')
  assert.ok(staged < written && written < named && named < at('owned.containers = true'))
  assert.match(stand, /const directory = join\(tmpdir\(\), runDirectoryName\(runId\)\)/)
  assert.match(
    stand,
    /owned\.services\.push\(service\)\n[^]*?await rename\(`\$\{record\}\.new`, record\)/,
  )
  // Every process of the run is started through that: web, core and the second core.
  assert.equal([...stand.matchAll(/\bstartService\(/g)].length, 2, 'its definition and one call')
})

test('the sweep takes what carries the id of a dead run, and of processes only those in its copy', () => {
  const copy = '/private/var/tmp/raditi-billing-verify-build'
  const record = {
    run: RUN,
    pid: 4242,
    copy: '/var/tmp/raditi-billing-verify-build',
    services: [
      { name: 'web', pid: 4250 },
      { name: 'core', pid: 4251 },
      { name: 'core-2', pid: 4252 },
    ],
  }
  const living =
    (...pids) =>
    (pid) =>
      pids.includes(pid)
  const containers = [
    { name: `raditi-billing-verify-${RUN}-postgres`, run: RUN },
    { name: `raditi-billing-verify-${RUN}-redis`, run: RUN },
    // Never one of another run of the stand, whatever Docker answered to the filter.
    { name: 'raditi-billing-verify-ffffffff-postgres', run: 'ffffffff' },
    { name: 'raditi-dev-postgres-1', run: undefined },
    { name: `raditi-billing-verify-${RUN}-lookalike`, run: '' },
  ]
  const seen = {
    self: 'aaaaaaaa',
    copy,
    containers,
    lockPid: 4242,
    cwds: new Map([
      [4250, `${copy}/apps/web/.next/standalone/apps/web`],
      [4251, `${copy}/apps/orchestrator`],
    ]),
  }

  // The stand is alive — another run with a copy of its own, or one kept up for hours: nothing.
  assert.equal(sweepOf(record, { ...seen, alive: living(4242, 4250, 4251) }), null)
  // This run itself is never its own leftover.
  assert.equal(sweepOf(record, { ...seen, self: RUN, alive: living() }), null)

  // The stand is gone, web lives on as an orphan; core ended by itself.
  assert.deepEqual(sweepOf(record, { ...seen, alive: living(4250) }), {
    run: RUN,
    pid: 4242,
    containers: [`raditi-billing-verify-${RUN}-postgres`, `raditi-billing-verify-${RUN}-redis`],
    processes: [{ name: 'web', pid: 4250 }],
    lock: true,
  })

  // A recorded pid that is alive but runs somewhere else was given to another process since:
  // another session's `next dev` in the repository, a shell, anything. It is left alone.
  for (const elsewhere of [
    '/Users/dev/Projects/raditi/apps/web',
    '/private/var/tmp/raditi-billing-verify-build-other/apps/web',
    '/private/var/tmp',
    '/',
    null,
    undefined,
  ]) {
    const sweep = sweepOf(record, {
      ...seen,
      alive: living(4250, 4251),
      cwds: new Map([
        [4250, elsewhere],
        [4251, `${copy}/apps/orchestrator`],
      ]),
    })
    assert.deepEqual(sweep.processes, [{ name: 'core', pid: 4251 }], String(elsewhere))
  }
  // The copy of the dead run is gone, or its directory cannot be resolved: no process is its.
  assert.deepEqual(sweepOf(record, { ...seen, copy: null, alive: living(4250) }).processes, [])
  // A lock that names someone else — the run that took the copy over — stays.
  assert.equal(sweepOf(record, { ...seen, lockPid: 5151, alive: living() }).lock, false)
  assert.equal(sweepOf(record, { ...seen, lockPid: null, alive: living() }).lock, false)
  // Nothing of it is left but its directory: that goes, and the line says so.
  const bare = sweepOf(record, { ...seen, containers: [], lockPid: null, alive: living() })
  assert.deepEqual(bare, { run: RUN, pid: 4242, containers: [], processes: [], lock: false })
  assert.equal(
    sweepLine(bare),
    `SWEPT run ${RUN}, whose stand (pid 4242) is gone without cleaning up: its run directory`,
  )
  assert.equal(
    sweepLine(sweepOf(record, { ...seen, alive: living(4250) })),
    `SWEPT run ${RUN}, whose stand (pid 4242) is gone without cleaning up: ` +
      `containers raditi-billing-verify-${RUN}-postgres, raditi-billing-verify-${RUN}-redis; ` +
      'processes web (pid 4250); its run directory; its lock of the build copy',
  )

  // The stand acts on that selection alone, before it takes the lock, and on nothing found
  // by a name: no pkill, no killall, no `docker rm` of a filter's whole answer.
  const stand = read('infra/dev/billing-verify/verify-billing.mjs')
  const [, sweep] = /async function sweepDeadRuns\(\) \{\n([^]*?)\n\}\n/.exec(stand) ?? []
  assert.ok(sweep, 'verify-billing.mjs has sweepDeadRuns')
  assert.match(
    sweep,
    /if \(record === null \|\| record\.run === runId \|\| alive\(record\.pid\)\) continue/,
  )
  assert.match(sweep, /'--filter', `label=\$\{STAND_LABEL\}=\$\{record\.run\}`/)
  assert.match(sweep, /const copy = await realpath\(record\.copy\)\.catch\(\(\) => null\)/)
  assert.match(sweep, /for \(const \{ pid \} of sweep\.processes\) signalTo\(pid, 'SIGTERM'\)/)
  assert.match(
    sweep,
    /for \(const container of sweep\.containers\) await docker\(\['rm', '-fv', container\]\)/,
  )
  assert.match(sweep, /console\.log\(sweepLine\(sweep\)\)/)
  assert.equal(
    [...sweep.matchAll(/signalTo\(/g)].length,
    2,
    'SIGTERM, then SIGKILL, of the selection',
  )
  assert.equal([...sweep.matchAll(/'rm', '-fv'/g)].length, 1)
  assert.doesNotMatch(stand, /pkill|killall|next-server'|pgrep/)
  assert.ok(
    stand.indexOf('await sweepDeadRuns()') < stand.indexOf('owned.lock = await lockCopy(copy)'),
  )
  // The README tells how to do the same by hand, and never by a name either.
  const readme = read('infra/dev/billing-verify/README.md')
  assert.match(readme, /### После аварийной остановки/)
  assert.match(readme, /docker ps -a --filter label=io\.raditi\.billing-verify/)
  assert.match(readme, /не `pkill next-server`/)
})

test('every plan document the stand cites exists, under a number no other document has', () => {
  // The documents of docs/plan are cited by number («план 37», «отчёт 35»). Two files with one
  // number are two documents such a citation cannot tell apart: the owner's checklist was
  // written as a second «39» and moved to a number of its own.
  const cited = new Set()
  for (const name of readdirSync(join(root, 'infra/dev/billing-verify'))) {
    if (!/\.(mjs|md)$/.test(name) || name === 'stand.test.mjs') continue
    for (const [, document] of read(`infra/dev/billing-verify/${name}`).matchAll(
      /docs\/plan\/([\w.-]+\.md)/g,
    ))
      cited.add(document)
  }
  // At least the plan the stand proves and the checklist of the real shop the fake stands in for.
  assert.ok(cited.has('37-billing-plan.md'))
  assert.ok(cited.size >= 2, 'the README links to the owner’s checklist')
  const documents = readdirSync(join(root, 'docs/plan'))
  for (const document of cited) {
    assert.ok(documents.includes(document), `docs/plan/${document} is cited and does not exist`)
    const [number] = document.split('-')
    assert.deepEqual(
      documents.filter((other) => other.startsWith(`${number}-`)),
      [document],
      `docs/plan has more than one document numbered ${number}`,
    )
  }
})

test('the READMEs of the two stands that prove billing count the unit in credits', () => {
  // The unit is the credit. «Правка» in these files is the editing of dates in the stand's
  // database («правкой дат»), never what an account holds or a tariff grants.
  const billing = read('infra/dev/billing-verify/README.md')
  const database = read('infra/dev/db-verify/README.md')
  for (const readme of [billing, database]) assert.doesNotMatch(readme, /правок|\d\s*правк/i)
  assert.match(billing, /баланс каждого счёта кредитов/)
  assert.match(database, /счета кредитов, журнал и модели чтения биллинга/)
})

// ─── Scenarios ────────────────────────────────────────────────────────────────

/** The first column of the table «Проверочный стенд» of the plan. */
function planRows() {
  const plan = read('docs/plan/37-billing-plan.md')
  const section = plan.slice(
    plan.indexOf('\n## Проверочный стенд\n'),
    plan.indexOf('\n## Что не входит\n'),
  )
  return [...section.matchAll(/^\| ([^|]+?) \| [^|]+? \|$/gm)]
    .map(([, row]) => row)
    .filter((row) => row !== 'Сценарий' && !/^-+$/.test(row))
}

test('every row of the plan’s table is proved by a scenario, «Возврат» included', () => {
  const rows = planRows()
  assert.equal(rows.length, 15)
  assert.ok(rows.includes('Возврат (M5.16)'))
  assert.ok(rows.includes('Подарок: регистрация, первый сайт, оплата тарифа'))
  assert.ok(rows.includes('Курс кредита: команда оператора'))
  const proved = new Set(SCENARIOS.map(({ row }) => row))
  for (const row of rows) assert.ok(proved.has(row), `no scenario proves «${row}»`)
  // And nothing claims a row the plan does not have: the rest are the four named extras.
  assert.deepEqual(
    [...proved].filter((row) => !rows.includes(row)),
    [...EXTRA_ROWS],
  )
  assert.equal(EXTRA_ROWS.length, 4)
})

test('the scenarios that are listed are the scenarios that are written', () => {
  // The order of a run is the order of SCENARIOS; the files group them by what they are about.
  assert.deepEqual([...scenarioIds].sort(), SCENARIOS.map(({ id }) => id).sort())
  assert.equal(new Set(scenarioIds).size, scenarioIds.length)
  assert.equal(new Set(SCENARIOS.map(({ id }) => id)).size, SCENARIOS.length)
  assert.match(
    read('infra/dev/billing-verify/verify-billing.mjs'),
    /const selected = SCENARIOS\.filter\(/,
  )
  for (const { id, title } of SCENARIOS) {
    assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/)
    assert.ok(title.length > 20, id)
  }
  // The README names each of them, and how many there are.
  const readme = read('infra/dev/billing-verify/README.md')
  for (const { id } of SCENARIOS) assert.ok(readme.includes(`\`${id}\``), `${id} is not in README`)
  assert.ok(readme.includes(`${SCENARIOS.length} of ${SCENARIOS.length} scenarios`))
  // The renewal row: the four outcomes of a charge, then the two that prove the letter comes
  // before the charge as a rule of the charge — a charge that waits while no notice can be
  // written, and a period that ends by the clock with nothing edited after its notice.
  assert.deepEqual(
    SCENARIOS.filter(({ row }) => row.startsWith('Продление:')).map(({ id }) => id),
    [
      'renewal-success',
      'renewal-declined',
      'renewal-http-500',
      'renewal-stuck-pending',
      'renewal-waits-for-notice',
      'renewal-in-real-time',
    ],
  )
  assert.equal(SCENARIOS.length, 26)
  // A customer starts with the gift of the registration: its scenario runs first. The credit
  // rate is approved right after it, so that one scenario ends with the pause of the platform
  // on its pages and every later one with the answer the balances give.
  assert.equal(SCENARIOS[0].id, 'signup-gift')
  assert.equal(SCENARIOS[1].id, 'credit-rate')
})

test('purchased credits are on the account wherever a tariff remainder expires', () => {
  const sourceOf = (file, id) => {
    const source = read(`infra/dev/billing-verify/${file}`)
    const start = source.indexOf(`scenarios['${id}'] = async (t) => {`)
    assert.notEqual(start, -1, id)
    const end = source.indexOf('\n}\n', start)
    return source.slice(start, end)
  }
  // The three places of the product that expire the rest of a tariff and grant a new quota:
  // a renewal, a payment by hand of an overdue tariff, a renewal that changes the tariff.
  for (const [file, id, renewed] of [
    [
      'scenarios-renewal.mjs',
      'renewal-success',
      "'when the period ends the renewal order is made and paid'",
    ],
    ['scenarios-renewal.mjs', 'renewal-declined', "'the order of the payment by hand is paid'"],
    ['scenarios-renewal.mjs', 'plan-change', "'when the period ends the renewal is paid'"],
  ]) {
    const source = sourceOf(file, id)
    const bought = source.indexOf('const pack = await packBought(t, customer)')
    const paid = source.indexOf(renewed)
    const intact = source.indexOf('await packIntact(t, workspaceId, pack, ', paid)
    assert.ok(bought !== -1 && paid !== -1 && intact !== -1, id)
    assert.ok(bought < paid && paid < intact, `${id}: the pack is bought first and checked after`)
  }
  // And the two ways a tariff ends: with its period, and after the grace of an overdue one.
  assert.match(
    sourceOf('scenarios-payment.mjs', 'pack-and-period-end'),
    /ledgerHolds\(t, workspaceId, \{ tariff: 0, pack: CREDITS\.pack \}\)/,
  )
  assert.match(
    sourceOf('scenarios-tariff.mjs', 'past-due-expires'),
    /ledgerHolds\(t, workspaceId, \{ tariff: 0, pack: CREDITS\.pack \}\)/,
  )
  // What «intact» means: the hundred credits, and a journal that is the one grant of the pack.
  const kit = read('infra/dev/billing-verify/scenario-kit.mjs')
  assert.match(kit, /ledgerHolds\(t, workspaceId, \{ tariff, pack: CREDITS\.pack \}, who\)/)
  assert.match(kit, /\[\{ kind: 'grant', amount: '100\.00', key: `order:\$\{pack\.id\}:pack` \}\]/)
})

test('the journal rule and the pages cover the three credit accounts of the domain', () => {
  const kit = read('infra/dev/billing-verify/scenario-kit.mjs')
  // The units of the stand are those of the domain, in the order credits are spent in.
  const [, list] = kit.match(/\nconst CREDIT_UNITS = \[([^\]]+)\]\n/) ?? []
  assert.deepEqual(
    list?.split(',').map((unit) => unit.trim().replaceAll("'", '')),
    Object.values(creditAccountUnits),
  )
  assert.deepEqual(Object.values(creditAccountUnits), [
    'credit_tariff',
    'credit_gift',
    'credit_pack',
  ])
  // A workspace has the three accounts or none, and the rule compares the balance of each.
  // The gift is expected whole unless a scenario names another number: the product grants it
  // with every workspace it makes.
  assert.match(kit, /made\.length !== 0 && made\.length !== CREDIT_UNITS\.length/)
  for (const [name, unit] of Object.entries(creditAccountUnits)) {
    assert.ok(kit.includes(`${name}: Number(accounts.${unit}?.balance ?? 0),`), unit)
  }
  assert.equal(CREDITS.gift, signupGiftCredits)
  assert.match(kit, /const \{ gift = CREDITS\.gift \} = expected/)
  assert.match(kit, /\{ gift, \.\.\.expected \},/)
  // Not every scenario compares balances, so «the three or none» is also asked of the whole
  // database after every scenario: `atRest` expects no workspace with another number of them.
  const [, rest] = /export async function atRest\(t\) \{\n([^]*?)\n\}\n/.exec(kit) ?? []
  assert.match(
    rest ?? '',
    /await t\.rows\(\n\s+`SELECT workspace_id, [^`]*?\n\s+FROM billing_accounts WHERE unit::text = ANY\(\$1::text\[\]\)\n\s+GROUP BY workspace_id HAVING count\(\*\) <> \$2::int`,\n\s+\[CREDIT_UNITS, CREDIT_UNITS\.length\],\n\s+\),\n\s+\[\],\n/,
  )
  // What the pages show of the gift is what its account holds, and both totals count it.
  assert.ok(
    kit.includes(
      'usage: [usage.subscription?.id ?? null, usage.gift, usage.pack, usage.totalLeft],',
    ),
  )
  assert.ok(kit.includes("const tariff = account('credit_tariff')"))
  assert.ok(kit.includes('totalAvailable: tariff.available + gift.available + pack.available,'))
  assert.ok(kit.includes('(usage.tariff?.credits.left ?? 0) + gift.available + pack.available,'))
  assert.ok(kit.includes(".some(({ kind }) => kind === 'grant')"))
  assert.ok(
    kit.includes('{ left: gift.available, held: gift.held, granted: gift.granted },'),
    'the page of usage is compared with whether the gift was granted',
  )
})

test('the pages are compared with the answer about a new task and with the meter of the period', () => {
  const kit = read('infra/dev/billing-verify/scenario-kit.mjs')
  const [, pages] =
    /export async function pagesShowWhatIsStored\(t\) \{\n([^]*?)\n\}\n/.exec(kit) ?? []
  assert.ok(pages, 'the rule of the pages is in the kit')
  // The whole of `credits` is compared, with what «Тарифы» tells of a new task; «Использование»
  // tells the same.
  assert.ok(pages.includes('credits: overview.credits,'))
  assert.ok(
    pages.includes(
      'task: [usage.spendable, usage.setAside, usage.minToStart, usage.today, usage.newTask],',
    ),
  )
  assert.ok(
    pages.includes(
      'task: [task.spendable, task.setAside, task.minToStart, task.today, task.newTask],',
    ),
  )
  assert.match(
    pages,
    /credits: \{\n\s+tariff,\n\s+gift,\n\s+pack,\n\s+totalAvailable: [^\n]+\n\s+\.\.\.task,\n\s+\},/,
  )
  // The numbers of that answer are written in the stand on their own and agree with the product.
  const constant = (name) => Number(new RegExp(`\\nconst ${name} = (\\d+)\\n`).exec(kit)?.[1])
  assert.equal(constant('MIN_START_CREDITS'), minStartCredits)
  assert.equal(constant('TASKS_PER_DAY_WITHOUT_TARIFF'), tasksPerDayWithoutTariff)
  assert.ok(pages.includes('minToStart: MIN_START_CREDITS,'))
  assert.ok(
    pages.includes(
      'today: { used: 0, limit: paid ? live.tasks_per_day : TASKS_PER_DAY_WITHOUT_TARIFF },',
    ),
  )
  // Gift credits are spent always, the others only while the tariff is paid.
  assert.ok(pages.includes("const paid = live?.status === 'active'"))
  assert.ok(
    pages.includes('const spent = (pick) => pick(gift) + (paid ? pick(tariff) + pick(pack) : 0)'),
  )
  // The answer follows from what is stored: the pause of the platform until a credit rate is
  // usable, a task that is taken from then on — five credits can always be spent in the stand,
  // which queues no task; a customer without them fails the check instead of passing as refused.
  assert.ok(pages.includes('const usable = await creditRateUsable(t)'))
  assert.ok(pages.includes('task.newTask = newTaskOf(usable, task.spendable, customer.email)'))
  const [, answer] =
    /\nfunction newTaskOf\(usable, spendable, who\) \{\n([^]*?)\n\}\n/.exec(kit) ?? []
  assert.deepEqual((answer ?? '').split('\n').slice(0, 2), [
    "  if (!usable) return { allowed: false, reason: 'rate_missing' }",
    '  if (spendable >= MIN_START_CREDITS) return { allowed: true, reason: null }',
  ])
  assert.match(answer ?? '', /throw new CheckFailed\(/)
  // A rate is usable by the rule of the product: one has started, and no price in force of an
  // enabled model started after it — asked by the clock of this host, which is web's.
  const [, usable] = /export async function creditRateUsable\(t\) \{\n([^]*?)\n\}\n/.exec(kit) ?? []
  assert.match(usable ?? '', /const now = new Date\(\)/)
  assert.match(
    usable ?? '',
    /SELECT effective_from FROM credit_rates WHERE effective_from <= \$1\s+ORDER BY effective_from DESC LIMIT 1/,
  )
  assert.match(
    usable ?? '',
    /WHERE m\.enabled AND p\.effective_from <= \$1 AND p\.effective_from > \$2 LIMIT 1/,
  )
  assert.doesNotMatch(usable ?? '', /now\(\)/)
  // «Тарифы» sells what the table of plans holds, and the table holds what the stand expects.
  assert.ok(pages.includes('sold: onSale(plans),'))
  assert.match(
    pages,
    /t\.equal\(\n\s+'the table of plans holds the terms the stand expects[^']*',\n\s+sold,\n\s+ON_SALE,\n\s+\)/,
  )
  assert.deepEqual(
    ON_SALE.plans.map(({ slug, creditsPerMonth }) => [slug, creditsPerMonth]),
    [
      ['start', CREDITS.start],
      ['business', CREDITS.business],
      ['agency', 2500],
    ],
  )
  assert.equal(ON_SALE.pack.credits, CREDITS.pack)
  // No enabled model has a price in the stand: «Точный расчёт» has no table, with a rate or not.
  assert.ok(pages.includes('conversion: plans.creditConversion,'))
  assert.ok(pages.includes('conversion: null,'))
  // The meter of the period adds up, and what is left of it is what the account has free.
  assert.ok(pages.includes('meter: usage.tariff && meterAddsUp(usage.tariff.credits),'))
  assert.ok(
    pages.includes(
      'meter: live && { addsUp: true, left: tariff.available, held: 0, heldEarlier: 0 },',
    ),
  )
  assert.ok(kit.includes('addsUp: granted === charged + held + expired + left,'))
  // A scenario that expects balances compares the accounts, not the answer beside them.
  assert.match(
    kit,
    /export const creditAccounts = \(\{ tariff, gift, pack, totalAvailable \}\) => \(\{/,
  )
  const payment = read('infra/dev/billing-verify/scenarios-payment.mjs')
  assert.equal(payment.match(/credits: creditAccounts\(overview\.credits\),/g)?.length, 2)
  assert.ok(
    payment.includes(
      'credits: { granted: 300, charged: 0, held: 0, expired: 0, left: 300, heldEarlier: 0 },',
    ),
  )
})

test('time passes for a subscription together with the order that paid for its period', () => {
  const kit = read('infra/dev/billing-verify/scenario-kit.mjs')
  const [, moves] =
    /export async function periodEndsAt\(t, subscriptionIds, end\) \{\n([^]*?)\n\}\n/.exec(kit) ??
    []
  assert.ok(moves, 'the move of a period is in the kit')
  // «Использование» finds the quota of the period by the order whose period starts with it: a
  // subscription moved alone would stand in a period nothing was granted to, and the page would
  // refuse to answer. One statement moves both; the order is the one of the period left behind.
  assert.equal(moves.match(/t\.rows\(/g)?.length, 1)
  assert.match(
    moves,
    /WITH moved AS \(\s+UPDATE subscriptions\s+SET period_anchor = \$2, current_period_start = \$3, current_period_end = \$4\s+WHERE id = ANY\(\$1::uuid\[\]\)\s+\)\s+UPDATE orders o\s+SET period_start = \$3, period_end = \$4\s+FROM subscriptions s\s+WHERE s\.id = ANY\(\$1::uuid\[\]\)\s+AND o\.subscription_id = s\.id\s+AND o\.period_start = s\.current_period_start`/,
  )
  // The first order of a renewed tariff is then shown with the period that ended.
  assert.ok(
    read('infra/dev/billing-verify/scenarios-renewal.mjs').includes(
      'period: { start: iso(ended.start), end: iso(ended.end) },',
    ),
  )
})

test('the gift of the registration is the product’s, and the stand asks for it everywhere', () => {
  const kit = read('infra/dev/billing-verify/scenario-kit.mjs')
  // The numbers and the key are written in the stand on their own and agree with the product.
  assert.equal(CREDITS.gift, 35)
  assert.equal(CREDITS.gift, signupGiftCredits)
  assert.ok(signupGiftCredits >= minStartCredits)
  const user = '0199a000-0000-7000-8000-0000000000d4'
  assert.equal(giftKey(user), `user:${user}:signup-gift`)
  assert.ok(
    read('packages/billing/src/ledger.ts').includes(
      'signupGift: (userId: string) => `user:${userId}:signup-gift`,',
    ),
  )
  // After every scenario, for every workspace of the database: one grant of the whole gift on
  // the gift account, under the key of the user who made the workspace, paid for by no order;
  // no other row under such a key and no second grant; one entry in the audit.
  const [, rest] = /export async function atRest\(t\) \{\n([^]*?)\n\}\n/.exec(kit) ?? []
  const [, rule] =
    /every workspace was granted the gift of the registration once[^]*?await t\.rows\(\n\s+`([^`]+)`,\n\s+\[CREDITS\.gift\],\n\s+\),\n\s+\[\],\n/.exec(
      rest ?? '',
    ) ?? []
  assert.ok(rule, 'atRest asks for the gift of every workspace')
  for (const part of [
    'FROM workspaces w',
    "a.unit = 'credit_gift' AND l.kind = 'grant'",
    'l.amount = $1::int AND l.order_id IS NULL',
    "l.idempotency_key = 'user:' || w.created_by_id::text || ':signup-gift') = 1",
    "l.idempotency_key LIKE 'user:%:signup-gift'",
    "g.action = 'billing.gift.grant') = 1",
  ])
    assert.ok(rule.includes(part), part)
  // Before the workspace the gift is promised whole, unless the key of the user is taken.
  assert.ok(kit.includes('giftKey(customer.id),'))
  assert.ok(
    kit.includes('const promised = workspace === null && taken === null ? CREDITS.gift : 0'),
  )
  assert.ok(kit.includes(': { balance: promised, held: 0, available: promised, granted: false }'))
  // The scenario of the gift is the one that leaves customers without a workspace behind, so
  // the promise is compared with the database when it is over.
  const payment = read('infra/dev/billing-verify/scenarios-payment.mjs')
  const start = payment.indexOf("scenarios['signup-gift'] = async (t) => {")
  assert.notEqual(start, -1)
  const gift = payment.slice(start, payment.indexOf('\n}\n', start))
  assert.match(gift, /customer\.mutate\('project\.create', \{/)
  assert.match(gift, /customer\.mutate\('billing\.startCheckout', \{/)
  assert.match(gift, /const onlooker = await t\.customer\(\)/)
  assert.doesNotMatch(gift, /onlooker\.mutate/)
})

test('a scenario drives the product from outside: no package of the product is imported', () => {
  assert.deepEqual(scenarioFiles, [
    'scenario-kit.mjs',
    'scenarios-operator.mjs',
    'scenarios-payment.mjs',
    'scenarios-renewal.mjs',
    'scenarios-tariff.mjs',
    'scenarios.mjs',
  ])
  const imports = new Set(
    [...scenarioSource.matchAll(/^(?:import .*|\}) from '([^']+)'$/gm)].map(([, from]) => from),
  )
  // Node itself, the pure parts of the stand and each other: nothing of the product.
  assert.deepEqual(
    [...imports].sort(),
    [
      './scenario-kit.mjs',
      './scenarios-operator.mjs',
      './scenarios-payment.mjs',
      './scenarios-renewal.mjs',
      './scenarios-tariff.mjs',
      './stand.mjs',
      'node:buffer',
      'node:crypto',
      'node:timers/promises',
      'node:util',
    ].sort(),
  )
  assert.doesNotMatch(scenarioSource, /@repo\/|packages\/|createRequire|node:child_process/)
  // Waits poll with a deadline: nothing sleeps for a fixed time and hopes.
  assert.equal(
    [...scenarioSource.matchAll(/\bsleep\(/g)].length,
    1,
    'one sleep: the pause of `until`',
  )
  // The seller is self-employed: no scenario expects a receipt, and two of them assert none.
  assert.ok([...scenarioSource.matchAll(/receipt: undefined/g)].length >= 2)
})

test('after every scenario nothing is left for the scheduler, the pages show what is stored, and the fake starts clean', () => {
  const source = read('infra/dev/billing-verify/scenarios.mjs')
  const [, run] =
    /export async function runScenarios[^]*?try \{\n([^]*?)\n {4}\} catch/.exec(source) ?? []
  assert.ok(run, 'runScenarios runs each scenario in a try block')
  assert.deepEqual(
    run
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('await ')),
    [
      'await t.shop.settle()',
      "await t.shop.control('reset', {})",
      'await run(t)',
      'await t.shop.settle()',
      'await atRest(t)',
      'await pagesShowWhatIsStored(t)',
      'await lettersSayWhatIsStored(t)',
    ],
  )
  // A pass a scenario paused runs again whatever became of the scenario: the runner sees to
  // it after the scenario's own `finally`.
  assert.match(source, /\} finally \{\n[^]*?await stand\.schedulers\.resumeAll\(\)/)
  const kit = read('infra/dev/billing-verify/scenario-kit.mjs')
  assert.match(
    kit,
    /await stand\.schedulers\.pause\(job\)\n\s+try \{\n\s+return await body\(\)\n\s+\} finally \{\n\s+await stand\.schedulers\.resume\(job\)/,
  )
  // Every scenario ends with the check that each renewal order of the run was announced, and
  // a failure of it prints the order with the notices of its subscription.
  const [, rest] = /export async function atRest\(t\) \{\n([^]*?)\n\}\n/.exec(kit) ?? []
  assert.ok(rest?.trimEnd().endsWith('await renewalsWereAnnounced(t)'))
  assert.match(kit, /unannounced\.push\(\{\n\s+order: \{[^]*?notices: written\.map\(/)
  // A scenario that changes the price list puts it back in `finally`.
  const renewal = read('infra/dev/billing-verify/scenarios-renewal.mjs')
  const changes = [...scenarioSource.matchAll(/UPDATE plans SET/g)].length
  assert.equal(changes, 2, 'one change and its restore')
  assert.match(
    renewal,
    /\} finally \{\n\s+await t\.rows\(`UPDATE plans SET price = \$1 WHERE slug = 'business'`, \[PRICE\.business\]\)/,
  )
})

test('the operator approves the credit rate in the stand, and only there', () => {
  const operator = read('infra/dev/billing-verify/scenarios-operator.mjs')
  const start = operator.indexOf("scenarios['credit-rate'] = async (t) => {")
  assert.notEqual(start, -1)
  const scenario = operator.slice(start, operator.indexOf('\n}\n', start))
  // The provisional rate of the credits model: the steps of an attempt stay inside the limit of
  // one turn key — 120, 270 and 720 RUB.
  assert.equal(CREDIT_RATE, '6.00')
  assert.deepEqual(
    Object.entries(attemptStepCredits).map(
      ([modelClass, credits]) =>
        `${modelClass} — ${credits} кредитов, ${(credits * Number(CREDIT_RATE)).toFixed(2)} ₽`,
    ),
    [
      'light — 20 кредитов, 120.00 ₽',
      'standard — 45 кредитов, 270.00 ₽',
      'heavy — 120 кредитов, 720.00 ₽',
    ],
  )
  assert.ok(
    scenario.includes(
      "'light — 20 кредитов, 120.00 ₽; standard — 45 кредитов, 270.00 ₽; heavy — 120 кредитов, 720.00 ₽'",
    ),
  )
  // Before: no rate, and the pause on every page. Two refusals that write nothing. Then the
  // approval, by the command and by nothing else: no scenario writes the table itself.
  assert.match(
    scenario,
    /'no credit rate is in force yet[^']*',\n\s+\[await rates\(\), await creditRateUsable\(t\)\],\n\s+\[\[\], false\],/,
  )
  assert.equal(scenario.match(/t\.operator\('billing-rates', /g)?.length, 3)
  assert.match(scenario, /'--effective-from',\n\s+'2026-01-01T00:00:00\.000\+03:00',/)
  assert.match(
    scenario,
    /\[await rates\(\), await approvals\(\), await told\(paying\.customer\)\],\n\s+\[\[\], \[\], both\(PAUSED, 435\)\],/,
  )
  assert.match(scenario, /\[both\(TAKEN, 35\), both\(TAKEN, 35\), both\(TAKEN, 435\)\],/)
  assert.doesNotMatch(
    scenarioSource,
    /INSERT INTO credit_rates|UPDATE credit_rates|DELETE FROM credit_rates/,
  )
  assert.equal(scenarioSource.match(/t\.operator\('billing-rates', /g)?.length, 3)
})

test('each rule of expiry of the credits model is a check of a scenario, on the three journals', () => {
  // docs/research/2026-10-credits/credits-design.md, «Правила сгорания в одном месте»: what a
  // renewal, the end of a tariff and the refund of a pack do to each of the three accounts.
  // The rule about a reserve is not here: nothing sets credits aside before the task queue.
  const sourceOf = (file, id) => {
    const source = read(`infra/dev/billing-verify/${file}`)
    const start = source.indexOf(`scenarios['${id}'] = async (t) => {`)
    const dotted = source.indexOf(`scenarios.${id} = async (t) => {`)
    const from = start === -1 ? dotted : start
    assert.notEqual(from, -1, id)
    return source.slice(from, source.indexOf('\n}\n', from))
  }
  const rules = [
    [
      'scenarios-renewal.mjs',
      'renewal-success',
      'a renewal: of the three accounts only the tariff moved',
    ],
    [
      'scenarios-renewal.mjs',
      'renewal-declined',
      'a payment while overdue: of the three accounts only the tariff moved',
    ],
    [
      'scenarios-payment.mjs',
      'pack-and-period-end',
      'a tariff that is not renewed: the rest of its quota expired',
    ],
    [
      'scenarios-tariff.mjs',
      'past-due-expires',
      'a tariff unpaid for seven days: the rest of its quota expired',
    ],
    [
      'scenarios-operator.mjs',
      'refund',
      'a refund with --end-subscription: the rest of the quota expired',
    ],
    [
      'scenarios-operator.mjs',
      'refund',
      'a refund with --take-credits: the hundred of that pack is taken',
    ],
  ]
  for (const [file, id, rule] of rules) {
    const source = sourceOf(file, id)
    const at = source.indexOf(`'${rule}`)
    assert.notEqual(at, -1, `${id}: «${rule}»`)
    // The check compares the journals of all three accounts, whole.
    const check = source.slice(at, source.indexOf('\n  )\n', at))
    assert.match(check, /await journalsOf\(t, workspaceId\),\n\s+\{\n\s+tariff: \[/, rule)
    assert.match(check, /\n\s+gift: \[giftGrant\(customer\.id\)\],\n\s+pack: \[/, rule)
  }
  // The pack that is refunded: two were bought, and only its own hundred is taken.
  const refund = sourceOf('scenarios-operator.mjs', 'refund')
  assert.match(refund, /const second = await packBought\(t, customer, /)
  assert.match(
    refund,
    /pack: \[\s+journalRow\.pack\(\{ id: pack\.orderId \}\),\s+journalRow\.pack\(second\),\s+journalRow\.packTaken\(\{ id: pack\.orderId \}\),\s+\],/,
  )
  // What the journals are made of: the keys the product writes its rows under.
  const order = { id: '0199a000-0000-7000-8000-00000000000a' }
  const subscription = { id: '0199a000-0000-7000-8000-00000000000b' }
  const end = new Date('2026-10-18T09:00:00.000Z')
  assert.deepEqual(
    [
      journalRow.quota(order),
      journalRow.quota(order, 800),
      journalRow.expired(subscription, end),
      journalRow.pack(order),
      journalRow.packTaken(order),
      giftGrant('0199a000-0000-7000-8000-0000000000d4'),
    ],
    [
      { kind: 'grant', amount: '300.00', key: `order:${order.id}:grant` },
      { kind: 'grant', amount: '800.00', key: `order:${order.id}:grant` },
      { kind: 'expire', amount: '-300.00', key: `sub:${subscription.id}:${end.getTime()}:expire` },
      { kind: 'grant', amount: '100.00', key: `order:${order.id}:pack` },
      { kind: 'adjust', amount: '-100.00', key: `order:${order.id}:refund:adjust` },
      {
        kind: 'grant',
        amount: '35.00',
        key: 'user:0199a000-0000-7000-8000-0000000000d4:signup-gift',
      },
    ],
  )
  const ledger = read('packages/billing/src/ledger.ts')
  for (const key of [
    'tariffGrant: (orderId: string) => `order:${orderId}:grant`,',
    'packGrant: (orderId: string) => `order:${orderId}:pack`,',
    'refundAdjust: (orderId: string) => `order:${orderId}:refund:adjust`,',
  ])
    assert.ok(ledger.includes(key), key)
  // A whole gift is one row of the journal, wherever a scenario compares balances.
  const kit = read('infra/dev/billing-verify/scenario-kit.mjs')
  assert.match(
    kit,
    /if \(gift === CREDITS\.gift\) \{\n[^]*?const untouched = \[giftGrant\(owner\.id\)\]\n\s+if \(!isDeepStrictEqual\(journal\(accounts\.credit_gift\), untouched\)\)\n\s+throw new CheckFailed\(/,
  )
  // The README names the rule every scenario proves, and the one the stand cannot reach.
  const readme = read('infra/dev/billing-verify/README.md')
  assert.match(readme, /### Правила сгорания/)
  for (const [, id] of rules) assert.ok(readme.includes(`\`${id}\``), id)
})

// ─── Letters ──────────────────────────────────────────────────────────────────

test('what a letter is made of is kept by a mirror of the outbox in the stand’s own database', () => {
  // The product keeps none of it: the relay clears the payload of a published row, and a
  // delivered notification leaves Redis at once.
  assert.match(
    read('apps/orchestrator/src/outbox/outbox-relay.service.ts'),
    /payload: Prisma\.DbNull,/,
  )
  assert.match(
    read('apps/orchestrator/src/queue/queues.ts'),
    /notifications: \{\n\s+attempts: 8,\n[^]*?removeOnComplete: true,/,
  )
  assert.equal(LETTER_MIRROR, 'stand_letter_mirror')
  const [table, copy, trigger] = LETTER_MIRROR_SQL
  assert.equal(LETTER_MIRROR_SQL.length, 3)
  assert.match(table, /^CREATE TABLE stand_letter_mirror \(\n\s+seq bigserial PRIMARY KEY,/)
  assert.match(
    copy,
    /INSERT INTO stand_letter_mirror \(id, type, dedupe_key, payload, created_at\)\n\s+VALUES \(NEW\.id, NEW\.type, NEW\.dedupe_key, NEW\.payload, NEW\.created_at\);/,
  )
  // After the insert, in its transaction, and only for letters: nothing of the row is changed.
  assert.match(
    trigger,
    /AFTER INSERT ON outbox_events\n\s+FOR EACH ROW WHEN \(NEW\.topic = 'notifications' AND NEW\.payload IS NOT NULL\)/,
  )
  assert.doesNotMatch(LETTER_MIRROR_SQL.join('\n'), /BEFORE|UPDATE|DELETE|RETURN NEW/)
  // The name of the table is no name of the product's schema.
  assert.doesNotMatch(read('packages/db/prisma/schema.prisma'), /stand_letter_mirror/)
  // Made after the migrations and the seeds, before any process of the product starts.
  const stand = read('infra/dev/billing-verify/verify-billing.mjs')
  const made = stand.indexOf('for (const statement of LETTER_MIRROR_SQL) await db.query(statement)')
  assert.ok(made > stand.indexOf("for (const script of ['db:deploy', 'db:seed'])"))
  assert.ok(made < stand.indexOf("stage = 'starting the fake ЮKassa, web and core'"))
  // The scenarios read it, and nothing of them writes to it.
  const kit = read('infra/dev/billing-verify/scenario-kit.mjs')
  assert.match(kit, /FROM \$\{LETTER_MIRROR\} WHERE \$\{where\} ORDER BY seq`/)
  assert.doesNotMatch(scenarioSource, /INSERT INTO \$\{LETTER_MIRROR\}|stand_letter_mirror/)
})

test('a letter is read by the mailer of the product: its catalogue, its templates, no transport', () => {
  // The program imports the two packages core delivers a notification with, and nothing else.
  assert.deepEqual(
    [...LETTER_READER.matchAll(/^import .* from '([^']+)'$/gm)].map(([, from]) => from),
    ['@repo/mail', '@repo/notifications'],
  )
  assert.match(LETTER_READER, /await deliverNotification\(\{ type, payload \}, \{ mailer \}\)/)
  assert.doesNotMatch(LETTER_READER, /process\.env|DATABASE_URL|fetch\(|node:fs/)
  // What the notifications worker of core calls with a job is that function.
  assert.match(
    read('apps/orchestrator/src/notifications/notifications.processor.ts'),
    /deliverNotification\(/,
  )
  const stand = read('infra/dev/billing-verify/verify-billing.mjs')
  assert.match(
    stand,
    /inCopy\(\['--input-type=module', '-e', LETTER_READER\], \{\n\s+env: letterReaderEnvironment\(shared\),\n\s+input: JSON\.stringify\(rows\),/,
  )
  assert.match(stand, /cwd: join\(copy, 'apps\/orchestrator'\),\n\s+env,/)

  // And it reads: the program itself, on the sources of this tree, as it runs in the copy.
  const rows = [
    {
      type: 'billing.payment_succeeded',
      payload: {
        to: 'reader@example.ru',
        item: 'plan',
        planName: 'Агентство',
        amount: '39900.00',
        periodEnd: '2026-11-18T09:00:00.000Z',
        credits: 2500,
        appUrl: 'http://127.0.0.1:43100',
      },
    },
    {
      type: 'billing.payment_succeeded',
      payload: {
        to: 'reader@example.ru',
        item: 'pack',
        packCredits: 100,
        amount: '1990.00',
        appUrl: 'http://127.0.0.1:43100',
      },
    },
  ]
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', LETTER_READER], {
    cwd: join(root, 'apps/orchestrator'),
    env: { PATH: process.env.PATH, HOME: tmpdir(), TMPDIR: tmpdir() },
    input: JSON.stringify(rows),
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(run.status, 0, run.stderr)
  const [tariff, pack] = JSON.parse(run.stdout)
  assert.deepEqual(
    [tariff.to, tariff.subject, pack.subject],
    ['reader@example.ru', 'Оплата прошла', 'Оплата прошла'],
  )
  // The sentences the stand expects, in its own words, are the sentences of the letters.
  const plainText = (text) => text.replaceAll('\u00a0', ' ')
  for (const sentence of [
    `Оплата прошла: тариф «Агентство» — ${rubles('39900.00')}.`,
    `Тариф действует до ${moscowDate('2026-11-18T09:00:00.000Z')}. Начислили ${creditsCount(2500)} на этот период.`,
    'http://127.0.0.1:43100/settings/plans',
  ])
    assert.ok(plainText(tariff.text).includes(sentence), `${sentence}\n${tariff.text}`)
  for (const sentence of [
    `Оплата прошла: пакет из ${counted(100)} кредитов — ${rubles('1990.00')}.`,
    'Кредиты из пакета уже добавлены и не сгорают в конце периода.',
  ])
    assert.ok(plainText(pack.text).includes(sentence), `${sentence}\n${pack.text}`)
  // A row that is no notification of the catalogue is refused, not passed over.
  const refused = spawnSync(process.execPath, ['--input-type=module', '-e', LETTER_READER], {
    cwd: join(root, 'apps/orchestrator'),
    env: { PATH: process.env.PATH, HOME: tmpdir(), TMPDIR: tmpdir() },
    input: JSON.stringify([{ type: 'billing.payment_succeeded', payload: { to: 'x' } }]),
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.notEqual(refused.status, 0)
})

test('the words the stand expects of a letter are written on their own and agree with the product', () => {
  const plainText = (text) => text.replaceAll('\u00a0', ' ')
  for (const count of [1, 2, 5, 35, 100, 300, 800, 2500, 12_345])
    assert.equal(counted(count), plainText(formatCount(count)), String(count))
  assert.deepEqual([1, 2, 5, 11, 21, 35, 100, 2500].map(creditsCount), [
    '1 кредит',
    '2 кредита',
    '5 кредитов',
    '11 кредитов',
    '21 кредит',
    '35 кредитов',
    '100 кредитов',
    '2 500 кредитов',
  ])
  for (const amount of ['4900.00', '12900.00', '1990.00', '1990.50', '39900.00'])
    assert.equal(rubles(amount), plainText(formatRubles(amount)), amount)
  // The Moscow day: 21:30 UTC is already tomorrow there.
  for (const instant of ['2026-10-18T09:00:00.000Z', '2026-12-31T21:30:00.000Z'])
    assert.equal(moscowDate(instant), plainText(formatMoscowDate(instant)), instant)
  assert.equal(moscowDate('2026-12-31T21:30:00.000Z'), '1 января 2027')
  // Every letter about a payment or about the end of a tariff is compared after every
  // scenario, with numbers that come from the journal and the accounts.
  const kit = read('infra/dev/billing-verify/scenario-kit.mjs')
  assert.match(
    kit,
    /const LETTER_RULES = \{\n\s+'billing\.payment_succeeded': paidLetterSays,\n\s+'billing\.payment_failed': failedLetterSays,\n\s+'billing\.subscription_ended': endedLetterSays,\n\}/,
  )
  assert.match(
    kit,
    /l\.kind = 'grant' AND l\.idempotency_key = 'order:' \|\| o\.id::text \|\| ':grant'\) AS quota/,
  )
  assert.match(kit, /Начислили \$\{creditsCount\(order\.quota \?\? 0\)\} на этот период\./)
  // «Тариф закончился» counts what is free on the gift and on the pack — the balance less what
  // is set aside —, as the product writes the letter: the two differ under the first reserve.
  const ended = kit.slice(
    kit.indexOf('async function endedLetterSays('),
    kit.indexOf('async function failedLetterSays('),
  )
  for (const [unit, name] of [
    ['credit_gift', 'gift'],
    ['credit_pack', 'pack'],
  ])
    assert.ok(
      ended.includes(
        `COALESCE((SELECT (a.balance - a.held)::int FROM billing_accounts a\n` +
          `                 WHERE a.workspace_id = s.workspace_id AND a.unit = '${unit}'), 0) AS ${name}`,
      ),
      `the ${name} of the letter is what is free on the account`,
    )
  assert.doesNotMatch(ended, /a\.balance::int/)
  const periodEnd = read('packages/billing/src/renewal.ts')
  assert.match(periodEnd, /const packCreditsLeft = left\.pack\.available\n/)
  assert.match(periodEnd, /giftCreditsLeft: left\.gift\.available,\n/)
  assert.match(kit, /const letters = await t\.newMail\(Object\.keys\(LETTER_RULES\)\)/)
  // The keys of those letters end with the id the rule looks its row up by.
  assert.ok(
    read('packages/billing/src/settlement.ts').includes(
      'export const paymentLetterKey = (orderId: string) => `billing.payment_succeeded:${orderId}`',
    ),
  )
  assert.ok(
    read('packages/billing/src/settlement.ts').includes(
      'export const paymentFailedLetterKey = (orderId: string) => `billing.payment_failed:${orderId}`',
    ),
  )
  assert.match(
    read('packages/billing/src/renewal.ts'),
    /export const subscriptionEndedLetterKey = \(subscriptionId: string\) =>\n\s+`billing\.subscription_ended:\$\{subscriptionId\}`/,
  )
})

// ─── Time ─────────────────────────────────────────────────────────────────────

const at = (text) => new Date(text)

test('a month later by the Moscow calendar: the day of the anchor, the last day of a short month', () => {
  // 31 January → 28 February → 31 March: the day comes back (default «в» of the plan).
  const anchor = at('2026-01-31T09:00:00.000Z')
  const february = moscowMonthLater(anchor, anchor)
  assert.equal(february.toISOString(), '2026-02-28T09:00:00.000Z')
  assert.equal(moscowMonthLater(anchor, february).toISOString(), '2026-03-31T09:00:00.000Z')
  // A leap year keeps the 29th.
  assert.equal(
    moscowMonthLater(at('2028-01-30T09:00:00.000Z'), at('2028-01-30T09:00:00.000Z')).toISOString(),
    '2028-02-29T09:00:00.000Z',
  )
  // 00:30 in Moscow is still the day before in UTC: the month is the Moscow one.
  const night = at('2026-10-31T21:30:00.000Z') // 1 November, 00:30 in Moscow
  assert.equal(moscowMonthLater(night, night).toISOString(), '2026-11-30T21:30:00.000Z')
  // December runs into the next year.
  const december = at('2026-12-15T12:00:00.123Z')
  assert.equal(moscowMonthLater(december, december).toISOString(), '2027-01-15T12:00:00.123Z')
})

test('time is moved to dates the product takes for a period of its own making', () => {
  // 31 March is two months after 31 January: no 31 February exists.
  const march = periodEndingAt(at('2026-03-31T09:00:00.000Z'))
  assert.deepEqual(
    [march.anchor.toISOString(), march.start.toISOString(), march.end.toISOString()],
    ['2026-01-31T09:00:00.000Z', '2026-02-28T09:00:00.000Z', '2026-03-31T09:00:00.000Z'],
  )
  const plain = periodEndingAt(at('2026-10-09T18:30:15.250Z'))
  assert.deepEqual(
    [plain.anchor.toISOString(), plain.start.toISOString()],
    ['2026-09-09T18:30:15.250Z', '2026-09-09T18:30:15.250Z'],
  )
  // Every hour and a quarter of three years: the product's own arithmetic takes the end as a
  // boundary of the anchor (it would re-anchor the tariff otherwise), starts the next period
  // there, and ends it where the rule written in the stand says.
  let checked = 0
  for (
    let moment = Date.UTC(2026, 0, 1, 0, 7, 3, 11);
    moment < Date.UTC(2029, 0, 1);
    moment += 75 * 60_000
  ) {
    const end = new Date(moment)
    const { anchor, start } = periodEndingAt(end)
    const next = nextBillingPeriod(anchor, end)
    assert.equal(next.start.getTime(), end.getTime())
    assert.equal(next.end.getTime(), moscowMonthLater(anchor, end).getTime(), end.toISOString())
    // The current period is one of the anchor's own months, and ends where it must.
    assert.ok(start.getTime() < end.getTime() && start.getTime() >= anchor.getTime())
    assert.equal(moscowMonthLater(anchor, start).getTime(), end.getTime(), end.toISOString())
    const months = Math.round((end.getTime() - anchor.getTime()) / (30 * 24 * 60 * 60_000))
    assert.equal(addBillingMonths(anchor, months).getTime(), end.getTime(), end.toISOString())
    assert.ok(months === 1 || months === 2)
    checked += 1
  }
  assert.ok(checked > 20_000)
})

// ─── Readers ──────────────────────────────────────────────────────────────────

test('tRPC over HTTP: superjson input in the query string, data or the refusal with its codes', () => {
  assert.equal(
    trpcQueryUrl('http://127.0.0.1:1', 'billing.overview'),
    'http://127.0.0.1:1/api/trpc/billing.overview',
  )
  assert.equal(
    trpcQueryUrl('http://127.0.0.1:1', 'billing.payments', { limit: 5 }),
    'http://127.0.0.1:1/api/trpc/billing.payments?input=%7B%22json%22%3A%7B%22limit%22%3A5%7D%7D',
  )
  assert.deepEqual(
    trpcOutcome(200, { result: { data: { json: { subscription: null }, meta: { values: {} } } } }),
    { ok: true, status: 200, data: { subscription: null } },
  )
  assert.deepEqual(trpcOutcome(200, { result: { data: { json: null } } }), {
    ok: true,
    status: 200,
    data: null,
  })
  assert.deepEqual(
    trpcOutcome(409, {
      error: {
        json: {
          message: 'Тариф уже оформлен. Обновите страницу, чтобы увидеть его',
          code: -32009,
          data: { code: 'CONFLICT', httpStatus: 409, domainCode: 'BILLING_SUBSCRIPTION_EXISTS' },
        },
      },
    }),
    {
      ok: false,
      status: 409,
      code: 'CONFLICT',
      domainCode: 'BILLING_SUBSCRIPTION_EXISTS',
      message: 'Тариф уже оформлен. Обновите страницу, чтобы увидеть его',
    },
  )
  // Not an answer of tRPC at all: a refusal without codes, never a success.
  assert.deepEqual(trpcOutcome(502, null), {
    ok: false,
    status: 502,
    code: null,
    domainCode: null,
    message: null,
  })
  // The transformer of the product is superjson, as the readers expect.
  assert.match(read('packages/trpc/src/trpc.ts'), /transformer: superjson/)
})

test('the cookies of a session: set, replaced, and dropped when the server deletes one', () => {
  const first = cookieHeader([
    'better-auth.session_token=abc.def%3D; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax',
    'theme=dark; Path=/',
  ])
  assert.equal(first, 'better-auth.session_token=abc.def%3D; theme=dark')
  assert.equal(
    cookieHeader(['theme=light; Path=/'], first),
    'better-auth.session_token=abc.def%3D; theme=light',
  )
  assert.equal(
    cookieHeader(['better-auth.session_token=; Max-Age=0; Path=/', 'broken'], first),
    'theme=dark',
  )
  assert.equal(cookieHeader([], ''), '')
})

test('letters are read from the log of core’s mailer: subject, recipient, links', () => {
  const log = [
    '[Orchestrator] 1  - 10/09/2026, 10:07:08 PM     LOG [Mail] [mail] not sent (SENDSAY_API_KEY is empty): "Подтвердите адрес почты" to a@example.ru',
    '  http://127.0.0.1:1/api/auth/verify-email?token=t.o.k&callbackURL=%2F',
    '[Orchestrator] 1  - 10/09/2026, 10:07:09 PM     LOG [Billing] billing notices: notified=1',
    '  http://127.0.0.1:1/not-a-letter',
    '[Orchestrator] 1  - 10/09/2026, 10:07:09 PM     LOG [Mail] [mail] not sent (SENDSAY_API_KEY is empty): "Скоро спишем 4\u00a0900\u00a0₽ за тариф «Старт»" to b@example.ru',
    '  http://127.0.0.1:1/settings/plans',
    '  http://127.0.0.1:1/terms',
    '',
  ].join('\n')
  assert.deepEqual(lettersOf(log), [
    {
      subject: 'Подтвердите адрес почты',
      to: 'a@example.ru',
      links: ['http://127.0.0.1:1/api/auth/verify-email?token=t.o.k&callbackURL=%2F'],
    },
    {
      subject: 'Скоро спишем 4\u00a0900\u00a0₽ за тариф «Старт»',
      to: 'b@example.ru',
      links: ['http://127.0.0.1:1/settings/plans', 'http://127.0.0.1:1/terms'],
    },
  ])
  assert.deepEqual(lettersOf(''), [])
  // The line is the one the log transport of @repo/mail writes.
  assert.ok(
    read('packages/mail/src/transport.ts').includes(
      '`[mail] not sent (SENDSAY_API_KEY is empty): "${email.subject}" to ${email.to}`',
    ),
  )
})

test('a counter of a core process is summed over the series its labels match', () => {
  const text = [
    '# HELP raditi_billing_renewal_rows_total Rows of the renewal passes',
    '# TYPE raditi_billing_renewal_rows_total counter',
    'raditi_billing_renewal_rows_total{job="charges",outcome="renewed"} 3',
    'raditi_billing_renewal_rows_total{job="charges",outcome="skipped"} 2',
    'raditi_billing_renewal_rows_total{job="notices",outcome="notified"} 5',
    'raditi_billing_renewal_rows_total_created{job="charges",outcome="renewed"} 1791572828',
    '',
  ].join('\n')
  const name = 'raditi_billing_renewal_rows_total'
  assert.equal(metricValue(text, name, { job: 'charges', outcome: 'renewed' }), 3)
  assert.equal(metricValue(text, name, { job: 'charges' }), 5)
  assert.equal(metricValue(text, name), 10)
  assert.equal(metricValue(text, name, { job: 'charges', outcome: 'blocked' }), 0)
  // The counter and its labels are the ones the billing module of core registers.
  const module = read('apps/orchestrator/src/billing/billing.module.ts')
  assert.match(module, /name: 'raditi_billing_renewal_rows_total'/)
  assert.match(module, /labelNames: \['job', 'outcome'\]/)
})

// ─── The command and its workflow ─────────────────────────────────────────────

/** Workspace packages a workspace depends on, through other workspace packages too. */
function workspaceDependencies(workspace, seen = new Set()) {
  const { dependencies = {} } = JSON.parse(read(`${workspace}/package.json`))
  for (const name of Object.keys(dependencies)) {
    if (!name.startsWith('@repo/') || seen.has(name)) continue
    seen.add(name)
    workspaceDependencies(`packages/${name.slice('@repo/'.length)}`, seen)
  }
  return seen
}

test('pnpm verify:billing runs the stand, and a signal sent to it reaches the stand', () => {
  // `exec`: without it a SIGTERM sent to the command would end the shell and leave the stand,
  // its two builds and its containers behind.
  assert.equal(
    JSON.parse(read('package.json')).scripts['verify:billing'],
    'exec node infra/dev/billing-verify/verify-billing.mjs',
  )
  // `pnpm test:infra` picks this file up.
  assert.equal(
    JSON.parse(read('package.json')).scripts['test:infra'],
    'node --test infra/*/*.test.mjs infra/dev/*/*.test.mjs',
  )
})

test('the billing workflow starts on every source the stand builds and runs', () => {
  const source = read('.github/workflows/billing.yml')
  const filter = [
    ...(/^ {4}paths:\n((?: {6}(?:- .+|#.*)\n)+)/m.exec(source)?.[1] ?? '').matchAll(
      /^ {6}- (.+)$/gm,
    ),
  ].map(([, pattern]) => pattern)
  // GitHub's filter patterns as the workflows use them: `**` crosses directories, `*` does not.
  const starts = (file) =>
    filter.some((pattern) =>
      new RegExp(
        `^${pattern
          .split('**')
          .map((part) => part.replace(/[.+^$(){}|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*'))
          .join('.*')}$`,
      ).test(file),
    )
  assert.ok(filter.length >= 8, 'billing.yml has a path filter')
  // The stand itself, the fake and whatever its scripts import from the repository.
  const stand = readdirSync(join(root, 'infra/dev/billing-verify')).map(
    (name) => `infra/dev/billing-verify/${name}`,
  )
  for (const file of stand) assert.ok(starts(file), `${file} does not start the workflow`)
  for (const script of ['verify-billing.mjs', 'stand.mjs', 'fake-yookassa.mjs', ...scenarioFiles])
    for (const [, from] of read(`infra/dev/billing-verify/${script}`).matchAll(
      /^import .* from '(\.\.\/[^']+)'$/gm,
    ))
      assert.ok(
        starts(join('infra/dev/billing-verify', from)),
        `${from}, imported by ${script}, does not start the workflow`,
      )
  // The two applications it builds, every workspace package they are built from, and what
  // decides the versions of all of them.
  const packages = new Set([
    ...workspaceDependencies('apps/web'),
    ...workspaceDependencies('apps/orchestrator'),
  ])
  for (const name of ['@repo/billing', '@repo/yookassa', '@repo/db', '@repo/trpc', '@repo/auth'])
    assert.ok(packages.has(name), `the stand builds ${name}`)
  for (const name of packages)
    assert.ok(
      starts(`packages/${name.slice('@repo/'.length)}/src/index.ts`),
      `${name} does not start the workflow`,
    )
  for (const file of [
    'apps/web/src/app/api/webhooks/yookassa/route.ts',
    'apps/web/next.config.ts',
    'apps/orchestrator/src/billing/billing.module.ts',
    'apps/orchestrator/scripts/billing-refund.mjs',
    'packages/db/prisma/migrations/x/migration.sql',
    'packages/db/prisma/seed/data.ts',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    '.nvmrc',
    '.github/workflows/billing.yml',
    '.github/actions/setup/action.yml',
  ])
    assert.ok(starts(file), `${file} does not start the workflow`)
  // Not on what the stand never builds or reads.
  for (const file of ['docs/plan/37-billing-plan.md', 'apps/e2e/tests/billing/plans.spec.ts'])
    assert.ok(!starts(file), `${file} starts the workflow`)

  // The stand never pulls: the workflow pulls exactly the two images it pins.
  const pull = /^ {6}- name: Pull the pinned images\n {8}run: \|\n((?: {10}.*\n)+)/m.exec(source)
  assert.ok(pull, 'billing.yml pulls the pinned images')
  assert.match(pull[1], /docker pull --quiet "\$image"/)
  assert.deepEqual(
    [...pull[1].matchAll(/(\S+@sha256:[a-f0-9]{64})/g)].map(([, image]) => image).sort(),
    [POSTGRES_IMAGE, REDIS_IMAGE].sort(),
  )
  const runs = [...source.matchAll(/^ {8}run: (.+)$/gm)]
    .map(([, command]) => command)
    .filter((command) => command !== '|')
  // No `pnpm db:generate` and no build step: the stand builds in its own copy of the tree.
  assert.deepEqual(runs, ['pnpm verify:billing'])
  // The logs of a failed run outlive the run directory: the stand leaves them where the
  // workflow says, and the workflow uploads that directory — only then, by a pinned action.
  const logs = '${{ runner.temp }}/billing-logs'
  assert.ok(
    source.includes(
      `        env:\n          # Where the stand leaves the logs of web and core when it fails, before it removes\n          # its run directory.\n          BILLING_VERIFY_LOG_DIR: ${logs}\n        run: pnpm verify:billing\n`,
    ),
  )
  const upload = /^ {6}- name: Upload the logs of a failed run\n((?: {8}.*\n)+)/m.exec(source)
  assert.ok(upload, 'billing.yml uploads the logs of a failed run')
  assert.match(upload[1], /^ {8}if: failure\(\)$/m)
  assert.match(upload[1], /^ {8}uses: actions\/upload-artifact@[a-f0-9]{40} # v\d+\.\d+\.\d+$/m)
  assert.ok(upload[1].includes(`          path: ${logs}\n`))
  assert.ok(
    source.indexOf('run: pnpm verify:billing') < source.indexOf('Upload the logs of a failed run'),
  )
  for (const [, action] of source.matchAll(/^\s+(?:- )?uses: (\S+)/gm))
    assert.match(action, /^(\.\/|[\w-]+\/[\w-]+@[a-f0-9]{40}$)/, `${action} is pinned by commit`)
  assert.match(source, /^ {4}runs-on: ubuntu-latest$/m)
  assert.match(source, /^ {6}- name: Setup toolchain\n {8}uses: \.\/\.github\/actions\/setup$/m)
  assert.match(source, /^permissions:\n {2}contents: read$/m)
  // Synthetic data only: the job is given no secret.
  assert.doesNotMatch(source, /secrets\./)
})
