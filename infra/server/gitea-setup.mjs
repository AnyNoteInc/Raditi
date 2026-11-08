#!/usr/bin/node
// Gitea of the single server (README.md, «Gitea»), as root on the host from /opt/raditi/app:
//   gitea-setup.mjs bootstrap   accounts, organisations, teams, tokens into Vault, the runner's
//                               registration token; repeatable: what exists is left as it is
//   gitea-setup.mjs ci <dir>    platform/ci from <dir>/.gitea/scoped_workflows (every deploy),
//                               registered as the required source of scoped workflows
// Run with NODE_EXTRA_CA_CERTS=/etc/raditi/ca/ca.pem (deploy.sh does): Gitea serves the internal CA.
// The recipe is the one of the stand verify:release (infra/dev/release-verify/services.mjs):
//   raditi-admin       site administrator; its password and token stay in kv/platform/app/gitea
//   raditi-bot         team sites/bots (write, every repository) → GITEA_TOKEN of core
//   raditi-provisioner team sites/creators (creates repositories) → GITEA_PROVISIONER_TOKEN
//   raditi-release     team sites/Owners → kv/platform/gitea-org-owner, read only by core
// No secret is printed or passed as an argument: Vault takes them from the root token's session.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const VAULT = 'http://127.0.0.1:8200'
const GITEA = 'https://git.raditi.internal:3443'
const APP = '/opt/raditi/app'

const fail = (message) => {
  console.error(`gitea-setup: ${message}`)
  process.exit(1)
}
const say = (message) => console.log(`gitea-setup: ${message}`)
const password = () => randomBytes(24).toString('base64url')

