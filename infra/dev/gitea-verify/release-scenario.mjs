// The release calls of GiteaProvider on the stand's Gitea (docs/plan/53-chat-preview-release.md,
// Р26–Р29, Р35): Actions secrets of a repository and tag protection as an owner of the
// organization, the release tag made as that account, tags, the run the tag starts,
// workflow_dispatch, and the webhooks of all that.
// The adapter is the source module: these calls are not wired into the orchestrator yet (R8b).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { createGitProvider } from '../../../packages/git-providers/src/index.ts'
import { parseGiteaWebhook } from '../../../packages/git-providers/src/webhook.ts'

const SECRET = 'RADITI_DEPLOY_WRAP'
const WORKFLOW = 'release-probe.yml'
const NO_DISPATCH = 'no-dispatch.yml'
// A tag push starts it, and so does a dispatch; no runner takes it: the run stays queued.
const workflowFile = `on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      release:
        required: false
jobs:
  probe:
    runs-on: release-probe
    steps:
      - run: echo probe
`
const noDispatchFile = `on:
  push:
    branches: [never-pushed]
jobs:
  probe:
    runs-on: release-probe
    steps:
      - run: echo probe
`

/**
 * `context`: the stand's address and tokens, `git(cwd, args, { grant, allowFailure })` of the
 * scenario, `stage(name)` to name the step a failure reports, `passed(text)` for a PASS line.
 */
