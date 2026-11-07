// Pure parts of the stand of the site stacks (verify-stack.mjs; docs/plan/62-site-stacks.md, Т66,
// §5.5; docs/plan/62-slices/e3.md, Э3.10): its options, the groups a build runs, the names of
// everything a run owns, the images it builds under names of its own, the arguments of the
// production container of a build and the environment of core. The services, the builds and the
// scenarios of the release stand are taken as they are (infra/dev/release-verify); nothing here
// touches Docker, the network or a file but the two tables the stand reads.
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

import { BUILT_IMAGES, CONTAINERS, roleEnvironment, turnResult } from '../release-verify/stand.mjs'
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
 * The groups whose scenarios are written. `browser`, `safety` and `safety-browser` come with Э8
 * and Э11: until then a group is never run, so that an empty group never passes as a proof.
 */
export const WRITTEN_GROUPS = Object.freeze(['import', 'preview', 'release'])

/**
 * The groups a group runs on the results of: `preview` opens the site `import` made (Э3.11);
 * `release` takes that site after `preview` closed its dialog (Э3.12). A named group brings these
 * with it.
 */
export const GROUP_NEEDS = Object.freeze({
  preview: Object.freeze(['import']),
  release: Object.freeze(['import', 'preview']),
})

/**
 * The first letter of the rows a written group adds to the final table: `I1 <archive>`,
 * `P5 <archive> <engine>`, `R6 <archive>`… A group written later adds its letter with its scenarios.
 */
export const GROUP_ROWS = Object.freeze({ import: 'I', preview: 'P', release: 'R' })

/**
 * What the final table of a run lacks: each build of `runs` has, for each of its groups, at least
 * one row of that group that names its archive and ended. Without it a group dropped by a filter or
 * a missing call would pass as a shorter table.
 */
export function groupRowProblems(runs, rows) {
  const problems = []
  for (const { build, groups } of runs)
    for (const group of groups) {
      const letter = GROUP_ROWS[group]
      if (!letter) {
        problems.push(`the group ${group} has no letter of its rows`)
        continue
      }
      const ran = rows.some((row) => {
        const [id, ...rest] = row.id.split(' ')
        return row.ok && id[0] === letter && rest.includes(build.archive)
      })
      if (!ran) problems.push(`no row of the group ${group} names ${build.archive}`)
    }
  return problems
}

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
 * stack without `refuseBelow`, and I5 does not run). `copyChecks`, `browserPaths` and `signIn` —
 * the group `preview` (Э3.11); `edit(build)` (`{ template, style, texts }`: `template` —
 * `{ path, before, line }`, the line goes right before the tag; `style` and `texts` —
 * `{ path, line, created }`, the line is appended, `created` — the supply has no such file; one of
 * `template` and `style` at least), `outsideWorkingSet` (a path R2 may not add) and
 * `breakOnProduction(build)` (the line R4 breaks production only with) — the group `release`
 * (Э3.12).
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
  copyChecks: 'function',
  browserPaths: 'object',
  signIn: 'function',
  edit: 'function',
  outsideWorkingSet: 'string',
  breakOnProduction: 'function',
})
const BUILD = /^[a-z0-9][a-z0-9.-]{0,63}$/

const RELATIVE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

