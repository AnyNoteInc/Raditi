// `pnpm verify:site-import [-- --infra-only | --only <ids>] [--keep]`: the whole first import of
// a connected site on real servers (docs/plan/39-site-connection-wizard.md, W5). The stand
// (stand.mjs) brings up the platform's services, two hostings with SFTP and FTP(S), the site's
// MySQL and PostgreSQL, core from apps/orchestrator/dist and next dev of apps/web; then
//
//   infra   the self-checks of the stand (infra-checks.mjs);
//   phase 0 core stopped: the site of r6 is created and its password changed on the hosting;
//   phase 1 the browser (Playwright, apps/e2e/playwright.site-import.config.ts) drives the wizard
//           — b1 also proves the setup screen while core is still stopped, then has it started —
//           while the stand drives r3 and r4 through the cabinet's own API;
//           every imported site is then checked from outside (scenarios.mjs, verifySite);
//   phase 2 alone on the stand: r1 (kill -9 of core), r2 (SIGTERM), r5 (the hosting away);
//   last    nothing secret anywhere — the database, Redis, every git object, the logs of core and
//           web —, the site databases saw no read of a table and no write, the hostings are as
//           they were, OpenBao holds no access without its reference.
//
// No .env, no pull, no real account. Output names checks, never a secret.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

import { cleanEnvironment } from '../../../apps/orchestrator/scripts/verify-agent-supervisor.mjs'
import { createAccounts } from './accounts.mjs'
import { startControl } from './control.mjs'
import { runInfraChecks, stage as infraStage } from './infra-checks.mjs'
import {
  Report,
  assertPendingEvent,
  assertReadOnlyStatements,
  clientOf,
  createProject,
  databaseDump,
  foundNeedles,
  projectUrl,
  redisDump,
  repositoryObjects,
  scenarioInterruptions,
  scenarioMismatch,
  scenarioTagMissing,
  secretNeedles,
  sftpSource,
  waitStage,
  verifySite,
} from './scenarios.mjs'
import {
  BROWSER_SCENARIOS,
  SCENARIO_IDS,
  browserStand,
  playwrightGrep,
  scenarioAccounts,
  siteExpectations,
  startStand,
  standOptions,
} from './stand.mjs'

const here = fileURLToPath(new URL('./', import.meta.url))
const repository = resolve(here, '../../..')

const controller = new AbortController()
let interrupted = false
const interrupt = () => {
  interrupted = true
  controller.abort(new Error('The stand was interrupted'))
}
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** A 0600 copy outside the run directory, which is removed: the logs of a failed run. */
async function keepAside(stand, text) {
  try {
    const directory = await mkdtemp(join(tmpdir(), 'raditi-siteimport-diagnostic-'))
    await chmod(directory, 0o700)
    await writeFile(join(directory, 'failure.log'), text.slice(-512 * 1024), { mode: 0o600 })
    if (stand)
      for (const name of ['core.log', 'web.log', 'playwright.log']) {
        const log = await readFile(join(stand.logsDir, name), 'utf8').catch(() => null)
        if (log !== null) await writeFile(join(directory, name), stand.redact(log), { mode: 0o600 })
      }
    if (stand)
      await cp(join(stand.directory, 'playwright', 'results'), join(directory, 'playwright'), {
        recursive: true,
      }).catch(() => {})
    return directory
  } catch {
    return null
  }
}

/** Every spec of a Playwright JSON report: `[id] title`, whether it passed, its first error. */
function playwrightResults(report) {
  const specs = []
  const walk = (suite) => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? []) {
        const last = test.results?.at(-1)
        specs.push({
          title: spec.title,
          id: /^\[([a-z0-9]+)\]/.exec(spec.title)?.[1] ?? 'browser',
          status: test.status,
          error: (last?.error?.message ?? last?.errors?.[0]?.message ?? '')
            // eslint-disable-next-line no-control-regex -- the colours of Playwright's messages.
            .replace(/\u001b\[[0-9;]*m/g, '')
            .split('\n')
            .slice(0, 6)
            .join(' | '),
        })
      }
    for (const child of suite.suites ?? []) walk(child)
  }
  for (const suite of report.suites ?? []) walk(suite)
  return specs
}

