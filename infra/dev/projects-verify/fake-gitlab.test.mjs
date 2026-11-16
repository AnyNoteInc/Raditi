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
      const mr = await call('POST', `/api/v4/projects/${project.id}/merge_requests`, {
        body: {
          source_branch: 'raditi/menu',
          target_branch: 'main',
          title: 'Меню',
          description: '/merge',
        },
      })
      assert.equal(mr.status, 201)
      assert.equal(mr.json.sha, branchSha)
      const stale = await call('PUT', `/api/v4/projects/${project.id}/merge_requests/1/merge`, {
        body: { sha: 'f'.repeat(40) },
      })
      assert.equal(stale.status, 409)
      const merged = await call('PUT', `/api/v4/projects/${project.id}/merge_requests/1/merge`, {
        body: { sha: branchSha, should_remove_source_branch: true },
      })
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
      // A project of another host is not found by this one's user.
      assert.equal(
        (await call('GET', `/api/v4/projects/${project.id}`, { host: COM_HOST })).status,
        401,
      )
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
