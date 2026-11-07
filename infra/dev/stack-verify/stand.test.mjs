// Contract of the pure parts of the stand of the site stacks (pnpm test:infra;
// docs/plan/62-slices/e3.md, Э3.10): its options, its names, its images, the records of the stacks,
// the groups of a build, the environment of core and the scan of what a run left. Nothing here
// starts Docker or a process.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { BUILT_IMAGES, standNames } from '../release-verify/stand.mjs'
import { CMS_ARCHIVES } from './fetch-cms.mjs'
import {
  STACK_BUILT_IMAGES,
  STACK_LABEL,
  STAND_FIELDS,
  STAND_GROUPS,
  WRITTEN_GROUPS,
  buildNames,
  groupsOf,
  needleScanner,
  productionArgs,
  siteImageTag,
  stackCoreEnvironment,
  stackNames,
  standOptions,
  standProblems,
} from './stand.mjs'
import { STACK_STANDS } from './stacks.mjs'

/** The vendor whose core may not be here (plan 62, §5), named in parts: no file of the stand says it. */
const closed = ['bit', 'rix'].join('')
const run = '0a1b2c3d'

test('the options take the stacks, the builds, the groups and the runtime only', () => {
  const all = standOptions([])
  assert.equal(all.build, true)
  assert.equal(all.keep, false)
  assert.equal(all.runtime, 'runc')
  assert.deepEqual(all.stacks, Object.keys(STACK_STANDS))
  // Every build of every stack, each with the written groups it runs.
  assert.deepEqual(
    all.runs.map(({ build }) => build.archive),
    Object.values(STACK_STANDS).flatMap((stand) => stand.builds.map((build) => build.archive)),
  )
  for (const entry of all.runs) assert.deepEqual(entry.groups, ['import'])
  assert.deepEqual(all.unwritten, ['preview', 'release'])

  const named = standOptions([
    '--',
    '--stack=joomla',
    '--build=joomla-5.4.10',
    '--build=joomla-6.2.0',
    '--group=import',
    '--no-build',
    '--keep',
    '--runtime=runsc',
  ])
  assert.equal(named.build, false)
  assert.equal(named.keep, true)
  assert.equal(named.runtime, 'runsc')
  assert.deepEqual(
    named.runs.map(({ stack, build, groups }) => [stack, build.archive, groups]),
    [
      ['joomla', 'joomla-5.4.10', ['import']],
      ['joomla', 'joomla-6.2.0', ['import']],
    ],
  )
  assert.deepEqual(named.unwritten, [])
})

test('the options refuse a stack, a build, a group or a runtime the stand does not have', () => {
  // The closed CMS has no row: the refusal lists the stacks there are.
  assert.throws(
    () => standOptions([`--stack=${closed}`]),
    /no stack .*the stacks of the stand are joomla/,
  )
  assert.throws(() => standOptions(['--runtime=docker']), /the runtime is one of runc, runsc/)
  assert.throws(() => standOptions(['--build=joomla-1.5.26']), /no build joomla-1\.5\.26/)
  assert.throws(() => standOptions(['--group=everything']), /no group everything/)
  // A database, an address or a key is never taken: the stand works on what it started.
  for (const arg of ['--database=postgres://x', '--url=https://example.ru', '--key=x', 'joomla'])
    assert.throws(() => standOptions([arg]), /it takes no database, address or key/)
  // A group not written yet would pass empty: it is refused.
  assert.throws(() => standOptions(['--group=preview']), /the group preview are not written yet/)
})

