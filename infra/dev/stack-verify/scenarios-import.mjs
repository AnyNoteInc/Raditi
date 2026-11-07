// The group `import` of the stand of the site stacks (verify-stack.mjs; docs/plan/62-site-stacks.md,
// Т48, Т66, М3; docs/plan/62-slices/e3.md, Э3.10): the real first import of a real CMS over SFTP —
// `project.create` of web with the owner's session, core, Gitleaks — on each build, and what it left
// everywhere. No row of the import is written by the stand; the stack is named only by the record of
// STACK_STANDS, the scenarios read what the record says.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { HOSTING_ROOT } from '../release-verify/stand.mjs'
import {
  databaseDump,
  foundNeedles,
  redisDump,
  secretNeedles,
} from '../site-import-verify/scenarios.mjs'
import { trpcClient } from '../site-import-verify/trpc.mjs'
import { rawCommand, writeHostingFolder } from './services.mjs'
import { needleScanner } from './stand.mjs'

const STAGE = 'code_import'
const TAG = 'v0.0.0'
/** A stage that has not ended in this time is a failure of the import, not a slow machine. */
const IMPORT_TIMEOUT_MS = 15 * 60_000

/** The stage of the first import of a site, polled until it is no longer queued or running. */
async function finishedStage(rt, db, siteId) {
  return rt.until(
    `the first import of ${siteId} ends`,
    async () => {
      const stage = await db.siteProvisioningStage.findFirst({ where: { siteId, stage: STAGE } })
      return stage && !['queued', 'running'].includes(stage.status) ? stage : null
    },
    { timeoutMs: IMPORT_TIMEOUT_MS, intervalMs: 1000 },
  )
}

/** The source of SFTP the wizard sends: the hosting of the build, its folder and its pinned key. */
function sftpSource(hosting, rootPath) {
  return {
    kind: 'sftp',
    host: '127.0.0.1',
    port: Number(hosting.access.port),
    username: hosting.access.username,
    auth: { method: 'password', password: hosting.access.password },
    rootPath,
    hostKey: hosting.access.hostKey,
  }
}

/** A repository of `sites` read by the administrator of the stand's Gitea. */
function repository(gitea, name) {
  const api = (path, expect) =>
    gitea.api('GET', `/repos/sites/${encodeURIComponent(name)}${path}`, {
      as: { token: gitea.tokens.admin },
      expect,
    })
  /** The commit a reference names; a lightweight tag names the commit itself. */
  const ref = async (name) => {
    const answer = await api(`/git/refs/${name}`, [200, 404])
    const found = [answer.json].flat().find((entry) => entry?.ref === `refs/${name}`)
    return found?.object?.type === 'commit' ? found.object.sha : null
  }
  return {
    /**
     * Gitea takes a push in on its own time: until then its API calls the repository empty (409)
     * and panics on the branch (Gitea 1.27.3). A precondition of the stand, never a check.
     */
    settled: (rt) =>
      rt.until(
        `Gitea took in the push to ${name}`,
        async () =>
          (await api('', 200)).json?.empty === false &&
          (await api('/branches/main', [200, 404, 500])).status === 200,
        { timeoutMs: 120_000, intervalMs: 1000 },
      ),
    // The references of git itself: the branch table of Gitea is filled after a push, on its own
    // time, and its API panics on a branch it has not synced yet (Gitea 1.27.3).
    branch: () => ref('heads/main'),
    tag: () => ref(`tags/${TAG}`),
    commits: async (sha) =>
      Number(
        (await api(`/commits?sha=${sha}&limit=1&stat=false&verification=false&files=false`, 200))
          .headers['x-total-count'],
      ),
    /** Whether the commit holds the path, a file or a folder. */
    holds: async (sha, path) => {
      const encoded = path.replace(/\/$/, '').split('/').map(encodeURIComponent).join('/')
      const answer = await api(`/contents/${encoded}?ref=${sha}`, [200, 404])
      return answer.status === 200
    },
  }
}

