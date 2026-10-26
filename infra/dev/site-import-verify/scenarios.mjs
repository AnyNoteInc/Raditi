// The scenarios of the first import that the stand drives itself, through the product's own API
// (tRPC with a session cookie) and from outside (Docker, Gitea, PostgreSQL, OpenBao), and the
// checks of every imported site and of everything the run left behind. The browser half is
// apps/e2e/tests/site-import; verify-site-import.mjs runs both.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { runCommand } from '../../../apps/core/scripts/verify-agent-supervisor.mjs'
import { trpcClient } from './trpc.mjs'

const STAGE = 'code_import'
const TAG = 'v0.0.0'
const MAIN_REF = 'refs/heads/main'
const TAG_REF = `refs/tags/${TAG}`

/** One line per check; a failed scenario is reported and the others go on. */
export class Report {
  constructor(print = console.log) {
    this.print = print
    this.passed = 0
    this.failures = []
    this.skipped = []
  }

  pass(id, text) {
    this.passed += 1
    this.print(`PASS ${id} ${text}`)
  }

  fail(id, error, redact = (text) => text) {
    const message = redact(error instanceof Error ? error.message : String(error))
    this.failures.push({ id, message, stack: redact(error?.stack ?? '') })
    this.print(`FAIL ${id} ${message}`)
  }

  skip(id, text) {
    this.skipped.push(id)
    this.print(`SKIP ${id} ${text}`)
  }

  /** Runs one scenario; its failure is recorded, never thrown. */
  async run(id, work, redact) {
    try {
      await work()
      return true
    } catch (error) {
      this.fail(id, error, redact)
      return false
    }
  }
}

/** The address a scenario's project is added with: unique per run and scenario, never dialed. */
export const projectUrl = (run, id) => `https://${id}-${run}.stand.example.test`

/** The source of an SSH access with a password, pinned to the key the hosting presents first. */
export function sftpSource(stand, { hosting = 'site', user = 'site', password }) {
  const server = stand.coordinates[hosting === 'site' ? 'siteServer' : 'spareServer']
  return {
    kind: 'sftp',
    host: '127.0.0.1',
    port: server.ssh.port,
    username: user,
    auth: { method: 'password', password },
    rootPath: server.roots.site,
    hostKey: server.hostKeys.first,
  }
}

/** The stage row of a site, or null. */
export async function stageOf(stand, siteId) {
  const { rows } = await stand.db.query(
    `SELECT status::text AS status, attempt, enqueues, lease_epoch, step, error_code, summary,
            heartbeat_at, started_at, finished_at
     FROM site_provisioning_stages WHERE site_id = $1::uuid AND stage = 'code_import'`,
    [siteId],
  )
  return rows[0] ?? null
}

/** Polls the stage until `ready(stage)`; `seen` collects every status on the way. */
export async function waitStage(stand, siteId, ready, { timeoutMs = 180_000, what, seen } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await stageOf(stand, siteId)
    if (last && seen) seen.add(`${last.status}:${last.enqueues}`)
    if (last && ready(last)) return last
    if (Date.now() > deadline)
      throw new Error(
        `${what ?? 'the stage'} not reached in ${timeoutMs / 1000} s (last: ${last ? `${last.status}, attempt ${last.attempt}, enqueues ${last.enqueues}, error ${last.error_code ?? 'none'}` : 'no stage'})`,
      )
    await sleep(250)
  }
}

/**
 * What an operator does after looking at a stage: marks it failed (with a code) by hand. A
 * succeeded import made the site `active` with `v0.0.0` installed (26.10.2026); a failed one
 * leaves it `onboarding` with nothing installed — the site is put back there with the stage.
 */
export async function failStageBySql(stand, siteId, code) {
  const { rowCount } = await stand.db.query(
    `UPDATE site_provisioning_stages
     SET status = 'failed', error_code = $2, finished_at = now(), step = NULL, heartbeat_at = NULL,
         updated_at = now()
     WHERE site_id = $1::uuid AND stage = 'code_import' AND status = 'succeeded'`,
    [siteId, code],
  )
  assert.equal(rowCount, 1, 'The succeeded stage is set failed by the operator')
  const site = await stand.db.query(
    `UPDATE sites
     SET status = 'onboarding', installed_version = NULL, installed_sha = NULL, installed_at = NULL,
         updated_at = now()
     WHERE id = $1::uuid AND status = 'active' AND installed_release_id IS NULL`,
    [siteId],
  )
  assert.equal(site.rowCount, 1, 'The site is back to being connected, nothing installed')
}

