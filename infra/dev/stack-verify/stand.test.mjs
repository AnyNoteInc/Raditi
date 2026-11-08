// Contract of the pure parts of the stand of the site stacks (pnpm test:infra;
// docs/plan/62-slices/e3.md, Э3.10): its options, its names, its images, the records of the stacks,
// the groups of a build, the environment of core and the scan of what a run left. Nothing here
// starts Docker or a process.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { joomlaAdapter } from '../../../packages/site-adapters/src/joomla/joomla.ts'
import { wordpressAdapter } from '../../../packages/site-adapters/src/wordpress.ts'
import { BUILT_IMAGES, LARGE_USAGE, standNames } from '../release-verify/stand.mjs'
import { CMS_ARCHIVES } from './fetch-cms.mjs'
import {
  GROUP_NEEDS,
  GROUP_ROWS,
  STACK_BUILT_IMAGES,
  STACK_LABEL,
  STAND_FIELDS,
  STAND_GROUPS,
  WRITTEN_GROUPS,
  adapterProblems,
  buildNames,
  gitleaksVersionOf,
  gitleaksVersionProblem,
  groupRowProblems,
  groupsOf,
  hostGatewayOf,
  hostOf,
  hostRelays,
  needleScanner,
  pinnedImagesOf,
  productionArgs,
  SERVICE_IMAGES,
  siteImageTag,
  stackCoreEnvironment,
  stackNames,
  stackRoleEnvironment,
  browserTurn,
  canonicalLinks,
  navigationStatus,
  pageProblems,
  refusalCode,
  standOptions,
  standProblems,
  toolCallsOf,
  uuid7,
} from './stand.mjs'
import { imageLines } from './images.mjs'
import { parseRuntimes } from './scenarios-preview.mjs'
import { STACK_STANDS } from './stacks.mjs'

/** The adapter of each stack of STACK_STANDS: Э4 and Э5 add theirs with their records. */
const ADAPTERS = Object.freeze({ joomla: joomlaAdapter, wordpress: wordpressAdapter })
import {
  appendLine,
  breakingTurn,
  conflictPart,
  conflictTurn,
  editTurn,
  forbiddenTurn,
  insertBefore,
  markOf,
  ownerLine,
  shellQuote,
} from './turns.mjs'

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
  for (const entry of all.runs) assert.deepEqual(entry.groups, ['import', 'preview', 'release'])
  assert.deepEqual(all.unwritten, [])

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
})

