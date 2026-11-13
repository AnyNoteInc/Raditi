#!/usr/bin/node
// The platform's own secrets on the single server (infra/server/README.md). They live in Vault
// (kv/platform/shared and kv/platform/app/<service>, rule 2); this tool is what vault-agent is in
// the multi-VM design (infra/app/README.md, «Секреты»). Run as root on the host, Node 26:
//   platform-secrets.mjs seed               creates every missing generated value; never rewrites
//   platform-secrets.mjs set <path> <field> the value from stdin (keys the owner gives: SmartCaptcha,
//                                           Sendsay, the leads bot, Gitea), never an argument
//   platform-secrets.mjs render [service…]  /run/raditi/<service>/ for the containers (raditi-secrets.service:
//                                           all of them at boot); a running service keeps working only
//                                           if it is not named: its SecretID is replaced — recreate it
// seed and set use the root token (/etc/raditi/openbao/root-token); render logs in as the AppRole
// renderer (/etc/raditi/openbao/renderer.json) and issues each service a fresh SecretID, destroying
// its earlier ones. No value is ever printed.
import { createHash, randomBytes } from 'node:crypto'
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
const GENERATED = {
  shared: { pg_password: hex(24), pg_superuser_password: hex(24), redis_password: hex(24) },
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
  },
  'app/browser': {
    METRICS_TOKEN: hex(32),
    S3_ACCESS_KEY_ID: s3Key,
    S3_SECRET_ACCESS_KEY: b64url(30),
  },
  'app/preview': { PREVIEW_SESSION_SECRET: b64url(48) },
  // mcp writes the content snapshots of previews into raditi-artifacts, its only bucket (spec §14)
  'app/mcp': { S3_ACCESS_KEY_ID: s3Key, S3_SECRET_ACCESS_KEY: b64url(30) },
  'app/traefik': { dashboard_user: () => 'admin', dashboard_password: b64url(18) },
}

/** Fields `set` accepts: what the owner hands over. */
const PROVIDED = {
  // reg.ru API (an alternative password, the server's IP allowed): DNS-01 of *.raditi-preview.ru
  'app/traefik': ['regru_username', 'regru_password'],
  'app/web': ['SMARTCAPTCHA_CLIENT_KEY', 'SMARTCAPTCHA_SERVER_KEY'],
  'app/core': [
    'SENDSAY_API_KEY',
    'LEADS_TELEGRAM_BOT_TOKEN',
    'GITEA_TOKEN',
    'GITEA_PROVISIONER_TOKEN',
  ],
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

async function set(path, field) {
  if (!PROVIDED[path]?.includes(field)) fail(`${path} ${field} is not a field the owner sets`)
  const value = readFileSync(0, 'utf8').trim()
  if (!value || /["\\\n\r]/.test(value))
    fail(`${field}: empty or holds a quote, backslash or newline`)
  const token = rootToken()
  const { data, metadata } = await readKv(token, path)
  await writeKv(token, path, { ...data, [field]: value }, metadata.version)
  console.log(`platform-secrets: ${path} ${field} stored`)
}

// ---- render -----------------------------------------------------------------------------------

/** One file of a service directory: name → contents. */
function serviceFiles(kv, roles) {
  const { shared, web, core, browser, preview, traefik, gitea, mcp } = kv
  const db = `postgresql://raditi:${shared.pg_password}@postgres:5432/raditi`
  // browser runs in the host network: the database on the private address (docker-compose.server.yml)
  const hostDb = `postgresql://raditi:${shared.pg_password}@10.10.0.10:5432/raditi`
  const redis = `redis://:${shared.redis_password}@redis:6379`
  const ca = readFileSync(CA_FILE, 'utf8')
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
          METRICS_TOKEN: web.METRICS_TOKEN,
          PAGES_SIGNING_SECRET: web.PAGES_SIGNING_SECRET,
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
          GITEA_TOKEN: core.GITEA_TOKEN,
          GITEA_PROVISIONER_TOKEN: core.GITEA_PROVISIONER_TOKEN,
          BROWSER_WORKER_TOKEN: core.BROWSER_WORKER_TOKEN,
          ...s3(core),
          ...approle('core'),
        }),
        'vault-ca.pem': ca,
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
        // mcp runs in the host network (the agent's browser on a preview): the private address
        'app.env': env({
          DATABASE_URL: hostDb,
          BROWSER_WORKER_TOKEN: core.BROWSER_WORKER_TOKEN,
          ...s3(mcp),
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
          PREVIEW_SESSION_SECRET: preview.PREVIEW_SESSION_SECRET,
          BROWSER_WORKER_TOKEN: core.BROWSER_WORKER_TOKEN,
        }),
      },
    },
    traefik: {
      uid: 65532,
      files: {
        'dashboard-users': htpasswd(traefik.dashboard_user, traefik.dashboard_password),
        ...(traefik.regru_username
          ? { 'regru-username': traefik.regru_username, 'regru-password': traefik.regru_password }
          : {}),
      },
    },
    // Gitea: the TLS pair of git.raditi.internal; its runner: the registration token gitea-setup.mjs
    // stored (empty until then) and the public CA
    gitea: {
      uid: 1000,
      files: {
        'git.pem': readFileSync(`${TLS_DIR}/git.pem`, 'utf8'),
        'git.key': readFileSync(`${TLS_DIR}/git.key`, 'utf8'),
      },
    },
    'gitea-runner': {
      uid: 0,
      files: { 'registration-token': gitea.runner_registration_token ?? '', 'ca.pem': ca },
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
            [
              'mcp',
              mcp,
              ['Read:raditi-artifacts', 'Write:raditi-artifacts', 'List:raditi-artifacts'],
            ],
          ].map(([name, keys, actions]) => ({
            name,
            credentials: [
              { accessKey: keys.S3_ACCESS_KEY_ID, secretKey: keys.S3_SECRET_ACCESS_KEY },
            ],
            actions,
          })),
        }),
        's3.pem': readFileSync(`${TLS_DIR}/s3.pem`, 'utf8'),
        's3.key': readFileSync(`${TLS_DIR}/s3.key`, 'utf8'),
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
  for (const name of ['shared', 'web', 'core', 'browser', 'preview', 'traefik', 'gitea', 'mcp'])
    kv[name] = (await readKv(token, name === 'shared' ? 'shared' : `app/${name}`)).data ?? {}
  if (!kv.shared.pg_password) fail('kv/platform/shared is empty: run seed first')

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
    'gitea',
    'gitea-runner',
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

const [command, ...args] = process.argv.slice(2)
if (command === 'seed') await seed()
else if (command === 'set' && args.length === 2) await set(args[0], args[1])
else if (command === 'render') await render(args)
else fail('usage: seed | set <path> <field> | render')