/** The outbox events of a site's stage, oldest first. */
export async function stageEvents(stand, siteId) {
  const { rows } = await stand.db.query(
    `SELECT dedupe_key, topic, type, status::text AS status, payload, available_at, created_at
     FROM outbox_events WHERE dedupe_key LIKE $1 ORDER BY created_at, dedupe_key`,
    [`site-provisioning:${siteId}:%`],
  )
  return rows
}

/** The event written with the stage, while no relay has published it yet: ids only. */
export async function assertPendingEvent(stand, siteId, { attempt = 1, enqueues = 1 } = {}) {
  const key = `site-provisioning:${siteId}:${STAGE}:${attempt}:${enqueues}`
  const event = (await stageEvents(stand, siteId)).find(({ dedupe_key: dedupe }) => dedupe === key)
  assert.ok(event, `The outbox event ${attempt}:${enqueues} of the stage exists`)
  assert.equal(event.status, 'pending')
  assert.equal(event.topic, 'site-import')
  assert.equal(event.type, 'site.provision')
  assert.deepEqual(event.payload, { siteId, stage: STAGE }, 'The payload is exactly the ids')
  return event
}

/** `refs/heads/main`, the tag and every other ref of the site repository, read from git. */
export async function refsOf(stand, siteId) {
  const refs = await stand.giteaApi.refs(`site-${siteId}`)
  const at = (ref) => refs.find((entry) => entry.ref === ref) ?? null
  return {
    all: refs,
    main: at(MAIN_REF)?.sha ?? null,
    tag: at(TAG_REF)?.sha ?? null,
    tagType: at(TAG_REF)?.type ?? null,
  }
}

/** A project through project.create; the outcome must be `created`. */
export async function createProject(client, { name, url, source, database = null, requestKey }) {
  const outcome = await client.mutation('project.create', {
    requestKey: requestKey ?? randomUUID(),
    name,
    url,
    stack: 'wordpress',
    source,
    database,
  })
  assert.equal(
    outcome.outcome,
    'created',
    `project.create answered ${outcome.outcome}${outcome.reason ? ` (${outcome.reason})` : ''}`,
  )
  return outcome.project.id
}

/**
 * Everything one imported site must be, from outside: the rows of PostgreSQL, the references and
 * the versions in OpenBao, the repository, its refs, its one commit and its tree. `expect`:
 * `{ auth, kind, hosting, user?, tls?, database, events, attempt, failedWith?, foreign? }`.
 */