test('a named build of another stack, or a group no chosen build runs, is refused', () => {
  const other = {
    stack: 'other',
    builds: [{ archive: 'other-1.0', php: '8.3', generation: 'o1', version: '1.0' }],
  }
  const stands = { joomla: STACK_STANDS.joomla, other }
  const archives = {
    ...CMS_ARCHIVES,
    'other-1.0': { ...CMS_ARCHIVES['joomla-6.2.0'], stack: 'other' },
  }
  assert.throws(
    () => standOptions(['--stack=joomla', '--build=other-1.0'], { stands, archives }),
    /the build other-1\.0 is not one of the stacks joomla/,
  )
  // No stand walks the panel yet: `browser` runs on no build and is refused, not passed empty.
  assert.throws(() => standOptions(['--group=browser']), /the group browser runs on none/)
  assert.throws(() => standOptions(['--group=safety']), /the group safety runs on none/)
  // A stand that walks the panel, with the support of its adapter open: `browser` runs on its build,
  // and the options refuse it only because its scenarios are not written yet.
  const walking = { ...STACK_STANDS.joomla, walks: true }
  const build = walking.builds.at(-1)
  const open = { browser: 'dev', generations: [{ id: build.generation, browser: true }] }
  assert.throws(
    () =>
      standOptions(['--group=browser'], {
        stands: { joomla: walking },
        supports: { joomla: open },
      }),
    /the scenarios of the group browser are not written yet/,
  )
  // The same stand without the support passed: no `browser` at all.
  assert.throws(
    () => standOptions(['--group=browser'], { stands: { joomla: walking } }),
    /the group browser runs on none/,
  )
  assert.deepEqual(
    standOptions([], { stands: { joomla: walking }, supports: { joomla: open } }).unwritten,
    ['preview', 'release', 'browser'],
  )
})

test('the groups of a build are counted by one function, never written in a record', () => {
  const build = STACK_STANDS.joomla.builds[0]
  const open = {
    browser: 'dev',
    generations: [{ id: build.generation, browser: true }],
  }
  assert.deepEqual(groupsOf({}, build, open), ['import', 'preview', 'release'])
  // A stand that does not walk the panel gets no `browser`, whatever the stack.
  assert.deepEqual(groupsOf({ safety: true }, build, open), [
    'import',
    'preview',
    'release',
    'safety',
  ])
  assert.deepEqual(groupsOf({ walks: true }, build, open), [
    'import',
    'preview',
    'release',
    'browser',
  ])
  assert.deepEqual(groupsOf({ walks: true, safety: true }, build, open), [
    'import',
    'preview',
    'release',
    'browser',
    'safety',
    'safety-browser',
  ])
  // The panel closed by the stack or by the branch: no `browser`.
  assert.deepEqual(groupsOf({ walks: true }, build, { ...open, browser: 'off' }).at(-1), 'release')
  assert.deepEqual(
    groupsOf({ walks: true }, build, {
      ...open,
      generations: [{ id: build.generation, browser: false }],
    }).at(-1),
    'release',
  )
  assert.deepEqual(groupsOf({ walks: true }, build).at(-1), 'release')
  for (const group of WRITTEN_GROUPS) assert.ok(STAND_GROUPS.includes(group))
  // A record of a stack names no group.
  for (const stand of Object.values(STACK_STANDS))
    for (const group of STAND_GROUPS) assert.equal(stand[group], undefined)
})

