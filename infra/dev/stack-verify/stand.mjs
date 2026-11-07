// Pure parts of the stand of the site stacks (verify-stack.mjs; docs/plan/62-site-stacks.md, Т66,
// §5.5; docs/plan/62-slices/e3.md, Э3.10): its options, the groups a build runs, the names of
// everything a run owns, the images it builds under names of its own, the arguments of the
// production container of a build and the environment of core. The services, the builds and the
// scenarios of the release stand are taken as they are (infra/dev/release-verify); nothing here
// touches Docker, the network or a file but the two tables the stand reads.
import { dirname } from 'node:path'

import { BUILT_IMAGES, CONTAINERS, roleEnvironment } from '../release-verify/stand.mjs'
import { CMS_ARCHIVES } from './fetch-cms.mjs'
import { STACK_STANDS } from './stacks.mjs'

// ─── Groups ───────────────────────────────────────────────────────────────────

/** Every group the stand knows, in the order a build runs them. */
export const STAND_GROUPS = Object.freeze([
  'import',
  'preview',
  'release',
  'browser',
  'safety',
  'safety-browser',
])

/**
 * The groups whose scenarios are written. `preview` comes with Э3.11, `release` with Э3.12,
 * `browser`, `safety` and `safety-browser` with Э8 and Э11: until then a group is never run, so
 * that an empty group never passes as a proof.
 */
export const WRITTEN_GROUPS = Object.freeze(['import'])

/**
 * The groups a build runs: `import`, `preview` and `release` always; `browser` when the stand walks
 * the panel, the stack opens it and the branch of the build has it open; `safety` when the stand has
 * its cases; `safety-browser` with both. The record of a stack names no group: a literal there would
 * drop a group added later. `support` — `StackSupport` of the adapter; without it no `browser`.
 */
export function groupsOf(stand, build, support = null) {
  const groups = ['import', 'preview', 'release']
  const branch = support?.generations?.find((row) => row.id === build.generation)
  const browser = Boolean(stand.walks) && support?.browser !== 'off' && branch?.browser === true
  if (browser) groups.push('browser')
  if (stand.safety) groups.push('safety')
  if (stand.safety && browser) groups.push('safety-browser')
  return groups
}

// ─── The records of the stacks ────────────────────────────────────────────────

/**
 * What every record of STACK_STANDS gives by now: the fields of `StackStand` this slice reads and
 * the three of `StackStandCases` (docs/plan/62-slices/e5.md, Э5.8) the group `import` reads —
 * `factsOf(build)` (what I1 expects in `stack_facts` beside the version, the branch and the limit),
 * `refusedLayout` ({ files, limit }, the tree of I4) and `refusedVersion` ({ files } or null — a
 * stack without `refuseBelow`, and I5 does not run). `signIn` joins with the group `preview`
 * (Э3.11), `edit`, `outsideWorkingSet` and `breakOnProduction` with `release` (Э3.12).
 * `scannerFinds(build)` is optional: when it says so, I2 requires the scanner to have dropped files.
 */
export const STAND_FIELDS = Object.freeze({
  stack: 'string',
  builds: 'object',
  database: 'object',
  install: 'function',
  markersInRepository: 'function',
  absentFromRepository: 'object',
  secrets: 'function',
  page: 'function',
  factsOf: 'function',
  refusedLayout: 'object',
  refusedVersion: 'object or null',
})
const BUILD = /^[a-z0-9][a-z0-9.-]{0,63}$/

const fits = (value, type) =>
  type === 'object or null' ? typeof value === 'object' : typeof value === type && value !== null
const isTree = (files) =>
  typeof files === 'object' &&
  files !== null &&
  Object.keys(files).length > 0 &&
  Object.values(files).every((text) => typeof text === 'string')