export async function verifySite(stand, siteId, expect) {
  const query = async (text, params = [siteId]) => (await stand.db.query(text, params)).rows
  const expected = stand.fixture.expected(expect.auth)
  const fileCount = expected.files.length
  const byteCount = expected.files.reduce((total, file) => total + file.bytes, 0)

  const [site] = await query(
    `SELECT status::text AS status, stack::text AS stack, workspace_id FROM sites WHERE id = $1::uuid`,
  )
  assert.ok(site, 'The site exists')
  // Owner's decision of 26.10.2026: after a successful import the first version is the installed
  // one and the site takes tasks; a stopped import leaves it onboarding.
  assert.equal(
    site.status,
    expect.failedWith ? 'onboarding' : 'active',
    'The site is active after a successful import, onboarding after a stopped one',
  )

  const stage = await stageOf(stand, siteId)
  if (expect.failedWith) {
    assert.equal(stage.status, 'failed')
    assert.equal(stage.error_code, expect.failedWith)
  } else {
    assert.equal(stage.status, 'succeeded', `stage ${stage.status} ${stage.error_code ?? ''}`)
    assert.equal(stage.error_code, null)
    assert.equal(stage.step, null)
  }
  if (expect.attempt !== undefined) assert.equal(stage.attempt, expect.attempt, 'attempt')
  if (expect.enqueues !== undefined) assert.equal(stage.enqueues, expect.enqueues, 'enqueues')
  assert.deepEqual(
    stage.summary,
    { files: fileCount, bytes: byteCount, skipped: expected.skipped },
    'The summary counts what the manifest says',
  )

  const [version] = await query(
    `SELECT commit_sha, tag, files, bytes, imported_at FROM site_initial_versions WHERE site_id = $1::uuid`,
  )
  assert.ok(version, 'site_initial_versions has the site')
  assert.match(version.commit_sha, /^[0-9a-f]{40}$/)
  assert.equal(version.tag, TAG)
  assert.ok(version.imported_at, 'imported_at is set')
  assert.equal(version.files, fileCount)
  assert.equal(version.bytes, byteCount)

  const repositories = await query(
    `SELECT provider::text AS provider, owner, name, default_branch, url, credential_ref_id
     FROM git_repositories WHERE site_id = $1::uuid`,
  )
  const name = `site-${siteId}`
  assert.deepEqual(repositories, [
    {
      provider: 'gitea',
      owner: 'sites',
      name,
      default_branch: 'main',
      url: `${stand.coordinates.gitea.origin}/sites/${name}`,
      credential_ref_id: null,
    },
  ])

  // The references: one per kind, the canonical path, the version OpenBao has as current.
  const references = await query(
    `SELECT id, kind::text AS kind, workspace_id, vault_path, key_version
     FROM credential_refs WHERE site_id = $1::uuid ORDER BY kind`,
  )
  const accessKind = expect.kind === 'sftp' ? 'ssh' : 'ftp'
  const kinds = [accessKind, ...(expect.database ? ['db'] : [])].sort()
  assert.deepEqual(
    references.map(({ kind }) => kind),
    kinds,
  )
  for (const reference of references) {
    assert.equal(reference.vault_path, `kv/sites/${siteId}/${reference.kind}`)
    assert.equal(reference.workspace_id, site.workspace_id)
    const metadata = await stand.vault.metadata(reference.vault_path)
    assert.ok(metadata, `OpenBao has ${reference.kind}`)
    assert.equal(
      reference.key_version,
      metadata.current_version,
      `key_version of ${reference.kind} is the current version in OpenBao`,
    )
    if (reference.kind === accessKind && expect.accessVersion !== undefined)
      assert.equal(reference.key_version, expect.accessVersion, 'the version of the access')
  }
  const server = stand.coordinates[expect.hosting === 'spare' ? 'spareServer' : 'siteServer']
  const [source] = await query(
    `SELECT kind::text AS kind, host, port, root_path, tls::text AS tls, host_key, credential_ref_id
     FROM site_code_sources WHERE site_id = $1::uuid`,
  )
  assert.deepEqual(source, {
    kind: expect.kind,
    host: '127.0.0.1',
    port: expect.kind === 'sftp' ? server.ssh.port : server.ftp.port,
    root_path: server.roots.site,
    tls: expect.kind === 'ftp' ? expect.tls : null,
    host_key: expect.kind === 'sftp' ? server.hostKeys.first : null,
    credential_ref_id: references.find(({ kind }) => kind === accessKind).id,
  })
  const databases = await query(
    `SELECT engine::text AS engine, host, port, database_name, tls::text AS tls, credential_ref_id
     FROM site_databases WHERE site_id = $1::uuid`,
  )
  if (expect.database) {
    const at = stand.coordinates.siteDatabases[expect.database]
    assert.deepEqual(databases, [
      {
        engine: expect.database,
        host: '127.0.0.1',
        port: at.port,
        database_name: at.database,
        tls: 'verified',
        credential_ref_id: references.find(({ kind }) => kind === 'db').id,
      },
    ])
  } else assert.deepEqual(databases, [])

  // Every event of the stage was published, and the relay dropped its payload.
  const events = await stageEvents(stand, siteId)
  assert.deepEqual(
    events.map(({ dedupe_key: key }) => key.split(':').slice(-2).join(':')),
    expect.events,
    'The outbox events of the stage',
  )
  for (const event of events) {
    assert.equal(event.status, 'published')
    assert.equal(event.payload, null, 'A published event keeps no payload')
  }
  const creations = await query(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'site.create' AND target_id = $1`,
    [siteId],
  )
  assert.equal(creations[0].n, 1, 'One site.create in the audit log')

  // The repository: private, one root commit by the bot, main and the lightweight tag on it.
  const repository = await stand.giteaApi.repository(name)
  assert.ok(repository, 'The repository exists in Gitea')
  assert.equal(repository.private, true)
  assert.equal(repository.owner.login, 'sites')
  assert.equal(
    (await stand.giteaApi.request('GET', `/v1/repos/sites/${name}`, { auth: undefined })).status,
    404,
    'Without a token the repository is invisible',
  )
  const refs = await refsOf(stand, siteId)
  const sha = version.commit_sha
  assert.equal(refs.main, sha, 'main is the recorded commit')
  if (expect.foreign) {
    assert.equal(refs.tag, expect.foreign, 'The foreign tag is left as it was')
    assert.deepEqual(refs.all.map(({ ref }) => ref).sort(), [
      'refs/heads/foreign',
      MAIN_REF,
      TAG_REF,
    ])
  } else {
    assert.equal(refs.tag, sha, 'v0.0.0 is the recorded commit')
    assert.equal(refs.tagType, 'commit', 'v0.0.0 is a lightweight tag')
    assert.deepEqual(refs.all.map(({ ref }) => ref).sort(), [MAIN_REF, TAG_REF])
  }
  const commit = await stand.giteaApi.commit(name, sha)
  assert.deepEqual(commit.parents ?? [], [], 'The first version has no parent')
  // Gitea's commit: `parents` beside it, the git identities in `commit`.
  for (const who of [commit.commit?.author, commit.commit?.committer]) {
    assert.equal(who?.name, 'Raditi Bot')
    assert.equal(who?.email, 'bot@raditi.ru')
  }
  const blobs = (await stand.giteaApi.tree(name, sha))
    .filter(({ type }) => type === 'blob')
    .map(({ path, sha: id, size }) => ({ path, blob: id, bytes: size }))
    .sort((a, b) => (a.path < b.path ? -1 : 1))
  assert.deepEqual(
    blobs.map(({ path }) => path),
    expected.files.map(({ path }) => path),
    'The tree holds exactly the files of the manifest',
  )
  assert.deepEqual(blobs, expected.files, 'Every file is byte for byte the hosting one')
  for (const absent of expected.absent)
    assert.ok(!blobs.some(({ path }) => path === absent), `${absent} is not in the repository`)
  return { sha, workspaceId: site.workspace_id }
}

/** A tRPC client of an account of the run. */
export const clientOf = (stand, account, signal) =>
  trpcClient({ origin: stand.web.origin, cookie: account.cookie, signal })

// ─── Scenarios run by the stand ──────────────────────────────────────────────────────────────

/**
 * R3: the tag went missing after `main` was published. The tag is deleted in Gitea, the stage
 * marked failed by hand; «Повторить» brings the same commit back under the tag — fetched from
 * Gitea, not downloaded again: the hosting sees no new login of the account.
 */
export async function scenarioTagMissing(stand, { account, run, report, signal }) {
  const client = clientOf(stand, account, signal)
  const { sitec } = stand.secrets
  const siteId = await createProject(client, {
    name: 'R3 tag missing',
    url: projectUrl(run, 'r3'),
    source: sftpSource(stand, { user: sitec.user, password: sitec.password }),
  })
  await waitStage(stand, siteId, (stage) => stage.status === 'succeeded', { what: 'R3 import' })
  const before = await refsOf(stand, siteId)
  assert.ok(before.main && before.tag === before.main)
  await stand.giteaApi.deleteTag(`site-${siteId}`, TAG)
  assert.equal((await refsOf(stand, siteId)).tag, null, 'The tag is gone')
  await failStageBySql(stand, siteId, 'repository_push_failed')
  const logins = await stand.siteServer.logins(sitec.user)
  const retried = await client.mutation('siteConnection.retry', { id: siteId })
  assert.equal(retried.state, 'pending')
  assert.equal(retried.attempt, 2)
  await waitStage(stand, siteId, (stage) => stage.status === 'succeeded' && stage.attempt === 2, {
    what: 'R3 retry',
  })
  const after = await refsOf(stand, siteId)
  assert.equal(after.main, before.main, 'main is the same commit')
  assert.equal(after.tag, before.main, 'the tag is back on the same commit')
  assert.equal(
    await stand.siteServer.logins(sitec.user),
    logins,
    'The retry did not log in to the hosting: the commit came from Gitea',
  )
  report.pass(
    'r3',
    'tag deleted, stage failed by hand, «Повторить»: the same commit tagged again, no new login on the hosting',
  )
  return siteId
}

/**
 * R4: another commit holds the tag. «Повторить» fails `repository_mismatch`; nothing is forced or
 * retagged: the foreign tag and `main` stay as they were.
 */
export async function scenarioMismatch(stand, { account, run, report, signal, requestKey }) {
  const client = clientOf(stand, account, signal)
  const { site } = stand.secrets
  const siteId = await createProject(client, {
    name: 'R4 mismatch',
    url: projectUrl(run, 'r4'),
    source: sftpSource(stand, { password: site.password }),
    requestKey,
  })
  await waitStage(stand, siteId, (stage) => stage.status === 'succeeded', { what: 'R4 import' })
  const name = `site-${siteId}`
  const before = await refsOf(stand, siteId)
  // Gitea treats a repository as empty until it has processed the first push in the background;
  // a branch made before that becomes its default. Wait until `main` is known to Gitea itself.
  const deadline = Date.now() + 60_000
  while (
    (await stand.giteaApi.branch(name, 'main').catch(() => null))?.commit?.id !== before.main ||
    (await stand.giteaApi.repository(name))?.empty !== false
  ) {
    if (Date.now() > deadline) throw new Error('Gitea did not take in the first push in 60 s')
    await sleep(500)
  }
  const foreign = await stand.giteaApi.createFile(name, {
    path: 'foreign.txt',
    content: 'A commit the import did not make\n',
    branch: 'main',
    newBranch: 'foreign',
  })
  assert.equal((await stand.giteaApi.repository(name)).default_branch, 'main')
  await stand.giteaApi.deleteTag(name, TAG)
  await stand.giteaApi.pushTag(name, TAG, foreign)
  assert.equal((await refsOf(stand, siteId)).tag, foreign)
  await failStageBySql(stand, siteId, 'repository_push_failed')
  await client.mutation('siteConnection.retry', { id: siteId })
  const failed = await waitStage(
    stand,
    siteId,
    (stage) => stage.status === 'failed' && stage.attempt === 2,
    { what: 'R4 retry to fail' },
  )
  if (failed.error_code !== 'repository_mismatch') {
    // What Gitea and core saw, for the private diagnostic of the run (redacted by the report).
    const error = new Error(`The retry failed ${failed.error_code}, not repository_mismatch`)
    error.stack += `\n--- the repository as Gitea's administrator sees it\n${JSON.stringify(
      await stand.giteaApi.repository(name),
    )}\n--- refs\n${JSON.stringify((await refsOf(stand, siteId)).all)}\n--- collaborators\n${JSON.stringify(
      (await stand.giteaApi.request('GET', `/v1/repos/sites/${name}/collaborators`)).json,
    )}\n--- Gitea\n${await stand.containerLogs('gitea')}\n--- core\n${stand.core.log().slice(-20_000)}`
    throw error
  }
  const after = await refsOf(stand, siteId)
  assert.equal(after.main, before.main, 'main is untouched')
  assert.equal(after.tag, foreign, 'The foreign tag is not replaced')
  const setup = await client.query('siteConnection.setup', { id: siteId })
  assert.equal(setup.state, 'failed')
  assert.equal(setup.errorCode, 'repository_mismatch')
  report.pass(
    'r4',
    'a foreign v0.0.0: «Повторить» fails repository_mismatch, main and the foreign tag untouched',
  )
  return { siteId, foreign }
}

/**
 * The third phase, alone on the stand: core is killed, stopped and the hosting stopped while an
 * import runs. R1 (kill -9 while fetching), R2 (SIGTERM while fetching), R5 (the hosting refuses
 * connections): each its own account and site; their waits overlap.
 */
export async function scenarioInterruptions(stand, { accounts, run, report, signal, selected }) {
  const { site } = stand.secrets
  const done = {}
  const waits = []
  await stand.core.stop()

  if (selected.includes('r1')) {
    await report.run(
      'r1',
      async () => {
        const client = clientOf(stand, accounts.r1, signal)
        const siteId = await createProject(client, {
          name: 'R1 kill',
          url: projectUrl(run, 'r1'),
          source: sftpSource(stand, { hosting: 'spare', password: site.password }),
        })
        await assertPendingEvent(stand, siteId)
        await stand.spareServer.pause()
        try {
          await stand.core.start()
          const running = await waitStage(
            stand,
            siteId,
            (stage) => stage.status === 'running' && stage.step === 'fetch',
            { what: 'R1 fetch', timeoutMs: 30_000 },
          )
          // The claim, the repository and its refs come first; then the import dials the frozen
          // hosting and waits for its banner (30 s at most): that is when core dies.
          await sleep(2_000)
          assert.equal((await stageOf(stand, siteId)).status, 'running')
          await stand.core.kill()
          assert.equal(running.lease_epoch, 1)
        } finally {
          await stand.spareServer.unpause()
        }
        const killedAt = Date.now()
        report.pass('r1', 'core killed (SIGKILL) while the import fetched from a frozen hosting')
        waits.push(
          (async () => {
            const stage = await waitStage(stand, siteId, (row) => row.status === 'succeeded', {
              what: 'R1 recovery through the sweep',
              timeoutMs: 330_000,
            })
            assert.equal(stage.enqueues, 2, 'The sweep queued it once more')
            assert.equal(stage.lease_epoch, 2, 'A second claim took it')
            assert.ok(Date.now() - killedAt >= 100_000, 'Not before the stage went stale (120 s)')
            done.r1 = siteId
            report.pass(
              'r1',
              `the silent stage came back through the sweep after ${Math.round((Date.now() - killedAt) / 1000)} s and succeeded`,
            )
          })().catch((error) => report.fail('r1', error, stand.redact)),
        )
      },
      stand.redact,
    )
    if (stand.core.running()) await stand.core.stop()
  }

  if (selected.includes('r2')) {
    await report.run(
      'r2',
      async () => {
        const client = clientOf(stand, accounts.r2, signal)
        const siteId = await createProject(client, {
          name: 'R2 shutdown',
          url: projectUrl(run, 'r2'),
          source: sftpSource(stand, { hosting: 'spare', password: site.password }),
        })
        await assertPendingEvent(stand, siteId)
        await stand.spareServer.pause()
        let released
        try {
          await stand.core.start()
          await waitStage(stand, siteId, (stage) => stage.status === 'running', {
            what: 'R2 fetch',
            timeoutMs: 30_000,
          })
          await sleep(2_000)
          await stand.core.stop()
          released = await stageOf(stand, siteId)
        } finally {
          await stand.spareServer.unpause()
        }
        assert.equal(released.status, 'queued', 'SIGTERM released the stage')
        assert.equal(released.enqueues, 2)
        const event = (await stageEvents(stand, siteId)).find(({ dedupe_key: key }) =>
          key.endsWith(':1:2'),
        )
        assert.ok(event, 'The release wrote an outbox event')
        const delay = event.available_at.getTime() - event.created_at.getTime()
        assert.ok(delay >= 40_000 && delay <= 50_000, `available after ${delay} ms, not ≈ 45 s`)
        report.pass(
          'r2',
          `SIGTERM while fetching: the stage released to queued, enqueues 2, available after ${Math.round(delay / 1000)} s`,
        )
        waits.push(
          (async () => {
            await waitStage(stand, siteId, (row) => row.status === 'succeeded', {
              what: 'R2 after the restart',
              timeoutMs: 180_000,
            })
            done.r2 = siteId
            report.pass('r2', 'a restarted core finished the released import')
          })().catch((error) => report.fail('r2', error, stand.redact)),
        )
      },
      stand.redact,
    )
  }

  if (selected.includes('r5')) {
    await report.run(
      'r5',
      async () => {
        if (stand.core.running()) await stand.core.stop()
        const client = clientOf(stand, accounts.r5, signal)
        const siteId = await createProject(client, {
          name: 'R5 hosting away',
          url: projectUrl(run, 'r5'),
          source: sftpSource(stand, { password: site.password }),
        })
        await assertPendingEvent(stand, siteId)
        const seen = new Set()
        await stand.siteServer.stopContainer()
        try {
          await stand.core.start()
          await waitStage(
            stand,
            siteId,
            (stage) => stage.status === 'queued' && stage.enqueues >= 2,
            {
              what: 'R5 requeue',
              timeoutMs: 90_000,
              seen,
            },
          )
        } finally {
          await stand.siteServer.startContainer()
        }
        assert.ok(![...seen].some((state) => state.startsWith('failed')), 'Never failed on the way')
        report.pass(
          'r5',
          'the hosting refused connections: the stage went back to the queue (enqueues 2), not failed',
        )
        waits.push(
          (async () => {
            await waitStage(stand, siteId, (row) => row.status === 'succeeded', {
              what: 'R5 after the hosting came back',
              timeoutMs: 180_000,
              seen,
            })
            assert.ok(![...seen].some((state) => state.startsWith('failed')))
            done.r5 = siteId
            report.pass('r5', 'the hosting back: the requeued import succeeded')
          })().catch((error) => report.fail('r5', error, stand.redact)),
        )
      },
      stand.redact,
    )
  }

  if (!stand.core.running()) await stand.core.start()
  await Promise.all(waits)
  return done
}

// ─── What the run left behind ────────────────────────────────────────────────────────────────

/** Every line of a PEM body and the whole value: a key may sit in JSON with escaped breaks. */
export function secretNeedles(values) {
  const needles = new Set()
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 8) continue
    needles.add(value)
    if (value.includes('-----BEGIN'))
      for (const line of value.split('\n'))
        if (line.length >= 40 && !line.startsWith('-----')) needles.add(line)
  }
  return [...needles]
}

/** The needles a buffer holds, by their index in `needles` (never the needles themselves). */
export function foundNeedles(buffer, needles) {
  const found = []
  needles.forEach((needle, index) => {
    if (buffer.includes(Buffer.from(needle, 'utf8'))) found.push(index)
  })
  return found
}

const REDIS_DUMP = `
local out = {}
local cursor = "0"
repeat
  local page = redis.call("SCAN", cursor, "COUNT", 1000)
  cursor = page[1]
  for _, key in ipairs(page[2]) do
    table.insert(out, key)
    local kind = redis.call("TYPE", key)["ok"]
    if kind == "string" then table.insert(out, redis.call("GET", key))
    elseif kind == "hash" then for _, v in ipairs(redis.call("HGETALL", key)) do table.insert(out, v) end
    elseif kind == "list" then for _, v in ipairs(redis.call("LRANGE", key, 0, -1)) do table.insert(out, v) end
    elseif kind == "set" then for _, v in ipairs(redis.call("SMEMBERS", key)) do table.insert(out, v) end
    elseif kind == "zset" then for _, v in ipairs(redis.call("ZRANGE", key, 0, -1)) do table.insert(out, v) end
    elseif kind == "stream" then
      for _, entry in ipairs(redis.call("XRANGE", key, "-", "+")) do
        for _, v in ipairs(entry[2]) do table.insert(out, v) end
      end
    end
  end