test('every record of a stack has every field, and its builds are rows of the table', () => {
  for (const [stack, stand] of Object.entries(STACK_STANDS)) {
    assert.equal(stand.stack, stack)
    assert.deepEqual(standProblems(stand), [], stack)
    for (const build of stand.builds) assert.ok(Object.hasOwn(CMS_ARCHIVES, build.archive))
  }
  const joomla = STACK_STANDS.joomla
  for (const field of Object.keys(STAND_FIELDS)) {
    assert.ok(standProblems({ ...joomla, [field]: undefined }).includes(`no ${field}`), field)
    const { [field]: _dropped, ...without } = joomla
    assert.ok(standProblems(without).includes(`no ${field}`), field)
  }
  // A stack without `refuseBelow` says so with null: I5 does not run, the record is whole.
  assert.deepEqual(standProblems({ ...joomla, refusedVersion: null }), [])
  assert.deepEqual(standProblems({ ...joomla, refusedVersion: {} }), ['refusedVersion: no files'])
  assert.deepEqual(standProblems({ ...joomla, refusedLayout: { files: {}, limit: 'x' } }), [
    'refusedLayout: no files or limit',
  ])
  assert.deepEqual(
    standProblems({ ...joomla, refusedLayout: { files: joomla.refusedLayout.files } }),
    ['refusedLayout: no files or limit'],
  )
  assert.deepEqual(standProblems({ ...joomla, scannerFinds: true }), [
    'scannerFinds: not a function',
  ])
  assert.deepEqual(standProblems({ ...joomla, scannerFinds: undefined }), [])
  const sample = { archive: 'joomla-6.2.0', php: '8.3', generation: 'j6', version: '6.2.0' }
  assert.deepEqual(standProblems({ ...joomla, builds: [] }), ['no build'])
  assert.deepEqual(standProblems({ ...joomla, builds: [{ ...sample, archive: 'joomla-0.1' }] }), [
    'joomla-0.1: no row of cms-archives.json',
  ])
  assert.deepEqual(
    standProblems(
      { ...joomla, builds: [{ ...sample, archive: 'other-1.0' }] },
      { ...CMS_ARCHIVES, 'other-1.0': { ...CMS_ARCHIVES['joomla-6.2.0'], stack: 'other' } },
    ),
    ['other-1.0: a row of other'],
  )
  assert.deepEqual(standProblems({ ...joomla, builds: [{ ...sample, generation: undefined }] }), [
    'joomla-6.2.0: no version or generation',
  ])
  assert.deepEqual(standProblems({ ...joomla, database: { name: 'site', user: 'site' } }), [
    'database: no prefix',
  ])
  assert.deepEqual(
    standProblems({
      ...STACK_STANDS.joomla,
      builds: [{ archive: 'joomla-6.2.0', php: '7.4', generation: 'j6', version: '6.2.0' }],
    }),
    ['joomla-6.2.0: PHP 7.4, the table says 8.3'],
  )
  // The closed CMS is in no record and in no table of the stand.
  for (const stand of Object.values(STACK_STANDS)) {
    const text = [
      JSON.stringify(stand),
      ...Object.values(stand)
        .filter((value) => typeof value === 'function')
        .map(String),
    ].join('\n')
    assert.doesNotMatch(text, new RegExp(closed, 'i'))
  }
  assert.doesNotMatch(Object.keys(STACK_STANDS).join(','), new RegExp(closed, 'i'))
  assert.doesNotMatch(JSON.stringify(CMS_ARCHIVES), new RegExp(closed, 'i'))
})

test('the names of a run have the form of the release stand, under a label of their own', () => {
  const names = stackNames(run)
  const release = standNames(run)
  assert.deepEqual(Object.keys(names).sort(), Object.keys(release).sort())
  assert.deepEqual(Object.keys(names.containers).sort(), Object.keys(release.containers).sort())
  assert.deepEqual(Object.keys(names.volumes).sort(), Object.keys(release.volumes).sort())
  assert.equal(names.label, `${STACK_LABEL}=${run}`)
  assert.notEqual(names.label, release.label)
  for (const name of [
    ...Object.values(names.containers),
    names.network,
    ...Object.values(names.volumes),
  ])
    assert.match(name, new RegExp(`^raditi-stack-verify-${run}-`))
  assert.throws(() => stackNames('../x'), /Invalid run id/)

  // Each build has its production, hosting, network and volumes; the rest is the run's.
  const a = buildNames(names, 'joomla-5.4.10')
  const b = buildNames(names, 'joomla-6.2.0')
  for (const key of ['prod', 'hosting']) assert.notEqual(a.containers[key], b.containers[key])
  assert.notEqual(a.network, b.network)
  assert.notEqual(a.volumes.docroot, b.volumes.docroot)
  assert.equal(a.containers.postgres, names.containers.postgres)
  assert.equal(a.label, names.label)
  assert.throws(() => buildNames(names, '../x'), /Invalid id of a build/)
})