/** What is wrong with a record of a stack against the table of the archives; empty when nothing. */
export function standProblems(stand, archives = CMS_ARCHIVES) {
  const problems = []
  for (const [field, type] of Object.entries(STAND_FIELDS))
    if (stand === null || typeof stand !== 'object' || !Object.hasOwn(stand, field))
      problems.push(`no ${field}`)
    else if (!fits(stand[field], type)) problems.push(`no ${field}`)
  if (problems.length > 0) return problems
  if (!Array.isArray(stand.builds) || stand.builds.length === 0) problems.push('no build')
  else
    for (const build of stand.builds) {
      const row = archives[build.archive]
      if (!BUILD.test(build.archive ?? '') || !row)
        problems.push(`${build.archive}: no row of cms-archives.json`)
      else if (row.stack !== stand.stack) problems.push(`${build.archive}: a row of ${row.stack}`)
      else if (row.php !== build.php)
        problems.push(`${build.archive}: PHP ${build.php}, the table says ${row.php}`)
      if (typeof build.version !== 'string' || typeof build.generation !== 'string')
        problems.push(`${build.archive}: no version or generation`)
    }
  for (const key of ['name', 'user', 'prefix'])
    if (typeof stand.database[key] !== 'string') problems.push(`database: no ${key}`)
  if (!Array.isArray(stand.absentFromRepository)) problems.push('absentFromRepository: no list')
  if (!isTree(stand.refusedLayout.files) || typeof stand.refusedLayout.limit !== 'string')
    problems.push('refusedLayout: no files or limit')
  if (stand.refusedVersion !== null && !isTree(stand.refusedVersion.files))
    problems.push('refusedVersion: no files')
  if (stand.scannerFinds !== undefined && typeof stand.scannerFinds !== 'function')
    problems.push('scannerFinds: not a function')
  return problems
}

// ─── Options ──────────────────────────────────────────────────────────────────

export const RUNTIMES = Object.freeze(['runc', 'runsc'])
const USAGE =
  'pnpm verify:stack [-- --stack=<stack>] [--build=<id of cms-archives.json>]... [--group=<group>]... [--no-build] [--keep] [--runtime=runc|runsc]'
const refuse = (why) => {
  throw new Error(`verify:stack: ${why}. Usage: ${USAGE}`)
}

/**
 * The stacks, the builds and the groups of a run. By default every stack of STACK_STANDS, all its
 * builds and every written group a build runs, `runc`. `--stack`, `--build` and `--group` repeat;
 * a named build or group that no selected build runs is refused, and so is a group whose scenarios
 * are not written yet. Nothing names a database, an address or a key: the stand works only on what
 * it started itself. `runs` — one entry per build: its stack, the build and its groups.
 * `supports` — the `StackSupport` of each stack's adapter, by stack: `groupsOf` reads it for
 * `browser`. No stack of the stand opens the panel yet, so the stand passes none; Э8 passes the
 * support of the adapter here.
 */
