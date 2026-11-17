// The fake GitLab of the projects stand (docs/plan/84-projects.md, §6): the part of GitLab REST v4
// the adapter of @repo/git-providers sends (gitlab.ts, gitlab-paths.ts), the OAuth of gitlab.com
// with PKCE (connect.ts) and real git smart HTTP — `git http-backend` of this machine over bare
// repositories the stand made. One process answers two GitLabs by the Host of a request:
// `gitlab.localhost` — an own server of the client reached by token — and `gitlab.com`, which the
// apps reach at `https://localhost:<port>` (RADITI_FAKE_GITLAB_COM_URL) for the API and by its own
// name on 443 for git. A merge request merges in the bare repository; a push makes a pipeline with
// its jobs, a merge into the main branch — one with a manual deploy job. Everything it saw is kept
// for the scenarios: requests (method, path, how they were signed — never a token), pushes, merge
// requests with their texts, lints, played jobs. Where a real GitLab CE 19.5.6 answered otherwise
// than this fake did (the live check of 17.11.2026, docs/plan/84-projects.md, §10), it answers so
// now: the races of a push and of the check of a request, quick actions, the list of pipelines,
// the log of Runner 19, the lint of `include: local` (the README of the stand).
import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

/** The two hosts this fake answers for. */
export const OWN_HOST = 'gitlab.localhost'
export const COM_HOST = 'gitlab.com'

const GIT_ENV = (home) => ({
  PATH: process.env.PATH,
  HOME: home,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Клиент Проверкин',
  GIT_AUTHOR_EMAIL: 'client@example.ru',
  GIT_COMMITTER_NAME: 'Клиент Проверкин',
  GIT_COMMITTER_EMAIL: 'client@example.ru',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
})