/** The repositories of `sites`, every one of them: what git would ever hand out. */
async function repositories(gitea) {
  const listed = await gitea.api('GET', '/orgs/sites/repos?limit=50', {
    as: { token: gitea.tokens.admin },
    expect: 200,
  })
  return listed.json.map((repo) => repo.name)
}

/**
 * Which needles every object of every repository of `sites` holds: each repository mirrored and its
 * objects streamed decompressed through `git cat-file --batch-all-objects --batch` into a scanner.
 * The object store of a CMS is larger than the output a helper of the import stand keeps, so the
 * stream is searched as it goes and never held whole.
 */
async function repositoryNeedles(rt, { gitea, directory, caFile }, needles) {
  const work = join(directory, 'objects')
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true, mode: 0o700 })
  const basic = Buffer.from(`${gitea.bot.user}:${gitea.tokens.bot}`).toString('base64')
  const env = {
    PATH: process.env.PATH,
    HOME: join(directory, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSL_CAINFO: caFile,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  }
  const scanner = needleScanner(needles)
  const scanned = []
  for (const name of await repositories(gitea)) {
    const target = join(work, `${name}.git`)
    await rawCommand(
      rt,
      'git',
      ['clone', '--quiet', '--mirror', `${gitea.base}/sites/${name}.git`, target],
      { env, timeoutMs: 600_000 },
    )
    await new Promise((done, reject) => {
      const child = spawn('git', ['cat-file', '--batch-all-objects', '--batch'], {
        cwd: target,
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        signal: AbortSignal.any([rt.signal, AbortSignal.timeout(600_000)]),
      })
      child.stdout.on('data', (chunk) => scanner.push(chunk))
      child.once('error', reject)
      child.once('close', (code) =>
        code === 0 ? done() : reject(new Error(`git cat-file of ${name} exited ${code}`)),
      )
    })
    scanned.push(name)
  }
  await rm(work, { recursive: true, force: true })
  return { found: scanner.found(), repositories: scanned }
}

/** The import stand's view of this stand, for its dumps of PostgreSQL and Redis. */
function dumpTarget(rt, names) {
  return {
    stand: {
      coordinates: {
        postgres: { container: names.containers.postgres },
        redis: { container: names.containers.redis },
      },
    },
    docker: async (args, options = {}) => ({
      stdout: (await rawCommand(rt, 'docker', args, options)).toString('utf8'),
    }),
  }
}

/** I1 and I2 of one build: `project.create`, the stage, the record of the site, its repository. */
async function importBuild(rt, ctx, entry) {
  const { db, gitea } = ctx
  const { stand, build, production, hosting } = entry
  const client = trpcClient({ origin: ctx.webUrl, cookie: ctx.owner.cookie(), signal: rt.signal })

  rt.begin(`I1 ${build.archive}`, 'импорт с SFTP настоящей сборки')
  const outcome = await client.mutation('project.create', {
    requestKey: randomUUID(),
    name: `Стенд ${build.archive}`,
    url: entry.siteUrl,
    stack: stand.stack,
    source: sftpSource(hosting, HOSTING_ROOT),
    database: {
      engine: 'mysql',
      host: '127.0.0.1',
      port: production.dbPort,
      database: stand.database.name,
      username: stand.database.user,
      password: production.dbPassword,
      tls: 'plain',
    },
  })
  rt.check(outcome.outcome === 'created', 'project.create answered created', outcome)
  const siteId = outcome.project.id
  entry.siteId = siteId
  ctx.siteIds.push(siteId)
  const stage = await finishedStage(rt, db, siteId)
  rt.check(stage.status === 'succeeded', 'the stage code_import succeeded', {
    status: stage.status,
    error: stage.errorCode,
  })
  const site = await db.site.findUniqueOrThrow({ where: { id: siteId } })
  rt.check(
    site.status === 'active' && site.stack === stand.stack,
    `the site is active, of the stack ${stand.stack}`,
    { status: site.status, stack: site.stack },
  )
  const facts = site.stackFacts ?? {}
  rt.check(
    facts.cmsVersion === build.version && facts.generation === build.generation,
    `stack_facts: version ${build.version}, generation ${build.generation}`,
    { cmsVersion: facts.cmsVersion, generation: facts.generation },
  )
  rt.check((facts.limit ?? null) === null, 'stack_facts: no limit', { limit: facts.limit })
  for (const [key, value] of Object.entries(stand.factsOf(build)))
    if (value !== null && typeof value === 'object')
      rt.check(
        Object.entries(value).every(([name, held]) => facts[key]?.[name] === held),
        `stack_facts.${key}: ${Object.keys(value).join(', ')}`,
        facts[key],
      )
    else rt.check(facts[key] === value, `stack_facts.${key} is ${value}`, { [key]: facts[key] })
  const repo = repository(gitea, `site-${siteId}`)
  await repo.settled(rt)
  const main = await repo.branch()
  rt.check(
    main !== null && (await repo.tag()) === main && (await repo.commits(main)) === 1,
    `the tag ${TAG} on the one commit of main`,
  )
  rt.end()

  rt.begin(`I2 ${build.archive}`, 'дерево в репозитории')
  for (const path of stand.markersInRepository(build))
    rt.check(await repo.holds(main, path), `main holds ${path}`)
  for (const path of stand.absentFromRepository)
    rt.check(!(await repo.holds(main, path)), `main does not hold ${path}`)
  // Т48: the scanner drops files and the import goes on — on Joomla four files of libraries/vendor
  // on 4.4, 5.4 and 6.2 (Т48 named 5.4 and 6.2; plan 62, §10, Э3.10). The number is not pinned.
  const skipped = stage.summary?.skipped ?? {}
  if (stand.scannerFinds?.(build))
    rt.check(
      (skipped.secret ?? 0) > 0,
      'the scanner dropped files, and the import went on',
      skipped,
    )
  rt.note(`the import skipped ${JSON.stringify(skipped)}`)
  rt.end()
}

