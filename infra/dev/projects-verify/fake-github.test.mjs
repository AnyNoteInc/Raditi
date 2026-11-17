// The fake GitHub of the projects stand on its own (pnpm test:infra): a token of an installation
// only for a JWT of the app, with the repositories and rights it names; git over smart HTTP with
// that token; a push that changes `.github/workflows` refused without `workflows`, as GitHub does;
// the signature of a delivery. Needs git and openssl; skipped without them.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { GITHUB_HOST, appJwtValid, githubSignature, startFakeGithub } from './fake-github.mjs'
import { runGit } from './fake-gitlab.mjs'

const has = (tool, args) => {
  try {
    execFileSync(tool, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const ready = has('git', ['--version']) && has('openssl', ['version'])

const jwtOf = (appId, key, { iat = Math.floor(Date.now() / 1000) - 60, life = 540 } = {}) => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const head = part({ alg: 'RS256', typ: 'JWT' })
  const body = part({ iat, exp: iat + life, iss: appId })
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url')
  return `${head}.${body}.${signature}`
}

describe(
  'the fake GitHub of the projects stand',
  { skip: !ready && 'needs git and openssl' },
  () => {
    let dir
    let fake
    let ca
    let port
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const app = {
      id: '4242',
      slug: 'raditi-stand',
      clientId: 'Iv23test',
      clientSecret: 'client-secret',
      webhookSecret: 'webhook-secret',
      publicKey: keys.publicKey,
    }

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), 'raditi-fake-github-test-'))
      execFileSync(
        'openssl',
        [
          ...['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'],
          ...['-keyout', 'key.pem', '-out', 'cert.pem', '-days', '1', '-subj', '/CN=localhost'],
          ...['-addext', `subjectAltName = IP:127.0.0.1, DNS:localhost, DNS:${GITHUB_HOST}`],
        ],
        { cwd: dir, stdio: 'ignore' },
      )
      ca = await readFile(join(dir, 'cert.pem'))
      port = 20_000 + Math.floor(Math.random() * 20_000)
      fake = await startFakeGithub({
        key: await readFile(join(dir, 'key.pem')),
        cert: ca,
        port,
        app,
        callbackUrl: 'http://127.0.0.1:1/api/git/github/callback',
      })
    })
    after(async () => {
      await fake?.close()
      await rm(dir, { recursive: true, force: true })
    })

    const call = (method, path, { auth, body, host = 'localhost' } = {}) =>
      new Promise((done, reject) => {
        const payload = body ? JSON.stringify(body) : ''
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
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            const chunks = []
            res.on('data', (chunk) => chunks.push(chunk))
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8')
              let json = null
              try {
                json = JSON.parse(text)
              } catch {}
              done({ status: res.statusCode, headers: res.headers, json })
            })
          },
        )
        req.once('error', reject)
        req.end(payload)
      })

    it('checks the JWT of the app by its key, its issuer and its time', () => {
      const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const valid = { appId: app.id, publicKey: app.publicKey }
      assert.ok(appJwtValid(jwtOf(app.id, keys.privateKey), valid))
      assert.ok(!appJwtValid(jwtOf(app.id, other.privateKey), valid))
      assert.ok(!appJwtValid(jwtOf('9999', keys.privateKey), valid))
      assert.ok(!appJwtValid(jwtOf(app.id, keys.privateKey, { iat: 1_000_000, life: 60 }), valid))
      assert.ok(!appJwtValid(jwtOf(app.id, keys.privateKey, { life: 3600 }), valid))
      assert.ok(!appJwtValid('a.b.c', valid))
    })

    it('issues a token of one repository and refuses a workflow push without `workflows`', async () => {
      const anna = fake.addUser('anna')
      const installation = fake.addInstallation({ account: 'org', members: [anna] })
      const repo = await fake.addRepo(installation, {
        name: 'site',
        collaborators: [[anna, 'admin']],
        files: { 'README.md': 'Сайт\n', '.github/workflows/ci.yml': 'on: [push]\n' },
      })
      const other = await fake.addRepo(installation, {
        name: 'other',
        collaborators: [[anna, 'admin']],
        files: { 'README.md': 'Другой\n' },
      })
      const path = `/app/installations/${installation.id}/access_tokens`
      assert.equal((await call('POST', path, { auth: 'not-a-jwt' })).status, 401)
      const issue = async (permissions) =>
        (
          await call('POST', path, {
            auth: jwtOf(app.id, keys.privateKey),
            body: { repository_ids: [repo.id], permissions },
          })
        ).json.token
      const plain = await issue({ contents: 'write', metadata: 'read' })
      const withWorkflows = await issue({ contents: 'write', workflows: 'write' })
      assert.equal((await call('GET', '/repos/org/site', { auth: plain })).status, 200)
      assert.equal((await call('GET', '/repos/org/other', { auth: plain })).status, 404)
      void other

      const work = join(dir, 'work')
      const env = { GIT_SSL_CAINFO: join(dir, 'cert.pem') }
      const resolve = ['-c', `http.curloptResolve=${GITHUB_HOST}:${port}:127.0.0.1`]
      const url = (token) => `https://x-access-token:${token}@${GITHUB_HOST}:${port}/org/site.git`
      await runGit([...resolve, 'clone', '-q', url(plain), work], { cwd: dir, env })
      await mkdir(join(work, '.github/workflows'), { recursive: true })
      await writeFile(join(work, '.github/workflows/ci.yml'), 'on: [push, pull_request]\n')
      await runGit(['commit', '-qam', 'workflow'], { cwd: work })
      const refused = await runGit([...resolve, 'push', '-q', url(plain), 'HEAD:refs/heads/ci'], {
        cwd: work,
        env,
        allowFailure: true,
      })
      assert.notEqual(refused.code, 0)
      assert.equal((await fake.heads(repo)).ci, undefined)
      assert.equal(fake.refusedPushes.length, 1)
      await runGit([...resolve, 'push', '-q', url(withWorkflows), 'HEAD:refs/heads/ci'], {
        cwd: work,
        env,
      })
      assert.ok((await fake.heads(repo)).ci)
      assert.equal(fake.pushes.at(-1).permissions.workflows, 'write')

      // Revoked: the token no longer reads anything.
      assert.equal((await call('DELETE', '/installation/token', { auth: plain })).status, 204)
      assert.equal((await call('GET', '/repos/org/site', { auth: plain })).status, 401)
    })

    it('signs a delivery as GitHub does', () => {
      const body = '{"zen":"Keep it logically awesome."}'
      assert.equal(
        githubSignature('secret', body),
        `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`,
      )
    })
  },
)