const rootToken = readFileSync('/etc/raditi/openbao/root-token', 'utf8').trim()
async function vault(method, path, body) {
  const response = await fetch(`${VAULT}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': rootToken, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 404) return null
  if (!response.ok) fail(`Vault ${method} ${path}: HTTP ${response.status}`)
  return response.status === 204 ? {} : response.json()
}
const readKv = async (path) =>
  (await vault('GET', `kv/data/${path}`))?.data ?? { data: {}, metadata: { version: 0 } }
async function mergeKv(path, values) {
  const { data, metadata } = await readKv(path)
  await vault('POST', `kv/data/${path}`, {
    options: { cas: metadata.version },
    data: { ...data, ...values },
  })
}

/** Gitea's REST API as a user: Basic with a password, or a token. */
async function api(method, path, { as, body, expect = [200, 201, 204] } = {}) {
  const auth = as.token
    ? `token ${as.token}`
    : `Basic ${Buffer.from(`${as.user}:${as.password}`).toString('base64')}`
  const response = await fetch(`${GITEA}/api/v1${path}`, {
    method,
    headers: {
      authorization: auth,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const json = text ? JSON.parse(text) : null
  if (!expect.includes(response.status)) fail(`${method} ${path}: HTTP ${response.status}`)
  return { status: response.status, json }
}

/** The admin's web session: scoped workflows have no REST API in Gitea 1.27.3. */
async function webSession(admin) {
  const login = await fetch(`${GITEA}/user/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_name: admin.user, password: admin.password }).toString(),
  })
  if (login.status !== 303) fail(`the administrator could not sign in (HTTP ${login.status})`)
  const cookie = login.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .filter((value) => value.startsWith('i_like_gitea='))
    .at(-1)
  if (!cookie) fail('no session cookie')
  return (path, form) =>
    fetch(`${GITEA}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
    })
}

async function admin() {
  const { data } = await readKv('platform/app/gitea')
  if (!data.admin_password) fail('no administrator yet: run bootstrap')
  return { user: 'raditi-admin', password: data.admin_password, token: data.admin_token }
}

async function bootstrap() {
  // 1. The administrator, by the CLI inside the container (the only way before any account)
  let { data } = await readKv('platform/app/gitea')
  if (!data.admin_password) {
    // --random-password: the password comes back in the output, never as an argument
    const output = execFileSync(
      'docker',
      [
        ...['compose', 'exec', '-T', 'gitea', 'gitea', 'admin', 'user', 'create', '--admin'],
        ...['--username', 'raditi-admin', '--email', 'admin@raditi.internal'],
        ...['--random-password', '--must-change-password=false'],
      ],
      { cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    )
    const secret = /generated random password is '([^']+)'/.exec(output)?.[1]
    if (!secret) fail('the administrator was not created')
    await mergeKv('platform/app/gitea', { admin_password: secret })
    say('administrator raditi-admin created')
    ;({ data } = await readKv('platform/app/gitea'))
  }
  const root = { user: 'raditi-admin', password: data.admin_password }
  if (!data.admin_token) {
    const token = await api('POST', '/users/raditi-admin/tokens', {
      as: root,
      body: {
        name: `setup-${Date.now()}`,
        scopes: ['write:admin', 'write:organization', 'write:repository', 'write:user'],
      },
    })
    await mergeKv('platform/app/gitea', { admin_token: token.json.sha1 })
    ;({ data } = await readKv('platform/app/gitea'))
  }
  const asAdmin = { token: data.admin_token }

  // 2. Organisations and teams
  for (const org of ['platform', 'sites']) {
    const found = await api('GET', `/orgs/${org}`, { as: asAdmin, expect: [200, 404] })
    if (found.status === 404) {
      await api('POST', '/orgs', { as: asAdmin, body: { username: org, visibility: 'private' } })
      say(`organisation ${org}`)
    }
  }
  const teams = (await api('GET', '/orgs/sites/teams', { as: asAdmin })).json
  const team = async (name, body) => {
    const existing = teams.find((each) => each.name === name)
    if (existing) return existing.id
    const created = await api('POST', '/orgs/sites/teams', { as: asAdmin, body: { name, ...body } })
    say(`team sites/${name}`)
    return created.json.id
  }
  const units = ['repo.code', 'repo.pulls', 'repo.actions']
  const bots = await team('bots', { permission: 'write', includes_all_repositories: true, units })
  const creators = await team('creators', {
    permission: 'write',
    includes_all_repositories: false,
    can_create_org_repo: true,
    units,
  })
  const owners = teams.find((each) => each.name === 'Owners')?.id ?? fail('no Owners team in sites')

  // 3. Accounts, each in its team, with a token it makes for itself → Vault
  const account = async (user, teamId, scopes, store) => {
    const exists = await api('GET', `/users/${user}`, { as: asAdmin, expect: [200, 404] })
    const secret = password()
    if (exists.status === 404) {
      await api('POST', '/admin/users', {
        as: asAdmin,
        body: {
          username: user,
          email: `${user}@raditi.internal`,
          password: secret,
          must_change_password: false,
          visibility: 'private',
        },
      })
      say(`account ${user}`)
    } else if (await store.has()) {
      return
    } else {
      // A token is made with the account's own password: set a new one
      await api('PATCH', `/admin/users/${user}`, {
        as: asAdmin,
        body: { login_name: user, source_id: 0, password: secret, must_change_password: false },
      })
    }
    await api('PUT', `/teams/${teamId}/members/${user}`, { as: asAdmin })
    const token = await api('POST', `/users/${user}/tokens`, {
      as: { user, password: secret },
      body: { name: `raditi-${Date.now()}`, scopes },
    })
    await store.put(token.json.sha1)
    say(`token of ${user} in Vault`)
  }
  const coreField = (field) => ({
    has: async () => Boolean((await readKv('platform/app/core')).data?.[field]),
    put: (token) => mergeKv('platform/app/core', { [field]: token }),
  })
  await account('raditi-bot', bots, ['write:user', 'write:repository'], coreField('GITEA_TOKEN'))
  await account(
    'raditi-provisioner',
    creators,
    ['write:organization', 'write:repository'],
    coreField('GITEA_PROVISIONER_TOKEN'),
  )
  await account('raditi-release', owners, ['write:repository'], {
    has: async () => Boolean((await readKv('platform/gitea-org-owner')).data?.token),
    // The shape packages/git-providers/src/gitea-org-owner.ts reads
    put: (token) => mergeKv('platform/gitea-org-owner', { v: '1', token }),
  })

  // 4. The runner's registration token
  if (!data.runner_registration_token) {
    const registration = await api('POST', '/admin/actions/runners/registration-token', {
      as: asAdmin,
    })
    await mergeKv('platform/app/gitea', { runner_registration_token: registration.json.token })
    say('runner registration token in Vault')
  }
}

async function ci(directory) {
  const as = await admin()
  const asAdmin = { token: as.token }
  const repo = await api('GET', '/repos/platform/ci', { as: asAdmin, expect: [200, 404] })
  if (repo.status === 404)
    await api('POST', '/orgs/platform/repos', {
      as: asAdmin,
      body: { name: 'ci', private: true, auto_init: true, default_branch: 'main' },
    })
  const source = join(directory, '.gitea/scoped_workflows')
  const files = readdirSync(source)
    .filter((name) => name.endsWith('.yml'))
    .sort()
  for (const name of files) {
    const path = `.gitea/scoped_workflows/${name}`
    const content = readFileSync(join(source, name))
    const current = await api('GET', `/repos/platform/ci/contents/${path}`, {
      as: asAdmin,
      expect: [200, 404],
    })
    if (current.status === 200 && Buffer.from(current.json.content, 'base64').equals(content))
      continue
    await api(current.status === 200 ? 'PUT' : 'POST', `/repos/platform/ci/contents/${path}`, {
      as: asAdmin,
      body: {
        content: content.toString('base64'),
        message: `ci: ${name} of the platform`,
        ...(current.status === 200 ? { sha: current.json.sha } : {}),
      },
    })
    say(`platform/ci ${path}`)
  }
  // The source of scoped workflows for the whole instance, each file required (spec §10): a
  // repository of a site cannot switch deploy.yml off. Adding it again answers 4xx, not an error.
  const web = await webSession(as)
  await web(
    '/-/admin/actions/scoped-workflows/add',
    new URLSearchParams({ repo_name: 'platform/ci' }),
  )
  const repositoryId = (await api('GET', '/repos/platform/ci', { as: asAdmin })).json.id
  const form = new URLSearchParams({ repo_id: String(repositoryId) })
  for (const file of files) {
    form.append('workflow_ids', file)
    form.append('required_workflow_ids', file)
    // deploy.yml posts no status on a pull request: both wait for the status of check.yml
    form.append(`required_patterns[${file}]`, 'platform/ci: check / *')
  }
  const required = await web('/-/admin/actions/scoped-workflows/required', form.toString())
  if (required.status !== 200) fail(`required scoped workflows: HTTP ${required.status}`)
  say(`platform/ci: ${files.join(', ')} required`)
}

const [command, argument] = process.argv.slice(2)
if (command === 'bootstrap') await bootstrap()
else if (command === 'ci' && argument) await ci(argument)
else fail('usage: bootstrap | ci <directory of ci/>')