export function standOptions(
  argv,
  { stands = STACK_STANDS, archives = CMS_ARCHIVES, supports = {} } = {},
) {
  const options = { build: true, keep: false, runtime: 'runc' }
  const named = { stacks: [], builds: [], groups: [] }
  for (const arg of argv.filter((value) => value !== '--')) {
    const [, key, value] = /^--([a-z-]+)(?:=(.*))?$/.exec(arg) ?? []
    if (arg === '--no-build') options.build = false
    else if (arg === '--keep') options.keep = true
    else if (key === 'runtime' && value !== undefined) {
      if (!RUNTIMES.includes(value)) refuse(`the runtime is one of ${RUNTIMES.join(', ')}`)
      options.runtime = value
    } else if (key === 'stack' && value) named.stacks.push(value)
    else if (key === 'build' && value) named.builds.push(value)
    else if (key === 'group' && value) named.groups.push(value)
    else
      refuse(
        'it accepts --stack, --build, --group, --no-build, --keep and --runtime only; it takes no database, address or key',
      )
  }
  const known = Object.keys(stands)
  for (const stack of named.stacks)
    if (!Object.hasOwn(stands, stack))
      refuse(`no stack ${stack}: the stacks of the stand are ${known.join(', ')}`)
  for (const group of named.groups)
    if (!STAND_GROUPS.includes(group))
      refuse(`no group ${group}: the groups are ${STAND_GROUPS.join(', ')}`)
  const stacks = named.stacks.length > 0 ? [...new Set(named.stacks)] : known
  const offered = stacks.flatMap((stack) =>
    stands[stack].builds.map((build) => ({ stack, stand: stands[stack], build })),
  )
  for (const id of named.builds) {
    if (!Object.hasOwn(archives, id)) refuse(`no build ${id} in cms-archives.json`)
    if (!offered.some(({ build }) => build.archive === id))
      refuse(`the build ${id} is not one of the stacks ${stacks.join(', ')}`)
  }
  const chosen =
    named.builds.length > 0
      ? offered.filter(({ build }) => named.builds.includes(build.archive))
      : offered
  const groupsOfBuild = (stack, stand, build) => groupsOf(stand, build, supports[stack] ?? null)
  const runs = chosen.map(({ stack, stand, build }) => ({
    stack,
    build,
    groups: groupsOfBuild(stack, stand, build).filter(
      (group) =>
        WRITTEN_GROUPS.includes(group) &&
        (named.groups.length === 0 || named.groups.includes(group)),
    ),
  }))
  for (const group of named.groups) {
    if (
      !chosen.some(({ stack, stand, build }) => groupsOfBuild(stack, stand, build).includes(group))
    )
      refuse(`the group ${group} runs on none of the chosen builds`)
    if (!WRITTEN_GROUPS.includes(group))
      refuse(`the scenarios of the group ${group} are not written yet`)
  }
  const unwritten = [
    ...new Set(
      chosen.flatMap(({ stack, stand, build }) =>
        groupsOfBuild(stack, stand, build).filter(
          (group) =>
            !WRITTEN_GROUPS.includes(group) &&
            (named.groups.length === 0 || named.groups.includes(group)),
        ),
      ),
    ),
  ]
  return { ...options, stacks, runs, unwritten }
}

// ─── Names ────────────────────────────────────────────────────────────────────

/** Every container, volume and network of a run carries `io.raditi.stack-verify=<run>`. */
export const STACK_LABEL = 'io.raditi.stack-verify'
const RUN = /^[0-9a-f]{8}$/

/**
 * Every resource of one run by name, of the same form as `standNames` of the release stand: the
 * arguments of its containers take it as they are.
 */
export function stackNames(run) {
  if (typeof run !== 'string' || !RUN.test(run)) throw new Error('Invalid run id of the stand')
  const stand = `raditi-stack-verify-${run}`
  return {
    run,
    stand,
    label: `${STACK_LABEL}=${run}`,
    containers: Object.fromEntries(CONTAINERS.map((name) => [name, `${stand}-${name}`])),
    network: `${stand}-site`,
    volumes: { docroot: `${stand}-docroot`, ca: `${stand}-ca` },
  }
}

/**
 * The names of one build: its production, its hosting, their network and the volumes of its
 * document root and its database. The rest is the run's.
 */
export function buildNames(names, archive) {
  if (!BUILD.test(archive ?? '')) throw new Error('Invalid id of a build')
  const prefix = `${names.stand}-${archive}`
  return {
    ...names,
    containers: { ...names.containers, prod: `${prefix}-prod`, hosting: `${prefix}-hosting` },
    network: `${prefix}-site`,
    volumes: { ...names.volumes, docroot: `${prefix}-docroot`, db: `${prefix}-db` },
  }
}

/** The label of core's turn containers in a run (Э0и): another core lists and collects only its own. */
export function sandboxDeployment(run) {
  if (typeof run !== 'string' || !RUN.test(run)) throw new Error('Invalid run id of the stand')
  return `stack-${run}`
}

// ─── Images ───────────────────────────────────────────────────────────────────