export async function verifyReleaseCalls(context) {
  const { url, botToken, ownerToken, writerToken, receiverHost, repo, git, stage, passed } = context
  const api = async (method, path, token, body) => {
    const response = await fetch(`${url}/api/v1${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `token ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      // A status alone is the answer here.
    }
    return { status: response.status, json }
  }
  const code = async (promise) =>
    promise.then(
      () => null,
      (error) => error?.code ?? 'unknown',
    )
  const config = { baseUrl: url, token: botToken }
  const plain = createGitProvider('gitea', config)
  const release = createGitProvider('gitea', config, { ownerToken: async () => ownerToken })
  const secretNames = async (name) => {
    const answer = await api('GET', `/repos/sites/${name}/actions/secrets`, ownerToken)
    assert.equal(answer.status, 200, 'The owner cannot list the secrets of a repository')
    return answer.json.map((secret) => secret.name)
  }

  stage('release: Actions secrets of a repository')
  assert.equal(
    await code(plain.setActionsSecret(repo, SECRET, 'synthetic')),
    'GIT_PROVIDER_NOT_CONFIGURED',
    'A provider without the owner token wrote a secret',
  )
  // What makes the owner necessary: Gitea refuses the bot, a write member.
  const byBot = await api('PUT', `/repos/sites/demo/actions/secrets/${SECRET}`, botToken, {
    data: 'synthetic',
  })
  assert.equal(byBot.status, 403, 'Gitea let the bot write an Actions secret')
  await release.setActionsSecret(repo, SECRET, `synthetic-wrap-${randomBytes(8).toString('hex')}`)
  await release.setActionsSecret(repo, SECRET, `synthetic-wrap-${randomBytes(8).toString('hex')}`)
  assert.deepEqual(await secretNames('demo'), [SECRET])
  // A secret of the repository, not of the organization: the other repository has none.
  assert.deepEqual(await secretNames('other'), [])
  assert.equal(
    (await api('GET', '/repos/sites/demo/actions/secrets', botToken)).status,
    403,
    'Gitea let the bot list the Actions secrets',
  )
  await release.deleteActionsSecret(repo, SECRET)
  assert.deepEqual(await secretNames('demo'), [])
  await release.deleteActionsSecret(repo, SECRET)
  passed(
    'Actions secret of a repository: written and replaced as the organization owner (the bot gets 403), absent from another repository, deleted; a second deletion passes',
  )

  stage('release: tag protection')
  const rules = async () => {
    const answer = await api('GET', '/repos/sites/demo/tag_protections', ownerToken)
    assert.equal(answer.status, 200, 'The owner cannot list the tag protections')
    return answer.json.map((rule) => [rule.name_pattern, rule.whitelist_usernames])
  }
  assert.equal(await code(plain.protectTags(repo, 'v*')), 'GIT_PROVIDER_NOT_CONFIGURED')
  const byBotRule = await api('POST', '/repos/sites/demo/tag_protections', botToken, {
    name_pattern: 'v*',
    whitelist_usernames: ['raditi-bot'],
  })
  assert.equal(byBotRule.status, 403, 'Gitea let the bot protect tags')
  // A rule that names the bot, as an earlier design had it: the protection replaces it.
  const earlier = await api('POST', '/repos/sites/demo/tag_protections', ownerToken, {
    name_pattern: 'v*',
    whitelist_usernames: ['raditi-bot'],
    whitelist_teams: [],
  })
  assert.equal(earlier.status, 201, 'The earlier rule was not created')
  await release.protectTags(repo, 'v*')
  assert.deepEqual(await rules(), [['v*', ['stand-owner']]])
  await release.protectTags(repo, 'v*')
  assert.deepEqual(await rules(), [['v*', ['stand-owner']]])
  passed(
    'tag protection v*: a rule naming the bot narrowed to the account of the owner token, a repeat changes nothing; the bot itself may not protect',
  )

  stage('release: workflow files and the webhook receiver')
  const deliveries = []
  const hookSecret = randomBytes(24).toString('hex')
  const receiver = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const headers = new Headers()
      for (const [key, value] of Object.entries(request.headers))
        headers.set(key, [value].flat().join(', '))
      deliveries.push({ headers, raw: Buffer.concat(chunks).toString('utf8') })
      response.writeHead(204).end()
    })
  })
  await new Promise((done, reject) => {
    receiver.once('error', reject)
    receiver.listen(0, receiverHost, done)
  })
  try {
    const hook = await api('POST', '/repos/sites/demo/hooks', ownerToken, {
      type: 'gitea',
      active: true,
      events: ['push', 'workflow_run', 'workflow_job'],
      config: {
        url: `http://host.docker.internal:${receiver.address().port}/webhooks/gitea`,
        content_type: 'json',
        secret: hookSecret,
      },
    })
    assert.equal(hook.status, 201, 'The webhook was not created')
    const events = () =>
      deliveries.map((delivery) => parseGiteaWebhook(delivery.headers, delivery.raw, hookSecret))
    const waitFor = async (what, find) => {
      const deadline = Date.now() + 45_000
      for (;;) {
        const found = events().find((event) => event && find(event))
        if (found) return found
        if (Date.now() > deadline) throw new Error(`No webhook: ${what}`)
        await sleep(250)
      }
    }
    for (const [path, content] of [
      [`.gitea/workflows/${WORKFLOW}`, workflowFile],
      [`.gitea/workflows/${NO_DISPATCH}`, noDispatchFile],
    ]) {
      const added = await api('POST', `/repos/sites/demo/contents/${path}`, ownerToken, {
        content: Buffer.from(content).toString('base64'),
        message: `stand: ${path}`,
        branch: 'main',
      })
      assert.equal(added.status, 201, 'A workflow file was not committed')
    }
    const head = (await api('GET', '/repos/sites/demo/branches/main', botToken)).json?.commit?.id
    assert.match(head ?? '', /^[0-9a-f]{40}$/, 'The head of main was not read')
    passed('a repository webhook to the scenario; two workflow files on main')

    stage('release: protected tags')
    const work = await mkdtemp(join(context.directory, 'release-'))
    const reader = await release.issueCredentials(repo, 'read', 120)
    const remote = `${url}/sites/demo.git`
    await git(work, ['clone', '--quiet', remote, '.'], { grant: reader })
    const push = (grant, ref, ...flags) =>
      git(work, ['push', ...flags, remote, ref], { grant, allowFailure: true })
    const refused = (result, what) => {
      assert.notEqual(result.code, 0, `${what} was accepted`)
      assert.match(result.stderr, /protected/, `${what} was refused for another reason`)
    }
    const writer = { username: 'stand-writer', token: writerToken }
    const owner = { username: 'stand-owner', token: ownerToken }
    // The bot's grant, as a turn or a publication holds one: v* is closed to it.
    const pusher = await release.issueCredentials(repo, 'write', 120)
    refused(await push(writer, `${head}:refs/tags/v9.9.9`), 'A tag of another member')
    refused(await push(pusher, `${head}:refs/tags/v9.9.8`), 'A tag of a write grant of the bot')
    const byBotTag = await api('POST', '/repos/sites/demo/tags', botToken, {
      tag_name: 'v9.9.7',
      target: head,
    })
    assert.equal(byBotTag.status, 422, 'Gitea let the bot create a protected tag')
    assert.equal(await code(plain.createTag(repo, 'v9.9.6', head)), 'GIT_PROVIDER_NOT_CONFIGURED')
    for (const tag of ['v9.9.9', 'v9.9.8', 'v9.9.7', 'v9.9.6'])
      assert.equal(await release.getTag(repo, tag), null)
    // The release tag: through the API, as the release account.
    const released = { name: 'v1.0.0', commitSha: head, objectSha: head }
    assert.deepEqual(await release.createTag(repo, 'v1.0.0', head), released)
    assert.deepEqual(await release.getTag(repo, 'v1.0.0'), released)
    // Another commit of the repository (on a branch of the bot, as a turn pushes one).
    await writeFile(join(work, 'moved.txt'), 'synthetic\n')
    await git(work, ['add', 'moved.txt'])
    await git(work, ['commit', '--quiet', '-m', 'stand: another commit'])
    const other = (await git(work, ['rev-parse', 'HEAD'])).stdout.toString().trim()
    assert.equal((await push(pusher, `${other}:refs/heads/stand/other`)).code, 0)
    // A taken name answers the tag as it stands: createTag never moves it.
    assert.deepEqual(await release.createTag(repo, 'v1.0.0', other), released)
    assert.deepEqual(await release.createTag(repo, 'v1.0.0', head), released)
    refused(await push(writer, ':refs/tags/v1.0.0'), 'The deletion of a tag by another member')
    refused(await push(pusher, ':refs/tags/v1.0.0'), 'The deletion of a tag by a grant of the bot')
    refused(
      await push(pusher, `${other}:refs/tags/v1.0.0`, '--force'),
      'A forced move of a tag by a grant of the bot',
    )
    assert.deepEqual(await release.getTag(repo, 'v1.0.0'), released)
    // With git, the allowed account itself can move a tag with --force: Gitea protects a tag
    // from others, its immutability is the code's (plan 53, Р26) — createTag has no force.
    assert.equal((await push(owner, `${head}:refs/tags/v0.9.9`)).code, 0)
    assert.notEqual((await push(owner, `${other}:refs/tags/v0.9.9`)).code, 0)
    assert.equal((await release.getTag(repo, 'v0.9.9'))?.commitSha, head)
    assert.equal((await push(owner, `${other}:refs/tags/v0.9.9`, '--force')).code, 0)
    assert.equal((await release.getTag(repo, 'v0.9.9'))?.commitSha, other)
    await git(work, ['tag', '-a', 'v1.1.0', '-m', 'stand: annotated', head])
    assert.equal((await push(owner, 'refs/tags/v1.1.0')).code, 0)
    const annotated = await release.getTag(repo, 'v1.1.0')
    assert.ok(annotated?.commitSha === head && annotated.objectSha !== head)
    assert.equal(await release.getTag(repo, 'v7.0.0'), null)
    passed(
      'protected v* tags: another member and a write grant of the bot are refused (push, forced move, deletion, API), createTag makes the tag as the owner and answers a taken name with the tag unmoved; getTag tells a lightweight tag from an annotated one; with git the allowed owner can force-move a tag',
    )

    // v1.0.0 came from createTag (the API), v1.1.0 from a git push: Gitea treats both as a push.
    stage('release: the run of a tag')
    const tagEvent = await waitFor(
      'the push of v1.0.0',
      (event) => event.kind === 'tag' && event.tag === 'v1.0.0',
    )
    assert.deepEqual(tagEvent, { kind: 'tag', repo, tag: 'v1.0.0', sha: head })
    const annotatedEvent = await waitFor(
      'the push of v1.1.0',
      (event) => event.kind === 'tag' && event.tag === 'v1.1.0',
    )
    assert.equal(annotatedEvent.sha, annotated.objectSha)
    const runEvent = await waitFor(
      'the run of v1.0.0',
      (event) => event.kind === 'workflow_run' && event.run.ref === 'refs/tags/v1.0.0',
    )
    assert.deepEqual(
      {
        file: runEvent.run.workflowFile,
        path: runEvent.run.workflowPath,
        event: runEvent.run.event,
        branch: runEvent.run.headBranch,
        attempt: runEvent.run.runAttempt,
        sha: runEvent.run.headSha,
        status: runEvent.run.status,
      },
      {
        file: WORKFLOW,
        path: `.gitea/workflows/${WORKFLOW}`,
        event: 'push',
        branch: null,
        attempt: 1,
        sha: head,
        status: 'queued',
      },
    )
    const jobEvent = await waitFor(
      'the job of the run of v1.0.0',
      (event) => event.kind === 'workflow_job' && event.job.runId === runEvent.run.id,
    )
    assert.equal(jobEvent.job.status, 'queued')
    const runs = await release.listWorkflowRuns(repo, { headSha: head, event: 'push' })
    const listed = runs.find((run) => run.id === runEvent.run.id)
    assert.ok(listed, 'The run of the tag is not listed')
    assert.deepEqual(
      [listed.ref, listed.workflowFile, listed.workflowPath, listed.event, listed.runAttempt],
      ['refs/tags/v1.0.0', WORKFLOW, null, 'push', 1],
    )
    assert.ok(runs.every((run) => run.headSha === head && run.event === 'push'))
    assert.deepEqual(await release.getWorkflowRun(repo, runEvent.run.id), listed)
    assert.equal(await release.getWorkflowRun(repo, '999999'), null)
    passed(
      'a tag made by createTag fires what a push of it does: webhook `tag` with the commit (a pushed annotated tag: its object), a push run with ref refs/tags/v1.0.0 and no branch, its job; listWorkflowRuns and getWorkflowRun show the same run without the path of the file',
    )

    stage('release: workflow_dispatch')
    // The bot dispatches: the provider sends its token, the owner's is not needed.
    const { runId } = await plain.dispatchWorkflow(repo, {
      workflow: WORKFLOW,
      ref: 'refs/tags/v1.0.0',
      inputs: { release: 'synthetic' },
    })
    assert.match(runId ?? '', /^[1-9]\d*$/)
    const dispatched = await plain.getWorkflowRun(repo, runId)
    assert.deepEqual(
      [dispatched?.event, dispatched?.ref, dispatched?.headSha, dispatched?.status],
      ['workflow_dispatch', 'refs/tags/v1.0.0', head, 'queued'],
    )
    const dispatchEvent = await waitFor(
      'the dispatched run',
      (event) => event.kind === 'workflow_run' && event.run.id === runId,
    )
    assert.equal(dispatchEvent.run.event, 'workflow_dispatch')
    const unsupported = async (dispatch) =>
      plain.dispatchWorkflow(repo, dispatch).then(
        () => null,
        (error) => [error?.code, error?.details?.reason],
      )
    assert.deepEqual(await unsupported({ workflow: NO_DISPATCH, ref: 'main' }), [
      'NOT_SUPPORTED',
      'no_trigger',
    ])
    assert.deepEqual(await unsupported({ workflow: 'missing.yml', ref: 'main' }), [
      'NOT_SUPPORTED',
      'not_found',
    ])
    assert.deepEqual(await unsupported({ workflow: WORKFLOW, ref: 'refs/tags/v9.9.9' }), [
      'NOT_SUPPORTED',
      'not_found',
    ])
    // A repository that is no source of scoped workflows for this one.
    assert.deepEqual(
      await unsupported({
        workflow: WORKFLOW,
        ref: 'main',
        source: { provider: 'gitea', owner: 'sites', name: 'other' },
      }),
      ['NOT_SUPPORTED', 'not_found'],
    )
    passed(
      'workflow_dispatch of a repository workflow on a tag by the bot: run id, event workflow_dispatch, ref of the tag, its webhook; a file without the trigger, a missing file or ref and a source that is not one answer NOT_SUPPORTED',
    )
  } finally {
    receiver.closeAllConnections()
    await new Promise((done) => receiver.close(done))
  }
}