test('a named group brings the group it runs on the results of', () => {
  // `preview` opens the site `import` made: it never runs without it (Э3.11).
  const preview = standOptions(['--group=preview', '--build=joomla-4.4.14'])
  assert.deepEqual(
    preview.runs.map(({ build, groups }) => [build.archive, groups]),
    [['joomla-4.4.14', ['import', 'preview']]],
  )
  assert.deepEqual(GROUP_NEEDS.preview, ['import'])
  assert.deepEqual(standOptions(['--group=import']).runs[0].groups, ['import'])
  assert.deepEqual(standOptions(['--group=import', '--group=preview']).runs[0].groups, [
    'import',
    'preview',
  ])
  // `release` takes the site of `import` and the dialogs of `preview` before it (Э3.12).
  assert.deepEqual(GROUP_NEEDS.release, ['import', 'preview'])
  assert.deepEqual(standOptions(['--group=release', '--build=joomla-6.2.0']).runs[0].groups, [
    'import',
    'preview',
    'release',
  ])
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
    ['browser'],
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
  // A stack without `refuseBelow` says so with null, one that reads no layout (`readLayout: null` —
  // WordPress) too: the shape of the record takes both, and its adapter says whether they are right.
  assert.deepEqual(standProblems({ ...joomla, refusedVersion: null }), [])
  assert.deepEqual(standProblems({ ...joomla, refusedLayout: null }), [])
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
  // P4 and P5 read the paths of the agent's browser and the sign-in to the panel of each build.
  assert.deepEqual(standProblems({ ...joomla, browserPaths: { closed: [], open: '/x' } }), [
    'browserPaths: no closed paths or no open one',
  ])
  assert.deepEqual(
    standProblems({ ...joomla, browserPaths: { closed: ['/administrator/'], open: 'x' } }),
    ['browserPaths: no closed paths or no open one'],
  )
  assert.deepEqual(
    standProblems({
      ...joomla,
      signIn: (build) => ({ ...joomla.signIn(build), lostCookie: null }),
    }),
    joomla.builds.map((build) => `${build.archive}: signIn is not whole`),
  )
  // R1–R6 read what a turn edits, the file R2 may not add and the line R4 breaks production with.
  assert.deepEqual(
    standProblems({ ...joomla, edit: () => ({ template: null, style: null }) }),
    joomla.builds.map((build) => `${build.archive}: edit names no template and no style`),
  )
  assert.deepEqual(
    standProblems({
      ...joomla,
      edit: (build) => ({ ...joomla.edit(build), template: { path: 'x.php', line: 'x' } }),
    }),
    joomla.builds.map((build) => `${build.archive}: edit names no template and no style`),
  )
  assert.deepEqual(standProblems({ ...joomla, outsideWorkingSet: '/libraries/x.php' }), [
    'outsideWorkingSet: no relative path',
  ])
  assert.deepEqual(
    standProblems({ ...joomla, breakOnProduction: () => '' }),
    joomla.builds.map((build) => `${build.archive}: breakOnProduction is no line`),
  )
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
  // A stack without a table of generations names none with null (WordPress, Э3.15): I1 then
  // expects no generation in stack_facts, and the edit of R1 is still asked of the build.
  const ofStack = () => joomla.edit(sample)
  assert.deepEqual(
    standProblems({ ...joomla, builds: [{ ...sample, generation: null }], edit: ofStack }),
    [],
  )
  assert.deepEqual(
    standProblems({
      ...joomla,
      builds: [{ ...sample, generation: null }],
      edit: () => ({ template: null, style: null }),
    }),
    ['joomla-6.2.0: edit names no template and no style'],
  )

  // WordPress (Э3.15): the stack on which everything already works holds the groups to account.
  const wordpress = STACK_STANDS.wordpress
  assert.ok(wordpress, 'STACK_STANDS has the record of WordPress')
  assert.equal(wordpress.stack, 'wordpress')
  for (const field of Object.keys(STAND_FIELDS))
    assert.ok(Object.hasOwn(wordpress, field), `wordpress: ${field}`)
  assert.deepEqual(standProblems(wordpress), [])
  assert.deepEqual(
    wordpress.builds.map((build) => [build.archive, build.php, build.generation, build.version]),
    [['wordpress-7.1.2', '8.3', null, '7.1.2']],
  )
  // No layout and no version is refused: neither I4 nor I5 runs on it.
  assert.equal(wordpress.refusedLayout, null)
  assert.equal(wordpress.refusedVersion, null)
  assert.deepEqual(wordpress.database, { name: 'site', user: 'site', prefix: 'wp_' })
  const byStack = standOptions(['--stack=wordpress'])
  assert.deepEqual(
    byStack.runs.map(({ stack, build, groups }) => [stack, build.archive, groups]),
    [['wordpress', 'wordpress-7.1.2', ['import', 'preview', 'release']]],
  )
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

test('a null in a record is right only where its adapter has no such thing', () => {
  // docs/plan/62-slices/e3.md, Э3.15: a null drops I4, I5 or the generation of I1 silently, so it is
  // held to the adapter — `readLayout`, `support.refuseBelow`, `support.generations`.
  for (const [stack, stand] of Object.entries(STACK_STANDS)) {
    assert.ok(Object.hasOwn(ADAPTERS, stack), `the test knows the adapter of ${stack}`)
    assert.deepEqual(adapterProblems(stand, ADAPTERS[stack]), [], stack)
  }
  const { joomla, wordpress } = STACK_STANDS
  // Joomla reads a layout, refuses below 3.0 and has generations: none of its nulls is right.
  assert.deepEqual(adapterProblems({ ...joomla, refusedLayout: null }, joomlaAdapter), [
    'refusedLayout: null, but the adapter reads a layout (I4 would not run)',
  ])
  assert.deepEqual(adapterProblems({ ...joomla, refusedVersion: null }, joomlaAdapter), [
    'refusedVersion: null, but the adapter refuses below 3.0 (I5 would not run)',
  ])
  const [sample] = joomla.builds
  assert.deepEqual(
    adapterProblems({ ...joomla, builds: [{ ...sample, generation: null }] }, joomlaAdapter),
    [`${sample.archive}: generation null is not one of j30, j3, j4, j5, j6`],
  )
  assert.deepEqual(
    adapterProblems({ ...joomla, builds: [{ ...sample, generation: 'j9' }] }, joomlaAdapter),
    [`${sample.archive}: generation j9 is not one of j30, j3, j4, j5, j6`],
  )
  // WordPress has none of them: a value where the adapter has nothing is refused as well.
  assert.deepEqual(
    adapterProblems({ ...wordpress, refusedLayout: joomla.refusedLayout }, wordpressAdapter),
    ['refusedLayout: the adapter reads no layout, so it refuses none'],
  )
  assert.deepEqual(
    adapterProblems({ ...wordpress, refusedVersion: joomla.refusedVersion }, wordpressAdapter),
    ['refusedVersion: the adapter refuses no version'],
  )
  const [build] = wordpress.builds
  assert.deepEqual(
    adapterProblems({ ...wordpress, builds: [{ ...build, generation: 'j5' }] }, wordpressAdapter),
    [`${build.archive}: generation j5, but the adapter has no table of generations`],
  )
  assert.deepEqual(adapterProblems(wordpress, joomlaAdapter), [
    'the adapter is of joomla, not wordpress',
  ])
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
  // The stand's own production names its runtime: runc whatever --runtime of the run is (Э3.16).
  assert.equal(args[args.indexOf('--runtime') + 1], 'runc')
  assert.throws(() => productionArgs({ names, image: 'x', port: 80 }), /Invalid port/)
})

/** A host of each kind, as `hostOf` reads them (Э3.16). */
const DESKTOP = 'Docker Desktop'
const BRIDGE = '172.17.0.1'
const desktopHost = hostOf({
  operatingSystem: DESKTOP,
  bridgeGateway: BRIDGE,
  hostGateway: '192.168.65.254',
})
// Plain Linux: host-gateway is the bridge gateway — whether docker0 is up or DOWN (idle) does not
// matter, the interfaces of the machine are not read.
const linuxHost = hostOf({
  operatingSystem: 'Ubuntu 24.04.4 LTS',
  bridgeGateway: BRIDGE,
  hostGateway: BRIDGE,
})
// A VM of Colima: host-gateway leads to the Mac.
const vmHost = hostOf({
  operatingSystem: 'Ubuntu 24.04.4 LTS',
  bridgeGateway: BRIDGE,
  hostGateway: '192.168.5.2',
})

/** The context of the processes of a run, as verify-stack.mjs gives it. */
const processContext = (overrides = {}) => ({
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
  roles: {
    core: { roleId: 'r', secretId: 's' },
    llm: { roleId: 'r', secretId: 's' },
    mcp: { roleId: 'r', secretId: 's' },
  },
  s3: { endpoint: 'http://127.0.0.1:20003', accessKey: 'a', secretKey: 'b' },
  secrets: { metrics: 'm', botToken: 'bot', provisionerToken: 'provisioner', previewSession: 'p' },
  caFile: '/tmp/stack-run/ca.pem',
  socket: '/var/run/docker.sock',
  images: { sandbox: 's', gateway: 'g', guard: 'n', tools: 't', browser: 'b', core: 'c' },
  siteImages: { 7.4: 'site74@sha256:a', 8.3: 'site83@sha256:b' },
  gitleaks: '/opt/homebrew/bin/gitleaks',
  runtime: 'runc',
  host: desktopHost,
  ...overrides,
})

test('the host is read from the daemon and a probe, three kinds (Э3.16)', () => {
  assert.deepEqual(desktopHost, {
    kind: 'desktop',
    mirror: true,
    listen: '127.0.0.1',
    relay: null,
    upstream: 'host.docker.internal',
  })
  // Plain Linux: host-gateway is this machine; the jobs see its loopback, no mirror.
  assert.deepEqual(linuxHost, {
    kind: 'linux',
    mirror: false,
    listen: '127.0.0.1',
    relay: BRIDGE,
    upstream: 'host.docker.internal',
  })
  // A VM whose host-gateway is another machine: by the probe, not by `docker info`, which says Ubuntu.
  assert.deepEqual(vmHost, {
    kind: 'vm',
    mirror: false,
    listen: '127.0.0.1',
    relay: BRIDGE,
    upstream: BRIDGE,
  })
  // Linux whose daemon sets `host-gateway-ip` to an address of this host other than the bridge
  // (eth0): host.docker.internal is not where the relays listen, so containers go by address.
  assert.deepEqual(
    hostOf({ operatingSystem: 'Debian 13', bridgeGateway: BRIDGE, hostGateway: '10.0.0.5' }),
    vmHost,
  )
})

test('the address of host-gateway is read from getent of the probe container, in words when none', () => {
  // As getent ahostsv4 prints it on Docker Desktop, on Linux and in the VM of Colima.
  assert.equal(
    hostGatewayOf('192.168.65.254  STREAM host.docker.internal\n192.168.65.254  DGRAM  \n'),
    '192.168.65.254',
  )
  assert.equal(hostGatewayOf('172.17.0.1      STREAM host.docker.internal\n'), '172.17.0.1')
  assert.equal(hostGatewayOf('192.168.5.2     STREAM host.docker.internal\n'), '192.168.5.2')
  for (const output of ['', 'fe80::1  STREAM host.docker.internal', 'getent: not found'])
    assert.throws(() => hostGatewayOf(output), /host-gateway of this daemon resolved to no IPv4/)
})

test('the runtimes of containers are read from docker inspect, by name', () => {
  assert.deepEqual(parseRuntimes('/raditi-preview-1 runsc\n/raditi-sandbox-2 runc\n\n'), {
    'raditi-preview-1': 'runsc',
    'raditi-sandbox-2': 'runc',
  })
  assert.deepEqual(parseRuntimes(''), {})
})

test('a relay on the bridge per role a container reaches: llm, mcp and the gateway of previews', () => {
  const { ports } = processContext()
  assert.deepEqual(hostRelays(desktopHost, ports), [])
  for (const host of [linuxHost, vmHost])
    assert.deepEqual(hostRelays(host, ports), [
      { role: 'llm', listen: BRIDGE, port: ports.llm, to: '127.0.0.1' },
      { role: 'mcp', listen: BRIDGE, port: ports.mcp, to: '127.0.0.1' },
      { role: 'preview', listen: BRIDGE, port: ports.preview, to: '127.0.0.1' },
    ])
})

test('in a VM the containers go to the bridge by address; the roles listen on loopback', () => {
  const context = processContext({ host: vmHost })
  const core = stackCoreEnvironment(context)
  assert.equal(core.SANDBOX_LLM_UPSTREAM, `http://${BRIDGE}:${context.ports.llm}`)
  assert.equal(core.SANDBOX_MCP_UPSTREAM, `http://${BRIDGE}:${context.ports.mcp}`)
  assert.equal(core.PREVIEW_RELAY_GATEWAY_HOST, BRIDGE)
  const llm = stackRoleEnvironment('llm', context)
  assert.ok(llm.LLM_GATEWAY_HOSTS.split(',').includes(`${BRIDGE}:${context.ports.llm}`))
  // The relay is what the role sees: it connects from loopback.
  assert.equal(llm.LLM_GATEWAY_CLIENTS, '127.0.0.1/32')
  assert.equal(llm.LLM_GATEWAY_LISTEN_HOST, '127.0.0.1')
  const mcp = stackRoleEnvironment('mcp', context)
  assert.ok(mcp.MCP_ALLOWED_HOSTS.split(',').includes(BRIDGE))
  // The address of the bridge would take the port of the relay: preview listens on loopback.
  assert.equal(stackRoleEnvironment('preview', context).PREVIEW_GATEWAY_HOST, '127.0.0.1')
  // On Docker Desktop and plain Linux host.docker.internal is this host: nothing by address.
  for (const host of [desktopHost, linuxHost]) {
    const same = processContext({ host })
    const env = stackCoreEnvironment(same)
    assert.equal(env.SANDBOX_LLM_UPSTREAM, `http://host.docker.internal:${same.ports.llm}`)
    assert.equal(env.SANDBOX_MCP_UPSTREAM, `http://host.docker.internal:${same.ports.mcp}`)
    assert.equal(env.PREVIEW_RELAY_GATEWAY_HOST, undefined)
    assert.ok(!stackRoleEnvironment('llm', same).LLM_GATEWAY_HOSTS.includes(BRIDGE))
    assert.equal(stackRoleEnvironment('mcp', same).MCP_ALLOWED_HOSTS, 'host.docker.internal')
  }
  assert.throws(
    () => stackRoleEnvironment('core', processContext({ host: undefined })),
    /kind of its host/,
  )
})

test('under runsc the turns and previews of core run under it, production stays on runc', () => {
  const env = stackCoreEnvironment(processContext({ runtime: 'runsc', host: vmHost }))
  assert.equal(env.SANDBOX_RUNTIME, 'runsc')
  assert.equal(env.PREVIEW_RUNTIME, 'runsc')
  const runc = stackCoreEnvironment(processContext())
  assert.equal(runc.SANDBOX_RUNTIME, 'runc')
  assert.equal(runc.PREVIEW_RUNTIME, 'runc')
  // Production is the stand's own container: it names runc, whatever the run's runtime (the
  // hosting runs under the daemon's default, which the stand requires to be runc before it starts,
  // and both are read back by docker inspect in the run).
  const names = buildNames(stackNames(run), 'joomla-5.4.10')
  const args = productionArgs({ names, image: 'site@sha256:x', port: 18080 })
  assert.deepEqual(
    args.filter((arg, index) => arg === '--runtime' || args[index - 1] === '--runtime'),
    ['--runtime', 'runc'],
  )
  assert.throws(
    () => stackCoreEnvironment(processContext({ runtime: 'docker' })),
    /Invalid runtime/,
  )
})

test('core gets the label of its run, the provisioner, Gitleaks first and the site images', () => {
  const context = {
    host: desktopHost,
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
  for (const file of [
    'verify-stack.mjs',
    'services.mjs',
    'scenarios-import.mjs',
    'scenarios-preview.mjs',
    'scenarios-release.mjs',
    'turns.mjs',
    'frame.mjs',
  ]) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /(?:writeFile|rm|cp)\([^)]*release-verify/)
    assert.doesNotMatch(text, new RegExp(closed, 'i'))
  }
})

test('a page of a preview is judged by its errors, its links to production and its canonical link', () => {
  const facts = {
    productionOrigin: 'http://localhost:18080',
    previewOrigin: 'http://site-a-chat-b.localhost:18090',
  }
  const clean =
    '<base href="http://site-a-chat-b.localhost:18090/"><link href="/o-kompanii" rel="canonical">' +
    '<a href="http://localhost:180800/">another port</a><img src="/images/x.png">'
  assert.deepEqual(pageProblems(clean, facts), [])
  assert.deepEqual(canonicalLinks(clean), ['/o-kompanii'])
  assert.deepEqual(pageProblems('<b>Fatal error</b>: x', facts), ['Fatal error'])
  assert.deepEqual(pageProblems('<b>Warning:</b> Undefined', facts), ['Warning:'])
  assert.deepEqual(pageProblems('<a href="http://localhost:18080/o-kompanii">x</a>', facts), [
    'a link to production: http://localhost:18080/o-kompanii',
  ])
  // As JSON writes a slash, and in a script's options.
  assert.equal(
    pageProblems('<div data-src="http:\\/\\/localhost:18080\\/x"></div>', facts).length,
    1,
  )
  assert.deepEqual(
    pageProblems('<link rel="canonical" href="http://localhost:18080/o-kompanii">', facts),
    [
      'a link to production: http://localhost:18080/o-kompanii',
      'a canonical link off the preview: http://localhost:18080/o-kompanii',
    ],
  )
  // A host that only ends like the production's is another host.
  assert.deepEqual(pageProblems('<a href="http://site-x.localhost:18080/">', facts), [])
})

test('the turn of the browser names its tools only, and its answers are read back by call', () => {
  const turn = browserTurn({
    closed: ['/administrator/', '/configuration.php'],
    open: '/images/x.png',
  })
  assert.deepEqual(
    turn.rounds.map((round) => round.map((call) => [call.name, call.arguments.path])),
    [
      [['raditi_browser_navigate', '/']],
      [['raditi_browser_navigate', '/administrator/']],
      [['raditi_browser_navigate', '/configuration.php']],
      [['raditi_browser_navigate', '/images/x.png']],
    ],
  )
  assert.doesNotMatch(JSON.stringify(turn), /wp_rest|bash|content/)
  assert.equal(JSON.parse(turn.text).change_type, 'none')
  const body = {
    messages: [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'a', function: { name: 'raditi_browser_navigate', arguments: '{"path":"/"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'a', content: '{"path":"/","title":"x","status":200}' },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'b',
            function: { name: 'raditi_browser_navigate', arguments: '{"path":"/administrator/"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'b',
        content: [{ type: 'text', text: '{"code":"BROWSER_PATH_DENIED"}' }],
      },
    ],
  }
  const calls = toolCallsOf(body)
  assert.deepEqual(
    calls.map((call) => [call.args.path, refusalCode(call.result), navigationStatus(call.result)]),
    [
      ['/', null, 200],
      ['/administrator/', 'BROWSER_PATH_DENIED', null],
    ],
  )
  assert.equal(refusalCode('{\\"code\\":\\"BROWSER_PATH_DENIED\\"}'), 'BROWSER_PATH_DENIED')
  assert.deepEqual(toolCallsOf(null), [])
})

test('the id of a chat is a UUID of version 7', () => {
  const id = uuid7(Date.UTC(2026, 10, 7), Buffer.alloc(16, 0xff))
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(uuid7(), uuid7())
})

test('the turns of the release are built of the record of the stack, with no tool of content', () => {
  for (const [stack, stand] of Object.entries(STACK_STANDS))
    for (const build of stand.builds) {
      const edit = stand.edit(build)
      const turns = {
        edit: editTurn(edit),
        forbidden: forbiddenTurn(stand.outsideWorkingSet),
        breaking: breakingTurn(edit, stand.breakOnProduction(build)),
        conflict: conflictTurn(edit),
      }
      for (const [name, turn] of Object.entries(turns)) {
        const text = JSON.stringify(turn)
        assert.doesNotMatch(text, /wp_rest|raditi_content|raditi_restore/, `${stack} ${name}`)
        assert.equal(turn.scenario, 'tools')
        for (const round of turn.rounds)
          for (const call of round)
            assert.ok(
              ['bash', 'raditi_browser_navigate', 'raditi_browser_run_checks'].includes(call.name),
              `${stack} ${name}: ${call.name}`,
            )
        assert.doesNotThrow(() => JSON.parse(turn.text), `${stack} ${name}: a result of a turn`)
      }
      // R1 checks the mark in the agent's browser and names the files it changed.
      const checks = turns.edit.rounds.flat().find((call) => call.name.endsWith('run_checks'))
      assert.deepEqual(checks.arguments.checks, [
        { path: '/', selector: '.stack-mark', ...markOf(edit) },
      ])
      const result = JSON.parse(turns.edit.text)
      assert.deepEqual(
        result.files_changed.toSorted(),
        [edit.template, edit.style, edit.texts]
          .filter(Boolean)
          .map((part) => part.path)
          .toSorted(),
      )
      assert.match(JSON.stringify(turns.breaking), /RADITI_PREVIEW_ORIGIN/)
      assert.match(JSON.stringify(turns.forbidden), new RegExp(stand.outsideWorkingSet))
      // R1 reports a usage above the minimum of a task, so its charge is told from the minimum.
      assert.deepEqual(turns.edit.usage, LARGE_USAGE)
      // R6 changes one file the installed version holds after the undo of R5: never a new one.
      const part = conflictPart(edit)
      assert.ok(part === edit.template || part === edit.style, `${stack} ${build.archive}`)
      assert.notEqual(part.created, true, `${stack} ${build.archive}: ${part.path}`)
      assert.deepEqual(JSON.parse(turns.conflict.text).files_changed, [part.path])
      assert.match(turns.conflict.rounds[0][0].arguments.command, new RegExp(part.path))
    }
})

test('R6 takes the style the supply has, else the template; the owner writes in its language', () => {
  const template = { path: 't/index.php', before: '</body>', line: '<p class="stack-mark">M</p>' }
  const style = (created) => ({ path: 'css/s.css', line: '.m {}', created })
  assert.equal(conflictPart({ template, style: style(false) }).path, 'css/s.css')
  assert.equal(conflictPart({ template, style: style(true) }).path, 't/index.php')
  assert.equal(conflictPart({ template: null, style: style(false) }).path, 'css/s.css')
  assert.throws(
    () => conflictPart({ template: null, style: style(true) }),
    /no file of the installed/,
  )
  // A rule of style before the tag of the template, a line of the stylesheet otherwise.
  assert.match(
    conflictTurn({ template, style: style(true) }).rounds[0][0].arguments.command,
    /^sed -i .*<style>\.stack-mark \{ font-weight: bold; \}<\/style><\/body>/,
  )
  assert.match(
    conflictTurn({ template, style: style(false) }).rounds[0][0].arguments.command,
    /printf .* >> 'css\/s\.css'$/,
  )
  assert.equal(ownerLine('css/s.css'), '/* Правка владельца на хостинге */')
  assert.equal(ownerLine('t/index.php'), '<!-- Правка владельца на хостинге -->')
  // Without a template the mark is the plain text of shownAt.
  assert.deepEqual(markOf({ template: null }, { path: '/', text: 'Подвал: версия 1' }), {
    text: 'Подвал: версия 1',
  })
  assert.throws(() => markOf({ template: null }, { path: '/', text: '<p>x</p>' }), /carries a mark/)
  assert.throws(() => markOf({ template: null }), /carries a mark/)
})

test('a group that ran on a build left a row of its letter naming the build', () => {
  assert.deepEqual(Object.keys(GROUP_ROWS).toSorted(), [...WRITTEN_GROUPS].toSorted())
  const build = (archive) => ({ archive })
  const runs = [
    { build: build('joomla-3.10.12'), groups: ['import', 'preview', 'release'] },
    { build: build('joomla-6.2.0'), groups: ['import'] },
  ]
  const rows = [
    { id: 'I1 joomla-3.10.12', ok: true },
    { id: 'P5 joomla-3.10.12 webkit', ok: true },
    { id: 'R1 joomla-3.10.12', ok: true },
    { id: 'I5 joomla', ok: true },
    { id: 'I1 joomla-6.2.0', ok: true },
  ]
  assert.deepEqual(groupRowProblems(runs, rows), [])
  // A group whose call was dropped, a row that did not end, and a row of another build all fail.
  assert.deepEqual(
    groupRowProblems(
      runs,
      rows.filter((row) => !row.id.startsWith('R')),
    ),
    ['no row of the group release names joomla-3.10.12'],
  )
  assert.deepEqual(
    groupRowProblems(runs, [...rows.slice(0, 2), { id: 'R1 joomla-3.10.12', ok: false }, rows[4]]),
    ['no row of the group release names joomla-3.10.12'],
  )
  assert.deepEqual(groupRowProblems([runs[1]], rows.slice(0, 3)), [
    'no row of the group import names joomla-6.2.0',
  ])
  assert.deepEqual(groupRowProblems([{ build: build('x'), groups: ['browser'] }], rows), [
    'the group browser has no letter of its rows',
  ])
})

test('the commands of a turn quote what they write and insert it before the tag once', () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'")
  assert.equal(
    insertBefore('a b/index.php', '</body>', '<p class="m">1 & 2</p>'),
    "sed -i 's|</body>|<p class=\"m\">1 \\& 2</p></body>|' 'a b/index.php'",
  )
  assert.equal(
    insertBefore('x.php', '</footer>', "<?php f('x'); ?>"),
    "sed -i 's|</footer>|<?php f('\\''x'\\''); ?></footer>|' 'x.php'",
  )
  // A tag a regular expression would read otherwise is matched as it is written.
  assert.match(insertBefore('x', 'a.b*', 'y'), /s\|a\\\.b\\\*\|ya\.b\*\|/)
  assert.throws(() => insertBefore('x', '</body>', 'a|b'), /neither a bar nor a line break/)
  assert.throws(() => insertBefore('x', '</body>', 'a\nb'), /neither a bar nor a line break/)
  assert.equal(
    appendLine('css/user.css', '.m { color: red; }'),
    "mkdir -p 'css' && printf '%s\\n' '.m { color: red; }' >> 'css/user.css'",
  )
  assert.deepEqual(markOf({ template: { line: '<p class="stack-mark">Подвал: версия 1</p>' } }), {
    text: 'Подвал: версия 1',
  })
})

test('the pinned images of a run: the services, then the PHP bases of its builds once each', () => {
  const bases = [
    { php: '8.3', image: 'php@sha256:' + 'a'.repeat(64) },
    { php: '7.4', image: 'php@sha256:' + 'b'.repeat(64) },
  ]
  const pinned = pinnedImagesOf(['8.3', '7.4', '8.3'], bases)
  assert.deepEqual(
    pinned.map(({ image }) => image),
    [...SERVICE_IMAGES, bases[0].image, bases[1].image],
  )
  // Every service is pinned by digest; a person pulls by the tag the release stand names, if any.
  for (const image of SERVICE_IMAGES) assert.match(image, /@sha256:[0-9a-f]{64}$/)
  assert.ok(pinned.some(({ image, tag }) => image !== tag && tag === 'mariadb:11.4.13'))
  assert.throws(
    () => pinnedImagesOf(['5.6'], bases),
    /No row of infra\/preview\/site-bases\.json for PHP 5\.6/,
  )
})

test('images.mjs prints the list of a stack or of its builds, by digest, with tags on request', () => {
  const siteBases = JSON.parse(
    readFileSync(new URL('../../preview/site-bases.json', import.meta.url), 'utf8'),
  ).versions
  const builds = Object.entries(CMS_ARCHIVES).filter(([, row]) => row.stack === 'joomla')
  assert.ok(builds.length > 0, 'the table has builds of joomla')
  const php = [...new Set(builds.map(([, row]) => row.php))]
  const expected = pinnedImagesOf(php, siteBases)
  assert.deepEqual(
    imageLines(['--stack=joomla']),
    expected.map(({ image }) => image),
  )
  assert.deepEqual(
    imageLines(['--stack=joomla', '--tags']),
    expected.map(({ image, tag }) => `${image}\t${tag}`),
  )
  const [id, row] = builds[0]
  assert.deepEqual(
    imageLines([id]),
    pinnedImagesOf([row.php], siteBases).map(({ image }) => image),
  )
  assert.throws(() => imageLines([]), /usage: images\.mjs/)
  assert.throws(() => imageLines(['--pull']), /unknown option --pull/)
  assert.throws(() => imageLines(['joomla-0.0.0']), /no build joomla-0\.0\.0/)
})

test('the version of Gitleaks is read from a release archive and from the pinned core image', () => {
  assert.equal(gitleaksVersionOf('8.30.1\n'), '8.30.1')
  assert.equal(gitleaksVersionOf('v8.30.1'), '8.30.1')
  for (const other of ['', 'dev', 'v8.30', '8.30.1-rc1', 'gitleaks 8.30.1', 'vv8.30.1'])
    assert.equal(gitleaksVersionOf(other), null, other)
})

test('the stand refuses a Gitleaks of another version, in either form of its output', () => {
  for (const output of ['8.30.1\n', 'v8.30.1'])
    assert.equal(gitleaksVersionProblem(output, '8.30.1', '/bin/gitleaks'), null, output)
  for (const output of ['8.31.0', 'v8.31.0\n', '8.30.0', ''])
    assert.equal(
      gitleaksVersionProblem(output, '8.30.1', '/bin/gitleaks'),
      'Use Gitleaks 8.30.1; /bin/gitleaks is another version',
      output,
    )
  // The run calls this check, not a comparison of its own (verify-stack.mjs, gitleaksBinary).
  const main = readFileSync(new URL('./verify-stack.mjs', import.meta.url), 'utf8')
  const binary = /async function gitleaksBinary\(\) \{\n([\s\S]*?)\n\}\n/.exec(main)?.[1] ?? ''
  assert.match(binary, /gitleaksVersionProblem\(version\.output, GITLEAKS_VERSION, found\)/)
  assert.doesNotMatch(binary, /!==|===/)
})

test('the run checks the rows of P5 against the kind of its own host', () => {
  // frameRowProblems (frame.mjs) catches a wrong kind at the call of frameEnginesOn only when the
  // run asks it with the host preflight read (hostOf), not a literal.
  const main = readFileSync(new URL('./verify-stack.mjs', import.meta.url), 'utf8')
  assert.match(main, /frameRowProblems\(runs, rt\.rows, frames\.noted, host\.kind\)/)
  assert.match(main, /const \{ socket, gitleaks, host \} = await preflight\(options\)/)
  const preview = readFileSync(new URL('./scenarios-preview.mjs', import.meta.url), 'utf8')
  assert.match(preview, /frameEnginesOn\(ctx\.host\.kind\)/)
  assert.match(preview, /return \{ failed, noted \}/)
})
