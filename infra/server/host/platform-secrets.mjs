#!/usr/bin/node
// The platform's own secrets on the single server (infra/server/README.md). They live in Vault
// (kv/platform/shared and kv/platform/app/<service>, rule 2); this tool is what vault-agent is in
// the multi-VM design (infra/app/README.md, «Секреты»). Run as root on the host, Node 26:
//   platform-secrets.mjs seed               creates every missing generated value; never rewrites
//   platform-secrets.mjs set <path> <field> the value from stdin (keys the owner gives: SmartCaptcha,
//                                           Sendsay, the leads bot, the GitLab and GitHub apps),
//                                           never an argument; `< file` for the GitHub App's key
//   platform-secrets.mjs render [service…]  /run/raditi/<service>/ for the containers (raditi-secrets.service:
//                                           all of them at boot); a running service keeps working only
//                                           if it is not named: its SecretID is replaced — recreate it
// seed and set use the root token (/etc/raditi/openbao/root-token); render logs in as the AppRole
// renderer (/etc/raditi/openbao/renderer.json) and issues each service a fresh SecretID, destroying
// its earlier ones. No value is ever printed.
import { createHash, createPrivateKey, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chownSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const ADDR = 'http://127.0.0.1:8200'
const SECRETS_DIR = '/run/raditi'
const CA_FILE = '/etc/raditi/ca/ca.pem'
const TLS_DIR = '/etc/raditi/tls'

const hex = (bytes) => () => randomBytes(bytes).toString('hex')
const b64url = (bytes) => () => randomBytes(bytes).toString('base64url')
const s3Key = () => `RD${randomBytes(9).toString('hex').toUpperCase()}`

/** Generated values: path → field → generator. `seed` only adds what is missing. */
export const GENERATED = {
  shared: {
    pg_password: hex(24),
    pg_superuser_password: hex(24),
    redis_password: hex(24),
    // REPO_CONFIRM_SECRET of web and core (docs/plan/84-projects.md, ПР13, ПР15): the HMAC of the
    // cards of a repository; core checks a token again before it calls the provider
    repo_confirm_secret: b64url(48),
  },
  'app/web': {
    BETTER_AUTH_SECRET: b64url(48),
    METRICS_TOKEN: hex(32),
    // The tokens of the domain of pages (docs/plan/67-agent-documents.md, Д3): a new value voids
    // every address of a page given out
    PAGES_SIGNING_SECRET: b64url(48),
    S3_ACCESS_KEY_ID: s3Key,
    S3_SECRET_ACCESS_KEY: b64url(30),
  },
  // METRICS_TOKEN of core is shared with llm (its control endpoint) and differs from web's
  'app/core': {
    METRICS_TOKEN: hex(32),
    S3_ACCESS_KEY_ID: s3Key,
    S3_SECRET_ACCESS_KEY: b64url(30),
    BROWSER_WORKER_TOKEN: hex(32),
    // The bot of the chat (docs/plan/80-telegram.md): core posts its updates to web with it
    TELEGRAM_WEBHOOK_SECRET: b64url(32),
    // The runs of scheduled tasks (docs/plan/82-scheduled-tasks.md, Зп19): core posts each to web
    // with it; web and core both get it
    SCHEDULE_INTAKE_SECRET: b64url(32),
  },
  'app/browser': {
    METRICS_TOKEN: hex(32),
    S3_ACCESS_KEY_ID: s3Key,
    S3_SECRET_ACCESS_KEY: b64url(30),
  },
  // PAGES_COOKIE_SECRET: the cookie of a page's password (docs/plan/69-pages.md, Ст13), its own
  'app/preview': { PAGES_COOKIE_SECRET: b64url(48) },
  'app/traefik': { dashboard_user: () => 'admin', dashboard_password: b64url(18) },
}

/** Fields `set` accepts: what the owner hands over. */
export const PROVIDED = {
  // The OAuth app of Raditi on gitlab.com (docs/plan/84-projects.md, ПР10, §4.2): both or neither;
  // web signs in with it, core renews the tokens. Empty — «Подключить GitLab.com» says «Скоро»
  'gitlab-oauth': ['client_id', 'client_secret'],
  // The GitHub App of Raditi (Э10): web — slug, client and webhook secret; core — the app id and
  // the private key, which it gets as a file (/run/raditi/core/github-app.pem), never in app.env
  'github-app': ['app_id', 'slug', 'client_id', 'client_secret', 'webhook_secret', 'private_key'],
  // reg.ru API (an alternative password, the server's IP allowed): DNS-01 of *.pages.raditi.ru
  'app/traefik': ['regru_username', 'regru_password'],
  // YANDEX_CLIENT_*: the Yandex ID app of sign-in (oauth.yandex.ru), both or neither
  'app/web': [
    'SMARTCAPTCHA_CLIENT_KEY',
    'SMARTCAPTCHA_SERVER_KEY',
    'YANDEX_SPEECHKIT_API_KEY',
    'YANDEX_CLIENT_ID',
    'YANDEX_CLIENT_SECRET',
  ],
  'app/core': [
    'SENDSAY_API_KEY',
    'LEADS_TELEGRAM_BOT_TOKEN',
    // The bot of the chat @raditi_bot (docs/plan/80-telegram.md): web and core both get it
    'TELEGRAM_BOT_TOKEN',
    'WEB_PUSH_PRIVATE_KEY',
  ],
}

/** Fields of several lines, `set` from a file: a PEM private key. */
export const MULTILINE = { 'github-app': ['private_key'] }

/** Groups that work only whole: path → fields. A group with a field missing is not rendered. */
export const WHOLE = {
  'gitlab-oauth': PROVIDED['gitlab-oauth'],
  'github-app': PROVIDED['github-app'],
}

const fail = (message) => {
  console.error(`platform-secrets: ${message}`)
  process.exit(1)
}

async function vault(token, method, path, body) {
  const response = await fetch(`${ADDR}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 404) return null
  if (!response.ok) fail(`${method} ${path}: HTTP ${response.status}`)
  return response.status === 204 ? {} : response.json()
}

const readKv = async (token, path) =>
  (await vault(token, 'GET', `kv/data/platform/${path}`))?.data ?? {
    data: {},
    metadata: { version: 0 },
  }

async function writeKv(token, path, data, version) {
  await vault(token, 'POST', `kv/data/platform/${path}`, { options: { cas: version }, data })
}

const rootToken = () => readFileSync('/etc/raditi/openbao/root-token', 'utf8').trim()

async function seed() {
  const token = rootToken()
  for (const [path, fields] of Object.entries(GENERATED)) {
    const { data, metadata } = await readKv(token, path)
    const missing = Object.keys(fields).filter((field) => !data?.[field])
    if (missing.length === 0) continue
    const next = { ...data }
    for (const field of missing) next[field] = fields[field]()
    await writeKv(token, path, next, metadata.version)
    console.log(`platform-secrets: ${path} + ${missing.join(', ')}`)
  }
}

/**
 * The value `set` stores, or why it is refused (never the value itself). One line for a key of
 * app.env; a PEM private key of RSA, which the renderer writes as a file, of several lines.
 */
export function storedValue(path, field, input) {
  if (!PROVIDED[path]?.includes(field))
    return { problem: `${path} ${field} is not a field the owner sets` }
  if (MULTILINE[path]?.includes(field)) {
    const pem = input.replaceAll('\r\n', '\n').trim()
    if (
      !/^-----BEGIN (RSA )?PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END (RSA )?PRIVATE KEY-----$/.test(
        pem,
      )
    )
      return { problem: `${field}: expected a PEM private key` }
    try {
      if (createPrivateKey(pem).asymmetricKeyType !== 'rsa')
        return { problem: `${field}: expected an RSA key (GitHub signs app tokens with RS256)` }
    } catch {
      return { problem: `${field}: the key does not parse` }
    }
    return { value: `${pem}\n` }
  }
  const value = input.trim()
  if (!value || /["\\\n\r]/.test(value))
    return { problem: `${field}: empty or holds a quote, backslash or newline` }
  return { value }
}

async function set(path, field) {
  const stored = storedValue(path, field, readFileSync(0, 'utf8'))
  if (stored.problem) fail(stored.problem)
  const { value } = stored
  const token = rootToken()
  const { data, metadata } = await readKv(token, path)
  await writeKv(token, path, { ...data, [field]: value }, metadata.version)
  console.log(`platform-secrets: ${path} ${field} stored`)
}

// ---- render -----------------------------------------------------------------------------------

/** Where core finds the GitHub App's key: /run/raditi/core is mounted at /run/raditi. */
export const GITHUB_APP_KEY_FILE = '/run/raditi/github-app.pem'

/** A group of WHOLE as it is when every field is set, else null (the feature stays off). */
export function wholeGroup(path, data) {
  const fields = WHOLE[path]
  return fields.every((field) => data?.[field]) ? data : null
}

/** The fields of a group set in part, for the warning of render (names, never values). */
export function partialGroups(kv) {
  return Object.keys(WHOLE)
    .filter((path) => {
      const set = WHOLE[path].filter((field) => kv[path]?.[field])
      return set.length > 0 && set.length < WHOLE[path].length
    })
    .map((path) => `${path} (${WHOLE[path].filter((field) => !kv[path]?.[field]).join(', ')})`)
}

/** One file of a service directory: name → contents. */
export function serviceFiles(kv, roles, { readFile = readFileSync, bcrypt = htpasswd } = {}) {
  const { shared, web, core, browser, preview, traefik } = kv
  // The apps of the repositories of projects (docs/plan/84-projects.md, §4.2, §4.5)
  const gitlab = wholeGroup('gitlab-oauth', kv['gitlab-oauth'])
  const github = wholeGroup('github-app', kv['github-app'])
  const gitlabEnv = gitlab
    ? { GITLAB_OAUTH_CLIENT_ID: gitlab.client_id, GITLAB_OAUTH_CLIENT_SECRET: gitlab.client_secret }
    : {}
  const db = `postgresql://raditi:${shared.pg_password}@postgres:5432/raditi`
  // browser runs in the host network: the database on the private address (docker-compose.server.yml)
  const hostDb = `postgresql://raditi:${shared.pg_password}@10.10.0.10:5432/raditi`
  const redis = `redis://:${shared.redis_password}@redis:6379`
  const ca = readFile(CA_FILE, 'utf8')
  const env = (values) =>
    Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([name, value]) => {
        if (/["\\\n\r]/.test(value)) fail(`${name}: a quote, backslash or newline`)
        return `${name}="${value}"\n`
      })
      .join('')
  const approle = (name) =>
    roles[name] ? { VAULT_ROLE_ID: roles[name].roleId, VAULT_SECRET_ID: roles[name].secretId } : {}
  const s3 = (keys) => ({
    S3_ACCESS_KEY_ID: keys.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: keys.S3_SECRET_ACCESS_KEY,
  })
  const redisHash = createHash('sha256').update(shared.redis_password).digest('hex')
  return {
    postgres: {
      uid: 70,
      files: { 'superuser-password': shared.pg_superuser_password, password: shared.pg_password },
    },
    redis: {
      uid: 10003,
      files: {
        'users.acl': `user default on #${redisHash} ~* &* +@all -@admin -flushall -flushdb -keys -swapdb\n`,
        password: shared.redis_password,
      },
    },
    migrate: { uid: 10004, files: { 'app.env': env({ DATABASE_URL: db }) } },
    web: {
      uid: 10001,
      files: {
        'app.env': env({
          DATABASE_URL: db,
          REDIS_URL: redis,
          BETTER_AUTH_SECRET: web.BETTER_AUTH_SECRET,
          SMARTCAPTCHA_CLIENT_KEY: web.SMARTCAPTCHA_CLIENT_KEY,
          SMARTCAPTCHA_SERVER_KEY: web.SMARTCAPTCHA_SERVER_KEY,
          YANDEX_SPEECHKIT_API_KEY: web.YANDEX_SPEECHKIT_API_KEY,
          YANDEX_CLIENT_ID: web.YANDEX_CLIENT_ID,
          YANDEX_CLIENT_SECRET: web.YANDEX_CLIENT_SECRET,
          METRICS_TOKEN: web.METRICS_TOKEN,
          PAGES_SIGNING_SECRET: web.PAGES_SIGNING_SECRET,
          REPO_CONFIRM_SECRET: shared.repo_confirm_secret,
          ...gitlabEnv,
          ...(github
            ? {
                GITHUB_APP_SLUG: github.slug,
                GITHUB_APP_CLIENT_ID: github.client_id,
                GITHUB_APP_CLIENT_SECRET: github.client_secret,
                GITHUB_APP_WEBHOOK_SECRET: github.webhook_secret,
              }
            : {}),
          // web takes the updates core hands it and the files of messages (docs/plan/80-telegram.md)
          TELEGRAM_BOT_TOKEN: core.TELEGRAM_BOT_TOKEN,
          TELEGRAM_WEBHOOK_SECRET: core.TELEGRAM_BOT_TOKEN
            ? core.TELEGRAM_WEBHOOK_SECRET
            : undefined,
          // web takes the runs of scheduled tasks core hands it (docs/plan/82-scheduled-tasks.md)
          SCHEDULE_INTAKE_SECRET: core.SCHEDULE_INTAKE_SECRET,
          ...s3(web),
          ...approle('web'),
        }),
        'vault-ca.pem': ca,
      },
    },
    core: {
      uid: 10002,
      files: {
        'app.env': env({
          DATABASE_URL: db,
          REDIS_URL: redis,
          METRICS_TOKEN: core.METRICS_TOKEN,
          SENDSAY_API_KEY: core.SENDSAY_API_KEY,
          LEADS_TELEGRAM_BOT_TOKEN: core.LEADS_TELEGRAM_BOT_TOKEN,
          TELEGRAM_BOT_TOKEN: core.TELEGRAM_BOT_TOKEN,
          TELEGRAM_WEBHOOK_SECRET: core.TELEGRAM_BOT_TOKEN
            ? core.TELEGRAM_WEBHOOK_SECRET
            : undefined,
          WEB_PUSH_PRIVATE_KEY: core.WEB_PUSH_PRIVATE_KEY,
          SCHEDULE_INTAKE_SECRET: core.SCHEDULE_INTAKE_SECRET,
          BROWSER_WORKER_TOKEN: core.BROWSER_WORKER_TOKEN,
          REPO_CONFIRM_SECRET: shared.repo_confirm_secret,
          ...gitlabEnv,
          ...(github
            ? { GITHUB_APP_ID: github.app_id, GITHUB_APP_PRIVATE_KEY_FILE: GITHUB_APP_KEY_FILE }
            : {}),
          ...s3(core),
          ...approle('core'),
        }),
        'vault-ca.pem': ca,
        // A key of several lines: a file of its own, as app.env takes one line per value
        ...(github ? { 'github-app.pem': github.private_key } : {}),
      },
    },
    llm: {
      uid: 10008,
      files: {
        'app.env': env({ DATABASE_URL: db, METRICS_TOKEN: core.METRICS_TOKEN, ...approle('llm') }),
        'vault-ca.pem': ca,
      },
    },
    mcp: {
      uid: 10005,
      files: {
        // mcp runs in the host network (the sandbox gateway reaches it there): the private address
        'app.env': env({
          DATABASE_URL: hostDb,
          BROWSER_WORKER_TOKEN: core.BROWSER_WORKER_TOKEN,
          ...approle('mcp'),
        }),
        'vault-ca.pem': ca,
      },
    },
    browser: {
      uid: 10006,
      files: {
        'app.env': env({
          DATABASE_URL: hostDb,
          METRICS_TOKEN: browser.METRICS_TOKEN,
          BROWSER_WORKER_TOKEN: core.BROWSER_WORKER_TOKEN,
          ...s3(browser),
        }),
        'vault-ca.pem': ca,
      },
    },
    preview: {
      uid: 10009,
      files: {
        'app.env': env({
          DATABASE_URL: db,
          PAGES_COOKIE_SECRET: preview.PAGES_COOKIE_SECRET,
          BROWSER_WORKER_TOKEN: core.BROWSER_WORKER_TOKEN,
        }),
      },
    },
    traefik: {
      uid: 65532,
      files: {
        'dashboard-users': bcrypt(traefik.dashboard_user, traefik.dashboard_password),
        ...(traefik.regru_username
          ? { 'regru-username': traefik.regru_username, 'regru-password': traefik.regru_password }
          : {}),
      },
    },
    // SeaweedFS: one identity per service that holds S3 keys; the TLS pair of s3.raditi.internal
    s3: {
      uid: 10007,
      files: {
        's3.json': JSON.stringify({
          // No Admin: the buckets come from `weed shell` (s3-buckets). browser has only the inbox:
          // it reads the task's files and writes the screenshots of `web_screenshot` there.
          identities: [
            ['web', web, ['Read', 'Write', 'List', 'Tagging']],
            ['core', core, ['Read', 'Write', 'List', 'Tagging']],
            ['browser', browser, ['Read:raditi-inbox', 'Write:raditi-inbox', 'List:raditi-inbox']],
          ].map(([name, keys, actions]) => ({
            name,
            credentials: [
              { accessKey: keys.S3_ACCESS_KEY_ID, secretKey: keys.S3_SECRET_ACCESS_KEY },
            ],
            actions,
          })),
        }),
        's3.pem': readFile(`${TLS_DIR}/s3.pem`, 'utf8'),
        's3.key': readFile(`${TLS_DIR}/s3.key`, 'utf8'),
      },
    },
  }
}

function htpasswd(user, password) {
  // bcrypt from stdin: the password never becomes an argument
  const result = spawnSync('htpasswd', ['-niB', user], { input: `${password}\n`, encoding: 'utf8' })
  if (result.status !== 0) fail('htpasswd failed')
  return result.stdout.trim() + '\n'
}

async function render(only) {
  const login = JSON.parse(readFileSync('/etc/raditi/openbao/renderer.json', 'utf8'))
  const auth = await fetch(`${ADDR}/v1/auth/approle/login`, {
    method: 'POST',
    body: JSON.stringify({ role_id: login.role_id, secret_id: login.secret_id }),
  })
  if (!auth.ok) fail(`renderer login: HTTP ${auth.status}`)
  const token = (await auth.json()).auth.client_token

  const kv = {}
  for (const name of ['shared', 'web', 'core', 'browser', 'preview', 'traefik'])
    kv[name] = (await readKv(token, name === 'shared' ? 'shared' : `app/${name}`)).data ?? {}
  for (const path of Object.keys(WHOLE)) kv[path] = (await readKv(token, path)).data ?? {}
  if (!kv.shared.pg_password) fail('kv/platform/shared is empty: run seed first')
  for (const group of partialGroups(kv))
    console.error(`platform-secrets: ${group} not set: the group is not rendered`)

  const all = [
    'postgres',
    'redis',
    'migrate',
    'web',
    'core',
    'llm',
    'mcp',
    'browser',
    'preview',
    'traefik',
    's3',
  ]
  const named = only.length === 0 ? all : only
  for (const name of named) if (!all.includes(name)) fail(`${name} is not a service`)
  const roles = {}
  for (const name of ['web', 'core', 'llm', 'mcp']) {
    if (!named.includes(name)) {
      roles[name] = null
      continue
    }
    const roleId = (await vault(token, 'GET', `auth/approle/role/${name}/role-id`)).data.role_id
    const earlier =
      (
        await vault(token, 'LIST', `auth/approle/role/${name}/secret-id-accessor/list`).catch(
          () => null,
        )
      )?.data?.keys ?? []
    const secretId = (await vault(token, 'POST', `auth/approle/role/${name}/secret-id`, {})).data
      .secret_id
    for (const accessor of earlier)
      await vault(token, 'POST', `auth/approle/role/${name}/secret-id-accessor/destroy`, {
        secret_id_accessor: accessor,
      })
    roles[name] = { roleId, secretId }
  }

  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o755 })
  for (const [service, { uid, files }] of Object.entries(serviceFiles(kv, roles))) {
    if (!named.includes(service)) continue
    // Each directory is written beside and swapped in whole: a container never sees half of it
    const dir = `${SECRETS_DIR}/${service}`
    const next = `${dir}.next`
    rmSync(next, { recursive: true, force: true })
    mkdirSync(next, { mode: 0o700 })
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(`${next}/${name}`, contents, { mode: 0o400 })
      chownSync(`${next}/${name}`, uid, uid)
    }
    chownSync(next, uid, uid)
    rmSync(dir, { recursive: true, force: true })
    renameSync(next, dir)
  }
  console.log(`platform-secrets: rendered ${SECRETS_DIR}`)
}

// Run as a command; a test imports the functions above without touching the host
if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'seed') await seed()
  else if (command === 'set' && args.length === 2) await set(args[0], args[1])
  else if (command === 'render') await render(args)
  else fail('usage: seed | set <path> <field> | render')
}
