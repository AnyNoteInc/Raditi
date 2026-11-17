// The fake GitLab of the projects stand on its own (pnpm test:infra): git over its smart HTTP with
// a token, a push that makes a pipeline, a merge request merged with its head, PKCE of the OAuth.
// Needs git and openssl; skipped without them.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { COM_HOST, OWN_HOST, runGit, startFakeGitlab } from './fake-gitlab.mjs'

const has = (tool) => {
  try {
    execFileSync(tool, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    try {
      execFileSync(tool, ['version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
}
const ready = has('git') && has('openssl')

describe(
  'the fake GitLab of the projects stand',
  { skip: !ready && 'needs git and openssl' },
  () => {
    let dir
    let fake
    let ca
    let port
    const token = `stand-token-${randomBytes(8).toString('hex')}`
    const oauth = { clientId: 'stand-client', secret: 'stand-secret' }

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), 'raditi-fake-gitlab-test-'))
      const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
      await writeFile(
        join(dir, 'ext'),
        'subjectAltName = IP:127.0.0.1, DNS:localhost, DNS:gitlab.localhost, DNS:gitlab.com\n',
      )
      run(
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        'key.pem',
        '-out',
        'cert.pem',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName = IP:127.0.0.1, DNS:localhost, DNS:gitlab.localhost',
      )
      ca = await readFile(join(dir, 'cert.pem'))
      port = 20_000 + Math.floor(Math.random() * 20_000)
      fake = await startFakeGitlab({
        key: await readFile(join(dir, 'key.pem')),
        cert: ca,
        port,
        oauth,
      })
    })
    after(async () => {
      await fake?.close()
      await rm(dir, { recursive: true, force: true })
    })

    const call = (method, path, { host = OWN_HOST, auth = token, body, form } = {}) =>
      new Promise((done, reject) => {
        const payload = form
          ? new URLSearchParams(form).toString()
          : body
            ? JSON.stringify(body)
            : ''
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path,
            method,
            ca,
            servername: 'localhost',
            headers: {
              host,
              ...(auth ? { authorization: `Bearer ${auth}` } : {}),
              'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
              'content-length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8')
              let json = null
              try {
                json = JSON.parse(text)
              } catch {}
              done({ status: res.statusCode, headers: res.headers, json, text })
            })
          },
        )
        req.once('error', reject)
        req.end(payload)
      })

    it('serves git with a token, makes a pipeline on a push and merges a merge request', async () => {
      const user = fake.addUser(OWN_HOST, { username: 'klient', token })
      const project = await fake.addProject(OWN_HOST, {
        path: 'stand/shop',
        files: { 'README.md': 'Магазин\n' },
        members: [user],
      })
      assert.equal((await call('GET', '/api/v4/user')).json.username, 'klient')
      assert.equal((await call('GET', '/api/v4/user', { auth: 'wrong' })).status, 401)
      const work = join(dir, 'work')
      const env = { GIT_SSL_CAINFO: join(dir, 'cert.pem') }
      const resolve = ['-c', `http.curloptResolve=${OWN_HOST}:${port}:127.0.0.1`]
      const url = `https://oauth2:${token}@${OWN_HOST}:${port}/stand/shop.git`
      const bad = await runGit([...resolve, 'clone', '-q', url.replace(token, 'wrong'), work], {
        cwd: dir,
        env,
        allowFailure: true,
      })
      assert.notEqual(bad.code, 0)
      await runGit([...resolve, 'clone', '-q', url, work], { cwd: dir, env })
      await writeFile(join(work, 'menu.txt'), 'меню\n')
      await runGit(['add', '-A'], { cwd: work })
      await runGit(['commit', '-q', '-m', 'menu'], { cwd: work })
      await runGit([...resolve, 'push', '-q', 'origin', 'HEAD:raditi/menu'], { cwd: work, env })
      assert.equal(fake.pushes.length, 1)
      assert.equal(fake.pushes[0].updates[0][0], 'raditi/menu')
      const pushed = await call('GET', `/api/v4/projects/${project.id}/pipelines?ref=raditi/menu`)
      assert.equal(pushed.json.length, 1)
      // A branch of the agent and its merge request.
      const branchSha = (await fake.heads(project))['raditi/menu']
      const open = () =>
        call('POST', `/api/v4/projects/${project.id}/merge_requests`, {
          body: {
            source_branch: 'raditi/menu',
            target_branch: 'main',
            title: 'Меню',
            description: 'Новое меню.\n/draft\n/merge\n/label ~menu',
          },
        })
      // Right after the push GitLab does not know the branch yet; the next request opens.
      const early = await open()
      assert.equal(early.status, 400)
      assert.deepEqual(early.json, { message: { source_branch: ['does not exist'] } })
      const mr = await open()
      assert.equal(mr.status, 201)
      assert.equal(mr.json.sha, branchSha)
      // The quick actions it ran are taken out of the text; `/merge` does not run on opening.
      assert.equal(mr.json.title, 'Draft: Меню')
      assert.equal(mr.json.description, 'Новое меню.')
      assert.deepEqual(project.mergeRequests.at(-1).quickActions, ['/draft', '/label ~menu'])
      assert.equal((await open()).status, 409, 'one open merge request per branch')
      await call('PUT', `/api/v4/projects/${project.id}/merge_requests/1`, {
        body: { state_event: 'close' },
      })
      const ready = await call('POST', `/api/v4/projects/${project.id}/merge_requests`, {
        body: { source_branch: 'raditi/menu', target_branch: 'main', title: 'Меню' },
      })
      assert.equal(ready.status, 201)
      const iid = ready.json.iid
      // Being checked: a merge is 405, a merge when green 422; a read starts the check.
      assert.equal(ready.json.detailed_merge_status, 'checking')
      const early405 = await call(
        'PUT',
        `/api/v4/projects/${project.id}/merge_requests/${iid}/merge`,
        {
          body: { sha: branchSha },
        },
      )
      assert.equal(early405.status, 405)
      const early422 = await call(
        'PUT',
        `/api/v4/projects/${project.id}/merge_requests/${iid}/merge`,
        {
          body: { sha: branchSha, auto_merge: true },
        },
      )
      assert.equal(early422.status, 422)
      await new Promise((done) => setTimeout(done, 200))
      assert.equal(
        (await call('GET', `/api/v4/projects/${project.id}/merge_requests/${iid}`)).json
          .detailed_merge_status,
        'mergeable',
      )
      // No auto-merge on: cancel_auto_merge is 409, the deprecated endpoint 201 with an error.
      const cancel = await call(
        'POST',
        `/api/v4/projects/${project.id}/merge_requests/${iid}/cancel_auto_merge`,
      )
      assert.equal(cancel.status, 409)
      const legacy = await call(
        'POST',
        `/api/v4/projects/${project.id}/merge_requests/${iid}/cancel_merge_when_pipeline_succeeds`,
      )
      assert.equal(legacy.status, 201)
      assert.equal(legacy.json.status, 'error')
      const stale = await call(
        'PUT',
        `/api/v4/projects/${project.id}/merge_requests/${iid}/merge`,
        {
          body: { sha: 'f'.repeat(40) },
        },
      )
      assert.equal(stale.status, 409)
      const merged = await call(
        'PUT',
        `/api/v4/projects/${project.id}/merge_requests/${iid}/merge`,
        {
          body: { sha: branchSha, should_remove_source_branch: true },
        },
      )
      assert.equal(merged.json.state, 'merged')
      assert.ok(fake.isSha(merged.json.merge_commit_sha))
      const after = await fake.heads(project)
      assert.equal(after.main, merged.json.merge_commit_sha)
      assert.equal(after['raditi/menu'], undefined)
      const runs = await call('GET', `/api/v4/projects/${project.id}/pipelines?ref=main`)
      assert.equal(runs.json[0].sha, after.main)
      const jobs = await call(
        'GET',
        `/api/v4/projects/${project.id}/pipelines/${runs.json[0].id}/jobs?scope[]=manual`,
      )
      assert.deepEqual(
        jobs.json.map((job) => job.name),
        ['deploy'],
      )
      const play = await call('POST', `/api/v4/projects/${project.id}/jobs/${jobs.json[0].id}/play`)
      assert.equal(play.status, 200)
      assert.equal(fake.played.length, 1)
      // A project of another host is not found by this one's user: as anonymous, a private one
      // is not there (404), the rest of the API asks for a token (401).
      assert.equal(
        (await call('GET', `/api/v4/projects/${project.id}`, { host: COM_HOST })).status,
        404,
      )
      assert.equal((await call('GET', '/api/v4/user', { host: COM_HOST })).status, 401)
    })

    it('reads an open project without a token, redirects a redirecting server, runs slow refs', async () => {
      const owner = fake.addUser(OWN_HOST, { username: 'vladelec', token: `${token}-2` })
      const open = await fake.addProject(OWN_HOST, {
        path: 'stand/open',
        files: { 'README.md': 'Открыто\n' },
        members: [],
        visibility: 'public',
      })
      const closed = await fake.addProject(OWN_HOST, {
        path: 'stand/closed',
        files: { 'README.md': 'Закрыто\n' },
        members: [owner],
        size: 2 * 1024 ** 3,
      })
      const anonymous = await call('GET', `/api/v4/projects/${encodeURIComponent('stand/open')}`, {
        auth: null,
      })
      assert.equal(anonymous.status, 200)
      assert.equal(anonymous.json.visibility, 'public')
      assert.equal(
        (
          await call('GET', `/api/v4/projects/${encodeURIComponent('stand/closed')}`, {
            auth: null,
          })
        ).status,
        404,
      )
      const big = await call('GET', `/api/v4/projects/${closed.id}`, { auth: `${token}-2` })
      assert.equal(big.json.statistics.repository_size, 2 * 1024 ** 3)
      const env = { GIT_SSL_CAINFO: join(dir, 'cert.pem') }
      const resolve = ['-c', `http.curloptResolve=${OWN_HOST}:${port}:127.0.0.1`]
      const work = join(dir, 'open')
      await runGit(
        [...resolve, 'clone', '-q', `https://${OWN_HOST}:${port}/stand/open.git`, work],
        {
          cwd: dir,
          env,
        },
      )
      assert.ok(
        fake.requests.some(
          (entry) => entry.path === '/stand/open.git/git-upload-pack' && entry.anonymous,
        ),
      )
      await writeFile(join(work, 'x.md'), 'x\n')
      await runGit(['add', '-A'], { cwd: work })
      await runGit(['commit', '-q', '-m', 'x'], { cwd: work })
      const push = await runGit([...resolve, 'push', '-q', 'origin', 'HEAD:main'], {
        cwd: work,
        env,
        allowFailure: true,
      })
      assert.notEqual(push.code, 0, 'an open project takes no anonymous push')

      const redirecting = `${token}-redirect`
      fake.addUser(OWN_HOST, { username: 'redirect', token: redirecting, redirect: true })
      const moved = await call('GET', '/api/v4/user', { auth: redirecting })
      assert.equal(moved.status, 302)
      assert.match(moved.headers.location, /redirected=1/)

      closed.slowRefs.set('feature', 60_000)
      const sha = await fake.commitAsClient(closed, 'main', 'docs/a.md', 'a\n', {
        newBranch: 'feature',
      })
      assert.equal((await fake.heads(closed)).feature, sha)
      const runs = await call('GET', `/api/v4/projects/${closed.id}/pipelines?ref=feature`, {
        auth: `${token}-2`,
      })
      assert.equal(runs.json[0].status, 'running')
      closed.unverified = true
      await fake.commitAsClient(closed, 'feature', 'docs/b.md', 'b\n')
      const refused = await call('GET', `/api/v4/projects/${closed.id}/pipelines?ref=feature`, {
        auth: `${token}-2`,
      })
      // A pipeline has no `failure_reason`, and the list no times: the jobs say why.
      assert.equal(refused.json[0].failure_reason, undefined)
      assert.equal(refused.json[0].finished_at, undefined)
      const jobs = await call(
        'GET',
        `/api/v4/projects/${closed.id}/pipelines/${refused.json[0].id}/jobs`,
        { auth: `${token}-2` },
      )
      assert.equal(jobs.json[0].failure_reason, 'user_not_verified')
      // Anonymous: no statistics, no permissions.
      assert.equal(anonymous.json.statistics, undefined)
      assert.equal(anonymous.json.permissions, undefined)
    })

    it('makes a signed hook, names the files of include: local, retries and cancels a pipeline', async () => {
      const user = fake.addUser(OWN_HOST, { username: 'hooks', token: `${token}-hooks` })
      const auth = `${token}-hooks`
      const project = await fake.addProject(OWN_HOST, {
        path: 'stand/hooks',
        files: {
          'README.md': 'Хуки\n',
          'ci/build.yml': 'build: {}\n',
          'ci/test.yml': 'test: {}\n',
        },
        members: [user],
      })
      const at = `/api/v4/projects/${project.id}`
      const info = await call('GET', at, { auth })
      assert.equal(info.json.permissions.project_access.access_level, 40)
      const signing = `whsec_${randomBytes(32).toString('base64')}`
      const made = await call('POST', `${at}/hooks`, {
        auth,
        body: {
          url: 'https://raditi.example/api/webhooks/gitlab?r=x',
          token: 't',
          signing_token: signing,
        },
      })
      assert.equal(made.status, 201)
      assert.equal(made.json.signing_token_present, true)
      const lint = await call('POST', `${at}/ci/lint`, {
        auth,
        body: {
          content: "include:\n  - local: /ci/build.yml\n  - local: 'ci/*.yml'\nstages:\n  - test\n",
          ref: 'main',
        },
      })
      // A wildcard comes back expanded to the files at the ref.
      assert.deepEqual(
        lint.json.includes.map((item) => [item.type, item.location]),
        [
          ['local', 'ci/build.yml'],
          ['local', 'ci/build.yml'],
          ['local', 'ci/test.yml'],
        ],
      )
      const missing = await call('POST', `${at}/ci/lint`, {
        auth,
        body: { content: 'include:\n  - local: ci/new.yml\nstages:\n  - test\n', ref: 'main' },
      })
      assert.equal(missing.json.valid, false)
      assert.equal(missing.json.includes, null)
      const malformed = await call('POST', `${at}/hooks`, {
        auth,
        body: { url: 'https://raditi.example/x', token: 't', signing_token: 'whsec_short' },
      })
      assert.equal(malformed.status, 422)
      const sha = await fake.rerunPipeline(project, 'main')
      const pipeline = project.pipelines.findLast((item) => item.sha === sha)
      await call('POST', `${at}/pipelines/${pipeline.id}/cancel`, { auth })
      assert.equal(
        (await call('GET', `${at}/pipelines/${pipeline.id}`, { auth })).json.status,
        'canceled',
      )
      await call('POST', `${at}/pipelines/${pipeline.id}/retry`, { auth })
      assert.notEqual(
        (await call('GET', `${at}/pipelines/${pipeline.id}`, { auth })).json.status,
        'canceled',
      )
      assert.deepEqual(
        fake.pipelineActions.map((item) => item.action),
        ['cancel', 'retry'],
      )
      // A pipeline that passed: its retry runs nothing.
      pipeline.runMs = 50
      await new Promise((done) => setTimeout(done, 100))
      const passed = await call('GET', `${at}/pipelines/${pipeline.id}`, { auth })
      assert.equal(passed.json.status, 'success')
      await call('POST', `${at}/pipelines/${pipeline.id}/retry`, { auth })
      assert.equal(
        (await call('GET', `${at}/pipelines/${pipeline.id}`, { auth })).json.finished_at,
        passed.json.finished_at,
      )
      assert.equal(
        (await call('GET', `${at}/pipelines/${pipeline.id}`, { auth })).json.status,
        'success',
      )
      const job = pipeline.jobs.find((item) => !item.manual)
      // The log of a job as Runner 19 writes it: every line with its prefix.
      const trace = await call('GET', `${at}/jobs/${job.id}/trace`, { auth })
      assert.match(trace.text, /^\d{4}-\d\d-\d\dT[\d:.]+Z 0[01]O[ +]/)
      assert.equal((await call('DELETE', `${at}/hooks/${made.json.id}`, { auth })).status, 204)
      assert.equal(fake.removedHooks.length, 1)
    })

    it('signs in with PKCE and refuses another verifier', async () => {
      fake.addUser(COM_HOST, { username: 'oauth-klient', signsIn: true })
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const go = async () => {
        const query = new URLSearchParams({
          client_id: oauth.clientId,
          redirect_uri: 'http://127.0.0.1:3000/api/git/gitlab/callback',
          response_type: 'code',
          state: 's',
          scope: 'api write_repository',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        })
        const answer = await call('GET', `/oauth/authorize?${query}`, {
          host: 'localhost',
          auth: null,
        })
        assert.equal(answer.status, 302)
        return new URL(answer.headers.location).searchParams.get('code')
      }
      const form = (code, code_verifier) => ({
        client_id: oauth.clientId,
        client_secret: oauth.secret,
        redirect_uri: 'http://127.0.0.1:3000/api/git/gitlab/callback',
        grant_type: 'authorization_code',
        code,
        code_verifier,
      })
      const wrong = await call('POST', '/oauth/token', {
        host: 'localhost',
        auth: null,
        form: form(await go(), 'x'.repeat(43)),
      })
      assert.equal(wrong.status, 400)
      const right = await call('POST', '/oauth/token', {
        host: 'localhost',
        auth: null,
        form: form(await go(), verifier),
      })
      assert.equal(right.status, 200)
      const me = await call('GET', '/api/v4/user', {
        host: 'localhost',
        auth: right.json.access_token,
      })
      assert.equal(me.json.username, 'oauth-klient')
    })
  },
)