/** `pnpm --filter e2e exec playwright test -c playwright.site-import.config.ts`, its output kept. */
function runPlaywright(stand, { standFile, grep, signal, print }) {
  return new Promise((done) => {
    const child = spawn(
      'pnpm',
      [
        ...['--filter', 'e2e', 'exec', 'playwright', 'test'],
        ...['-c', 'playwright.site-import.config.ts', '--grep', grep],
      ],
      {
        cwd: repository,
        env: {
          ...cleanEnvironment(process.env),
          SITE_IMPORT_STAND_FILE: standFile,
          PLAYWRIGHT_HTML_OPEN: 'never',
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    )
    let log = ''
    const capture = (chunk) => {
      const text = stand.redact(chunk.toString('utf8'))
      log += text
      for (const line of text.split('\n'))
        if (/^\s+(?:✓|✘|ok|x|-)\s+\d+ |passed|failed|flaky/.test(line))
          print(`  playwright ${line.trim()}`)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const stop = () => {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
    signal.addEventListener('abort', stop, { once: true })
    child.once('close', async (code) => {
      signal.removeEventListener('abort', stop)
      await writeFile(join(stand.logsDir, 'playwright.log'), log, { mode: 0o600 }).catch(() => {})
      done({ code, log })
    })
    child.once('error', () => done({ code: null, log }))
  })
}

async function runScenarios(stand, { selected, report, print }) {
  const signal = controller.signal
  const redact = stand.redact
  const docker = (args, options = {}) => stand.docker(args, options)
  const run = stand.run

  // ── Baselines: what the site databases and the hostings were before any scenario ──────────
  const baseline = {
    site: await stand.siteServer.snapshot(),
    spare: await stand.spareServer.snapshot(),
    mysql: (await stand.siteDatabases.mysql.statements()).length,
    postgres: (await stand.siteDatabases.postgres.statements()).length,
  }

  print('site-import starting next dev of apps/web')
  await stand.web.start({
    onWait: (pids) =>
      print(
        `site-import another next dev of apps/web runs (pid ${pids.join(', ')}): waiting for it to end, it is not stopped`,
      ),
  })
  report.pass('stand', `next dev of apps/web answers on ${stand.web.origin}`)

  const accounts = await createAccounts({
    repository,
    databaseUrl: stand.env.web.DATABASE_URL,
    webEnv: stand.env.web,
    ids: scenarioAccounts(selected),
  })
  // The first compile of the pages and of the API, before any test waits on it.
  const warm = Object.values(accounts)[0]
  if (warm) {
    for (const path of ['/projects', '/projects/new'])
      await fetch(`${stand.web.origin}${path}`, {
        headers: { cookie: warm.cookie },
        signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
      }).then((response) => response.arrayBuffer())
    await clientOf(stand, warm, signal).query('project.list', undefined)
  }
  report.pass(
    'stand',
    `${Object.keys(accounts).length} cabinet users signed in; the pages and the API compiled`,
  )

  const sites = {}
  const extras = {}
  const { siteIdForRequest } = await import(
    pathToFileURL(join(repository, 'packages/trpc/src/services/site-request-id.ts')).href
  )
  const r4Key = randomUUID()
  if (accounts.r4) extras.r4 = siteIdForRequest(accounts.r4.userId, r4Key)

  // ── Phase 0: core is not running ──────────────────────────────────────────────────────────
  if (selected.includes('r6'))
    await report.run(
      'r6',
      async () => {
        const client = clientOf(stand, accounts.r6, signal)
        const { siteb } = stand.secrets
        const siteId = await createProject(client, {
          name: 'R6 replaced access',
          url: projectUrl(run, 'r6'),
          source: sftpSource(stand, { user: siteb.user, password: siteb.password }),
        })
        await assertPendingEvent(stand, siteId)
        await stand.siteServer.setPassword(siteb.user, siteb.newPassword)
        sites.r6 = siteId
        extras.r6 = siteId
        report.pass(
          'r6',
          'created with core stopped (the event holds exactly the ids); the password of siteb changed on the hosting',
        )
      },
      redact,
    )

  // ── Phase 1: the browser, and r3 and r4 by the stand ──────────────────────────────────────
  let coreStarted
  const started = new Promise((done) => {
    coreStarted = done
  })
  const startCore = async () => {
    if (!stand.core.running()) await stand.core.start()
    coreStarted()
  }
  const browser = selected.filter((id) => BROWSER_SCENARIOS.includes(id))
  const control = await startControl({
    token: randomBytes(24).toString('hex'),
    log: () => {},
    actions: {
      '/core/start': async () => {
        // b1 left its project waiting: the event of its stage is still pending, ids only.
        const { rows } = await stand.db.query(
          `SELECT s.id FROM sites s JOIN workspaces w ON w.id = s.workspace_id WHERE w.created_by_id = $1::uuid`,
          [accounts.b1?.userId ?? '00000000-0000-0000-0000-000000000000'],
        )
        if (rows.length === 1) {
          await assertPendingEvent(stand, rows[0].id)
          report.pass(
            'b1',
            'while core was stopped the event of the stage held exactly { siteId, stage }',
          )
        }
        await startCore()
        return { started: true }
      },
      '/spare/host-key/first': () => stand.spareServer.useHostKey('first'),
      '/spare/host-key/second': () => stand.spareServer.useHostKey('second'),
    },
  })
  stand.closeLater(() => control.close())
  if (!browser.includes('b1')) await startCore()

  const standFile = join(stand.directory, 'playwright', 'stand.json')
  await mkdir(join(stand.directory, 'playwright'), { recursive: true, mode: 0o700 })
  await writeFile(
    standFile,
    JSON.stringify(
      browserStand(stand, {
        accounts,
        control,
        extras,
        holdCore: browser.includes('b1') && !stand.core.running(),
        browser,
      }),
    ),
    { mode: 0o600 },
  )
  const playwright = browser.length
    ? runPlaywright(stand, { standFile, grep: playwrightGrep(browser), signal, print }).then(
        async (result) => {
          // A run that ended before b1 asked for core still needs it for what follows.
          await startCore()
          return result
        },
      )
    : Promise.resolve(null)

  const flows = []
  if (selected.includes('r3'))
    flows.push(
      report.run(
        'r3',
        async () => {
          await started
          sites.r3 = await scenarioTagMissing(stand, { account: accounts.r3, run, report, signal })
        },
        redact,
      ),
    )
  if (selected.includes('r4'))
    flows.push(
      report.run(
        'r4',
        async () => {
          await started
          const result = await scenarioMismatch(stand, {
            account: accounts.r4,
            run,
            report,
            signal,
            requestKey: r4Key,
          })
          assert.equal(result.siteId, extras.r4, 'The id of the site is the one its request names')
          sites.r4 = result.siteId
          extras.foreign = result.foreign
        },
        redact,
      ),
    )
  if (selected.includes('r6'))
    flows.push(
      report.run(
        'r6',
        async () => {
          await started
          const stage = await waitStage(stand, sites.r6, (row) => row.status === 'failed', {
            what: 'R6 to fail on the changed password',
            timeoutMs: 120_000,
          })
          assert.equal(stage.error_code, 'auth_failed')
          report.pass(
            'r6',
            'the import failed auth_failed: the hosting no longer takes the saved password',
          )
        },
        redact,
      ),
    )
  const [browserRun] = await Promise.all([playwright, ...flows])

  if (browserRun) {
    const reportFile = join(stand.directory, 'playwright', 'report.json')
    const parsed = await readFile(reportFile, 'utf8')
      .then((text) => playwrightResults(JSON.parse(text)))
      .catch(() => null)
    if (!parsed)
      report.fail('browser', new Error(`Playwright left no report (exit ${browserRun.code})`))
    else
      for (const spec of parsed) {
        if (spec.status === 'expected') report.pass(spec.id, `browser: ${spec.title}`)
        else if (spec.status === 'skipped') report.skip(spec.id, `browser: ${spec.title}`)
        else report.fail(spec.id, new Error(`browser: ${spec.title}: ${spec.error}`), redact)
      }
  }

  // Every site the browser made, found by its account: one per scenario, none for b4.
  for (const id of ['b1', 'b2', 'b3', 'b5', 'r6'].filter((key) => selected.includes(key))) {
    const { rows } = await stand.db.query(
      `SELECT s.id FROM sites s JOIN workspaces w ON w.id = s.workspace_id WHERE w.created_by_id = $1::uuid`,
      [accounts[id].userId],
    )
    if (rows.length !== 1) report.fail(id, new Error(`${rows.length} sites for the account, not 1`))
    else sites[id] = rows[0].id
  }
  if (selected.includes('b4'))
    await report.run(
      'b4',
      async () => {
        for (const id of scenarioAccounts(['b4'])) {
          const { rows } = await stand.db.query(
            `SELECT count(*)::int AS n FROM sites s JOIN workspaces w ON w.id = s.workspace_id WHERE w.created_by_id = $1::uuid`,
            [accounts[id].userId],
          )
          assert.equal(rows[0].n, 0, `${id}: a refused step made no project`)
        }
        report.pass('b4', 'none of the refusals made a project, a stage or an event')
      },
      redact,
    )

  // ── Phase 2: alone on the stand ───────────────────────────────────────────────────────────
  const interruptions = selected.filter((id) => ['r1', 'r2', 'r5'].includes(id))
  if (interruptions.length > 0) {
    Object.assign(
      sites,
      await scenarioInterruptions(stand, { accounts, run, report, signal, selected }),
    )
  }

  // ── Every imported site, from outside ─────────────────────────────────────────────────────
  for (const [id, siteId] of Object.entries(sites)) {
    if (!siteId) continue
    await report.run(
      id,
      async () => {
        const spec = siteExpectations(id, { foreign: extras.foreign })
        await verifySite(stand, siteId, spec)
        report.pass(
          id,
          `site ${siteId.slice(0, 8)}: rows, references and OpenBao versions, one root commit by Raditi Bot, main and the lightweight v0.0.0, the tree of the manifest (${stand.fixture.expected(spec.auth).files.length} files)`,
        )
      },
      redact,
    )
  }

  // ── What the run left behind ──────────────────────────────────────────────────────────────
  await report.run(
    'all',
    async () => {
      const all = secretNeedles(stand.secretValues())
      const where = []
      const scan = (label, buffer, needles = all) => {
        const found = foundNeedles(buffer, needles)
        if (found.length > 0) where.push(`${label} (${found.length})`)
      }
      scan('pg_dump of the platform database', await databaseDump(stand, docker))
      scan('Redis (every key and value)', await redisDump(stand, docker))
      scan('the log of core', Buffer.from(await readFile(join(stand.logsDir, 'core.log'), 'utf8')))
      scan(
        'the log of next dev',
        Buffer.from(await readFile(join(stand.logsDir, 'web.log'), 'utf8')),
      )
      // A key access lets notes/leaked.txt through: nothing typed for it matches the passwords.
      const keySites = Object.entries(sites)
        .filter(([id]) => siteExpectations(id, {}).auth === 'key')
        .map(([, siteId]) => `site-${siteId}`)
      const passwords = new Set(stand.hostingPasswords())
      for (const [name, objects] of Object.entries(await repositoryObjects(stand, signal)))
        scan(
          `git objects of ${name}`,
          objects,
          keySites.includes(name) ? all.filter((needle) => !passwords.has(needle)) : all,
        )
      assert.deepEqual(where, [], `A secret of the stand was found in: ${where.join(', ')}`)
      report.pass(
        'all',
        'no secret of the stand in pg_dump, Redis, any git object of any repository, the log of core or of next dev',
      )

      const mysql = (await stand.siteDatabases.mysql.statements()).slice(baseline.mysql)
      assertReadOnlyStatements(
        mysql.filter(({ command }) => command === 'Query').map(({ argument }) => argument),
        ['wp_posts'],
      )
      const postgres = (await stand.siteDatabases.postgres.statements()).slice(baseline.postgres)
      assertReadOnlyStatements(postgres, ['pages'])
      report.pass(
        'all',
        `the site databases: ${mysql.length} MySQL and ${postgres.length} PostgreSQL statements since the scenarios began, none writes or reads a table`,
      )

      assert.equal(
        await stand.siteServer.snapshot(),
        baseline.site,
        'The hosting site was written to',
      )
      assert.equal(
        await stand.spareServer.snapshot(),
        baseline.spare,
        'The hosting spare was written to',
      )
      report.pass(
        'all',
        'both hostings are byte for byte what they were: nothing was written to them',
      )

      const vaultSites = (await stand.vault.list('sites'))
        .map((key) => key.replace(/\/$/, ''))
        .sort()
      const { rows } = await stand.db.query(
        `SELECT DISTINCT site_id::text AS id FROM credential_refs WHERE site_id IS NOT NULL ORDER BY 1`,
      )
      assert.deepEqual(
        vaultSites,
        rows.map(({ id }) => id),
        'OpenBao holds an access without a reference',
      )
      const claims = await stand.db.query('SELECT count(*)::int AS n FROM site_creation_claims')
      assert.equal(claims.rows[0].n, 0, 'A creation claim was left behind')
      report.pass(
        'all',
        `OpenBao holds the accesses of exactly the ${vaultSites.length} sites that refer to them; no creation claim left`,
      )
    },
    redact,
  )
}

export async function verifySiteImport(argv) {
  const started = Date.now()
  const options = standOptions(argv)
  for (const signal of SIGNALS) process.on(signal, interrupt)
  const report = new Report((line) => console.log(line))
  // A rejection nobody awaited fails the run, never ends the process before its cleanup.
  const unhandled = (error) =>
    report.fail('stand', new Error(`unhandled: ${error?.message ?? error}`))
  process.on('unhandledRejection', unhandled)
  let stand
  let failed = false
  let stageName = 'start'
  try {
    stand = await startStand({ signal: controller.signal, log: (line) => console.log(line) })
    report.pass(
      'stand',
      `${stand.run} up in ${Math.round((Date.now() - started) / 1000)} s (${SCENARIO_IDS.length} parts; this run: ${options.selected.join(', ')})`,
    )
    const scenarios = options.selected.filter((id) => id !== 'infra')
    if (options.selected.includes('infra')) {
      stageName = 'infra'
      await report.run(
        'infra',
        () =>
          runInfraChecks(stand, {
            pass: (text) => report.pass('infra', text),
            signal: controller.signal,
            core: scenarios.length === 0,
          }),
        stand.redact,
      )
    }
    if (scenarios.length > 0) {
      stageName = 'scenarios'
      await runScenarios(stand, {
        selected: scenarios,
        report,
        print: (line) => console.log(line),
      })
    }
    if (options.keep && !controller.signal.aborted) {
      const { coordinates } = stand
      console.log(
        [
          '',
          'The stand stays up (--keep). Everything is on loopback and belongs to this run:',
          `  run directory  ${stand.directory}  (secrets/, tls/ca.pem, logs/)`,
          `  cabinet        ${stand.web.running() ? stand.web.origin : 'next dev not started'}`,
          `  platform db    docker exec -it ${coordinates.postgres.container} psql -U raditi raditi`,
          `  Gitea          ${coordinates.gitea.origin}  (tokens in secrets/)`,
          `  hostings       sftp -P ${coordinates.siteServer.ssh.port} site@127.0.0.1 (spare: ${coordinates.spareServer.ssh.port})`,
          `  core           ${coordinates.core.url} (${stand.core.running() ? 'running' : 'not running'})`,
          `Stop it with Ctrl-C (or kill -TERM ${process.pid}): everything is removed then.`,
          '',
        ].join('\n'),
      )
      await new Promise((done) => controller.signal.addEventListener('abort', done, { once: true }))
    }
  } catch (error) {
    failed = true
    const where = await keepAside(
      stand,
      stand
        ? stand.redact(`${error?.stack ?? error}\n${error?.verificationOutput ?? ''}`)
        : `${error?.message ?? error}\n${error?.verificationOutput ?? ''}`,
    )
    const message = stand ? stand.redact(error?.message ?? '') : (error?.message ?? '')
    console.error(
      `FAIL site-import stand at ${stageName === 'infra' ? infraStage : stageName}${interrupted ? ' (interrupted)' : `: ${message}`}${where ? `; private diagnostic: ${where}` : ''}`,
    )
  } finally {
    if (report.failures.length > 0 && !failed && stand) {
      const where = await keepAside(
        stand,
        report.failures
          .map(({ id, stack, message }) => `--- ${id}: ${message}\n${stack}`)
          .join('\n'),
      )
      if (where) console.error(`LOGS of the failed scenarios (redacted): ${where}`)
    }
    if (stand)
      try {
        await stand.stop()
        console.log('PASS stand owned containers, next dev, core and the run directory removed')
      } catch (error) {
        failed = true
        console.error(`FAIL ${error.message}`)
      }
    for (const signal of SIGNALS) process.removeListener(signal, interrupt)
    process.removeListener('unhandledRejection', unhandled)
  }
  if (report.failures.length > 0) failed = true
  const failedIds = [...new Set(report.failures.map(({ id }) => id))]
  console.log(
    `${failed ? 'FAIL' : 'PASS'} pnpm verify:site-import (${options.selected.join(', ')}): ${report.passed} checks passed` +
      (failedIds.length > 0 ? `, failed: ${failedIds.join(', ')}` : '') +
      ` in ${Math.round((Date.now() - started) / 1000)} s`,
  )
  if (failed) throw new Error('Site import stand failed')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifySiteImport(process.argv.slice(2)).catch((error) => {
    if (error?.message && !/^Site import stand failed$/.test(error.message))
      console.error(`FAIL ${error.message}`)
    process.exitCode = 1
  })
}