/** One git command; resolves to its output, rejects on a non-zero code unless `allowFailure`. */
export function runGit(args, { cwd, home, input, env = {}, allowFailure = false } = {}) {
  return new Promise((done, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...GIT_ENV(home ?? tmpdir()), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      if (code !== 0 && !allowFailure)
        reject(new Error(`git ${args[0]} failed (${code}): ${stderr.slice(0, 400)}`))
      else done({ code, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

const sha40 = /^[0-9a-f]{40}$/

/** A path of `include: local` as a test of file names: `*` within a directory, `**` across. */
function globOf(pattern) {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*' && pattern[i + 1] === '*') {
      source += '.*'
      i++
    } else if (char === '*') source += '[^/]*'
    else source += char.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

/** The heads of a bare repository: `{ branch: sha }`. */
async function headsOf(bare, home) {
  const { stdout } = await runGit(
    ['for-each-ref', '--format=%(refname:strip=2) %(objectname)', 'refs/heads'],
    { cwd: bare, home },
  )
  return Object.fromEntries(
    stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ')),
  )
}

/**
 * `delegate` — another fake that answers every request for its host on this server (the fake
 * GitHub, whose git reaches `github.com` on 443 through the same forwarder).
 */
export async function startFakeGitlab({ key, cert, port, oauth, logFile = null, delegate = null }) {
  const root = await mkdtemp(join(tmpdir(), 'raditi-projects-verify-gitlab-'))
  const home = join(root, 'home')
  await mkdir(home, { mode: 0o700 })
  let ids = 100
  const nextId = () => (ids += 1)

  /** By host: users by token, projects by id. */
  const hosts = {
    [OWN_HOST]: { users: new Map(), projects: new Map() },
    [COM_HOST]: { users: new Map(), projects: new Map() },
  }
  const codes = new Map()
  /** Tokens of an own server that answers every API request with a redirect. */
  const redirects = new Set()
  const requests = []
  const pushes = []
  const lints = []
  const played = []
  const mergeCalls = []
  /** Project hooks core made: id → { project, url, token, signingToken, ... }. */
  const hooks = new Map()
  const removedHooks = []
  const pipelineActions = []
  /** cancel_auto_merge and its deprecated endpoint: { iid, on }. */
  const autoMergeCancels = []

  const hostOf = (req) => {
    const name = String(req.headers.host ?? '')
      .replace(/:\d+$/, '')
      .toLowerCase()
    return name === OWN_HOST ? OWN_HOST : COM_HOST
  }
  const userOf = (host, token) => (token ? (hosts[host].users.get(token) ?? null) : null)

  // Without a token GitLab answers a public project without `statistics`, `permissions` and
  // `ci_config_path`: `statistics=true` is ignored, not refused (GitLab CE 19.5.6, gitlab.com).
  const projectJson = (host, project, size, { anonymous = false } = {}) => ({
    id: project.id,
    path_with_namespace: project.path,
    name: project.path.split('/').at(-1),
    default_branch: project.defaultBranch,
    visibility: project.visibility,
    web_url: `https://${host}/${project.path}`,
    // An own server may answer any address for git: the platform builds its own (§4.6).
    http_url_to_repo: `https://10.0.0.1/${project.path}.git`,
    archived: false,
    ...(anonymous
      ? {}
      : {
          statistics: { repository_size: size },
          ci_config_path: null,
          // Maintainer (40) by default: the role GitLab requires to make a project hook (84.26).
          permissions: {
            project_access: { access_level: project.accessLevel ?? 40 },
            group_access: null,
          },
        }),
  })

  /** When a pipeline that is over ended: its run time after its last start. */
  const endedAt = (p) => new Date(p.started + p.runMs).toISOString()
  // The list of pipelines has no `started_at` and `finished_at` — only the pipeline itself does
  // (GitLab CE 19.5.6); `updated_at` is in both. Neither has `failure_reason`: the jobs do.
  const pipelineJson = (host, project, p, { listed = false } = {}) => {
    const status = statusOf(p)
    const over = ['success', 'failed', 'canceled'].includes(status)
    return {
      id: p.id,
      sha: p.sha,
      ref: p.ref,
      status,
      source: p.source,
      name: p.name,
      web_url: `https://${host}/${project.path}/-/pipelines/${p.id}`,
      created_at: p.createdAt,
      updated_at: over && !p.canceled && !p.failureReason ? endedAt(p) : new Date().toISOString(),
      ...(listed
        ? {}
        : {
            started_at: new Date(p.started).toISOString(),
            finished_at: over ? (p.canceled || p.failureReason ? p.createdAt : endedAt(p)) : null,
          }),
    }
  }
  /** A pipeline runs for `runMs`, then its jobs are done (the manual ones wait). */
  const jobStatusOf = (p, job) =>
    p.canceled && !job.manual
      ? 'canceled'
      : job.played
        ? Date.now() - job.played > 1500
          ? 'success'
          : 'running'
        : job.manual
          ? 'manual'
          : p.failureReason
            ? 'failed'
            : Date.now() - p.started > p.runMs
              ? 'success'
              : 'running'
  const statusOf = (p) => {
    if (p.canceled) return 'canceled'
    if (p.failureReason) return 'failed'
    const statuses = p.jobs.map((job) => jobStatusOf(p, job))
    if (statuses.includes('running')) return 'running'
    if (statuses.every((status) => status === 'manual')) return 'manual'
    return 'success'
  }
  const jobJson = (host, project, p, job) => ({
    id: job.id,
    name: job.name,
    stage: job.stage,
    status: jobStatusOf(p, job),
    web_url: `https://${host}/${project.path}/-/jobs/${job.id}`,
    started_at: p.createdAt,
    finished_at: null,
    failure_reason: p.failureReason ?? null,
    pipeline: { id: p.id, sha: p.sha },
  })

  const seconds = () => Math.floor(Date.now() / 1000)
  /**
   * A log as GitLab Runner 19.5 writes it (GitLab CE 19.5.6 gives it so): every line
   * `<time> <stream><O|E><' '|'+'>`, `+` continuing the line before. `parts` — [stream, text, more].
   */
  const runnerLog = (parts) =>
    parts
      .map(
        ([stream, text, more = false]) =>
          `${new Date().toISOString().replace('Z', '123Z')} ${stream}O${more ? '+' : ' '}${text}`,
      )
      .join('\n') + '\n'

  const makePipeline = (project, { ref, sha, source, deploy }) => {
    const p = {
      id: nextId(),
      ref,
      sha,
      source,
      name: deploy ? 'Основная ветка' : `Ветка ${ref}`,
      createdAt: new Date().toISOString(),
      started: Date.now(),
      runMs: project.slowRefs?.get(ref) ?? 2000,
      failureReason: project.unverified ? 'user_not_verified' : null,
      jobs: [
        {
          id: nextId(),
          name: 'test',
          stage: 'test',
          manual: false,
          // The log of a build: ANSI, the access of the run and a variable — core masks them.
          trace: runnerLog([
            ['00', '\u001b[0KRunning with gitlab-runner 19.5.3 (stand)\u001b[0;m'],
            ['00', `section_start:${seconds()}:step_script\r\u001b[0K`],
            ['00', '\u001b[0K\u001b[36;1mExecuting "step_script" stage\u001b[0;m', true],
            ['01', '\u001b[0K\u001b[32;1m$ npm test\u001b[0;m'],
            ['01', `CI_JOB_TOKEN=${project.logSecret ?? 'none'}`],
            ['01', '\u001b[32mok\u001b[0m 3 tests'],
            ['00', `section_end:${seconds()}:step_script\r\u001b[0K`],
            ['00', '\u001b[32;1mJob succeeded\u001b[0;m'],
          ]),
        },
        ...(deploy
          ? [
              {
                id: nextId(),
                name: 'deploy',
                stage: 'deploy',
                manual: true,
                trace: runnerLog([['01', 'deploy']]),
              },
            ]
          : []),
      ],
    }
    project.pipelines.push(p)
    return p
  }

  /**
   * `detailed_merge_status` of `mr` (GitLab CE 19.5.6): a request is checked about a second after
   * it is opened, and again once a read of it alone follows a move of its target — until then
   * `unchecked`/`checking`, and a merge of it is refused (405, 422 when green).
   */
  const mergeStatusOf = (mr, heads, { read = false } = {}) => {
    if (mr.state !== 'opened') return 'not_open'
    const target = heads[mr.target] ?? null
    if (!mr.check || mr.check.target !== target) {
      if (read) mr.check = { target, readyAt: Date.now() + 150 }
      return 'unchecked'
    }
    return Date.now() < mr.check.readyAt ? 'checking' : 'mergeable'
  }

  const mrJson = async (host, project, mr, { read = false } = {}) => {
    const heads = await headsOf(project.bare, home)
    const head = mr.state === 'opened' ? (heads[mr.source] ?? mr.sha) : mr.sha
    const pipeline = project.pipelines.findLast((p) => p.sha === head) ?? null
    return {
      iid: mr.iid,
      title: mr.title,
      // What GitLab keeps: the text without the quick actions it ran.
      description: mr.kept ?? mr.description,
      state: mr.state,
      detailed_merge_status: mergeStatusOf(mr, heads, { read }),
      draft: mr.title.startsWith('Draft: '),
      source_branch: mr.source,
      target_branch: mr.target,
      sha: head,
      merge_commit_sha: mr.mergeSha ?? null,
      squash_commit_sha: null,
      merge_when_pipeline_succeeds: mr.autoMerge === true,
      web_url: `https://${host}/${project.path}/-/merge_requests/${mr.iid}`,
      head_pipeline: pipeline ? { id: pipeline.id, status: statusOf(pipeline) } : null,
    }
  }

  /** Merges `mr` in the bare repository with a merge commit; null on a conflict. */
  const merge = async (project, mr, remove) => {
    const heads = await headsOf(project.bare, home)
    const target = heads[mr.target]
    const source = heads[mr.source]
    const tree = await runGit(['merge-tree', '--write-tree', target, source], {
      cwd: project.bare,
      home,
      allowFailure: true,
    })
    if (tree.code !== 0) return null
    const commit = await runGit(
      [
        'commit-tree',
        tree.stdout.trim().split('\n')[0],
        ...['-p', target, '-p', source],
        '-m',
        `Merge branch '${mr.source}' into '${mr.target}'`,
      ],
      { cwd: project.bare, home },
    )
    const mergeSha = commit.stdout.trim()
    await runGit(['update-ref', `refs/heads/${mr.target}`, mergeSha, target], {
      cwd: project.bare,
      home,
    })
    if (remove)
      await runGit(['update-ref', '-d', `refs/heads/${mr.source}`, source], {
        cwd: project.bare,
        home,
      })
    mr.state = 'merged'
    mr.sha = source
    mr.mergeSha = mergeSha
    makePipeline(project, { ref: mr.target, sha: mergeSha, source: 'push', deploy: true })
    return mergeSha
  }

  /** Merge requests waiting for their pipeline (`auto_merge`): merged once it passed. */
  const settleAutoMerges = async (project) => {
    for (const mr of project.mergeRequests)
      if (mr.state === 'opened' && mr.autoMerge) {
        const heads = await headsOf(project.bare, home)
        const p = project.pipelines.findLast((item) => item.sha === heads[mr.source])
        if (p && statusOf(p) === 'success') await merge(project, mr, mr.removeSource)
      }
  }

  const readBody = async (req) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  // ─── OAuth of gitlab.com (https://docs.gitlab.com/api/oauth2/) ──────────────

  const authorize = (req, res, url) => {
    const q = url.searchParams
    const redirect = q.get('redirect_uri') ?? ''
    if (
      q.get('client_id') !== oauth.clientId ||
      q.get('response_type') !== 'code' ||
      q.get('code_challenge_method') !== 'S256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge') ?? '') ||
      !redirect.startsWith('http')
    )
      return json(res, 400, { error: 'invalid_request' })
    const user = [...hosts[COM_HOST].users.values()].find((item) => item.signsIn) ?? null
    if (user === null) return json(res, 403, { error: 'access_denied' })
    const code = randomBytes(18).toString('base64url')
    codes.set(code, {
      challenge: q.get('code_challenge'),
      redirect,
      user,
      scope: q.get('scope'),
      expires: Date.now() + 60_000,
    })
    const back = new URL(redirect)
    back.searchParams.set('code', code)
    back.searchParams.set('state', q.get('state') ?? '')
    res.writeHead(302, { location: back.href })
    res.end()
  }

  const issueTokens = (user) => {
    const access = `stand-oauth-${randomBytes(18).toString('hex')}`
    const refresh = `stand-refresh-${randomBytes(18).toString('hex')}`
    hosts[COM_HOST].users.set(access, user)
    user.refresh = refresh
    user.oauthTokens = (user.oauthTokens ?? []).concat(access, refresh)
    return {
      access_token: access,
      token_type: 'Bearer',
      refresh_token: refresh,
      expires_in: 7200,
      created_at: Math.floor(Date.now() / 1000),
      scope: 'api write_repository',
    }
  }

  const token = async (req, res) => {
    const form = new URLSearchParams((await readBody(req)).toString('utf8'))
    if (form.get('client_id') !== oauth.clientId || form.get('client_secret') !== oauth.secret)
      return json(res, 401, { error: 'invalid_client' })
    if (form.get('grant_type') === 'authorization_code') {
      const grant = codes.get(form.get('code') ?? '')
      codes.delete(form.get('code') ?? '')
      const verifier = form.get('code_verifier') ?? ''
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      if (
        !grant ||
        grant.expires < Date.now() ||
        grant.redirect !== form.get('redirect_uri') ||
        grant.challenge !== challenge
      ) {
        oauthRefusals.push(grant ? 'pkce' : 'code')
        return json(res, 400, { error: 'invalid_grant' })
      }
      grant.user.pkce = true
      return json(res, 200, issueTokens(grant.user))
    }
    if (form.get('grant_type') === 'refresh_token') {
      const user = [...hosts[COM_HOST].users.values()].find(
        (item) => item.refresh && item.refresh === form.get('refresh_token'),
      )
      if (!user) return json(res, 400, { error: 'invalid_grant' })
      return json(res, 200, issueTokens(user))
    }
    return json(res, 400, { error: 'unsupported_grant_type' })
  }
  const oauthRefusals = []

  // ─── git smart HTTP ─────────────────────────────────────────────────────────

  const gitRequest = async (req, res, host, url) => {
    const match = /^\/(.+?\.git)(\/.*)$/.exec(url.pathname)
    const project = [...hosts[host].projects.values()].find(
      (item) => `${item.path}.git` === match?.[1],
    )
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const password = basic
      ? Buffer.from(basic, 'base64').toString('utf8').split(':').slice(1).join(':')
      : null
    const user = userOf(host, password)
    const service = url.searchParams.get('service') ?? match?.[2]?.slice(1) ?? ''
    const writes = service === 'git-receive-pack' && req.method === 'POST'
    const entry = { host, method: req.method, path: url.pathname, git: service, auth: !!user }
    requests.push(entry)
    if (!project) return json(res, 404, { message: '404 Project Not Found' })
    const anonymousRead =
      user === null && service === 'git-upload-pack' && project.visibility === 'public'
    entry.anonymous = anonymousRead
    if (!anonymousRead && (user === null || !project.members.has(user.id))) {
      entry.status = 401
      res.writeHead(401, { 'www-authenticate': 'Basic realm="GitLab"' })
      return res.end()
    }
    const before = writes ? await headsOf(project.bare, home) : null
    const child = spawn('git', ['http-backend'], {
      env: {
        ...GIT_ENV(home),
        GIT_PROJECT_ROOT: project.projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: `/${project.path}.git${match[2]}`,
        REQUEST_METHOD: req.method,
        QUERY_STRING: url.search.replace(/^\?/, ''),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
        GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
        REMOTE_USER: user?.username ?? 'anonymous',
        REMOTE_ADDR: '127.0.0.1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    req.pipe(child.stdin)
    let head = Buffer.alloc(0)
    let started = false
    child.stdout.on('data', (chunk) => {
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
    if (writes) {
      const after = await headsOf(project.bare, home)
      const updates = Object.entries(after).filter(([branch, sha]) => before[branch] !== sha)
      const deleted = Object.keys(before).filter((branch) => !(branch in after))
      pushes.push({ host, path: project.path, user: user?.username ?? null, updates, deleted })
      for (const [branch] of updates) project.pushedAt.set(branch, Date.now())
      for (const [branch, sha] of updates)
        makePipeline(project, {
          ref: branch,
          sha,
          source: 'push',
          deploy: branch === project.defaultBranch,
        })
    }
    // The client hears the end of a push only once its pipelines exist.
    res.end()
  }

  // ─── REST v4 ────────────────────────────────────────────────────────────────

  const api = async (req, res, host, url) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null
    const user = userOf(host, bearer)
    const path = url.pathname.replace(/^\/api\/v4/, '')
    const entry = { host, method: req.method, path, query: url.search, auth: !!user }
    requests.push(entry)
    const answer = (status, body, headers) => {
      entry.status = status
      return json(res, status, body, headers)
    }
    // A token of a server that sends its client elsewhere: a client that follows comes back
    // here with `redirected=1`, which the scenarios look for.
    if (bearer !== null && redirects.has(bearer)) {
      entry.status = 302
      entry.redirected = url.searchParams.get('redirected') === '1'
      res.writeHead(302, { location: `https://${host}/api/v4${path}?redirected=1` })
      return res.end()
    }
    if (user === null) {
      // Without a token: a public project only, as GitLab answers an open link (§4.3).
      const at = /^\/projects\/([^/]+)$/.exec(path)
      const key = at ? decodeURIComponent(at[1]) : null
      const open = [...hosts[host].projects.values()].find(
        (p) => (String(p.id) === key || p.path === key) && p.visibility === 'public',
      )
      if (req.method === 'GET' && open)
        return answer(200, projectJson(host, open, open.size, { anonymous: true }))
      if (key !== null) return answer(404, { message: '404 Project Not Found' })
      return answer(401, { message: '401 Unauthorized' })
    }
    if (req.method === 'GET' && path === '/user')
      return answer(200, { id: user.id, username: user.username, name: user.username })
    if (req.method === 'GET' && path === '/projects') {
      const mine = [...hosts[host].projects.values()].filter((p) => p.members.has(user.id))
      return answer(
        200,
        mine.map((p) => projectJson(host, p, p.size)),
        { 'x-next-page': '' },
      )
    }
    const at = /^\/projects\/([^/]+)(\/.*)?$/.exec(path)
    if (!at) return answer(404, { message: '404 Not Found' })
    const key = decodeURIComponent(at[1])
    const project = [...hosts[host].projects.values()].find(
      (p) => String(p.id) === key || p.path === key,
    )
    if (!project || !project.members.has(user.id)) return answer(404, { message: '404 Project' })
    const rest = at[2] ?? ''
    const body = ['POST', 'PUT'].includes(req.method)
      ? JSON.parse((await readBody(req)).toString('utf8') || '{}')
      : null
    entry.body = body
    await settleAutoMerges(project)
    const heads = await headsOf(project.bare, home)
    if (req.method === 'GET' && rest === '')
      return answer(200, projectJson(host, project, project.size))
    if (req.method === 'GET' && rest === '/repository/branches') {
      const search = url.searchParams.get('search') ?? ''
      const exact = /^\^(.*)\$$/.exec(search)?.[1]
      const names = Object.keys(heads).filter((name) =>
        exact !== undefined ? name === exact : name.includes(search),
      )
      return answer(
        200,
        names.map((name) => ({
          name,
          default: name === project.defaultBranch,
          commit: { id: heads[name] },
        })),
      )
    }
    if (req.method === 'POST' && rest === '/merge_requests') {
      // A branch pushed a moment ago is not known yet: the first request opened within 300 ms of
      // the push is refused so (3 of 8 on GitLab CE 19.5.6), the next one opens.
      const pushedAt = project.pushedAt.get(body.source_branch)
      project.pushedAt.delete(body.source_branch)
      if (!heads[body.source_branch] || (pushedAt !== undefined && Date.now() - pushedAt < 300))
        return answer(400, { message: { source_branch: ['does not exist'] } })
      const other = project.mergeRequests.find(
        (item) => item.state === 'opened' && item.source === body.source_branch,
      )
      if (other)
        return answer(409, {
          message: [
            `Another open merge request already exists for this source branch: !${other.iid}`,
          ],
        })
      const description = String(body.description ?? '')
      // GitLab runs the quick actions of the description of a request it opens: `/draft`,
      // `/label`, `/assign` ran, `/title` and `/merge` did not; their lines are taken out.
      const quickActions = []
      const kept = []
      for (const line of description.split('\n')) {
        const action =
          /^\/(draft|label|assign|unassign|title|merge|approve|target_branch|close)\b/.exec(line)
        if (action === null) kept.push(line)
        else if (['draft', 'label', 'assign', 'unassign', 'close'].includes(action[1]))
          quickActions.push(line)
      }
      const mr = {
        iid: project.mergeRequests.length + 1,
        title: quickActions.some((line) => line.startsWith('/draft'))
          ? `Draft: ${String(body.title)}`
          : String(body.title),
        // As sent: the scenarios read what core gave GitLab.
        description,
        kept: kept.join('\n'),
        quickActions,
        source: body.source_branch,
        target: body.target_branch,
        state: 'opened',
        sha: heads[body.source_branch],
        check: { target: heads[body.target_branch] ?? null, readyAt: Date.now() + 150 },
      }
      project.mergeRequests.push(mr)
      return answer(201, await mrJson(host, project, mr))
    }
    // `cancel_auto_merge` (201 with the request; 409 when none was on or it is closed) and the
    // deprecated endpoint (201 with `status`), as GitLab CE 19.5.6 answers.
    const cancelAt =
      /^\/merge_requests\/(\d+)\/(cancel_auto_merge|cancel_merge_when_pipeline_succeeds)$/.exec(
        rest,
      )
    if (cancelAt && req.method === 'POST') {
      const mr = project.mergeRequests.find((item) => item.iid === Number(cancelAt[1]))
      if (!mr) return answer(404, { message: '404 Not found' })
      const on = mr.autoMerge === true && mr.state !== 'closed'
      if (on) mr.autoMerge = false
      autoMergeCancels.push({ iid: mr.iid, on })
      if (cancelAt[2] === 'cancel_auto_merge')
        return on
          ? answer(201, await mrJson(host, project, mr))
          : answer(409, { message: "Can't cancel the automatic merge" })
      return answer(
        201,
        on
          ? { status: 'success' }
          : { message: "Can't cancel the automatic merge", status: 'error', http_status: 406 },
      )
    }
    if (req.method === 'GET' && rest === '/merge_requests') {
      const source = url.searchParams.get('source_branch')
      const list = project.mergeRequests.filter((mr) => source === null || mr.source === source)
      return answer(
        200,
        await Promise.all(list.toReversed().map((mr) => mrJson(host, project, mr))),
      )
    }
    const mrAt = /^\/merge_requests\/(\d+)(\/merge)?$/.exec(rest)
    if (mrAt) {
      const mr = project.mergeRequests.find((item) => item.iid === Number(mrAt[1]))
      if (!mr) return answer(404, { message: '404 Not found' })
      if (req.method === 'GET' && !mrAt[2])
        return answer(200, await mrJson(host, project, mr, { read: true }))
      if (req.method === 'PUT' && !mrAt[2]) {
        if (body.state_event === 'close') mr.state = 'closed'
        return answer(200, await mrJson(host, project, mr))
      }
      if (req.method === 'PUT' && mrAt[2]) {
        mergeCalls.push({ iid: mr.iid, sha: body.sha, body })
        const green = body.auto_merge === true || body.merge_when_pipeline_succeeds === true
        if (mr.state !== 'opened') return answer(405, { message: '405 Method Not Allowed' })
        if (['unchecked', 'checking'].includes(mergeStatusOf(mr, heads))) {
          mergeCalls.at(-1).unchecked = true
          return green
            ? answer(422, { message: 'Branch cannot be merged' })
            : answer(405, { message: '405 Method Not Allowed' })
        }
        if (body.sha !== heads[mr.source]) return answer(409, { message: 'SHA does not match' })
        if (green) {
          const p = project.pipelines.findLast((item) => item.sha === heads[mr.source])
          if (p && statusOf(p) !== 'success') {
            mr.autoMerge = true
            mr.removeSource = body.should_remove_source_branch === true
            return answer(200, await mrJson(host, project, mr))
          }
        }
        const merged = await merge(project, mr, body.should_remove_source_branch === true)
        // A conflict is known by the check: a merge of it is 405, as on GitLab CE 19.5.6.
        if (merged === null) return answer(405, { message: '405 Method Not Allowed' })
        return answer(200, await mrJson(host, project, mr))
      }
    }
    if (req.method === 'GET' && rest === '/pipelines') {
      const ref = url.searchParams.get('ref')
      const sha = url.searchParams.get('sha')
      const list = project.pipelines
        .filter((p) => (ref === null || p.ref === ref) && (sha === null || p.sha === sha))
        .toReversed()
        .slice(0, Number(url.searchParams.get('per_page') ?? 20))
      return answer(
        200,
        list.map((p) => pipelineJson(host, project, p, { listed: true })),
      )
    }
    const retryAt = /^\/pipelines\/(\d+)\/(retry|cancel)$/.exec(rest)
    if (retryAt && req.method === 'POST') {
      const p = project.pipelines.find((item) => item.id === Number(retryAt[1]))
      if (!p) return answer(404, { message: '404 Not found' })
      pipelineActions.push({
        path: project.path,
        pipeline: p.id,
        action: retryAt[2],
        status: statusOf(p),
      })
      // A retry runs again the failed and canceled jobs only: a pipeline that passed stays as it
      // was (GitLab CE 19.5.6).
      if (retryAt[2] === 'retry' && (p.canceled || p.failureReason)) {
        p.started = Date.now()
        p.canceled = false
        p.failureReason = null
      } else if (retryAt[2] === 'cancel') p.canceled = true
      return answer(retryAt[2] === 'retry' ? 201 : 200, pipelineJson(host, project, p))
    }
    if (req.method === 'POST' && rest === '/hooks') {
      // `whsec_` and base64 of 24–64 bytes (Standard Webhooks); on GitLab CE 19.5.6 32 bytes were
      // taken and `whsec_short` refused so.
      if (typeof body.signing_token === 'string') {
        const key = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(body.signing_token)?.[1]
        const bytes = key ? Buffer.from(key, 'base64').length : 0
        if (bytes < 24 || bytes > 64) return answer(422, { error: 'Signing token is invalid' })
      }
      const hook = {
        id: nextId(),
        path: project.path,
        projectId: project.id,
        url: String(body.url ?? ''),
        token: String(body.token ?? ''),
        signingToken: typeof body.signing_token === 'string' ? body.signing_token : null,
        events: {
          push: body.push_events === true,
          mergeRequests: body.merge_requests_events === true,
          pipelines: body.pipeline_events === true,
        },
        sslVerification: body.enable_ssl_verification === true,
      }
      hooks.set(hook.id, hook)
      return answer(201, {
        id: hook.id,
        url: hook.url,
        signing_token_present: hook.signingToken !== null,
      })
    }
    const hookAt = /^\/hooks\/(\d+)$/.exec(rest)
    if (hookAt && req.method === 'DELETE') {
      const hook = hooks.get(Number(hookAt[1]))
      if (!hook || hook.projectId !== project.id) return answer(404, { message: '404 Not found' })
      hooks.delete(hook.id)
      removedHooks.push(hook)
      entry.status = 204
      res.writeHead(204)
      return res.end()
    }
    const pAt = /^\/pipelines\/(\d+)(\/jobs)?$/.exec(rest)
    if (pAt && req.method === 'GET') {
      const p = project.pipelines.find((item) => item.id === Number(pAt[1]))
      if (!p) return answer(404, { message: '404 Not found' })
      if (!pAt[2]) return answer(200, pipelineJson(host, project, p))
      const manual = url.searchParams.getAll('scope[]').includes('manual')
      return answer(
        200,
        p.jobs
          .filter((job) => !manual || jobStatusOf(p, job) === 'manual')
          .map((job) => jobJson(host, project, p, job)),
      )
    }
    const jAt = /^\/jobs\/(\d+)\/(trace|play)$/.exec(rest)
    if (jAt) {
      const p = project.pipelines.find((item) => item.jobs.some((j) => j.id === Number(jAt[1])))
      const job = p?.jobs.find((j) => j.id === Number(jAt[1]))
      if (!job) return answer(404, { message: '404 Not found' })
      if (jAt[2] === 'trace' && req.method === 'GET') {
        entry.status = 200
        res.writeHead(200, { 'content-type': 'text/plain' })
        return res.end(job.trace)
      }
      if (jAt[2] === 'play' && req.method === 'POST') {
        if (jobStatusOf(p, job) !== 'manual')
          return answer(400, { message: '400 Bad request - Unplayable Job' })
        job.played = Date.now()
        played.push({ path: project.path, job: job.name, sha: p.sha, ref: p.ref })
        return answer(200, jobJson(host, project, p, job))
      }
    }
    if (req.method === 'POST' && rest === '/ci/lint') {
      lints.push({ path: project.path, content: body.content, ref: body.ref })
      const content = String(body.content ?? '')
      const ref = String(body.ref ?? project.defaultBranch)
      // GitLab reads the files of `include: local` at `ref`: a wildcard is expanded to the files
      // there, and a file that is not there makes the configuration invalid and names no includes
      // at all (GitLab CE 19.5.6).
      const tree = await runGit(['ls-tree', '-r', '--name-only', ref, '--'], {
        cwd: project.bare,
        home,
        allowFailure: true,
      })
      if (tree.code !== 0)
        return answer(200, {
          valid: false,
          errors: ['Reference not found'],
          warnings: [],
          includes: null,
        })
      const files = tree.stdout.split('\n').filter(Boolean)
      const patterns = [
        ...content.matchAll(/^\s*(?:-\s*)?local:\s*['"]?([^'"\s]+)['"]?\s*$/gm),
      ].map((match) => match[1].replace(/^\//, ''))
      const includes = []
      for (const pattern of patterns) {
        const glob = globOf(pattern)
        const found = files.filter((file) => glob.test(file))
        if (!pattern.includes('*') && found.length === 0)
          return answer(200, {
            valid: false,
            errors: [`Local file \`${pattern}\` does not exist!`],
            warnings: [],
            includes: null,
          })
        for (const file of found)
          includes.push({
            type: 'local',
            location: file,
            blob: `https://${host}/${project.path}/-/blob/${ref}/${file}`,
            raw: `https://${host}/${project.path}/-/raw/${ref}/${file}`,
            extra: {},
            context_project: project.path,
            context_sha: null,
          })
      }
      const valid = /stages:/.test(content)
      return answer(200, {
        valid,
        errors: valid ? [] : ['jobs config should contain at least one visible job'],
        warnings: [],
        includes,
      })
    }
    return answer(404, { message: '404 Not Found' })
  }

  const handler = async (req, res) => {
    try {
      if (
        delegate !== null &&
        String(req.headers.host ?? '')
          .replace(/:\d+$/, '')
          .toLowerCase() === delegate.host
      )
        return await delegate.handle(req, res)
      const url = new URL(req.url, 'https://fake.invalid')
      const host = hostOf(req)
      if (url.pathname === '/oauth/authorize' && req.method === 'GET' && host === COM_HOST)
        return authorize(req, res, url)
      if (url.pathname === '/oauth/token' && req.method === 'POST' && host === COM_HOST)
        return await token(req, res)
      if (url.pathname.startsWith('/api/v4/')) return await api(req, res, host, url)
      if (/\.git\//.test(url.pathname)) return await gitRequest(req, res, host, url)
      requests.push({ host, method: req.method, path: url.pathname, status: 404 })
      json(res, 404, { message: '404 Not Found' })
    } catch (error) {
      if (logFile)
        await writeFile(logFile, `${error?.stack ?? error}\n`, { flag: 'a', mode: 0o600 })
      if (!res.headersSent) json(res, 500, { message: 'fake failed' })
      else res.destroy()
    }
  }

  // The fake answers on both loopback addresses: `localhost` resolves to ::1 first on macOS.
  const servers = []
  for (const address of ['127.0.0.1', '::1']) {
    const server = createServer({ key, cert, minVersion: 'TLSv1.2' }, handler)
    await new Promise((done, reject) => {
      server.once('error', reject)
      server.listen(port, address, done)
    })
    servers.push(server)
  }

  return {
    root,
    requests,
    pushes,
    lints,
    played,
    mergeCalls,
    oauthRefusals,
    codes,
    hooks,
    removedHooks,
    pipelineActions,
    autoMergeCancels,
    /**
     * A delivery of the hook of `project` as GitLab ≥ 19.0 sends it (Standard Webhooks:
     * `webhook-id`, `webhook-timestamp`, `webhook-signature`), to `origin` — the address of web the
     * stand reaches, in place of the public one of the hook. `forge` signs with another key;
     * `deliveryId` repeats a delivery. The status web answered.
     */
    async deliver(
      project,
      { origin, kind, body, forge = false, deliveryId = `stand-${randomBytes(6).toString('hex')}` },
    ) {
      const hook = [...hooks.values()].find((item) => item.projectId === project.id)
      if (!hook) throw new Error(`no hook on ${project.path}`)
      const raw = JSON.stringify({ object_kind: kind, project: { id: project.id }, ...body })
      const timestamp = String(Math.floor(Date.now() / 1000))
      const secret = forge
        ? randomBytes(32)
        : Buffer.from(String(hook.signingToken).replace(/^whsec_/, ''), 'base64')
      const signature = `v1,${createHmac('sha256', secret).update(`${deliveryId}.${timestamp}.${raw}`, 'utf8').digest('base64')}`
      const url = new URL(hook.url)
      const target = new URL(`${url.pathname}${url.search}`, origin)
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gitlab-event': `${kind} Hook`,
          'webhook-id': deliveryId,
          'webhook-timestamp': timestamp,
          'webhook-signature': signature,
        },
        body: raw,
        redirect: 'manual',
      })
      return { status: response.status, deliveryId }
    },
    /** A user of `host` reached by `token` (an own server) or signing in by OAuth (gitlab.com). */
    addUser(host, { username, token = null, signsIn = false, redirect = false }) {
      const user = { id: nextId(), username, signsIn }
      if (redirect && token) redirects.add(token)
      if (token) hosts[host].users.set(token, user)
      if (signsIn) hosts[host].users.set(`signs-in-${user.id}`, user)
      return user
    },
    /** A project with one commit of `files` on its main branch, and its members. */
    async addProject(
      host,
      {
        path,
        files,
        members,
        defaultBranch = 'main',
        logSecret,
        size = 4096,
        visibility = 'private',
      },
    ) {
      const work = await mkdtemp(join(root, 'work-'))
      for (const [name, content] of Object.entries(files)) {
        await mkdir(dirname(join(work, name)), { recursive: true })
        await writeFile(join(work, name), content)
      }
      await runGit(['init', '-q', '-b', defaultBranch], { cwd: work, home })
      await runGit(['add', '-A'], { cwd: work, home })
      await runGit(['commit', '-q', '-m', 'Первая версия'], { cwd: work, home })
      const bare = join(root, 'repos', host, `${path}.git`)
      await mkdir(dirname(bare), { recursive: true })
      await runGit(['clone', '-q', '--bare', work, bare], { cwd: root, home })
      await runGit(['config', 'http.receivepack', 'true'], { cwd: bare, home })
      // A commit fetched by its SHA (the revert of a merge reads the merge commit so, 84.26).
      await runGit(['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: bare, home })
      await rm(work, { recursive: true, force: true })
      const project = {
        id: nextId(),
        path,
        bare,
        projectRoot: join(root, 'repos', host),
        defaultBranch,
        visibility,
        size,
        /** ref → how long its pipelines run, ms (2 s by default). */
        slowRefs: new Map(),
        members: new Set(members.map((user) => user.id)),
        mergeRequests: [],
        pipelines: [],
        /** branch → when it was last pushed by git (the race of opening a request, above). */
        pushedAt: new Map(),
        logSecret,
      }
      hosts[host].projects.set(project.id, project)
      return project
    },
    heads: (project) => headsOf(project.bare, home),
    /** The text of `path` at `ref` of the bare repository, or null. */
    async show(project, ref, path) {
      const out = await runGit(['show', `${ref}:${path}`], {
        cwd: project.bare,
        home,
        allowFailure: true,
      })
      return out.code === 0 ? out.stdout : null
    },
    async parents(project, ref) {
      const out = await runGit(['rev-list', '--parents', '-n', '1', ref], {
        cwd: project.bare,
        home,
      })
      return out.stdout.trim().split(' ').slice(1)
    },
    /** A commit of the client on `branch` (a race with the agent's push). */
    async commitAsClient(
      project,
      branch,
      name,
      content,
      { newBranch = null, pipeline = true } = {},
    ) {
      const work = await mkdtemp(join(root, 'client-'))
      await runGit(['clone', '-q', '-b', branch, project.bare, work], { cwd: root, home })
      if (newBranch) await runGit(['checkout', '-q', '-b', newBranch], { cwd: work, home })
      await mkdir(dirname(join(work, name)), { recursive: true })
      await writeFile(join(work, name), content)
      await runGit(['add', '-A'], { cwd: work, home })
      await runGit(['commit', '-q', '-m', 'Правка клиента'], { cwd: work, home })
      // Straight into the bare repository, as the client's own push; GitLab makes its pipeline.
      await runGit(['push', '-q', 'origin', `HEAD:refs/heads/${newBranch ?? branch}`], {
        cwd: work,
        home,
      })
      const sha = (await runGit(['rev-parse', 'HEAD'], { cwd: work, home })).stdout.trim()
      await rm(work, { recursive: true, force: true })
      const ref = newBranch ?? branch
      if (pipeline)
        makePipeline(project, {
          ref,
          sha,
          source: 'push',
          deploy: ref === project.defaultBranch,
        })
      return sha
    },
    /** The client moves `branch` back to `sha` (a force push of its own), without a pipeline. */
    async resetBranch(project, branch, sha) {
      await runGit(['update-ref', `refs/heads/${branch}`, sha], { cwd: project.bare, home })
    },
    /** «Retry» of the client: a new pipeline on the current head of `ref`, no new commit. */
    async rerunPipeline(project, ref) {
      const sha = (await headsOf(project.bare, home))[ref]
      if (!sha) throw new Error(`no branch ${ref}`)
      makePipeline(project, { ref, sha, source: 'web', deploy: ref === project.defaultBranch })
      return sha
    },
    isSha: (value) => sha40.test(value),
    close: async () => {
      for (const server of servers) {
        server.closeAllConnections()
        await new Promise((done) => server.close(done))
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}