/** An edit of R1: a template with its tag or a style, and every part named by a relative path. */
function editIsWhole(edit) {
  const named = (part) => RELATIVE_PATH.test(part?.path ?? '') && typeof part.line === 'string'
  const { template = null, style = null, texts = null } = edit ?? {}
  if (template === null && style === null) return false
  if (template !== null && !(named(template) && typeof template.before === 'string')) return false
  return [style, texts].every((part) => part === null || named(part))
}

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
  const { closed, open } = stand.browserPaths
  if (
    !Array.isArray(closed) ||
    closed.length === 0 ||
    ![...closed, open].every((path) => typeof path === 'string' && path.startsWith('/'))
  )
    problems.push('browserPaths: no closed paths or no open one')
  for (const build of Array.isArray(stand.builds) ? stand.builds : []) {
    const sign = stand.signIn(build)
    const named = ['path', 'submit', 'signedIn'].every((key) => typeof sign?.[key] === 'string')
    if (
      !named ||
      typeof sign.fields?.login !== 'string' ||
      typeof sign.fields?.password !== 'string' ||
      !Array.isArray(sign.lostCookie) ||
      typeof sign.setPassword !== 'function'
    )
      problems.push(`${build.archive}: signIn is not whole`)
    // What a turn edits is a fact of the branch: a build that names none is reported above.
    if (typeof build.generation !== 'string') continue
    if (!editIsWhole(stand.edit(build)))
      problems.push(`${build.archive}: edit names no template and no style`)
    const broken = stand.breakOnProduction(build)
    if (typeof broken !== 'string' || broken.trim() === '' || /\n/.test(broken))
      problems.push(`${build.archive}: breakOnProduction is no line`)
  }
  if (!RELATIVE_PATH.test(stand.outsideWorkingSet))
    problems.push('outsideWorkingSet: no relative path')
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
 * a named group brings the groups it needs (`GROUP_NEEDS`: `preview` runs on the site of `import`);
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
  // A named group brings the groups it runs on the results of (`GROUP_NEEDS`).
  const wanted =
    named.groups.length === 0
      ? null
      : new Set(named.groups.flatMap((group) => [group, ...(GROUP_NEEDS[group] ?? [])]))
  const asked = (group) => wanted === null || wanted.has(group)
  const runs = chosen.map(({ stack, stand, build }) => ({
    stack,
    build,
    groups: groupsOfBuild(stack, stand, build).filter(
      (group) => WRITTEN_GROUPS.includes(group) && asked(group),
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
          (group) => !WRITTEN_GROUPS.includes(group) && asked(group),
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

// ─── What the scenarios of the preview read ──────────────────────────────────

/** An id of a chat: UUID version 7, as the cabinet makes it (CHECK tasks_chat_id_check). */
export function uuid7(now = Date.now(), random = randomBytes(16)) {
  const bytes = Buffer.from(random)
  const time = BigInt(now)
  for (let index = 0; index < 6; index++)
    bytes[index] = Number((time >> BigInt(8 * (5 - index))) & 0xffn)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The values of the attributes of a page that name an address: links, sources, forms. */
const LINK_ATTRIBUTES =
  /\b(?:href|src|action|content|data-src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi

/** The canonical links of a page, as written (`<link rel="canonical" href="…">`, either order). */
export function canonicalLinks(html) {
  const links = []
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']?canonical\b/i.test(tag)) continue
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
    if (href) links.push((href[1] ?? href[2]).replaceAll('&amp;', '&'))
  }
  return links
}

/**
 * What is wrong with a page of a preview (P2): an error of PHP in it, a link to the production —
 * its exact host and port, `http://localhost:<port>` — or a canonical link off the preview's own
 * origin. Empty when nothing.
 */
export function pageProblems(html, { productionOrigin, previewOrigin }) {
  const problems = []
  for (const marker of ['Fatal error', 'Warning:']) if (html.includes(marker)) problems.push(marker)
  const production = new URL(productionOrigin)
  const host = production.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const named = new RegExp(`(?<![\\w.-])${host}(?!\\d)`)
  for (const [, double, single] of html.matchAll(LINK_ATTRIBUTES)) {
    const value = (double ?? single).replaceAll('\\/', '/')
    if (named.test(value)) problems.push(`a link to production: ${value.slice(0, 120)}`)
  }
  for (const link of canonicalLinks(html)) {
    const origin = URL.parse(link, `${previewOrigin}/`)?.origin
    if (origin !== previewOrigin)
      problems.push(`a canonical link off the preview: ${link.slice(0, 120)}`)
  }
  return problems
}

/** The text of the content of a message of a chat request, its parts joined. */
const messageText = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
      : ''

/**
 * The calls of tools of a turn and what the CLI sent back for each, read from the body of a chat
 * request of the synthetic Z.ai: `{ name, args, result }` in the order of the calls. A call the CLI
 * answered nothing to has `result` null.
 */
export function toolCallsOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const results = new Map(
    messages
      .filter((message) => message?.role === 'tool')
      .map((message) => [message.tool_call_id, messageText(message.content)]),
  )
  const calls = []
  for (const message of messages)
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls))
      for (const call of message.tool_calls) {
        let args = null
        try {
          args = JSON.parse(call?.function?.arguments ?? 'null')
        } catch {
          // Unreadable arguments: kept null.
        }
        calls.push({
          name: call?.function?.name ?? null,
          args,
          result: results.get(call?.id) ?? null,
        })
      }
  return calls
}

/** The code of a refusal of a tool of the platform in its result (`{"code":"BROWSER_…"}`). */
export function refusalCode(result) {
  const found = /"code"\s*:\s*"([A-Z_]+)"/.exec(String(result ?? '').replaceAll('\\"', '"'))
  return found?.[1] ?? null
}

/** The answer of a navigation of the agent's browser: the status of the page, or null. */
export function navigationStatus(result) {
  const found = /"status"\s*:\s*(\d{3})/.exec(String(result ?? '').replaceAll('\\"', '"'))
  return found ? Number(found[1]) : null
}

/**
 * The turn of P4 (Э3.11): `browser_navigate` on the home page, on every closed path of the stack and
 * on its open one, a call a round, then an answer that changes nothing. Tools of the browser only:
 * no tool of content, no command.
 */
export function browserTurn({ closed, open }) {
  return {
    scenario: 'tools',
    rounds: ['/', ...closed, open].map((path) => [
      { name: 'raditi_browser_navigate', arguments: { path } },
    ]),
    text: turnResult({
      summary: 'Looked at the site in the browser',
      changeType: 'none',
      message: 'Посмотрели сайт в браузере, менять ничего не нужно.',
    }),
  }
}