/**
 * The images of the release stand under names of this stand: no tag of another stand is moved.
 * `site` is not among them: a build runs the image of its PHP (`siteImageTag`).
 */
export const STACK_BUILT_IMAGES = Object.freeze(
  Object.fromEntries(
    Object.entries(BUILT_IMAGES)
      .filter(([name]) => name !== 'site')
      .map(([name, image]) => [
        name,
        Object.freeze({
          ...image,
          tag: image.tag.replace(/^raditi-release-verify\//, 'raditi-stack-verify/'),
        }),
      ]),
  ),
)

/** The image `site` of one PHP version, built as `pnpm verify:site-images` builds it. */
export function siteImageTag(php) {
  if (!/^\d\.\d$/.test(php)) throw new Error('Invalid PHP version')
  return `raditi-stack-verify/preview-site:${php}-local`
}

// ─── The production of a build ────────────────────────────────────────────────

/** The document root of a production; the hosting serves the same volume at the same path. */
export const PRODUCTION_ROOT = '/var/www/html'

const loopbackPort = (port) => {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error('Invalid port')
  return port
}

/**
 * The production container of a build (prod/entry.sh): the image `site` of its PHP, its database
 * inside, the document root in the volume the hosting serves, the site on a loopback port of this
 * machine and the database on another. Created, not started: the stand copies prod/ in first.
 */
export function productionArgs({ names, image, port }) {
  return [
    ...['create', '--pull', 'never', '--name', names.containers.prod, '--label', names.label],
    ...['--network', names.network, '-p', `127.0.0.1:${loopbackPort(port)}:80`],
    ...['-p', '127.0.0.1::3306'],
    ...['--mount', `type=volume,src=${names.volumes.docroot},dst=${PRODUCTION_ROOT}`],
    ...['--mount', `type=volume,src=${names.volumes.db},dst=/var/lib/mysql`],
    ...['--entrypoint', '/prod/entry.sh'],
    image,
  ]
}

// ─── Processes ────────────────────────────────────────────────────────────────

/**
 * The environment of core: that of the release stand, and over it the token of the provisioner of
 * repositories (the first import makes one), Gitleaks first on PATH, the label of this run's turn
 * containers and the `site` images of the chosen builds. The runtime of turns and previews stays
 * that of the release stand (`runc`): `--runtime` reaches core with Э3.13, and until then `runsc` is
 * refused before the start.
 */
export function stackCoreEnvironment(context) {
  const base = roleEnvironment('core', context)
  const images = Object.entries(context.siteImages ?? {})
  if (images.length === 0) throw new Error('core needs the site image of at least one build')
  return {
    ...base,
    PATH: `${dirname(context.gitleaks)}:${base.PATH}`,
    GITEA_PROVISIONER_TOKEN: context.secrets.provisionerToken,
    SANDBOX_DEPLOYMENT: sandboxDeployment(context.run),
    PREVIEW_SITE_IMAGES: images.map(([php, image]) => `${php}=${image}`).join(','),
  }
}

// ─── The scan of what the run left ───────────────────────────────────────────

/**
 * A search of `needles` in a stream that may be larger than memory allows: each chunk is searched
 * with the tail of the one before, so a needle cut between two chunks is found. `found()` gives the
 * indexes of the needles seen, never the needles.
 */
export function needleScanner(needles) {
  const bytes = needles.map((needle) => Buffer.from(needle, 'utf8'))
  const keep = Math.max(0, ...bytes.map((needle) => needle.length - 1))
  const seen = new Set()
  let tail = Buffer.alloc(0)
  return {
    push(chunk) {
      const window = Buffer.concat([tail, chunk])
      bytes.forEach((needle, index) => {
        if (!seen.has(index) && window.includes(needle)) seen.add(index)
      })
      tail = window.subarray(Math.max(0, window.length - keep))
    },
    found: () => [...seen].sort((a, b) => a - b),
  }
}
