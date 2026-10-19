// The release tag on a real Gitea 1.27.3 (docs/plan/53-chat-preview-release.md, Р28–Р31): the
// product workflow ci/.gitea/scoped_workflows/deploy.yml of platform/ci on the SECOND Gitea of the
// stand — the one with `[actions] WORKFLOW_DIRS`, as every Gitea of the platform runs — with its
// own deploy runner whose label `deploy` is the orchestrator image, an SFTP hosting and a site
// server on the deploy network, OpenBao for the wrapping, and this process as the release API of
// core. Every PASS line states what the real Gitea and the real `deploy-step` did.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { openBackup } from '../../../apps/orchestrator/src/deploy-step/backup.ts'
import {
  deployAccessSchema,
  deployManifestSchema,
  formatDeployWrap,
  releaseBackupRequestSchema,
  releaseStepReportSchema,
} from '../../../packages/domain/src/release/deploy-manifest.ts'
import { parseGiteaWebhook } from '../../../packages/git-providers/src/webhook.ts'
import { SITE_ORIGIN } from './stand.mjs'

const SCOPED = '.gitea/scoped_workflows'
const DEPLOY_SECRET = 'RADITI_DEPLOY_WRAP'
const b64 = (text) => Buffer.from(text).toString('base64')
const form = (fields) => new URLSearchParams(fields).toString()
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
/** The failure markers of WordPress (wordpress-verify.ts) that the site server may show. */
const FAILURE_MARKERS = ['There has been a critical error on this website', '<b>Fatal error</b>:']

/**
 * The release API of core as the jobs of this stand meet it: the manifest and the access of each
 * armed release, reports kept once per key, the backup's presigned upload to this process and its
 * check by size and SHA-256 — the contract of deploy-manifest.ts, every request read by its schema.
 */
function fakeCore(port) {
  const releases = new Map()
  const uploads = new Map()
  const handler = async ({ method, path, headers, body }) => {
    if (path === '/health') return { status: 200, json: { status: 'ok' } }
    const upload = /^\/upload\/([0-9a-f]{32})$/.exec(path)
    if (upload) {
      if (method !== 'PUT') return { status: 405, json: null }
      uploads.set(upload[1], Buffer.from(body))
      return { status: 200, json: null }
    }
    const match = /^\/v1\/releases\/([0-9a-f-]{36})\/(manifest|access|steps|backup)$/.exec(path)
    const release = match ? releases.get(match[1]) : undefined
    if (!release) return { status: 404, json: { error: 'NOT_FOUND' } }
    if (headers.get('authorization') !== `Bearer ${release.token}`)
      return { status: 401, json: { error: 'UNAUTHORIZED' } }
    const call = match[2]
    release.calls.push(call)
    const json = body.length > 0 ? JSON.parse(body.toString('utf8')) : {}
    if (call === 'manifest' && method === 'GET') return { status: 200, json: release.manifest }
    if (call === 'access' && method === 'POST') {
      if (release.accessIssued || !release.reports.has('1:conflicts:started'))
        return { status: 409, json: { error: 'CONFLICT' } }
      release.accessIssued = true
      return { status: 200, json: release.access }
    }
    if (call === 'steps' && method === 'POST') {
      const report = releaseStepReportSchema.parse(json)
      if (release.reports.has(report.reportKey)) release.repeats += 1
      else {
        release.reports.set(report.reportKey, report)
        release.sequence.push(
          `${report.step} ${report.state}${report.detail.code ? ` ${report.detail.code}` : ''}`,
        )
      }
      return { status: 200, json: { accepted: true, proceed: true } }
    }
    if (call === 'backup' && method === 'POST') {
      const request = releaseBackupRequestSchema.parse(json)
      if (request.phase === 'put') {
        const id = randomBytes(16).toString('hex')
        release.backup = { id, named: request, bytes: null }
        return {
          status: 200,
          json: {
            phase: 'put',
            put: {
              method: 'PUT',
              url: `http://host.docker.internal:${port}/upload/${id}`,
              headers: {},
              expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            },
          },
        }
      }
      const landed = release.backup ? uploads.get(release.backup.id) : undefined
      const verified =
        landed !== undefined &&
        landed.byteLength === request.sizeBytes &&
        sha256(landed) === request.sha256 &&
        release.backup.named.sha256 === request.sha256
      if (verified) release.backup.bytes = landed
      return { status: 200, json: { phase: 'verify', verified } }
    }
    return { status: 405, json: null }
  }
  return { releases, handler }
}