/**
 * I3 of every build: the values of each production that are nowhere on the platform — in no object
 * of any repository, in the dump of PostgreSQL, in Redis, in the output of core and web. Each place
 * is searched once for every build; a row per build says what its own values were found in.
 */
async function secretsOfBuilds(rt, ctx, entries) {
  const owners = []
  const values = []
  for (const entry of entries) {
    const own = [
      ...(await entry.stand.secrets(entry.production)),
      entry.production.dbPassword,
      entry.hosting.access.password,
    ]
    for (const value of secretNeedles(own)) {
      values.push(value)
      owners.push(entry)
    }
  }
  // Controls, searched with the secrets: what each place does hold — the name of a file every
  // repository has, the id of each site in the database and in the output of core, the keys of the
  // queue of the import in Redis, the banner of Next.js in the output of web. A scan that finds
  // them is a scan that would have found a secret.
  const marker = entries[0].stand.markersInRepository(entries[0].build).at(-1).split('/').at(-1)
  const controls = { [marker]: ['git'], 'bull:site-import:': ['redis'], 'Next.js': ['web'] }
  for (const entry of entries) controls[entry.siteId] = ['postgres', 'core']
  const needles = [...values, ...Object.keys(controls)]
  const places = []
  const scanned = await repositoryNeedles(rt, ctx, needles)
  places.push(['git', `git objects of ${scanned.repositories.length} repositories`, scanned.found])
  const { stand, docker } = dumpTarget(rt, ctx.names)
  places.push([
    'postgres',
    'the dump of PostgreSQL',
    foundNeedles(await databaseDump(stand, docker), needles),
  ])
  places.push([
    'redis',
    'the keys and values of Redis',
    foundNeedles(await redisDump(stand, docker), needles),
  ])
  for (const name of ['core', 'web'])
    places.push([
      name,
      `the output of ${name}`,
      foundNeedles(Buffer.from(ctx.processes[name].log(), 'utf8'), needles),
    ])
  const missed = Object.entries(controls).flatMap(([control, where], index) =>
    where
      .filter((key) => !places.find(([place]) => place === key)[2].includes(values.length + index))
      .map((key) => `${control} in ${key}`),
  )
  // The repository of the site of every build is among those scanned.
  const unscanned = entries
    .map((entry) => `site-${entry.siteId}`)
    .filter((name) => !scanned.repositories.includes(name))

  for (const entry of entries) {
    rt.begin(`I3 ${entry.build.archive}`, 'ни одного секрета')
    rt.check(
      owners.filter((owner) => owner === entry).length >= 4,
      'the values of the configuration, the database and the hosting are searched',
    )
    rt.check(
      missed.length === 0,
      'control: each scan finds what its place holds (a file of git, the ids of the sites, the queue, Next.js)',
      missed,
    )
    rt.check(
      unscanned.length === 0,
      'the repository of the site of every build is scanned',
      unscanned,
    )
    for (const [, place, found] of places) {
      const own = found.filter((index) => index < values.length && owners[index] === entry)
      rt.check(own.length === 0, `no secret of the production in ${place}`, {
        values: own.length,
      })
    }
    rt.end()
  }
}