test('the images of the stand are built under tags of its own, the site image per PHP', () => {
  const release = new Set(Object.values(BUILT_IMAGES).map((image) => image.tag))
  for (const image of Object.values(STACK_BUILT_IMAGES)) {
    assert.ok(!release.has(image.tag), image.tag)
    assert.match(image.tag, /^raditi-stack-verify\//)
  }
  assert.equal(STACK_BUILT_IMAGES.site, undefined)
  assert.equal(siteImageTag('7.4'), 'raditi-stack-verify/preview-site:7.4-local')
  assert.ok(!release.has(siteImageTag('8.3')))
  assert.throws(() => siteImageTag('8'), /Invalid PHP version/)
})

test('the production of a build is published on the loopback and never pulled', () => {
  const names = buildNames(stackNames(run), 'joomla-6.2.0')
  const args = productionArgs({
    names,
    image: 'raditi-stack-verify/preview-site@sha256:x',
    port: 18080,
  })
  assert.deepEqual(args.slice(0, 4), ['create', '--pull', 'never', '--name'])
  assert.ok(args.includes(names.label))
  assert.ok(args.includes('127.0.0.1:18080:80'))
  assert.ok(args.includes('127.0.0.1::3306'))
  assert.ok(args.includes(`type=volume,src=${names.volumes.docroot},dst=/var/www/html`))
  assert.ok(args.includes('/prod/entry.sh'))
  assert.equal(args.filter((arg) => arg.startsWith('0.0.0.0')).length, 0)
  assert.throws(() => productionArgs({ names, image: 'x', port: 80 }), /Invalid port/)
})

test('core gets the label of its run, the provisioner, Gitleaks first and the site images', () => {
  const context = {
    run,
    path: '/usr/bin:/bin',
    directory: '/tmp/stack-run',
    ports: {
      gitea: 20001,
      vault: 20002,
      s3: 20003,
      web: 20004,
      core: 20005,
      mcp: 20006,
      llm: 20007,
      preview: 20008,
      releaseApi: 20009,
      zai: 20010,
    },
    databaseUrl: 'postgresql://raditi:x@127.0.0.1:1/raditi',
    redisUrl: 'redis://default:x@127.0.0.1:2',
    vault: { address: 'http://127.0.0.1:20002' },
    roles: { core: { roleId: 'r', secretId: 's' } },
    s3: { endpoint: 'http://127.0.0.1:20003', accessKey: 'a', secretKey: 'b' },
    secrets: { metrics: 'm', botToken: 'bot', provisionerToken: 'provisioner' },
    caFile: '/tmp/stack-run/ca.pem',
    socket: '/var/run/docker.sock',
    images: { sandbox: 's', gateway: 'g', guard: 'n', tools: 't', browser: 'b', core: 'c' },
    siteImages: { 7.4: 'site74@sha256:a', 8.3: 'site83@sha256:b' },
    gitleaks: '/opt/homebrew/bin/gitleaks',
    runtime: 'runc',
  }
  const env = stackCoreEnvironment(context)
  assert.equal(env.SANDBOX_DEPLOYMENT, `stack-${run}`)
  assert.equal(env.GITEA_PROVISIONER_TOKEN, 'provisioner')
  assert.equal(env.GITEA_TOKEN, 'bot')
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/bin:/bin')
  assert.equal(env.PREVIEW_SITE_IMAGES, '7.4=site74@sha256:a,8.3=site83@sha256:b')
  assert.equal(env.APP_ENV, 'test')
  assert.throws(() => stackCoreEnvironment({ ...context, run: 'x' }), /Invalid run id/)
  assert.throws(() => stackCoreEnvironment({ ...context, siteImages: {} }), /site image/)
})

test('the scan finds a needle cut between two chunks and says only which one', () => {
  const scanner = needleScanner(['canary-value-1', 'never-here'])
  scanner.push(Buffer.from('xxxxcanary-va'))
  scanner.push(Buffer.from('lue-1yyyy'))
  assert.deepEqual(scanner.found(), [0])
  // The longest needle, cut at every place, beside a short one: the tail kept is the longest's.
  const long = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
  for (let cut = 1; cut < long.length; cut += 1) {
    const cutScanner = needleScanner(['ab', long])
    cutScanner.push(Buffer.from(`${'x'.repeat(70)}${long.slice(0, cut)}`))
    cutScanner.push(Buffer.from(`${long.slice(cut)}${'y'.repeat(70)}`))
    assert.deepEqual(cutScanner.found(), [1], `cut after ${cut}`)
  }
  const clean = needleScanner(['abcdefgh'])
  for (const chunk of ['abcd', 'efg', 'xh']) clean.push(Buffer.from(chunk))
  assert.deepEqual(clean.found(), [])
})

test('the stand builds its copy with the contract of the copies, and takes the release stand as it is', () => {
  const source = readFileSync(new URL('./verify-stack.mjs', import.meta.url), 'utf8')
  assert.match(source, /from '\.\.\/billing-verify\/verify-billing\.mjs'/)
  assert.match(source, /lockCopy/)
  // The stand reads the files of the release stand and writes none of them.
  for (const file of ['verify-stack.mjs', 'services.mjs', 'scenarios-import.mjs']) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /(?:writeFile|rm|cp)\([^)]*release-verify/)
    assert.doesNotMatch(text, new RegExp(closed, 'i'))
  }
})