export async function tagScenario(ctx) {
  const { passed, pause, setStage, secret, bao, rootToken } = ctx
  const file = (path) => readFile(join(ctx.root, path), 'utf8')
  const waitFor = async (what, probe, timeoutMs = 180_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await probe()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
      await pause(500)
    }
  }

  setStage('the second Gitea: organizations, repositories and the source of scoped workflows')
  const gitea = await ctx.startHardenedGitea()
  const { admin, bot } = gitea
  // `admin` created the organizations: it is the owner of `sites` — the release account (Р26).
  const api = (method, path, { as = admin, body, expect } = {}) =>
    gitea.api(method, path, { as, body, expect })
  for (const org of ['platform', 'sites'])
    await api('POST', '/orgs', { body: { username: org, visibility: 'private' }, expect: 201 })
  const team = await api('POST', '/orgs/sites/teams', {
    body: {
      name: 'bots',
      permission: 'write',
      includes_all_repositories: true,
      units: ['repo.code', 'repo.pulls', 'repo.actions'],
    },
    expect: 201,
  })
  await api('PUT', `/teams/${team.json.id}/members/${bot.user}`, { expect: 204 })
  for (const [org, name] of [
    ['platform', 'ci'],
    ['sites', 'demo'],
  ])
    await api('POST', `/orgs/${org}/repos`, {
      body: { name, private: true, auto_init: true, default_branch: 'main' },
      expect: 201,
    })
  const issued = await api('POST', `/users/${bot.user}/tokens`, {
    as: bot,
    body: { name: 'raditi-core', scopes: ['write:user', 'write:repository'] },
    expect: 201,
  })
  const botToken = { token: secret(issued.json.sha1) }
  const commit = async (repo, path, message, { content = `${message}\n`, as = admin } = {}) => {
    const answer = await api('POST', `/repos/${repo}/contents/${path}`, {
      as,
      body: { content: b64(content), message, branch: 'main' },
      expect: 201,
    })
    return answer.json.commit.sha
  }
  for (const [name, content] of Object.entries({
    'check.yml': await file(`ci/${SCOPED}/check.yml`),
    'deploy.yml': await file(`ci/${SCOPED}/deploy.yml`),
    'push-probe.yml': await file('infra/dev/pipeline-verify/workflows/push-probe.yml'),
  }))
    await commit('platform/ci', `${SCOPED}/${name}`, `ci: ${name}`, { content })
  await gitea.web('POST', '/-/admin/actions/scoped-workflows/add', {
    cookie: await gitea.login(admin),
    form: form({ repo_name: 'platform/ci' }),
    expect: 200,
  })
  const source = await api('GET', '/repos/platform/ci', { expect: 200 })
  // Tags `v*` are the release account's only (R8a, `protectTags`).
  await api('POST', '/repos/sites/demo/tag_protections', {
    body: { name_pattern: 'v*', whitelist_usernames: [admin.user] },
    expect: 201,
  })
  const webhookSecret = secret(randomBytes(24).toString('hex'))
  await api('POST', '/orgs/sites/hooks', {
    body: {
      type: 'gitea',
      active: true,
      events: ['workflow_run'],
      config: {
        url: `http://host.docker.internal:${ctx.receiverPort}/webhooks/gitea`,
        content_type: 'json',
        secret: webhookSecret,
      },
    },
    expect: 201,
  })

  setStage('the second Gitea: its deploy runner, the hosting and the site')
  await ctx.startReleaseRunner(gitea)
  const hosting = await ctx.startHosting()
  await ctx.startSiteServer()
  const core = fakeCore(ctx.releaseApiPort)
  ctx.serveReleaseApi(core.handler)
  passed(
    `the second Gitea (WORKFLOW_DIRS) has its own deploy runner: label \`deploy\` is ${ctx.deployImage}, chosen by the runner, never by a repository; an SFTP hosting and the site's server are on its network`,
  )

  const runs = async () => {
    const list = await api('GET', '/repos/sites/demo/actions/runs?limit=50', {
      as: botToken,
      expect: 200,
    })
    return list.json.workflow_runs ?? []
  }
  const jobsOf = async (runId) =>
    (
      await api('GET', `/repos/sites/demo/actions/runs/${runId}/jobs`, {
        as: botToken,
        expect: 200,
      })
    ).json.jobs ?? []
  const jobLog = async (jobId) =>
    (
      await api('GET', `/repos/sites/demo/actions/jobs/${jobId}/logs`, {
        as: botToken,
        expect: 200,
      })
    ).text
  /** The lines `deploy-step` printed, without the timestamps of the log. */
  const stepLines = (log) =>
    log
      .split('\n')
      .map((line) => line.replace(/^\S+Z /, ''))
      .filter((line) => line.startsWith('deploy-step: '))
  const tagRuns = async (name) =>
    (await runs()).filter((run) => run.path === `deploy.yml@refs/tags/${name}`)
  /** The run of a tag once it ended, with its job and the job's log; exactly one run per tag. */
  const endedRun = async (name, event = 'push') => {
    const [run] = await waitFor(`the run of ${name}`, async () => {
      const list = (await tagRuns(name)).filter((one) => one.event === event)
      return list.length > 0 && list.every((one) => one.status === 'completed') ? list : null
    })
    // A second run of the same push would show up within a few seconds.
    await pause(3000)
    assert.equal(
      (await tagRuns(name)).filter((one) => one.event === event).length,
      1,
      `${name} has more than one ${event} run`,
    )
    const jobs = await jobsOf(run.id)
    assert.equal(jobs.length, 1, `the run of ${name} has another number of jobs`)
    const log = jobs[0].conclusion === 'skipped' ? '' : await jobLog(jobs[0].id)
    return { run, job: jobs[0], log }
  }

  // --- WORKFLOW_DIRS: repository workflow files are not read; a push to main deploys nothing ---
  setStage('the second Gitea: pushes to main')
  const repositoryWorkflow = await file('infra/dev/pipeline-verify/workflows/impostor.yml')
  const perPush = []
  for (const [path, content] of [
    ['.github/workflows/deploy.yml', repositoryWorkflow],
    ['.gitea/workflows/deploy.yml', repositoryWorkflow],
    ['page.php', 'a change of the site\n'],
  ]) {
    const sha = await commit('sites/demo', path, `push of ${path}`, { content })
    // One push at a time: a run takes the head of the branch when Gitea handles the push.
    await waitFor(`the scoped run of ${path}`, async () =>
      (await runs()).some((run) => run.head_sha === sha),
    )
    // On the first Gitea such a push starts two runs at once; give a second one time to appear.
    await pause(2000)
    perPush.push((await runs()).filter((run) => run.head_sha === sha).map((run) => run.path))
  }
  assert.deepEqual(
    perPush,
    [
      ['push-probe.yml@refs/heads/main'],
      ['push-probe.yml@refs/heads/main'],
      ['push-probe.yml@refs/heads/main'],
    ],
    'a repository workflow file or the deploy started a run on a push to main',
  )
  const fromHardened = (body) =>
    body.action === 'requested' &&
    body.repository?.html_url === 'https://gitea-hardened:3000/sites/demo'
  const probeHooks = await waitFor(
    'the workflow_run webhooks of the pushes',
    async () => {
      const all = ctx.deliveries
        .filter((delivery) => delivery.event === 'workflow_run')
        .map((delivery) => ({ delivery, body: JSON.parse(delivery.raw) }))
        .filter(({ body }) => fromHardened(body))
      return all.length >= 3 ? all : null
    },
    30_000,
  )
  for (const { delivery, body } of probeHooks) {
    assert.ok(parseGiteaWebhook(delivery.headers, delivery.raw, webhookSecret), 'unsigned webhook')
    assert.equal(body.workflow.path, `${SCOPED}/push-probe.yml`, 'a repository workflow file ran')
  }
  const listed = await api('GET', '/repos/sites/demo/actions/workflows', { expect: 200 })
  assert.equal(listed.json.total_count, 0)
  const untrackable = await api(
    'POST',
    '/repos/sites/demo/contents/.git/raditi-no-repository-workflows/deploy.yml',
    { body: { content: b64(repositoryWorkflow), message: 'a file below .git', branch: 'main' } },
  )
  assert.ok(untrackable.status >= 400, `a file below .git was committed: ${untrackable.status}`)
  passed(
    `with \`[actions] WORKFLOW_DIRS = .git/raditi-no-repository-workflows\` each of 3 pushes to main of a site that carries .github/workflows/deploy.yml and .gitea/workflows/deploy.yml starts exactly 1 run — the scoped ${SCOPED}/push-probe.yml of platform/ci (by its webhook); the product deploy.yml starts no run on a push to main; GET …/actions/workflows → 0; a commit below .git is refused (${untrackable.status})`,
  )

  // --- The site: the installed version on the hosting, the import tag -----------------------
  setStage('the second Gitea: the installed version and tag v0.0.0')
  /** Commits several files at once (ChangeFiles); `null` deletes a file. */
  const change = async (message, files) => {
    const operations = []
    for (const [path, content] of Object.entries(files)) {
      const prior = await api('GET', `/repos/sites/demo/contents/${path}?ref=main`)
      const sha = prior.status === 200 ? prior.json.sha : undefined
      operations.push(
        content === null
          ? { operation: 'delete', path, sha }
          : {
              operation: sha ? 'update' : 'create',
              path,
              content: b64(content),
              ...(sha ? { sha } : {}),
            },
      )
    }
    const answer = await api('POST', '/repos/sites/demo/contents', {
      body: { branch: 'main', message, files: operations },
      expect: 201,
    })
    return answer.json.commit.sha
  }
  const versions = {
    installed: {
      'index.php': '<html><body>Магазин, версия 1.0</body></html>\n',
      'old.txt': 'a file the next release deletes\n',
    },
    'v1.1.0': {
      'index.php': '<html><body>Магазин, версия 1.1</body></html>\n',
      'wp-content/themes/demo/style.css': 'body { color: #222; }\n',
      'old.txt': null,
    },
    'v1.2.0': {
      'index.php':
        '<html><body><b>Fatal error</b>: Uncaught Error: Call to undefined function in index.php</body></html>\n',
      'wp-content/themes/demo/extra.css': '.extra { margin: 0; }\n',
      // In folders that do not exist yet: the rollback removes them again.
      'wp-content/plugins/extra/extra.php': '<?php // extra\n',
    },
  }
  const installedSha = await change('the site as the platform imported it', versions.installed)
  for (const [path, content] of Object.entries(versions.installed))
    await hosting.write(path, content)
  const tag = async (name, target) => {
    const created = await api('POST', '/repos/sites/demo/tags', {
      body: { tag_name: name, target },
      expect: 201,
    })
    assert.equal(created.json.commit.sha, target)
  }
  await tag('v0.0.0', installedSha)
  const zero = await endedRun('v0.0.0')
  assert.equal(zero.run.event, 'push')
  assert.equal(zero.job.conclusion, 'skipped')
  passed(
    'a lightweight tag v0.0.0 (the import) made through the API by the release account starts exactly 1 run of the scoped deploy.yml (event push, path deploy.yml@refs/tags/v0.0.0), and its job is skipped by its `if:`',
  )

  // --- A release tag without a deploy secret --------------------------------------------------
  setStage('the second Gitea: a release tag without a deploy secret')
  await tag('v1.0.0', installedSha)
  const bare = await endedRun('v1.0.0')
  // REST names no branch for a run of a tag (the field is absent).
  assert.ok(!bare.run.head_branch, 'a run of a tag names a branch')
  assert.equal(bare.run.head_sha, installedSha)
  assert.equal(bare.job.conclusion, 'success')
  assert.deepEqual(stepLines(bare.log), [
    `deploy-step: run event=push ref=refs/tags/v1.0.0 ref_name=v1.0.0 sha=${installedSha}`,
    'deploy-step: the repository has no deploy secret — not for this run',
  ])
  assert.equal(core.releases.size, 0)
  passed(
    'a release tag starts exactly 1 run (event push, no branch); in its job gitea.ref = refs/tags/v1.0.0, gitea.ref_name = v1.0.0 and gitea.sha = the tagged commit, as `deploy-step match` of the orchestrator image prints them; without a secret the job ends successfully, its step `deploy` skipped, and nothing calls the release API',
  )

  // --- Arming a release: the wrapping in OpenBao, the secret of the repository ----------------
  const releaseFiles = (from, to) => {
    const write = []
    const remove = []
    for (const [path, content] of Object.entries(to)) {
      const before = from[path] ?? null
      if (content === null) remove.push({ path, before: sha256(before) })
      else
        write.push({
          path,
          before: before === null ? null : sha256(before),
          after: sha256(content),
          sizeBytes: Buffer.byteLength(content),
          executable: false,
        })
    }
    return { write, delete: remove }
  }
  const wrapAlive = async (wrapToken) =>
    (await bao('POST', 'sys/wrapping/lookup', { token: rootToken, body: { token: wrapToken } }))
      .status === 200
  const arm = async ({ tag: name, sha, files, installed }) => {
    const releaseId = randomUUID()
    const token = secret(randomBytes(32).toString('base64url'))
    const backupKey = randomBytes(32)
    secret(backupKey.toString('base64'))
    const manifest = deployManifestSchema.parse({
      v: 1,
      releaseId,
      siteId: '0196abcd-0000-7000-8000-0000000000aa',
      deployAttempt: 1,
      tag: name,
      installedSha: installed,
      approvedSha: sha,
      method: 'sftp',
      files,
      db: [],
      contentEpoch: 1,
      verify: { origin: SITE_ORIGIN, failureMarkers: FAILURE_MARKERS, pages: ['/'] },
    })
    const access = deployAccessSchema.parse({
      v: 1,
      hosting: { method: 'sftp', access: hosting.access },
      content: null,
    })
    const wrapped = await bao('POST', 'sys/wrapping/wrap', {
      token: rootToken,
      headers: { 'x-vault-wrap-ttl': '1800' },
      body: {
        v: '1',
        releaseId,
        attempt: '1',
        releaseApiToken: token,
        backupKey: backupKey.toString('base64'),
      },
    })
    assert.equal(wrapped.status, 200, 'OpenBao refused the wrapping')
    const wrapToken = secret(wrapped.json.wrap_info.token)
    const release = {
      releaseId,
      token,
      backupKey,
      wrapToken,
      manifest,
      access,
      calls: [],
      reports: new Map(),
      sequence: [],
      repeats: 0,
      accessIssued: false,
      backup: null,
    }
    core.releases.set(releaseId, release)
    const value = formatDeployWrap({ releaseId, attempt: 1, tag: name, sha, wrapToken })
    await api('PUT', `/repos/sites/demo/actions/secrets/${DEPLOY_SECRET}`, {
      body: { data: value },
      expect: [201, 204],
    })
    return release
  }
  /** What the job printed must never carry a secret of the run. */
  const assertNoSecret = (log, release) => {
    for (const value of [
      release.token,
      release.wrapToken,
      release.backupKey.toString('base64'),
      hosting.access.password,
    ])
      assert.ok(!log.includes(value), 'a secret reached the job log')
  }

  // --- A secret for another tag: nothing is unwrapped -----------------------------------------
  setStage('the second Gitea: a deploy secret of another tag')
  const foreign = await arm({
    tag: 'v9.9.9',
    sha: installedSha,
    files: { write: [], delete: [] },
    installed: installedSha,
  })
  await tag('v1.0.1', installedSha)
  const other = await endedRun('v1.0.1')
  assert.equal(other.job.conclusion, 'success')
  assert.deepEqual(stepLines(other.log).slice(1), [
    'deploy-step: the deploy secret is for another tag or commit — not for this run',
  ])
  assert.ok(await wrapAlive(foreign.wrapToken), 'the wrapping of another tag was spent')
  assert.deepEqual(foreign.calls, [])
  passed(
    'a secret of another tag is compared with gitea.ref_name and gitea.sha before anything is unwrapped: the job ends successfully, the wrapping stays unspent in OpenBao and the release API is not called',
  )

  // --- A release: conflicts, backup, files over SFTP, the check of the site --------------------
  setStage('the second Gitea: release v1.1.0')
  const v110 = await change('release 1.1', versions['v1.1.0'])
  const first = await arm({
    tag: 'v1.1.0',
    sha: v110,
    files: releaseFiles(versions.installed, versions['v1.1.0']),
    installed: installedSha,
  })
  await tag('v1.1.0', v110)
  const installedRun = await endedRun('v1.1.0')
  // What deploy-step printed and reported says why a release job failed; it carries no secret.
  assertNoSecret(installedRun.log, first)
  assert.equal(
    installedRun.job.conclusion,
    'success',
    `the release job failed: reports [${first.sequence.join(', ')}], ${stepLines(installedRun.log).join(' | ')}`,
  )
  assert.deepEqual(first.sequence, [
    'conflicts started',
    'conflicts succeeded',
    'backup started',
    'backup succeeded',
    'files started',
    'files succeeded',
    'verify started',
    'verify succeeded',
  ])
  assert.deepEqual(
    first.calls.filter((call) => call !== 'steps' && call !== 'backup'),
    ['manifest', 'access'],
  )
  assert.equal(first.accessIssued, true)
  assert.equal(await hosting.read('index.php'), versions['v1.1.0']['index.php'])
  assert.equal(
    await hosting.read('wp-content/themes/demo/style.css'),
    versions['v1.1.0']['wp-content/themes/demo/style.css'],
  )
  assert.equal(await hosting.read('old.txt'), null)
  assert.deepEqual(
    (await hosting.list()).filter((path) => path.includes('.raditi-')),
    [],
    'a temporary file of an atomic write was left',
  )
  const backup = await openBackup(first.backup.bytes, first.backupKey, first.releaseId, 1)
  assert.deepEqual(
    Object.fromEntries(backup.files.map((one) => [one.path, Buffer.from(one.bytes).toString()])),
    versions.installed,
  )
  assert.equal(await wrapAlive(first.wrapToken), false, 'the wrapping was not spent')
  assertNoSecret(installedRun.log, first)
  assert.equal(stepLines(installedRun.log).at(-1), 'deploy-step: the release is installed')
  passed(
    `release v1.1.0 through the real deploy-step of the orchestrator image: the secret matched the run, the wrapping was unwrapped once at the runner's OpenBao, the access was asked for once after \`conflicts started\`, the files of the release commit were read from the repository with the job token and written over SFTP (one replaced, one added, one deleted, no temporary left), the backup of exactly the replaced and the deleted file was uploaded, opens with the attempt's key and was verified, the site passed its check before the first write and after the last; ${first.sequence.length} reports, no secret in the job log`,
  )

  // --- A second run of the same tag: workflow_dispatch, the wrapping already spent -------------
  setStage('the second Gitea: workflow_dispatch of the scoped deploy.yml')
  const dispatch = (ref, query = `&scoped_workflow_source_repo_id=${source.json.id}`) =>
    api(
      'POST',
      `/repos/sites/demo/actions/workflows/deploy.yml/dispatches?return_run_details=true${query}`,
      { as: botToken, body: { ref, inputs: {} } },
    )
  const shortRef = await dispatch('v1.1.0')
  assert.equal(shortRef.status, 404, 'a short tag name was dispatched')
  const noSource = await dispatch('refs/tags/v1.1.0', '')
  assert.equal(noSource.status, 404, 'a scoped workflow was dispatched without its source')
  const dispatched = await dispatch('refs/tags/v1.1.0')
  assert.equal(dispatched.status, 200)
  const repeat = await endedRun('v1.1.0', 'workflow_dispatch')
  assert.equal(repeat.run.id, dispatched.json.workflow_run_id)
  assert.equal(repeat.run.head_sha, v110)
  assert.equal(repeat.job.conclusion, 'failure')
  assert.deepEqual(stepLines(repeat.log), [
    `deploy-step: run event=workflow_dispatch ref=refs/tags/v1.1.0 ref_name=v1.1.0 sha=${v110}`,
    'deploy-step: the deploy secret is for this run',
    `deploy-step: run event=workflow_dispatch ref=refs/tags/v1.1.0 ref_name=v1.1.0 sha=${v110}`,
    'deploy-step: the deploy secret is for this run',
    'deploy-step: the deploy secret was already used, has expired or holds something else',
  ])
  assert.equal(first.calls.filter((call) => call === 'manifest').length, 1)
  assert.equal(await hosting.read('index.php'), versions['v1.1.0']['index.php'])
  passed(
    'POST …/actions/workflows/deploy.yml/dispatches with scoped_workflow_source_repo_id and ref refs/tags/v1.1.0 starts the scoped workflow (event workflow_dispatch, the same gitea.ref and gitea.sha); a short tag name and a call without the source are 404; the repeat finds its wrapping spent and ends failed without calling the release API or touching the hosting',
  )

  // --- A broken release: the check fails, the rollback puts everything back -------------------
  setStage('the second Gitea: release v1.2.0 that breaks the site')
  const installedNow = { ...versions.installed, ...versions['v1.1.0'] }
  delete installedNow['old.txt']
  const v120 = await change('release 1.2', versions['v1.2.0'])
  const broken = await arm({
    tag: 'v1.2.0',
    sha: v120,
    files: releaseFiles(installedNow, versions['v1.2.0']),
    installed: v110,
  })
  await tag('v1.2.0', v120)
  const rolledBack = await endedRun('v1.2.0')
  assert.equal(rolledBack.job.conclusion, 'failure')
  // The job prints fixed lines only: they explain a failure of this check.
  const brokenLines = stepLines(rolledBack.log).join(' | ')
  assert.deepEqual(
    broken.sequence,
    [
      'conflicts started',
      'conflicts succeeded',
      'backup started',
      'backup succeeded',
      'files started',
      'files succeeded',
      'verify started',
      'verify failed site_broken',
      'rollback started',
      'rollback succeeded',
      'reverify started',
      'reverify succeeded',
    ],
    brokenLines,
  )
  assert.equal(await hosting.read('index.php'), versions['v1.1.0']['index.php'])
  assert.equal(await hosting.read('wp-content/themes/demo/extra.css'), null)
  assert.deepEqual(
    (await hosting.list()).filter(
      (path) => path.startsWith('wp-content/plugins') || path.includes('.raditi-'),
    ),
    [],
    'the rollback left a folder it made or a temporary',
  )
  assert.equal(
    stepLines(rolledBack.log).at(-1),
    'deploy-step: the release was rolled back: the site is as it was',
  )
  assertNoSecret(rolledBack.log, broken)
  passed(
    'release v1.2.0 whose front page shows a PHP fatal error: the site passed its check before the first write, fails it after; the rollback, on an SFTP connection of its own, writes back the replaced file from the backup, removes the added ones and the folders the release made — reports verify failed → rollback succeeded → reverify succeeded, the job ends failed',
  )

  // --- One run per tag --------------------------------------------------------------------------
  const byTag = {}
  for (const run of await runs())
    if (run.path?.startsWith('deploy.yml@')) {
      const key = `${run.path.slice('deploy.yml@'.length)} ${run.event}`
      byTag[key] = (byTag[key] ?? 0) + 1
    }
  assert.deepEqual(byTag, {
    'refs/tags/v0.0.0 push': 1,
    'refs/tags/v1.0.0 push': 1,
    'refs/tags/v1.0.1 push': 1,
    'refs/tags/v1.1.0 push': 1,
    'refs/tags/v1.1.0 workflow_dispatch': 1,
    'refs/tags/v1.2.0 push': 1,
  })
  passed(
    'the scoped deploy.yml ran exactly once per tag and once per dispatch, never for a push to main',
  )
}
