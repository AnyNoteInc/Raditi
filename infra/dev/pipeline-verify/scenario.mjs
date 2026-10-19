// The questions of spike N18, asked of a real Gitea 1.27.3 with real runners. Every PASS line
// states what the real Gitea did; an answer that changes with a Gitea release fails the stand.
// platform/ci of this (first) Gitea holds check.yml of ci/ and the push-triggered pipeline of the
// spike (workflows/deploy-spike.yml) as deploy.yml; the release tag and the setting
// `[actions] WORKFLOW_DIRS` are asked of the second Gitea (tag-scenario.mjs).
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// The product parser, as the webhook route of apps/web will call it (Node strips the types).
import { parseGiteaWebhook } from '../../../packages/git-providers/src/webhook.ts'
import { parseProbe, scopedRequiredForm } from './stand.mjs'

const SCOPED = '.gitea/scoped_workflows'
const CHECK_CONTEXT = 'platform/ci: check / check (pull_request)'
const WRAP_SECRET = 'RADITI_DEPLOY_WRAP'
const b64 = (text) => Buffer.from(text).toString('base64')
const form = (fields) => new URLSearchParams(fields).toString()
const show = (value) => JSON.stringify(value)

export async function scenario(ctx) {
  const { gitea, bao, rootToken, passed, pause, site, setStage } = ctx
  const { api, admin, bot } = gitea
  const file = (path) => readFile(join(ctx.root, path), 'utf8')
  const standWorkflow = (name) => file(`infra/dev/pipeline-verify/workflows/${name}`)

  const waitFor = async (what, probe, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await probe()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
      await pause(500)
    }
  }

  // --- Fixture: organizations, the bot, repositories, the webhook, OpenBao ------------------
  setStage('creating the organizations, the bot and the repositories')
  const post = (path, body, as = admin, expect = 201) => api('POST', path, { as, body, expect })
  await post('/orgs', { username: 'platform', visibility: 'private' })
  await post('/orgs', { username: 'sites', visibility: 'private' })
  const team = await post('/orgs/sites/teams', {
    name: 'bots',
    permission: 'write',
    includes_all_repositories: true,
    units: ['repo.code', 'repo.pulls', 'repo.actions'],
  })
  await api('PUT', `/teams/${team.json.id}/members/${bot.user}`, { as: admin, expect: 204 })
  for (const [org, name] of [
    ['platform', 'ci'],
    ['sites', 'demo'],
    ['sites', 'other'],
  ])
    await post(`/orgs/${org}/repos`, {
      name,
      private: true,
      auto_init: true,
      default_branch: 'main',
    })
  // The token of spec §10: token calls need write:user, git and the API need write:repository.
  const issued = await post(
    `/users/${bot.user}/tokens`,
    { name: 'raditi-core', scopes: ['write:user', 'write:repository'] },
    bot,
  )
  const botToken = { token: ctx.secret(issued.json.sha1) }

  const commit = async (repo, path, message, options = {}) => {
    const { content = `${message}\n`, branch = 'main', newBranch, as = botToken } = options
    const answer = await api('POST', `/repos/${repo}/contents/${path}`, {
      as,
      body: {
        content: b64(content),
        message,
        branch,
        ...(newBranch ? { new_branch: newBranch } : {}),
      },
      expect: 201,
    })
    return answer.json.commit.sha
  }
  // platform/ci: the product workflows of ci/ exactly as they are, plus the stand's probes.
  const sourceFiles = {
    'check.yml': await file(`ci/${SCOPED}/check.yml`),
    // The push-triggered pipeline of the spike under the product's name: the questions below are
    // about a deploy on a push to main. The product deploy.yml runs on the second Gitea.
    'deploy.yml': await standWorkflow('deploy-spike.yml'),
    'probe.yml': await standWorkflow('probe.yml'),
    'probe-restricted.yml': await standWorkflow('probe-restricted.yml'),
    'cancel-probe.yml': await standWorkflow('cancel-probe.yml'),
  }
  for (const [name, content] of Object.entries(sourceFiles))
    await commit('platform/ci', `${SCOPED}/${name}`, `ci: ${name}`, { content, as: admin })

  const webhookSecret = ctx.secret(randomBytes(24).toString('hex'))
  await post('/orgs/sites/hooks', {
    type: 'gitea',
    active: true,
    events: ['push', 'pull_request', 'workflow_run', 'workflow_job'],
    config: {
      url: `http://host.docker.internal:${ctx.receiverPort}/webhooks/gitea`,
      content_type: 'json',
      secret: webhookSecret,
    },
  })

  const vault = (method, path, body, headers) =>
    bao(method, path, { token: rootToken, body, headers })
  const mounted = await vault('POST', 'sys/mounts/kv', { type: 'kv', options: { version: '2' } })
  assert.equal(mounted.status, 204, 'OpenBao did not mount kv/')
  for (const name of ['demo', 'other']) {
    const policy = `path "kv/data/sites/${name}/deploy" { capabilities = ["read"] }`
    const written = await vault('PUT', `sys/policies/acl/site-${name}-deploy`, { policy })
    assert.equal(written.status, 204, 'OpenBao did not store the deploy policy')
    const access = { data: { target: `synthetic-host-${name}` } }
    assert.equal((await vault('POST', `kv/data/sites/${name}/deploy`, access)).status, 200)
  }

  // --- Helpers of the checks -----------------------------------------------------------------
  const setSecret = (repo, value, as = botToken) =>
    api('PUT', `/repos/${repo}/actions/secrets/${WRAP_SECRET}`, { as, body: { data: value } })
  const setVariable = async (repo, name, value) => {
    const path = `/repos/${repo}/actions/variables/${name}`
    const existing = await api('GET', path, { as: botToken })
    if (existing.status === 200)
      await api('PUT', path, { as: botToken, body: { value }, expect: 204 })
    else await api('POST', path, { as: botToken, body: { value }, expect: 201 })
  }
  const tokenAlive = async (accessor) =>
    (await vault('POST', 'auth/token/lookup-accessor', { accessor })).status === 200
  /** The orchestrator's step before a merge: a deploy token of one site, wrapped for 10 minutes. */
  const arm = async (name) => {
    const wrapped = await bao('POST', 'auth/token/create', {
      token: rootToken,
      body: { policies: [`site-${name}-deploy`], ttl: '15m', renewable: false, no_parent: true },
      headers: { 'x-vault-wrap-ttl': '600' },
    })
    assert.equal(wrapped.status, 200, 'OpenBao did not wrap a deploy token')
    const { token, wrapped_accessor: accessor } = wrapped.json.wrap_info
    ctx.secret(token)
    // Without this a later "the token is revoked" would also hold for an accessor that never
    // named a token.
    assert.equal(await tokenAlive(accessor), true, 'the wrapped deploy token does not exist')
    const stored = await setSecret(`sites/${name}`, token)
    assert.ok([201, 204].includes(stored.status), `the secret was refused: ${stored.status}`)
    return { wrap: token, accessor }
  }

  const runsOf = async (repo, sha, as = botToken) => {
    const list = await api('GET', `/repos/${repo}/actions/runs?limit=50`, { as, expect: 200 })
    return (list.json.workflow_runs ?? []).filter((run) => !sha || run.head_sha === sha)
  }
  /** The completed runs of a commit, once there are `count` of them. */
  const waitRuns = (repo, sha, { event = 'push', count = 1, as } = {}) =>
    waitFor(`${count} completed ${event} run(s) of ${sha.slice(0, 8)} in ${repo}`, async () => {
      const runs = (await runsOf(repo, sha, as)).filter((run) => run.event === event)
      return runs.length >= count && runs.every((run) => run.status === 'completed') ? runs : null
    })
  const jobsOf = async (repo, runId) => {
    const list = await api('GET', `/repos/${repo}/actions/runs/${runId}/jobs`, {
      as: botToken,
      expect: 200,
    })
    return list.json.jobs ?? []
  }
  const steps = (job) => Object.fromEntries((job.steps ?? []).map((s) => [s.name, s.conclusion]))
  const jobLog = async (repo, jobId) =>
    (await api('GET', `/repos/${repo}/actions/jobs/${jobId}/logs`, { as: botToken, expect: 200 }))
      .text
  const marker = (repo) => site(`${repo}/marker`)
  const pipelineLog = async (repo) =>
    ((await site(`${repo}/pipeline.log`)) ?? '').split('\n').filter(Boolean)
  /** The run of a commit, once its deploy step has started and holds. */
  const waitHolding = (repo, sha) =>
    waitFor(`the deploy of ${sha.slice(0, 8)} to hold`, async () => {
      const [run] = await runsOf(repo, sha)
      if (!run) return null
      const log = await pipelineLog(repo)
      return log.some((line) => line.startsWith(`deploy-start run=${run.id} `)) ? run : null
    })

  const parsed = (delivery, key = webhookSecret) =>
    parseGiteaWebhook(delivery.headers, delivery.raw, key)
  const hooks = (event, match) =>
    ctx.deliveries
      .filter((delivery) => delivery.event === event)
      .map((delivery) => ({ delivery, body: JSON.parse(delivery.raw) }))
      .filter(({ body }) => match(body))
  const waitHook = (what, event, match) =>
    waitFor(`the webhook ${what}`, async () => hooks(event, match)[0] ?? null, 30_000)
  const runHook = (runId, action) =>
    waitHook(`workflow_run ${action} of run ${runId}`, 'workflow_run', (body) => {
      return body.workflow_run?.id === runId && body.action === action
    })
  const samples = {}

  // --- Registration of the source -------------------------------------------------------------
  setStage('registering platform/ci as a source of scoped workflows')
  const cookie = await gitea.login(admin)
  const orgAdd = (name) =>
    gitea.web('POST', '/org/sites/settings/actions/scoped-workflows/add', {
      cookie,
      form: form({ repo_name: name }),
    })
  for (const name of ['platform/ci', 'ci']) {
    const refused = await orgAdd(name)
    assert.equal(refused.status, 400, `the organization accepted ${name}`)
    assert.equal(refused.json?.errorMessage, 'Repository not found.')
  }
  const own = await orgAdd('other')
  assert.equal(own.status, 200, 'the organization refused its own repository')
  const other = await api('GET', '/repos/sites/other', { as: admin, expect: 200 })
  await gitea.web('POST', '/org/sites/settings/actions/scoped-workflows/remove', {
    cookie,
    form: form({ repo_id: other.json.id }),
    expect: 200,
  })
  passed(
    'an organization takes only its own repository as a source: POST /org/sites/settings/actions/scoped-workflows/add repo_name=platform/ci → 400 "Repository not found.", repo_name=other → 200',
  )

  const adminAdd = (options) =>
    gitea.web('POST', '/-/admin/actions/scoped-workflows/add', {
      form: form({ repo_name: 'platform/ci' }),
      ...options,
    })
  const anonymous = await adminAdd({})
  assert.equal(anonymous.status, 303, 'an anonymous request was not sent to the login page')
  const asBot = await adminAdd({ cookie: await gitea.login(bot) })
  assert.ok([403, 404].includes(asBot.status), `the bot reached the admin form: ${asBot.status}`)
  const crossSite = await adminAdd({ cookie, headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403, 'a cross-site request was accepted')
  await adminAdd({ cookie, expect: 200 })
  const swagger = await gitea.web('GET', '/swagger.v1.json', { expect: 200 })
  const paths = Object.keys(swagger.json.paths)
  assert.ok(paths.length > 300, 'the API description is not the one of Gitea')
  assert.deepEqual(
    paths.filter((path) => path.toLowerCase().includes('scoped')),
    [],
  )
  passed(
    `platform/ci is registered for the whole instance by an administrator's web session only: POST /-/admin/actions/scoped-workflows/add → 200 (no session → 303, the bot → ${asBot.status}, cross-site → 403); the REST API (${paths.length} paths) has nothing for scoped workflows`,
  )

  const source = await api('GET', '/repos/platform/ci', { as: admin, expect: 200 })
  const sourceId = source.json.id
  const files = Object.keys(sourceFiles).sort()
  const toggle = (action, name, repo = 'sites/other') =>
    gitea.web(
      'POST',
      `/${repo}/actions/${action}?workflow=${name}&scoped_workflow_source_repo_id=${sourceId}`,
      { cookie },
    )
  const optional = await toggle('disable', 'deploy.yml')
  assert.equal(optional.status, 200, 'a scoped workflow that is not required could not be disabled')
  assert.equal((await toggle('enable', 'deploy.yml')).status, 200)
  const required = (patterns) =>
    gitea.web('POST', '/-/admin/actions/scoped-workflows/required', {
      cookie,
      form: scopedRequiredForm({ repositoryId: sourceId, files, required: patterns }),
    })
  const noPattern = await required({ 'deploy.yml': '' })
  assert.equal(noPattern.status, 400)
  assert.equal(
    noPattern.json?.errorMessage,
    'Each required workflow needs at least one status check pattern.',
  )
  // deploy.yml posts its status on a push to main, never on a pull request: its pattern is the
  // status of check.yml, or no pull request to a protected branch could ever be merged.
  const pattern = 'platform/ci: check / *'
  assert.equal((await required({ 'check.yml': pattern, 'deploy.yml': pattern })).status, 200)
  const locked = await toggle('disable', 'deploy.yml')
  assert.equal(locked.status, 400, 'a required scoped workflow was disabled')
  assert.equal(
    locked.json?.errorMessage,
    'This scoped workflow is required and cannot be disabled.',
  )
  const rest = await api('PUT', '/repos/sites/other/actions/workflows/deploy.yml/disable', {
    as: admin,
  })
  assert.equal(rest.status, 404, 'the REST API knows the scoped workflow')
  passed(
    'a scoped workflow can be switched off in a repository (200) until it is marked required; then POST /sites/other/actions/disable?workflow=deploy.yml → 400 "This scoped workflow is required and cannot be disabled."; REST …/workflows/deploy.yml/disable → 404',
  )

  // --- Rights of the bot ----------------------------------------------------------------------
  setStage('rights of the bot')
  const asWriter = await setSecret('sites/demo', 'not-a-token')
  assert.equal(asWriter.status, 403, `a team member with write set a secret: ${asWriter.status}`)
  assert.equal(asWriter.json?.message, 'user should be the owner of the repo')
  const variableAsWriter = await api('POST', '/repos/sites/demo/actions/variables/RADITI_PROBE', {
    as: botToken,
    body: { value: 'probe' },
  })
  assert.equal(variableAsWriter.status, 403, 'a team member with write set an Actions variable')
  const switchOff = await api('PATCH', '/repos/sites/demo', {
    as: botToken,
    body: { has_actions: false },
  })
  assert.equal(switchOff.status, 403, 'a team member with write switched Actions off')
  const teams = await api('GET', '/orgs/sites/teams', { as: admin, expect: 200 })
  const owners = teams.json.find((entry) => entry.name === 'Owners')
  await api('PUT', `/teams/${owners.id}/members/${bot.user}`, { as: admin, expect: 204 })
  const asOwner = await setSecret('sites/demo', 'not-a-token')
  assert.equal(asOwner.status, 201, `an owner could not set a secret: ${asOwner.status}`)
  passed(
    'the bot with the team permission `write` cannot set an Actions secret: PUT /repos/sites/demo/actions/secrets/… → 403 "user should be the owner of the repo" (a variable: POST …/actions/variables/… → 403; switching Actions off: 403); as a member of the team Owners of `sites` the same token gets 201',
  )

  // --- The first push of a site: no wrapper, no deploy ------------------------------------------
  // Site content is pushed only now. Gitea handles a push after it has answered: a push made
  // just before the registration may or may not start the scoped workflows.
  setStage('a push to main without a wrapped deploy token')
  const frontSha = await commit('sites/demo', 'index.php', 'site: front page', {
    content: '<?php echo "synthetic site";\n',
  })
  const [unarmed] = await waitRuns('sites/demo', frontSha)
  assert.equal(unarmed.conclusion, 'failure', 'a deploy ran without a wrapped token')
  const unarmedSteps = steps((await jobsOf('sites/demo', unarmed.id))[0])
  assert.equal(unarmedSteps['vault-login'], 'failure')
  assert.equal(unarmedSteps.backup, 'skipped')
  assert.equal(unarmedSteps.deploy, 'skipped')
  assert.equal(unarmedSteps.rollback, 'skipped')
  assert.equal(await marker('sites/demo'), null, 'the site was touched')
  passed(
    `a push to main of a site whose Actions secret is not a live wrapper starts the required deploy (run ${unarmed.id}) and it stops at vault-login: nothing is backed up, deployed or rolled back`,
  )

  // --- Q1: the workflow of platform/ci runs in a site repository without CI files ------------
  setStage('Q1: pull request, check, merge and deploy in a repository without CI files')
  const tree = await api('GET', '/repos/sites/demo/git/trees/main?recursive=true', {
    as: botToken,
    expect: 200,
  })
  const siteFiles = tree.json.tree.map((entry) => entry.path)
  assert.ok(!siteFiles.some((path) => /^\.(gitea|github|forgejo)(\/|$)/.test(path)))
  const headSha = await commit('sites/demo', 'style.css', 'agent: change the header colour', {
    newBranch: 'agent/task-1',
  })
  const opened = await post(
    '/repos/sites/demo/pulls',
    { head: 'agent/task-1', base: 'main', title: 'Task 1', body: 'synthetic' },
    botToken,
  )
  const [checkRun] = await waitRuns('sites/demo', headSha, { event: 'pull_request' })
  assert.equal(checkRun.conclusion, 'success', 'check failed')
  const status = await api('GET', `/repos/sites/demo/commits/${headSha}/status`, {
    as: botToken,
    expect: 200,
  })
  const contexts = (status.json.statuses ?? []).map((entry) => `${entry.context}=${entry.status}`)
  assert.deepEqual(contexts, [`${CHECK_CONTEXT}=success`], `statuses: ${show(contexts)}`)
  passed(
    `check.yml of platform/ci ran for a pull request of sites/demo (files: ${siteFiles.join(', ')}): run ${checkRun.id} success, commit status "${CHECK_CONTEXT}" = success`,
  )

  const first = await arm('demo')
  await waitFor(
    'the merge',
    async () => {
      const merge = await api('POST', `/repos/sites/demo/pulls/${opened.json.number}/merge`, {
        as: botToken,
        body: { Do: 'merge', head_commit_id: headSha },
      })
      if (merge.status === 200) return true
      // Gitea has not computed the mergeability yet.
      if (merge.status === 405) return false
      throw new Error(`The merge answered HTTP ${merge.status}`)
    },
    30_000,
  )
  const pull = await api('GET', `/repos/sites/demo/pulls/${opened.json.number}`, {
    as: botToken,
    expect: 200,
  })
  assert.equal(pull.json.merged, true)
  const mergeSha = pull.json.merge_commit_sha
  const polled = []
  const deployRun = await waitFor('the deploy of the merge', async () => {
    const [run] = (await runsOf('sites/demo', mergeSha)).filter((entry) => entry.event === 'push')
    if (!run) return null
    if (polled.at(-1) !== run.status) polled.push(run.status)
    return run.status === 'completed' ? run : null
  })
  assert.equal(deployRun.conclusion, 'success', 'the deploy failed')
  assert.equal(deployRun.path, 'deploy.yml@refs/heads/main')
  const deployed = await marker('sites/demo')
  assert.equal(
    deployed,
    `state=deployed\nsha=${mergeSha}\nsubject=Merge pull request 'Task 1' (#${opened.json.number}) from agent/task-1 into main\n`,
  )
  const firstLog = await pipelineLog('sites/demo')
  assert.deepEqual(firstLog, [
    `backup run=${deployRun.id}`,
    `deploy-start run=${deployRun.id} sha=${mergeSha} access=read`,
    `deploy-end run=${deployRun.id} sha=${mergeSha}`,
    `verify-ok run=${deployRun.id}`,
  ])
  // The job reached OpenBao by the address its runner gives it: the repository names none.
  const named = await api('GET', '/repos/sites/demo/actions/variables/RADITI_VAULT_ADDR', {
    as: botToken,
  })
  assert.equal(named.status, 404, 'a variable of the site repository names Vault')
  const listed = await api('GET', '/repos/sites/demo/actions/workflows', {
    as: botToken,
    expect: 200,
  })
  assert.equal(listed.json.total_count, 0, 'the REST API lists the scoped workflows')
  passed(
    `Q1 deploy.yml of platform/ci ran in sites/demo after the merge: run ${deployRun.id} (${polled.join(' → ')}) success, the site marker carries the merge commit ${mergeSha.slice(0, 8)}; the address of OpenBao came from the configuration of the deploy runner (the repository has no such variable); GET …/actions/workflows of the site lists 0 workflows`,
  )

  const noteSha = await commit('platform/ci', 'NOTE.md', 'ci: a note', { as: admin })
  // The bot is not a member of `platform`: for its token the repository does not exist (404).
  const [selfRun] = await waitRuns('platform/ci', noteSha, { as: admin })
  assert.equal(selfRun.conclusion, 'skipped', 'the pipeline ran in platform/ci itself')
  passed(
    `the instance-level source is triggered in platform/ci itself too: run ${selfRun.id} of deploy.yml there is "skipped" by the guard \`if: gitea.repository_owner == 'sites'\``,
  )

  // --- Q4: the status by polling and by signed webhooks ---------------------------------------
  setStage('Q4: webhooks of the deploy')
  const actions = ['requested', 'in_progress', 'completed']
  const runHooks = []
  for (const action of actions) runHooks.push(await runHook(deployRun.id, action))
  for (const [index, { delivery, body }] of runHooks.entries()) {
    const event = parsed(delivery)
    assert.ok(event, 'a signed workflow_run was not parsed')
    assert.equal(event.kind, 'workflow_run')
    assert.deepEqual(event.repo, { provider: 'gitea', owner: 'sites', name: 'demo' })
    assert.equal(event.run.id, String(deployRun.id))
    assert.equal(event.run.name, 'deploy')
    assert.equal(event.run.headSha, mergeSha)
    assert.equal(event.run.status, ['queued', 'in_progress', 'completed'][index])
    assert.equal(event.run.conclusion, index === 2 ? 'success' : null)
    // Where the workflow file lives is in the webhook only; the REST run does not say it.
    assert.equal(body.workflow.path, `${SCOPED}/deploy.yml`)
    assert.match(body.workflow.html_url, /\/platform\/ci\/src\/commit\/[0-9a-f]{40}\//)
    assert.equal(delivery.headers.get('x-gitea-hook-installation-target-type'), 'organization')
    assert.equal(parsed(delivery, 'another-secret'), null, 'a foreign signature was accepted')
    assert.equal(parseGiteaWebhook(delivery.headers, `${delivery.raw} `, webhookSecret), null)
  }
  samples.runRequested = runHooks[0].delivery
  samples.runInProgress = runHooks[1].delivery
  samples.runSuccess = runHooks[2].delivery
  const jobHooks = await waitFor(
    'the workflow_job webhooks',
    async () => {
      const all = hooks('workflow_job', (body) => body.workflow_job?.run_id === deployRun.id)
      return all.some(({ body }) => body.action === 'completed') ? all : null
    },
    30_000,
  )
  for (const { delivery } of jobHooks) {
    const signature = createHmac('sha256', webhookSecret).update(delivery.raw).digest('hex')
    assert.equal(delivery.headers.get('x-gitea-signature'), signature, 'workflow_job is unsigned')
    // A job of the deploy run: the only event that names the step (plan 53, R8a).
    const job = parsed(delivery)
    assert.equal(job?.kind, 'workflow_job')
    assert.equal(job.job.runId, String(deployRun.id))
  }
  const jobActions = [...new Set(jobHooks.map(({ body }) => body.action))]
  const jobDone = jobHooks.find(({ body }) => body.action === 'completed').body.workflow_job
  assert.equal(jobDone.conclusion, 'success')
  assert.deepEqual(
    jobDone.steps.map((step) => `${step.name}=${step.conclusion}`),
    [
      'vault-login=success',
      'backup=success',
      'deploy=success',
      'verify=success',
      'rollback=skipped',
      'vault-logout=success',
    ],
  )
  const prOpened = await waitHook('pull_request opened', 'pull_request', (body) => {
    return body.action === 'opened' && body.number === opened.json.number
  })
  assert.equal(parsed(prOpened.delivery)?.pullRequest.state, 'open')
  assert.equal(parsed(prOpened.delivery)?.pullRequest.headSha, headSha)
  const prMerged = await waitHook('pull_request closed', 'pull_request', (body) => {
    return body.action === 'closed' && body.number === opened.json.number
  })
  assert.equal(parsed(prMerged.delivery)?.pullRequest.state, 'merged')
  const pushed = await waitHook('push of the merge', 'push', (body) => body.after === mergeSha)
  assert.deepEqual(parsed(pushed.delivery), {
    kind: 'push',
    repo: { provider: 'gitea', owner: 'sites', name: 'demo' },
    branch: 'main',
    headSha: mergeSha,
  })
  samples.pullRequestOpened = prOpened.delivery
  samples.pullRequestMerged = prMerged.delivery
  samples.pushMain = pushed.delivery
  passed(
    `Q4 the run is visible by polling GET …/actions/runs and by three signed workflow_run webhooks (requested, in_progress, completed) that parseGiteaWebhook maps to queued → in_progress → completed/success; a foreign secret and a changed body give null; pull_request and push are parsed too`,
  )
  passed(
    `workflow_job webhooks (${jobActions.join(', ')}) are signed and carry every step with its conclusion; parseGiteaWebhook maps them to workflow_job events of the deploy run`,
  )

  // --- Q5: the wrapped token is unwrapped exactly once -----------------------------------------
  setStage('Q5: the wrapped deploy token')
  const again = await bao('POST', 'sys/wrapping/unwrap', { token: first.wrap })
  assert.equal(again.status, 400, `the wrapper was unwrapped twice: ${again.status}`)
  assert.match(show(again.json?.errors), /wrapping token is not valid or does not exist/)
  assert.equal(await tokenAlive(first.accessor), false, 'the deploy token outlived the pipeline')
  const [deployJob] = await jobsOf('sites/demo', deployRun.id)
  const deployLog = await jobLog('sites/demo', deployJob.id)
  assert.ok(deployLog.includes('vault-login: unwrapped'))
  assert.ok(!deployLog.includes(first.wrap), 'the wrapper is in the job log')
  const rerun = await api('POST', `/repos/sites/demo/actions/runs/${deployRun.id}/rerun`, {
    as: botToken,
  })
  assert.ok([200, 201].includes(rerun.status), `the re-run answered HTTP ${rerun.status}`)
  const second = await waitFor('the re-run', async () => {
    const run = await api('GET', `/repos/sites/demo/actions/runs/${deployRun.id}`, {
      as: botToken,
      expect: 200,
    })
    return run.json.run_attempt === 2 && run.json.status === 'completed' ? run.json : null
  })
  assert.equal(second.conclusion, 'failure', 'a re-run unwrapped the spent wrapper')
  const [rerunJob] = await jobsOf('sites/demo', deployRun.id)
  const rerunSteps = steps(rerunJob)
  assert.equal(rerunSteps['vault-login'], 'failure')
  assert.equal(rerunSteps.backup, 'skipped')
  assert.equal(rerunSteps.rollback, 'skipped')
  assert.equal(await marker('sites/demo'), deployed, 'the re-run changed the site')
  assert.deepEqual(await pipelineLog('sites/demo'), firstLog)
  const removed = await api('DELETE', `/repos/sites/demo/actions/secrets/${WRAP_SECRET}`, {
    as: botToken,
  })
  assert.equal(removed.status, 204)
  passed(
    'Q5 the wrapper made through the API of OpenBao was unwrapped by vault-login once: a second POST sys/wrapping/unwrap → 400 "wrapping token is not valid or does not exist"; the deploy token is revoked when the pipeline ends; the wrapper is not in the job log',
  )
  passed(
    `a re-run of the finished deploy (POST …/runs/${deployRun.id}/rerun → ${rerun.status}) fails at vault-login and leaves the site untouched: backup and rollback are skipped`,
  )

  // --- Q6: a failed verify starts the rollback --------------------------------------------------
  setStage('Q6: a deploy whose verify fails')
  await arm('demo')
  const faultSha = await commit(
    'sites/demo',
    'page.php',
    'raditi-fault: a page that breaks the site',
  )
  const [faultRun] = await waitRuns('sites/demo', faultSha)
  assert.equal(faultRun.conclusion, 'failure')
  const [faultJob] = await jobsOf('sites/demo', faultRun.id)
  assert.deepEqual(steps(faultJob), {
    'vault-login': 'success',
    backup: 'success',
    deploy: 'success',
    verify: 'failure',
    rollback: 'success',
    'vault-logout': 'success',
  })
  assert.equal(await marker('sites/demo'), deployed, 'the rollback did not restore the site')
  assert.deepEqual((await pipelineLog('sites/demo')).slice(-5), [
    `backup run=${faultRun.id}`,
    `deploy-start run=${faultRun.id} sha=${faultSha} access=read`,
    `deploy-end run=${faultRun.id} sha=${faultSha}`,
    `verify-failed run=${faultRun.id}`,
    `rollback-restored run=${faultRun.id}`,
  ])
  const faultHook = await runHook(faultRun.id, 'completed')
  assert.deepEqual(
    [parsed(faultHook.delivery)?.run.status, parsed(faultHook.delivery)?.run.conclusion],
    ['completed', 'failure'],
  )
  const faultJobHook = await waitHook(
    'workflow_job of the failed deploy',
    'workflow_job',
    (body) => {
      return body.workflow_job?.run_id === faultRun.id && body.action === 'completed'
    },
  )
  samples.runFailure = faultHook.delivery
  samples.jobFailure = faultJobHook.delivery
  passed(
    `Q6 a commit that breaks the site: verify failed, the step rollback ran and restored the previous marker; run ${faultRun.id} is "failure" by polling and by webhook; only the workflow_job body tells which step failed (verify)`,
  )

  // --- Q3: concurrency ---------------------------------------------------------------------------
  setStage('Q3: the queue of deploys')
  await setVariable('sites/demo', 'RADITI_DEPLOY_HOLD_SECONDS', '30')
  await arm('demo')
  const shaA = await commit('sites/demo', 'a.txt', 'queue A')
  const runA = await waitHolding('sites/demo', shaA)
  const jobContainers = await ctx.jobContainers()
  assert.equal(jobContainers.length, 1, `job containers: ${show(jobContainers)}`)
  const [jobName, jobLabel, jobNetworks] = jobContainers[0].split('\t')
  assert.match(jobName, /^GITEA-ACTIONS-TASK-\d+-WORKFLOW-deploy-JOB-deploy-/)
  assert.equal(jobLabel, ctx.names.stand)
  assert.equal(jobNetworks, ctx.names.networks.deploy)
  await arm('other')
  const shaX = await commit('sites/other', 'x.txt', 'another site')
  const [runX] = await waitRuns('sites/other', shaX)
  assert.equal(runX.conclusion, 'success')
  assert.equal((await runsOf('sites/demo', shaA))[0].status, 'in_progress', 'A ended too early')
  // A has unwrapped its token already: the next run of the site gets a fresh wrapper.
  await arm('demo')
  const shaB = await commit('sites/demo', 'b.txt', 'queue B')
  const waitingB = await waitFor('B to appear', async () => (await runsOf('sites/demo', shaB))[0])
  const shaC = await commit('sites/demo', 'c.txt', 'queue C')
  const cancelledB = await waitFor('B to be cancelled', async () => {
    const [run] = await runsOf('sites/demo', shaB)
    return run.status === 'completed' ? run : null
  })
  assert.equal(cancelledB.conclusion, 'cancelled')
  const [waitingC] = await runsOf('sites/demo', shaC)
  const stillA = (await runsOf('sites/demo', shaA))[0].status
  assert.equal(stillA, 'in_progress', 'A ended before the queue was measured')
  assert.equal(waitingC.status, 'waiting')
  const [doneA] = await waitRuns('sites/demo', shaA)
  const [doneC] = await waitRuns('sites/demo', shaC)
  assert.deepEqual([doneA.conclusion, doneC.conclusion], ['success', 'success'])
  assert.match(await marker('sites/demo'), new RegExp(`^state=deployed\nsha=${shaC}\n`))
  const queueLog = await pipelineLog('sites/demo')
  const at = (line) => queueLog.findIndex((entry) => entry.startsWith(line))
  assert.ok(
    at(`deploy-end run=${runA.id} `) < at(`backup run=${doneC.id}`),
    'C started before A ended',
  )
  assert.ok(!queueLog.some((entry) => entry.includes(`run=${cancelledB.id}`)), 'B touched the site')
  const otherLog = await pipelineLog('sites/other')
  assert.ok(otherLog.includes(`verify-ok run=${runX.id}`))
  await setVariable('sites/demo', 'RADITI_DEPLOY_HOLD_SECONDS', '0')
  passed(
    `Q3 concurrency deploy-<repository>, cancel-in-progress false: while run ${runA.id} (A) deploys, B is "${waitingB.status}"; the push of C cancels B (run ${cancelledB.id} "cancelled", it never touched the site) and C waits; C deployed after A ended — one running and one waiting run per repository, not a queue of all`,
  )
  passed(
    `the group is per repository: sites/other deployed (run ${runX.id}) while A of sites/demo was in progress`,
  )
  passed(
    `a job container carries the label of the run and joins the runner's network: ${jobName.slice(0, 48)}… on ${jobNetworks}`,
  )

  // --- Q2: what a site repository can do to the obligatory workflow -----------------------------
  setStage('Q2: Actions switched off in the repository')
  await api('PATCH', '/repos/sites/other', {
    as: botToken,
    body: { has_actions: false },
    expect: 200,
  })
  const shaOff = await commit('sites/other', 'off.txt', 'pushed while Actions are off')
  // Gitea handles a push after it has answered: the unit goes back on only when this push has
  // been handled (its webhook is out), so the missing run is not a matter of timing.
  await waitHook('push made while Actions are off', 'push', (body) => body.after === shaOff)
  await pause(1500)
  await api('PATCH', '/repos/sites/other', {
    as: botToken,
    body: { has_actions: true },
    expect: 200,
  })
  await arm('other')
  const shaOn = await commit('sites/other', 'on.txt', 'pushed after Actions are on again')
  const [runOn] = await waitRuns('sites/other', shaOn)
  assert.equal(runOn.conclusion, 'success')
  assert.deepEqual(await runsOf('sites/other', shaOff), [], 'a run exists for the silent commit')
  passed(
    'Q2 an owner of the repository can silence the required workflow by switching the Actions unit off (PATCH /repos/sites/other has_actions=false → 200): the push made while it was off has 0 runs, the next one deployed',
  )

  setStage('Q2: a workflow file on a branch of the site repository cancels the deploy')
  const attackInit = await commit('sites/other', '.gitea/workflows/attack.yml', 'a workflow file', {
    content: await standWorkflow('attack.yml'),
    newBranch: 'attack/1',
  })
  await waitRuns('sites/other', attackInit)
  await setVariable('sites/other', 'RADITI_DEPLOY_HOLD_SECONDS', '90')
  const beforeAttack = await marker('sites/other')
  const armedD = await arm('other')
  const shaD = await commit('sites/other', 'd.txt', 'a deploy that will be cancelled')
  const runD = await waitHolding('sites/other', shaD)
  assert.match(await marker('sites/other'), /^state=deploying\n/, 'the site is not half-deployed')
  const shaAttack = await commit('sites/other', 'attack.txt', 'cancel the deploy', {
    branch: 'attack/1',
  })
  const [cancelledD] = await waitRuns('sites/other', shaD)
  assert.equal(cancelledD.conclusion, 'cancelled', 'the deploy was not cancelled')
  const [jobD] = await jobsOf('sites/other', runD.id)
  const stepsD = steps(jobD)
  assert.equal(stepsD.verify, 'skipped')
  assert.equal(stepsD.rollback, 'success')
  assert.equal(stepsD['vault-logout'], 'success')
  assert.equal(
    await marker('sites/other'),
    beforeAttack,
    'the cancelled deploy was not rolled back',
  )
  assert.equal((await pipelineLog('sites/other')).at(-1), `rollback-restored run=${runD.id}`)
  assert.equal(await tokenAlive(armedD.accessor), false, 'the token of the cancelled deploy lives')
  const cancelHook = await runHook(runD.id, 'completed')
  assert.equal(parsed(cancelHook.delivery)?.run.conclusion, 'cancelled')
  samples.runCancelled = cancelHook.delivery
  await waitRuns('sites/other', shaAttack)
  await setVariable('sites/other', 'RADITI_DEPLOY_HOLD_SECONDS', '0')
  passed(
    `Q2 a workflow file on the branch attack/1 of the site repository (same concurrency group, cancel-in-progress: true) cancelled the running required deploy: run ${runD.id} "cancelled" in the middle of its deploy step (step deploy: ${stepsD.deploy})`,
  )
  passed(
    'the cancelled deploy was rolled back by the step `if: (failure() || cancelled()) && …`: the marker is the one before the deploy, the deploy token is revoked',
  )

  setStage('Q2: a workflow file named deploy in the site repository')
  await arm('other')
  const shaImpostor = await commit(
    'sites/other',
    '.gitea/workflows/deploy.yml',
    'a file named deploy',
    {
      content: await standWorkflow('impostor.yml'),
    },
  )
  const pair = await waitRuns('sites/other', shaImpostor, { count: 2 })
  assert.equal(pair.length, 2, `runs of the commit: ${pair.length}`)
  assert.deepEqual(
    pair.map((run) => [run.path, run.conclusion]),
    [
      ['deploy.yml@refs/heads/main', 'success'],
      ['deploy.yml@refs/heads/main', 'success'],
    ],
  )
  const pairHooks = []
  for (const run of pair) pairHooks.push(await runHook(run.id, 'completed'))
  assert.deepEqual(
    pairHooks.map(({ delivery }) => parsed(delivery)?.run.name),
    ['deploy', 'deploy'],
  )
  assert.deepEqual(pairHooks.map(({ body }) => body.workflow.path).sort(), [
    `${SCOPED}/deploy.yml`,
    '.gitea/workflows/deploy.yml',
  ])
  const impostorHook = pairHooks.find(({ body }) =>
    body.workflow.path.startsWith('.gitea/workflows/'),
  )
  const [impostorJob] = await jobsOf('sites/other', impostorHook.body.workflow_run.id)
  const impostor = parseProbe(await jobLog('sites/other', impostorJob.id)).impostor
  assert.deepEqual(impostor, { deploy_secret: 'visible', site_volume: 'mounted' })
  samples.runRepositoryWorkflow = impostorHook.delivery
  const repositoryListed = await api('GET', '/repos/sites/other/actions/workflows', {
    as: botToken,
    expect: 200,
  })
  assert.deepEqual(
    repositoryListed.json.workflows.map((entry) => entry.path),
    ['.gitea/workflows/deploy.yml'],
  )
  // The same for .github/workflows, in a repository that has neither a secret nor a variable:
  // the required deploy fails at vault-login, the repository workflow runs.
  await post('/orgs/sites/repos', {
    name: 'control',
    private: true,
    auto_init: true,
    default_branch: 'main',
  })
  const shaGithub = await commit('sites/control', '.github/workflows/deploy.yml', 'a file', {
    content: await standWorkflow('impostor.yml'),
  })
  const control = await waitRuns('sites/control', shaGithub, { count: 2 })
  assert.deepEqual(control.map((run) => run.conclusion).sort(), ['failure', 'success'])
  passed(
    `Q2 a file .gitea/workflows/deploy.yml (or .github/workflows/deploy.yml) in the site repository runs next to the required workflow: 2 runs of one commit, both "deploy.yml@refs/heads/main" in the REST API and both named "deploy" for parseGiteaWebhook; only workflow.path of the webhook body tells them apart; GET …/actions/workflows lists the repository file only`,
  )
  passed(
    'that repository workflow ran on the `deploy` runner with the site volume mounted and saw the Actions secret of the deploy (it reported "visible", the value was not used)',
  )

  setStage('Q2: conditional steps of a cancelled run')
  const shaHold = await commit('sites/other', 'cancel.txt', 'hold', { newBranch: 'cancel/1' })
  await waitFor('the held run', async () => {
    const [run] = await runsOf('sites/other', shaHold)
    return run?.status === 'in_progress'
  })
  await pause(4000)
  const shaRelease = await commit('sites/other', 'release.txt', 'release', { branch: 'cancel/1' })
  const [held] = await waitRuns('sites/other', shaHold)
  assert.equal(held.conclusion, 'cancelled')
  const heldSteps = steps((await jobsOf('sites/other', held.id))[0])
  assert.equal(heldSteps['failure-only'], 'skipped')
  assert.equal(heldSteps['failure-or-cancelled'], 'success')
  assert.equal(heldSteps.always, 'success')
  await waitRuns('sites/other', shaRelease)
  passed(
    'a cancelled run skips a step with `if: failure()` and executes steps with `failure() || cancelled()` and `always()`: the rollback of spec §10 (`if: failure()`) would not run after a cancel',
  )

  // --- Q7: what a job container reaches ----------------------------------------------------------
  setStage('Q7: what a job container reaches')
  await setVariable('sites/other', 'RADITI_PROBE_OTHER_REPO', 'sites/demo')
  await setVariable('sites/other', 'RADITI_PROBE_HOST_PORT', String(ctx.receiverPort))
  await setSecret('sites/other', 'placeholder-not-a-token')
  const shaProbe = await commit('sites/other', 'probe.txt', 'probe', { newBranch: 'probe/1' })
  const probeRuns = await waitRuns('sites/other', shaProbe, { count: 2 })
  const probe = {}
  for (const run of probeRuns)
    for (const job of await jobsOf('sites/other', run.id))
      Object.assign(probe, parseProbe(await jobLog('sites/other', job.id)))
  const common = {
    uid: '0',
    no_new_privs: '0',
    rootfs: 'writable',
    docker_socket: 'absent',
    default_route: '1',
    deploy_secret: 'visible',
    tcp_gitea: 'open',
    tcp_host: 'open',
    token_own_repo: '200',
    token_other_site: '404',
    token_platform_ci: '404',
    token_own_secrets: '403',
    token_set_variable: '403',
    token_write_code: '201',
  }
  for (const kind of ['check', 'deploy']) {
    const { cap_eff: capabilities, ...values } = probe[kind] ?? {}
    assert.match(capabilities ?? '', /^[0-9a-f]{16}$/)
    assert.notEqual(capabilities, '0000000000000000', 'a job has no capabilities at all')
    assert.deepEqual(
      values,
      {
        ...common,
        site_volume: kind === 'deploy' ? 'mounted' : 'absent',
        tcp_openbao: kind === 'deploy' ? 'open' : 'closed',
      },
      `probe of ${kind}: ${show(probe[kind])}`,
    )
  }
  assert.deepEqual(probe.restricted, { token_own_repo: '200', token_write_code: '403' })
  passed(
    `Q7 a job container (${probe.deploy.cap_eff} capabilities) runs as uid 0 with a writable root and Docker's default capabilities, without the Docker socket; it has a default route and reached a port of the host; the secret of the repository is visible to every workflow`,
  )
  passed(
    'Q7 a `check` job has no site volume and does not reach OpenBao on its Docker network (openbao:8200 closed); a `deploy` job has both (two runners, two networks). Both kinds reached a port on the loopback of the host, where the stand publishes OpenBao too: what keeps `check` away from Vault is the network of the runner machines, not this stand',
  )
  passed(
    'Q7 the job token reads its own repository (200) and no other (another site and platform/ci → 404), cannot list secrets or set variables (403), but by default WRITES code to its repository (201); with `permissions: contents: read` in the workflow the write is refused (403)',
  )

  return samples
}
