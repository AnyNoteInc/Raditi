// The fake GitHub of the projects stand (docs/plan/84-projects.md, §6, Э10): the part of the REST
// API the adapter of @repo/git-providers sends for Raditi's GitHub App (github.ts, connect.ts), the
// pages of github.com it goes through — the installation of the app (its Setup URL) and the sign-in
// of its user with PKCE — and real git smart HTTP over bare repositories (`git http-backend` of this
// machine), with a pre-receive hook that refuses a change of `.github/workflows/` by a token without
// `workflows`, as GitHub does. The API and the pages answer at `https://localhost:<port>`
// (RADITI_FAKE_GITHUB_API_URL and RADITI_FAKE_GITHUB_WEB_URL); git reaches `github.com` on 443 of
// loopback, where the forwarder of the stand passes it to the fake GitLab, which hands every
// request for `github.com` to `handle` here. An installation token is issued only for a JWT of the
// app signed by its key (RS256), with the repositories and the rights the request names; every
// request a token makes is checked against them. Runs, their jobs and checks finish after `runMs`;
// a merge into a protected branch needs its required check to have passed. Everything it saw is
// kept for the scenarios — requests (never a token), the tokens it issued (their rights), pushes
// with the rights of their token, pull requests, merges, dispatches, deliveries of its webhook.
import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, verify } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { runGit } from './fake-gitlab.mjs'

export const GITHUB_HOST = 'github.com'

/**
 * The pre-receive hook of every bare repository: a pushed commit that touches `.github/workflows/`
 * needs a token with `workflows` (RADITI_FAKE_WORKFLOWS=1, set per push by the fake).
 */
export const PRE_RECEIVE = `#!/bin/sh
zero=0000000000000000000000000000000000000000
while read old new ref; do
  [ "$new" = "$zero" ] && continue
  if [ "$old" = "$zero" ]; then files=$(git log --format= --name-only "$new" --not --all)
  else files=$(git log --format= --name-only "$old..$new"); fi
  if printf '%s\\n' "$files" | grep -q '^\\.github/workflows/'; then
    if [ "$RADITI_FAKE_WORKFLOWS" != "1" ]; then
      echo "refusing to allow a GitHub App to create or update workflow without \\\`workflows\\\` permission" >&2
      exit 1
    fi
  fi
done
exit 0
`

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

/** Verifies a JWT of the app: RS256 by its public key, `iss` the app id, within its time. */
export function appJwtValid(jwt, { appId, publicKey, now = Date.now() }) {
  const parts = String(jwt).split('.')
  if (parts.length !== 3) return false
  try {
    const head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    const body = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (head.alg !== 'RS256') return false
    const signed = verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    )
    const seconds = Math.floor(now / 1000)
    // GitHub: `exp` at most ten minutes after `iat`, `iat` not in the future (a minute of skew).
    return (
      signed &&
      String(body.iss) === String(appId) &&
      body.exp > seconds &&
      body.iat <= seconds + 60 &&
      body.exp - body.iat <= 600
    )
  } catch {
    return false
  }
}

/** `sha256=` + the hex HMAC of the body by the webhook secret, as GitHub signs a delivery. */
export const githubSignature = (secret, body) =>
  `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`

const RIGHTS = { read: 1, write: 2 }
const has = (permissions, name, level) => (RIGHTS[permissions?.[name]] ?? 0) >= (RIGHTS[level] ?? 9)