until cursor == "0"
return table.concat(out, "\\n")
`

/** Every key and value of the stand's Redis (BullMQ), as one buffer. */
export async function redisDump(stand, docker) {
  const answer = await docker(
    [
      ...['exec', '-i', stand.coordinates.redis.container, 'sh', '-c'],
      'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw EVAL "$(cat)" 0',
    ],
    { input: REDIS_DUMP, timeoutMs: 60_000 },
  )
  return Buffer.from(answer.stdout, 'utf8')
}

/** The data of the platform database as pg_dump writes it. */
export async function databaseDump(stand, docker) {
  const answer = await docker(
    [
      'exec',
      stand.coordinates.postgres.container,
      'pg_dump',
      '-U',
      'raditi',
      '--data-only',
      'raditi',
    ],
    { timeoutMs: 120_000 },
  )
  return Buffer.from(answer.stdout, 'utf8')
}

/** Every object of every repository of `sites`, decompressed: what git would ever hand out. */
export async function repositoryObjects(stand, signal) {
  const objects = {}
  const work = join(stand.directory, 'work', 'mirrors')
  await mkdir(work, { recursive: true })
  for (const name of await stand.giteaApi.repositories()) {
    const target = join(work, `${name}.git`)
    const env = stand.giteaApi.gitEnvironment('bot')
    await runCommand(
      'git',
      [
        'clone',
        '--quiet',
        '--mirror',
        `${stand.coordinates.gitea.origin}/sites/${name}.git`,
        target,
      ],
      { env, signal, timeoutMs: 120_000 },
    )
    const dump = await runCommand('git', ['cat-file', '--batch-all-objects', '--batch'], {
      env,
      cwd: target,
      signal,
      timeoutMs: 120_000,
    })
    objects[name] = Buffer.from(dump.stdout, 'utf8')
  }
  return objects
}

/** Statement logs of the site databases with no read of a table and no write since `from`. */
export function assertReadOnlyStatements(statements, tables) {
  const write =
    /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|MERGE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|COPY|LOCK|CALL|DO)\b/i
  const reads = new RegExp(`\\b(?:${tables.join('|')})\\b`, 'i')
  for (const statement of statements) {
    assert.ok(!write.test(statement), `A write reached a site database: ${statement.slice(0, 60)}`)
    assert.ok(
      !reads.test(statement),
      `A user table of a site database was named: ${statement.slice(0, 60)}`,
    )
  }
}