/**
 * I4 and I5, once per stack: synthetic trees the stand writes on the hosting of the first build.
 * I5 goes first: a refused `project.create` writes no site, so I4 then takes the same address. A
 * stack whose `refusedVersion` is null refuses no version, and I5 does not run.
 */
async function refusedTrees(rt, ctx, entry) {
  const { db } = ctx
  const { stand, production, hosting } = entry
  const client = trpcClient({ origin: ctx.webUrl, cookie: ctx.owner.cookie(), signal: rt.signal })
  const url = `http://127.0.0.1:${production.port}`

  if (stand.refusedVersion !== null) {
    rt.begin(`I5 ${stand.stack}`, 'версия ниже поддержки')
    const old = '/stand-roots/old'
    await writeHostingFolder(rt, hosting.names, old, stand.refusedVersion.files)
    const refused = await client.mutation('project.create', {
      requestKey: randomUUID(),
      name: `Старая версия ${stand.stack}`,
      url,
      stack: stand.stack,
      source: sftpSource(hosting, old),
      database: null,
    })
    rt.check(
      refused.outcome === 'source_refused' && refused.reason === 'version_unsupported',
      'project.create refuses version_unsupported',
      refused,
    )
    rt.check((await db.site.count({ where: { url } })) === 0, 'nothing of the site is written')
    rt.end()
  }

  const { files, limit } = stand.refusedLayout
  rt.begin(`I4 ${stand.stack}`, 'раскладка, которую стек не берёт')
  const refusedRoot = '/stand-roots/layout'
  await writeHostingFolder(rt, hosting.names, refusedRoot, files)
  const outcome = await client.mutation('project.create', {
    requestKey: randomUUID(),
    name: `Раскладка ${stand.stack}`,
    url,
    stack: stand.stack,
    source: sftpSource(hosting, refusedRoot),
    database: null,
  })
  rt.check(outcome.outcome === 'created', 'project.create answered created', outcome)
  const siteId = outcome.project.id
  ctx.siteIds.push(siteId)
  const stage = await finishedStage(rt, db, siteId)
  rt.check(
    stage.status === 'failed' && stage.errorCode === 'layout_unsupported',
    'the stage failed with layout_unsupported',
    { status: stage.status, error: stage.errorCode },
  )
  const site = await db.site.findUniqueOrThrow({ where: { id: siteId } })
  rt.check(site.stackFacts?.limit === limit, `stack_facts.limit is ${limit}`, {
    limit: site.stackFacts?.limit,
  })
  rt.check(
    site.status === 'onboarding' && site.deletedAt === null,
    'the site stays onboarding, the project is not deleted',
    { status: site.status },
  )
  rt.end()
}

/**
 * The group `import` on the chosen builds: I1 and I2 per build, I5 and I4 per stack, then I3 per
 * build — last, so that the search covers what the refusals left too: the hosting's password goes
 * through their checks of SFTP as well.
 */
export async function runImportGroup(rt, ctx, entries) {
  for (const entry of entries) await importBuild(rt, ctx, entry)
  const stacks = new Map()
  for (const entry of entries) if (!stacks.has(entry.stack)) stacks.set(entry.stack, entry)
  for (const entry of stacks.values()) await refusedTrees(rt, ctx, entry)
  await secretsOfBuilds(rt, ctx, entries)
}