export async function startFakeGithub({ key, cert, port, app, callbackUrl, logFile = null }) {
  const root = await mkdtemp(join(tmpdir(), 'raditi-projects-verify-github-'))
  const home = join(root, 'home')
  await mkdir(home, { mode: 0o700 })
  let ids = 7000
  const nextId = () => (ids += 1)
  const origin = `https://localhost:${port}`

  const users = new Map()
  /** OAuth tokens of the users of the app (the sign-in): token → user. */
  const userTokens = new Map()
  const installations = new Map()
  const repos = new Map()
  /** Installation tokens: token → { installationId, repositoryIds, permissions, ... }. */
  const tokens = new Map()
  const codes = new Map()
  const requests = []
  const issued = []
  const pushes = []
  const refusedPushes = []
  const pulls = []
  const mergeCalls = []
  const dispatches = []
  const blobRequests = []
  const signIns = []
  const runActions = []
  /** What the next installation page returns to the Setup URL: set by a scenario. */
  let installing = null
  /** Who signs in on the next authorization page: set by a scenario. */
  let signingIn = null

  const tokenOf = (req) => /^(?:Bearer|token) (.+)$/.exec(req.headers.authorization ?? '')?.[1]
  const readBody = async (req) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    return Buffer.concat(chunks)
  }
  const heads = async (repo) => {
    const { stdout } = await runGit(
      ['for-each-ref', '--format=%(refname:strip=2) %(objectname)', 'refs/heads'],
      { cwd: repo.bare, home },
    )
    return Object.fromEntries(
      stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' ')),
    )
  }
  const show = async (repo, ref, path) => {
    const out = await runGit(['show', `${ref}:${path}`], {
      cwd: repo.bare,
      home,
      allowFailure: true,
    })
    return out.code === 0 ? out.stdout : null
  }
  const filesAt = async (repo, ref) => {
    const out = await runGit(['ls-tree', '-r', '--name-only', ref], {
      cwd: repo.bare,
      home,
      allowFailure: true,
    })
    return out.code === 0 ? out.stdout.split('\n').filter(Boolean) : []
  }

  const repoJson = (repo, permissions) => ({
    id: repo.id,
    full_name: repo.fullName,
    name: repo.fullName.split('/')[1],
    default_branch: repo.defaultBranch,
    private: repo.private,
    html_url: `https://${GITHUB_HOST}/${repo.fullName}`,
    size: 12,
    ...(permissions ? { permissions } : {}),
  })
  const rightsOf = (repo, user) => {
    const role = repo.collaborators.get(user.id) ?? null
    return {
      admin: role === 'admin',
      maintain: role === 'admin' || role === 'maintain',
      push: role === 'admin' || role === 'maintain' || role === 'write',
      triage: role !== null,
      pull: role !== null,
    }
  }

  // ─── Runs, jobs and checks ──────────────────────────────────────────────────

  const runState = (run) => {
    if (run.canceled) return { status: 'completed', conclusion: 'cancelled' }
    if (Date.now() - run.started > run.runMs) return { status: 'completed', conclusion: 'success' }
    return { status: 'in_progress', conclusion: null }
  }
  const makeRun = (repo, { branch, sha, event, name = 'CI' }) => {
    const run = {
      id: nextId(),
      jobId: nextId(),
      name,
      branch,
      sha,
      event,
      created: new Date().toISOString(),
      started: Date.now(),
      runMs: repo.slowRefs.get(branch) ?? 2000,
      canceled: false,
    }
    repo.runs.push(run)
    return run
  }
  const runJson = (repo, run) => ({
    id: run.id,
    name: run.name,
    head_sha: run.sha,
    head_branch: run.branch,
    event: run.event,
    ...runState(run),
    html_url: `https://${GITHUB_HOST}/${repo.fullName}/actions/runs/${run.id}`,
    created_at: run.created,
    run_started_at: run.created,
    updated_at: new Date().toISOString(),
  })
  const checksOf = (repo, sha) =>
    repo.runs.filter((run) => run.sha === sha && run.event !== 'workflow_dispatch')
  /** Whether the required checks of `branch` passed on `sha` (every run's one check is `test`). */
  const requiredPassed = (repo, branch, sha) =>
    (repo.protected.get(branch) ?? []).every(
      (name) =>
        name === 'test' &&
        checksOf(repo, sha).some((run) => runState(run).conclusion === 'success'),
    )

  const pullJson = async (repo, pull) => {
    const now = await heads(repo)
    const sha = pull.state === 'open' ? (now[pull.head] ?? pull.sha) : pull.sha
    return {
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state === 'merged' ? 'closed' : pull.state,
      draft: pull.draft === true,
      merged_at: pull.state === 'merged' ? pull.mergedAt : null,
      merge_commit_sha: pull.mergeSha ?? null,
      html_url: `https://${GITHUB_HOST}/${repo.fullName}/pull/${pull.number}`,
      head: { ref: pull.head, sha, repo: { full_name: repo.fullName } },
      base: { ref: pull.base },
      auto_merge: null,
    }
  }

  /** A merge commit of `pull` into its base in the bare repository; null on a conflict. */
  const merge = async (repo, pull, head) => {
    const now = await heads(repo)
    const base = now[pull.base]
    const tree = await runGit(['merge-tree', '--write-tree', base, head], {
      cwd: repo.bare,
      home,
      allowFailure: true,
    })
    if (tree.code !== 0) return null
    const commit = await runGit(
      [
        'commit-tree',
        tree.stdout.trim().split('\n')[0],
        ...['-p', base, '-p', head],
        '-m',
        `Merge pull request #${pull.number} from ${repo.fullName.split('/')[0]}/${pull.head}`,
      ],
      { cwd: repo.bare, home },
    )
    const mergeSha = commit.stdout.trim()
    await runGit(['update-ref', `refs/heads/${pull.base}`, mergeSha, base], {
      cwd: repo.bare,
      home,
    })
    pull.state = 'merged'
    pull.sha = head
    pull.mergeSha = mergeSha
    pull.mergedAt = new Date().toISOString()
    makeRun(repo, { branch: pull.base, sha: mergeSha, event: 'push' })
    return mergeSha
  }

  // ─── The pages of github.com ────────────────────────────────────────────────

  /** `/apps/<slug>/installations/new`: back to the Setup URL with what a scenario set. */
  const installationPage = (res, url) => {
    if (installing === null) return json(res, 404, { message: 'Not Found' })
    const back = new URL(callbackUrl)
    back.searchParams.set('installation_id', String(installing.installationId))
    back.searchParams.set('setup_action', installing.action ?? 'install')
    // GitHub may pass `state` back; the platform does not rely on it.
    if (url.searchParams.get('state') && installing.passState)
      back.searchParams.set('state', url.searchParams.get('state'))
    res.writeHead(302, { location: back.href })
    res.end()
  }

  const authorizePage = (res, url) => {
    const q = url.searchParams
    const redirect = q.get('redirect_uri') ?? ''
    if (
      q.get('client_id') !== app.clientId ||
      q.get('code_challenge_method') !== 'S256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge') ?? '') ||
      redirect !== callbackUrl
    )
      return json(res, 400, { error: 'invalid_request' })
    if (signingIn === null) return json(res, 403, { error: 'access_denied' })
    const code = randomBytes(15).toString('hex')
    codes.set(code, {
      user: signingIn,
      challenge: q.get('code_challenge'),
      redirect,
      expires: Date.now() + 60_000,
    })
    const back = new URL(redirect)
    back.searchParams.set('code', code)
    back.searchParams.set('state', q.get('state') ?? '')
    res.writeHead(302, { location: back.href })
    res.end()
  }

  const accessToken = async (req, res) => {
    const form = new URLSearchParams((await readBody(req)).toString('utf8'))
    // GitHub answers a refused code with 200 and an `error`.
    if (form.get('client_id') !== app.clientId || form.get('client_secret') !== app.clientSecret)
      return json(res, 200, { error: 'incorrect_client_credentials' })
    const grant = codes.get(form.get('code') ?? '')
    codes.delete(form.get('code') ?? '')
    const challenge = createHash('sha256')
      .update(form.get('code_verifier') ?? '')
      .digest('base64url')
    if (
      !grant ||
      grant.expires < Date.now() ||
      grant.redirect !== form.get('redirect_uri') ||
      grant.challenge !== challenge
    ) {
      signIns.push({ user: grant?.user.login ?? null, pkce: false })
      return json(res, 200, { error: 'bad_verification_code' })
    }
    const access = `ghu_stand${randomBytes(16).toString('hex')}`
    userTokens.set(access, grant.user)
    signIns.push({ user: grant.user.login, pkce: true, token: access })
    return json(res, 200, { access_token: access, token_type: 'bearer', scope: '' })
  }

  // ─── git smart HTTP ─────────────────────────────────────────────────────────

  const gitRequest = async (req, res, url) => {
    const match = /^\/(.+?\.git)(\/.*)$/.exec(url.pathname)
    const repo = [...repos.values()].find((item) => `${item.fullName}.git` === match?.[1])
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const [username, ...rest] = basic
      ? Buffer.from(basic, 'base64').toString('utf8').split(':')
      : [null]
    const token = username === 'x-access-token' ? tokens.get(rest.join(':')) : undefined
    const service = url.searchParams.get('service') ?? match?.[2]?.slice(1) ?? ''
    const writes = service === 'git-receive-pack'
    const entry = { host: GITHUB_HOST, method: req.method, path: url.pathname, git: service }
    entry.auth = token !== undefined
    requests.push(entry)
    if (!repo) return json(res, 404, { message: 'Not Found' })
    const usable =
      token &&
      !token.revoked &&
      token.expires > Date.now() &&
      installations.get(token.installationId)?.repos.has(repo.id) &&
      (token.repositoryIds === null || token.repositoryIds.includes(repo.id)) &&
      has(token.permissions, 'contents', writes ? 'write' : 'read')
    const anonymous = !token && !writes && !repo.private
    if (!usable && !anonymous) {
      entry.status = 401
      res.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' })
      return res.end()
    }
    const before = writes && req.method === 'POST' ? await heads(repo) : null
    const workflows = has(token?.permissions, 'workflows', 'write')
    const child = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_PROJECT_ROOT: repo.projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: `/${repo.fullName}.git${match[2]}`,
        REQUEST_METHOD: req.method,
        QUERY_STRING: url.search.replace(/^\?/, ''),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
        GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
        REMOTE_USER: 'x-access-token',
        REMOTE_ADDR: '127.0.0.1',
        RADITI_FAKE_WORKFLOWS: workflows ? '1' : '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    req.pipe(child.stdin)
    let head = Buffer.alloc(0)
    let started = false
    const out = []
    child.stdout.on('data', (chunk) => {
      if (before) out.push(chunk)
      if (started) return res.write(chunk)
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      started = true
      let status = 200
      const headers = {}
      for (const line of head.subarray(0, end).toString('latin1').split('\r\n')) {
        const at = line.indexOf(':')
        const name = line.slice(0, at).trim()
        const value = line.slice(at + 1).trim()
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0])
        else headers[name] = value
      }
      entry.status = status
      res.writeHead(status, headers)
      res.write(head.subarray(end + 4))
    })
    child.stderr.on('data', () => {})
    await new Promise((done) => child.once('close', done))
    if (!started) {
      res.writeHead(500)
      return res.end()
    }
    if (before) {
      const after = await heads(repo)
      const updates = Object.entries(after).filter(([branch, sha]) => before[branch] !== sha)
      const record = {
        repo: repo.fullName,
        updates,
        permissions: { ...token.permissions },
        repositoryIds: token.repositoryIds,
      }
      if (
        updates.length === 0 &&
        /pre-receive hook declined/.test(Buffer.concat(out).toString('latin1'))
      )
        refusedPushes.push(record)
      else if (updates.length > 0) pushes.push(record)
      for (const [branch, sha] of updates) makeRun(repo, { branch, sha, event: 'push' })
    }
    res.end()
  }

  // ─── REST ───────────────────────────────────────────────────────────────────

  /** The installation token of a request that may act on `repo`, or null. */
  const tokenFor = (token, repo) =>
    token &&
    !token.revoked &&
    token.expires > Date.now() &&
    installations.get(token.installationId)?.repos.has(repo.id) &&
    (token.repositoryIds === null || token.repositoryIds.includes(repo.id))
      ? token
      : null

  const repoApi = async (req, res, url, repo, rest, auth, answer) => {
    const token = tokenFor(auth.installation, repo)
    const anonymousRead = auth.installation === undefined && !repo.private && req.method === 'GET'
    if (!token && !anonymousRead) return answer(404, { message: 'Not Found' })
    const may = (name, level) => token !== null && has(token.permissions, name, level)
    const body =
      ['POST', 'PUT', 'PATCH'].includes(req.method) && req.headers['content-length'] !== '0'
        ? JSON.parse((await readBody(req)).toString('utf8') || '{}')
        : null
    const now = await heads(repo)
    if (req.method === 'GET' && rest === '') return answer(200, repoJson(repo))
    if (req.method === 'GET' && rest === '/branches')
      return answer(
        200,
        Object.entries(now).map(([name, sha]) => ({
          name,
          commit: { sha },
          protected: repo.protected.has(name),
        })),
      )
    const branchAt = /^\/branches\/(.+)$/.exec(rest)
    if (req.method === 'GET' && branchAt) {
      const name = branchAt[1].split('/').map(decodeURIComponent).join('/')
      if (!now[name]) return answer(404, { message: 'Branch not found' })
      const required = repo.protected.get(name)
      return answer(200, {
        name,
        commit: { sha: now[name] },
        protected: required !== undefined,
        ...(required === undefined
          ? {}
          : {
              protection: {
                enabled: true,
                required_status_checks: {
                  contexts: required,
                  checks: required.map((context) => ({ context, app_id: null })),
                },
              },
            }),
      })
    }
    if (req.method === 'GET' && /^\/rules\/branches\/.+$/.test(rest)) return answer(200, [])
    const collaborator = /^\/collaborators\/([^/]+)\/permission$/.exec(rest)
    if (req.method === 'GET' && collaborator) {
      const user = [...users.values()].find(
        (item) => item.login === decodeURIComponent(collaborator[1]),
      )
      if (!user) return answer(404, { message: 'Not Found' })
      const role = repo.collaborators.get(user.id) ?? null
      const rights = rightsOf(repo, user)
      return answer(200, {
        permission: role === null ? 'none' : role === 'maintain' ? 'write' : role,
        role_name: role ?? 'none',
        user: { id: user.id, login: user.login, permissions: rights },
      })
    }
    if (rest === '/pulls' && req.method === 'POST') {
      if (!may('pull_requests', 'write')) return answer(403, { message: 'Resource not accessible' })
      if (!now[body.head]) return answer(422, { message: 'Validation Failed' })
      if (pulls.some((p) => p.repo === repo && p.head === body.head && p.state === 'open'))
        return answer(422, { message: 'A pull request already exists' })
      const pull = {
        repo,
        number: repo.pulls.length + 1,
        title: String(body.title),
        body: String(body.body ?? ''),
        head: body.head,
        base: body.base,
        draft: body.draft === true,
        state: 'open',
        sha: now[body.head],
        permissions: { ...token.permissions },
      }
      repo.pulls.push(pull)
      pulls.push(pull)
      return answer(201, await pullJson(repo, pull))
    }
    if (rest === '/pulls' && req.method === 'GET') {
      const head = url.searchParams.get('head')
      const list = repo.pulls.filter(
        (p) => head === null || `${repo.fullName.split('/')[0]}:${p.head}` === head,
      )
      return answer(200, await Promise.all(list.toReversed().map((p) => pullJson(repo, p))))
    }
    const pullAt = /^\/pulls\/(\d+)(\/merge)?$/.exec(rest)
    if (pullAt) {
      const pull = repo.pulls.find((p) => p.number === Number(pullAt[1]))
      if (!pull) return answer(404, { message: 'Not Found' })
      if (req.method === 'GET' && !pullAt[2]) return answer(200, await pullJson(repo, pull))
      if (req.method === 'PATCH' && !pullAt[2]) {
        if (!may('pull_requests', 'write')) return answer(403, { message: 'Forbidden' })
        if (body?.state === 'closed' && pull.state === 'open') pull.state = 'closed'
        return answer(200, await pullJson(repo, pull))
      }
      if (req.method === 'PUT' && pullAt[2]) {
        mergeCalls.push({ number: pull.number, sha: body?.sha, method: body?.merge_method })
        if (!may('contents', 'write')) return answer(403, { message: 'Forbidden' })
        if (pull.state !== 'open') return answer(405, { message: 'Pull Request is not mergeable' })
        const head = now[pull.head]
        if (body?.sha !== head) return answer(409, { message: 'Head branch was modified' })
        if (!requiredPassed(repo, pull.base, head))
          return answer(405, { message: 'Required status check "test" is expected.' })
        const sha = await merge(repo, pull, head)
        if (sha === null) return answer(405, { message: 'Merge conflict' })
        return answer(200, { sha, merged: true, message: 'Pull Request successfully merged' })
      }
    }
    const refAt = /^\/git\/refs\/heads\/(.+)$/.exec(rest)
    if (req.method === 'DELETE' && refAt) {
      if (!may('contents', 'write')) return answer(403, { message: 'Forbidden' })
      const name = refAt[1].split('/').map(decodeURIComponent).join('/')
      if (!now[name]) return answer(422, { message: 'Reference does not exist' })
      await runGit(['update-ref', '-d', `refs/heads/${name}`, now[name]], { cwd: repo.bare, home })
      return answer(204)
    }
    const commitAt = /^\/commits\/([0-9a-f]{40})\/(check-suites|check-runs|status)$/.exec(rest)
    if (req.method === 'GET' && commitAt) {
      const runs = checksOf(repo, commitAt[1])
      if (commitAt[2] === 'check-suites')
        return answer(200, {
          total_count: runs.length,
          check_suites: runs.map((run) => ({
            id: run.id,
            ...runState(run),
            latest_check_runs_count: 1,
          })),
        })
      if (commitAt[2] === 'check-runs')
        return answer(200, {
          total_count: runs.length,
          check_runs: runs.map((run) => ({ id: run.jobId, name: 'test', ...runState(run) })),
        })
      return answer(200, { state: 'success', statuses: [], total_count: 0 })
    }
    if (req.method === 'GET' && rest === '/actions/runs') {
      const branch = url.searchParams.get('branch')
      const sha = url.searchParams.get('head_sha')
      const list = repo.runs
        .filter(
          (run) => (branch === null || run.branch === branch) && (sha === null || run.sha === sha),
        )
        .toReversed()
        .slice(0, Number(url.searchParams.get('per_page') ?? 20))
      return answer(200, {
        total_count: list.length,
        workflow_runs: list.map((run) => runJson(repo, run)),
      })
    }
    const runAt = /^\/actions\/runs\/(\d+)(\/jobs|\/rerun|\/cancel)?$/.exec(rest)
    if (runAt) {
      const run = repo.runs.find((item) => item.id === Number(runAt[1]))
      if (!run) return answer(404, { message: 'Not Found' })
      if (req.method === 'GET' && !runAt[2]) return answer(200, runJson(repo, run))
      if (req.method === 'GET' && runAt[2] === '/jobs')
        return answer(200, {
          total_count: 1,
          jobs: [
            {
              id: run.jobId,
              run_id: run.id,
              name: 'test',
              ...runState(run),
              html_url: `https://${GITHUB_HOST}/${repo.fullName}/actions/runs/${run.id}/job/${run.jobId}`,
              started_at: run.created,
              completed_at: runState(run).status === 'completed' ? new Date().toISOString() : null,
            },
          ],
        })
      if (req.method === 'POST' && (runAt[2] === '/rerun' || runAt[2] === '/cancel')) {
        if (!may('actions', 'write')) return answer(403, { message: 'Forbidden' })
        const done = runState(run).status === 'completed'
        runActions.push({ run: run.id, action: runAt[2].slice(1) })
        if (runAt[2] === '/rerun') {
          if (!done) return answer(403, { message: 'This workflow is already running' })
          run.started = Date.now()
          run.canceled = false
          return answer(201, {})
        }
        if (done) return answer(409, { message: 'Cannot cancel a workflow run that is completed.' })
        run.canceled = true
        return answer(202, {})
      }
    }
    const logAt = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest)
    if (req.method === 'GET' && logAt) {
      const run = repo.runs.find((item) => item.jobId === Number(logAt[1]))
      if (!run) return answer(404, { message: 'Not Found' })
      // A redirect to a host that is not the storage of GitHub Actions: the platform must refuse
      // it, never follow it (§4.5). The blob path here would tell if it did.
      res.writeHead(302, {
        location: `${origin}/blob/${run.jobId}?sig=${randomBytes(8).toString('hex')}`,
      })
      entry.status = 302
      return res.end()
    }
    if (req.method === 'GET' && rest === '/actions/workflows') {
      const files = (await filesAt(repo, repo.defaultBranch)).filter((path) =>
        /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path),
      )
      return answer(200, {
        total_count: files.length,
        workflows: files.map((path) => ({
          id: repo.workflowIds.get(path) ?? repo.workflowIds.set(path, nextId()).get(path),
          name: path.endsWith('deploy.yml') ? 'Выкладка' : 'CI',
          path,
          state: 'active',
        })),
      })
    }
    const contentAt = /^\/contents\/(.+)$/.exec(rest)
    if (req.method === 'GET' && contentAt) {
      const path = contentAt[1].split('/').map(decodeURIComponent).join('/')
      const text = await show(repo, url.searchParams.get('ref') ?? repo.defaultBranch, path)
      if (text === null) return answer(404, { message: 'Not Found' })
      return answer(200, {
        type: 'file',
        path,
        encoding: 'base64',
        content: Buffer.from(text).toString('base64'),
      })
    }
    const dispatchAt = /^\/actions\/workflows\/(\d+)\/dispatches$/.exec(rest)
    if (req.method === 'POST' && dispatchAt) {
      if (!may('actions', 'write')) return answer(403, { message: 'Forbidden' })
      const path = [...repo.workflowIds].find(([, id]) => id === Number(dispatchAt[1]))?.[0]
      if (!path || !now[body?.ref]) return answer(422, { message: 'Unexpected inputs' })
      dispatches.push({ repo: repo.fullName, workflow: path, ref: body.ref, sha: now[body.ref] })
      makeRun(repo, {
        branch: body.ref,
        sha: now[body.ref],
        event: 'workflow_dispatch',
        name: 'Выкладка',
      })
      return answer(204)
    }
    return answer(404, { message: 'Not Found' })
  }

  const api = async (req, res, url) => {
    const path = url.pathname
    const bearer = tokenOf(req) ?? null
    const entry = { method: req.method, path, query: url.search }
    requests.push(entry)
    const answer = (status, body) => {
      entry.status = status
      return json(res, status, body)
    }
    // The JWT of the app: a token of one installation, for what the request names.
    const issueAt = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path)
    if (req.method === 'POST' && issueAt) {
      if (!appJwtValid(bearer, { appId: app.id, publicKey: app.publicKey }))
        return answer(401, { message: 'A JSON web token could not be decoded' })
      const installation = installations.get(Number(issueAt[1]))
      if (!installation) return answer(404, { message: 'Not Found' })
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const repositoryIds = Array.isArray(body.repository_ids) ? body.repository_ids : null
      if (repositoryIds?.some((id) => !installation.repos.has(id)))
        return answer(422, { message: 'There is at least one repository that does not exist' })
      const token = `ghs_stand${randomBytes(16).toString('hex')}`
      const record = {
        token,
        installationId: installation.id,
        repositoryIds,
        permissions: { ...(body.permissions ?? {}) },
        expires: Date.now() + 3600_000,
        revoked: false,
      }
      tokens.set(token, record)
      issued.push(record)
      return answer(201, {
        token,
        expires_at: new Date(record.expires).toISOString(),
        permissions: record.permissions,
      })
    }
    const installationToken = bearer === null ? undefined : tokens.get(bearer)
    const user = bearer === null ? undefined : userTokens.get(bearer)
    if (bearer !== null && installationToken === undefined && user === undefined)
      return answer(401, { message: 'Bad credentials' })
    if (installationToken && (installationToken.revoked || installationToken.expires < Date.now()))
      return answer(401, { message: 'Bad credentials' })
    if (req.method === 'DELETE' && path === '/installation/token') {
      if (!installationToken) return answer(401, { message: 'Bad credentials' })
      installationToken.revoked = true
      return answer(204)
    }
    if (req.method === 'GET' && path === '/installation/repositories') {
      if (!installationToken) return answer(403, { message: 'Forbidden' })
      const installation = installations.get(installationToken.installationId)
      const list = [...installation.repos]
        .filter(
          (id) =>
            installationToken.repositoryIds === null ||
            installationToken.repositoryIds.includes(id),
        )
        .map((id) => repoJson(repos.get(id)))
      return answer(200, { total_count: list.length, repositories: list })
    }
    if (req.method === 'GET' && path === '/user') {
      if (!user) return answer(403, { message: 'Resource not accessible by integration' })
      return answer(200, { id: user.id, login: user.login })
    }
    if (req.method === 'GET' && path === '/user/installations') {
      if (!user) return answer(403, { message: 'Forbidden' })
      const list = [...installations.values()].filter((item) => item.members.has(user.id))
      return answer(200, {
        total_count: list.length,
        installations: list.map((item) => ({
          id: item.id,
          account: item.account,
          app_id: Number(app.id),
        })),
      })
    }
    const userRepos = /^\/user\/installations\/(\d+)\/repositories$/.exec(path)
    if (req.method === 'GET' && userRepos) {
      if (!user) return answer(403, { message: 'Forbidden' })
      const installation = installations.get(Number(userRepos[1]))
      if (!installation || !installation.members.has(user.id))
        return answer(404, { message: 'Not Found' })
      const list = [...installation.repos]
        .map((id) => repos.get(id))
        .filter((repo) => repo.collaborators.has(user.id))
        .map((repo) => repoJson(repo, rightsOf(repo, user)))
      return answer(200, { total_count: list.length, repositories: list })
    }
    const userAt = /^\/user\/(\d+)$/.exec(path)
    if (req.method === 'GET' && userAt) {
      const found = users.get(Number(userAt[1]))
      return found
        ? answer(200, { id: found.id, login: found.login })
        : answer(404, { message: 'Not Found' })
    }
    const repoAt = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path)
    if (repoAt) {
      const fullName = `${decodeURIComponent(repoAt[1])}/${decodeURIComponent(repoAt[2])}`
      const repo = [...repos.values()].find((item) => item.fullName === fullName)
      if (!repo) return answer(404, { message: 'Not Found' })
      return repoApi(
        req,
        res,
        url,
        repo,
        repoAt[3] ?? '',
        { installation: installationToken },
        answer,
      )
    }
    return answer(404, { message: 'Not Found' })
  }

  /** Every request of `github.com` or of the fake's own port. */
  const handle = async (req, res) => {
    try {
      const url = new URL(req.url, 'https://fake.invalid')
      const host = String(req.headers.host ?? '')
        .replace(/:\d+$/, '')
        .toLowerCase()
      if (host === GITHUB_HOST && /\.git\//.test(url.pathname))
        return await gitRequest(req, res, url)
      if (req.method === 'GET' && /^\/apps\/[^/]+\/installations\/new$/.test(url.pathname))
        return installationPage(res, url)
      if (req.method === 'GET' && url.pathname === '/login/oauth/authorize')
        return authorizePage(res, url)
      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token')
        return await accessToken(req, res)
      if (url.pathname.startsWith('/blob/')) {
        blobRequests.push(url.pathname)
        return json(res, 200, {})
      }
      return await api(req, res, url)
    } catch (error) {
      if (logFile)
        await writeFile(logFile, `${error?.stack ?? error}\n`, { flag: 'a', mode: 0o600 })
      if (!res.headersSent) json(res, 500, { message: 'fake failed' })
      else res.destroy()
    }
  }

  const servers = []
  for (const address of ['127.0.0.1', '::1']) {
    const server = createServer({ key, cert, minVersion: 'TLSv1.2' }, handle)
    await new Promise((done, reject) => {
      server.once('error', reject)
      server.listen(port, address, done)
    })
    servers.push(server)
  }

  return {
    origin,
    root,
    requests,
    issued,
    pushes,
    refusedPushes,
    pulls,
    mergeCalls,
    dispatches,
    blobRequests,
    signIns,
    runActions,
    handle,
    addUser(login) {
      const user = { id: nextId(), login }
      users.set(user.id, user)
      return user
    },
    /** An installation of the app on `account`, its members — the people who may see it. */
    addInstallation({ account, members }) {
      const installation = {
        id: nextId(),
        account: { login: account, id: nextId() },
        members: new Set(members.map((user) => user.id)),
        repos: new Set(),
      }
      installations.set(installation.id, installation)
      return installation
    },
    /** A repository of an installation with one commit of `files` and its collaborators. */
    async addRepo(installation, { name, files, collaborators, protectedBranches = {} }) {
      const fullName = `${installation.account.login}/${name}`
      const work = await mkdtemp(join(root, 'work-'))
      for (const [file, content] of Object.entries(files)) {
        await mkdir(dirname(join(work, file)), { recursive: true })
        await writeFile(join(work, file), content)
      }
      await runGit(['init', '-q', '-b', 'main'], { cwd: work, home })
      await runGit(['add', '-A'], { cwd: work, home })
      await runGit(['commit', '-q', '-m', 'Первая версия'], { cwd: work, home })
      const projectRoot = join(root, 'repos')
      const bare = join(projectRoot, `${fullName}.git`)
      await mkdir(dirname(bare), { recursive: true })
      await runGit(['clone', '-q', '--bare', work, bare], { cwd: root, home })
      await runGit(['config', 'http.receivepack', 'true'], { cwd: bare, home })
      await runGit(['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: bare, home })
      await writeFile(join(bare, 'hooks', 'pre-receive'), PRE_RECEIVE)
      await chmod(join(bare, 'hooks', 'pre-receive'), 0o755)
      await rm(work, { recursive: true, force: true })
      const repo = {
        id: nextId(),
        fullName,
        bare,
        projectRoot,
        defaultBranch: 'main',
        private: true,
        collaborators: new Map(collaborators.map(([user, role]) => [user.id, role])),
        protected: new Map(Object.entries(protectedBranches)),
        pulls: [],
        runs: [],
        slowRefs: new Map(),
        workflowIds: new Map(),
      }
      repos.set(repo.id, repo)
      installation.repos.add(repo.id)
      return repo
    },
    /** What the next installation page sends back to the Setup URL. */
    installs(next) {
      installing = next
    },
    /** Who signs in on the next authorization pages. */
    signsIn(user) {
      signingIn = user
    },
    heads,
    show,
    async parents(repo, ref) {
      const out = await runGit(['rev-list', '--parents', '-n', '1', ref], { cwd: repo.bare, home })
      return out.stdout.trim().split(' ').slice(1)
    },
    /**
     * A delivery of the app's webhook to `url`, signed by `secret` (the app's own, or another to
     * forge one); the status web answered.
     */
    async deliver(
      url,
      { event, body, secret = app.webhookSecret, deliveryId = randomBytes(8).toString('hex') },
    ) {
      const raw = JSON.stringify(body)
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': event,
          'x-github-delivery': deliveryId,
          'x-hub-signature-256': githubSignature(secret, raw),
          'user-agent': 'GitHub-Hookshot/stand',
        },
        body: raw,
        redirect: 'manual',
      })
      return { status: response.status, deliveryId }
    },
    close: async () => {
      for (const server of servers) {
        server.closeAllConnections()
        await new Promise((done) => server.close(done))
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}
