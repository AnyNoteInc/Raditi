// Trusted local connection of a WordPress site to the platform: a preparation step of the
// local stands, not product code. It turns a site in status `onboarding` — one a stand inserted,
// or one the wizard «Новый проект» created once its first version was imported — into one a turn
// can work on: the plugin is bound to the site, its access is in OpenBao behind a
// `credential_refs` row, the workspace has its Transit key, the site has a repository in the
// organization `sites`, and the site is `active`.
//
// Only outside production and only with loopback PostgreSQL, OpenBao, Gitea and WordPress. The
// environment is given explicitly: no env-file is discovered or loaded here. Tokens come from
// private files; neither they nor the application password are printed or passed as arguments.
// The connection wizard (M4), the packaged plugin and the choice between the plugin and
// SSH/FTP are not decided here: the command prepares what the content path needs.
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { siteAccessPath } from '../../../packages/domain/src/ports/site-adapter.ts'
import { workspaceTransitKey } from '../../../packages/domain/src/sessions/workspace-transit-key.ts'
import { getSiteContentAdapter } from '../../../packages/site-adapters/src/registry.ts'
import { localVaultAddress, localVaultRequest } from '../../vault/bootstrap.mjs'

/** The name of the application password this command owns in WordPress; earlier ones go. */
export const APPLICATION_PASSWORD_NAME = 'Raditi local connect'
const ADMIN_USER = 'raditi_admin'
const ORGANIZATION = 'sites'
const BINDING_OPTION = 'raditi_content_site_id'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** What a rebound installation must forget: its epoch fence and the receipts of old calls. */
const FENCE_OPTION = /^raditi_content_(?:epoch|call_[0-9a-f-]{36})$/
/** Names the content adapter accepts over plain http (packages/site-adapters). */
const LOOPBACK = ['127.0.0.1', '[::1]', 'localhost']
const REPOSITORY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** A refusal with a fixed code; the message names a setting or a step, never a value. */
export class ConnectError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ConnectError'
    this.code = code
  }
}
const refuse = (code, message) => new ConnectError(code, message)

function loopbackUrl(value, protocols) {
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!protocols.includes(url.protocol) || !LOOPBACK.includes(url.hostname)) return null
  if (url.username || url.password || url.search || url.hash) return null
  return url
}

function giteaAddress(value) {
  const url = loopbackUrl(value, ['https:'])
  if (!url || url.pathname !== '/')
    throw refuse(
      'SETTINGS',
      'GITEA_URL: нужен адрес https:// на loopback без пути и учётных данных',
    )
  return url
}

/**
 * The whole configuration of one run, from the arguments and the environment the caller gave.
 * Nothing has a default address: a forgotten variable never sends the command to another
 * service.
 */
export function connectSettings({ argv, env }) {
  const setting = (name, problem) => refuse('SETTINGS', `${name}: ${problem}`)
  const args = argv.filter((value) => value !== '--')
  if (args.length !== 2 || args[0] !== '--site' || !UUID.test(args[1]))
    throw setting('--site', 'нужен один аргумент --site <идентификатор сайта>')

  if (env.APP_ENV === 'production')
    throw refuse('PRODUCTION', 'APP_ENV: команда локального подключения не работает в production')
  if (!['development', 'test'].includes(env.APP_ENV))
    throw setting('APP_ENV', 'задайте явно development или test')

  // The credentials of the connection string are its own business; the host must be local.
  // The PostgreSQL client prefers a `host` named in the query to the one in the address, so a
  // string that names one there is refused as well.
  let databaseHost = null
  if (/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL ?? ''))
    try {
      const url = new URL(env.DATABASE_URL)
      if (!url.searchParams.has('host') && !url.searchParams.has('hostaddr'))
        databaseHost = url.hostname
    } catch {
      /* Refused below. */
    }
  if (!LOOPBACK.includes(databaseHost))
    throw setting('DATABASE_URL', 'нужна строка postgresql:// к базе на loopback')

  let vaultAddress
  try {
    vaultAddress = localVaultAddress(env.VAULT_ADDR)
  } catch {
    throw setting(
      'VAULT_ADDR',
      'нужен числовой loopback-адрес OpenBao, например http://127.0.0.1:8200',
    )
  }

  const file = (name, required = true) => {
    const value = env[name]
    if (value === undefined || value === '') {
      if (required) throw setting(name, 'нужен абсолютный путь к файлу')
      return undefined
    }
    if (!isAbsolute(value) || value.includes('\0'))
      throw setting(name, 'нужен абсолютный путь к файлу')
    return value
  }
  const sitesWriterTokenFile = file('CONNECT_SITES_WRITER_TOKEN_FILE')
  const provisionerTokenFile = file('CONNECT_WORKSPACE_PROVISIONER_TOKEN_FILE')
  const giteaTokenFile = file('CONNECT_GITEA_TOKEN_FILE')
  const giteaCaFile = file('GIT_CA_FILE', false)
  const giteaOrigin = giteaAddress(env.GITEA_URL).origin

  const composeProject = env.CONNECT_COMPOSE_PROJECT ?? 'raditi-dev'
  if (!/^raditi-[a-z0-9][a-z0-9-]{0,62}$/.test(composeProject))
    throw setting('CONNECT_COMPOSE_PROJECT', 'нужно имя проекта Compose вида raditi-…')
  const wpcliImage = env.SITE_WPCLI_IMAGE || undefined
  if (wpcliImage !== undefined && !/^[a-z0-9][a-z0-9._/:@-]{0,254}$/.test(wpcliImage))
    throw setting('SITE_WPCLI_IMAGE', 'нужно имя образа WP-CLI')

  return {
    siteId: args[1],
    appEnv: env.APP_ENV,
    databaseUrl: env.DATABASE_URL,
    vaultAddress,
    sitesWriterTokenFile,
    provisionerTokenFile,
    giteaOrigin,
    giteaCaFile,
    giteaTokenFile,
    composeProject,
    wpcliImage,
  }
}

/** `docker` arguments that run WP-CLI in the `wpcli` service of the profile `site`. */
export function composeWpArgs({ project, composeFile }) {
  return [
    'compose',
    // An explicit empty env-file: Compose discovers no other one.
    ...['--env-file', '/dev/null'],
    ...['-p', project, '-f', composeFile, '--profile', 'site'],
    // The site and its database are not started, recreated or pulled from here.
    ...['run', '--rm', '--no-deps', '-T', '--pull', 'never'],
    'wpcli',
  ]
}

/**
 * The WordPress side of the connection, over a `wp(args) → { code, stdout }` runner. Every
 * command is fixed here; a secret is read from the output and never sent as an argument.
 */
export function wordpressInstallation(wp) {
  const failed = (args) =>
    refuse('WORDPRESS', `WP-CLI: команда «${args.slice(0, 2).join(' ')}» не выполнена`)
  const run = async (args, allowed = [0]) => {
    let result
    try {
      result = await wp(args)
    } catch {
      throw failed(args)
    }
    if (!allowed.includes(result.code)) throw failed(args)
    return result
  }
  return {
    /** The database of the site answers: the profile is up and WordPress is configured. */
    async ready() {
      try {
        return (await wp(['db', 'check'])).code === 0
      } catch {
        return false
      }
    },
    async installed() {
      return (await run(['core', 'is-installed'], [0, 1])).code === 0
    },
    /** WP-CLI generates the administrator's password; its output is dropped here. */
    async install(origin) {
      await run([
        'core',
        'install',
        `--url=${origin}`,
        '--title=Raditi local site',
        `--admin_user=${ADMIN_USER}`,
        `--admin_email=${ADMIN_USER}@example.test`,
        '--skip-email',
      ])
    },
    /** The platform site this installation answers for, or null. */
    async binding() {
      const result = await run(['option', 'get', BINDING_OPTION], [0, 1])
      return (result.code === 0 && result.stdout.trim()) || null
    },
    async fenceOptions() {
      const listed = await run([
        'option',
        'list',
        '--search=raditi_content_*',
        '--field=option_name',
        '--format=json',
      ])
      let names
      try {
        names = JSON.parse(listed.stdout)
      } catch {
        throw failed(['option', 'list'])
      }
      if (!Array.isArray(names)) throw failed(['option', 'list'])
      return names.filter((name) => typeof name === 'string' && FENCE_OPTION.test(name))
    },
    async deleteOptions(names) {
      if (!names.every((name) => typeof name === 'string' && FENCE_OPTION.test(name)))
        throw refuse('WORDPRESS', 'WP-CLI: удаляются только опции ограждения плагина')
      for (let index = 0; index < names.length; index += 40)
        await run(['option', 'delete', ...names.slice(index, index + 40)])
    },
    async bind(siteId) {
      if (!UUID.test(siteId)) throw refuse('WORDPRESS', 'WP-CLI: неверный идентификатор сайта')
      await run(['option', 'update', BINDING_OPTION, siteId])
    },
    /** The first administrator: only an administrator may raise the epoch of the plugin. */
    async administrator() {
      const listed = await run([
        'user',
        'list',
        '--role=administrator',
        '--orderby=ID',
        '--order=ASC',
        '--number=1',
        '--field=user_login',
      ])
      const login = listed.stdout.trim().split('\n')[0] ?? ''
      if (!/^[^\s:]{1,60}$/.test(login))
        throw refuse('WORDPRESS', 'WP-CLI: администратор сайта не найден')
      return login
    },
    /** Earlier passwords of this command are removed: one access of the kind, one password. */
    async issueApplicationPassword(user) {
      const base = ['user', 'application-password']
      const earlier = (
        await run([...base, 'list', user, `--name=${APPLICATION_PASSWORD_NAME}`, '--field=uuid'])
      ).stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^[0-9a-f-]{1,64}$/.test(line))
      if (earlier.length > 0) await run([...base, 'delete', user, ...earlier])
      const created = await run([...base, 'create', user, APPLICATION_PASSWORD_NAME, '--porcelain'])
      const password = created.stdout.trim()
      if (!/^[A-Za-z0-9]{16,128}$/.test(password))
        throw refuse('WORDPRESS', 'WP-CLI: пароль приложения не получен')
      return password
    },
  }
}

/**
 * OpenBao on loopback with the two tokens of the connection step: `sites-writer` stores the
 * access with check-and-set and cannot read it back, `workspace-provisioner` creates the key.
 */
export function vaultPort({ address, sitesWriterToken, provisionerToken, fetchImpl }) {
  const origin = localVaultAddress(address)
  const call = async (token, path, options, statuses) => {
    let result
    try {
      result = await localVaultRequest({ address: origin, token, fetchImpl }, path, options)
    } catch {
      throw refuse('VAULT', 'OpenBao не ответил или ответил непонятно')
    }
    // Only the status: an error body of OpenBao may repeat what was sent.
    if (!statuses.includes(result.status))
      throw refuse('VAULT', `OpenBao отклонил запрос (HTTP ${result.status})`)
    return result
  }
  const access = (path) => {
    const [, rest] = /^kv\/(sites\/[0-9a-f-]{36}\/[a-z]{2,16})$/.exec(path) ?? []
    if (!rest) throw refuse('VAULT', 'OpenBao: путь не является доступом сайта')
    return rest
  }
  return {
    /** The current version of the secret and whether it still holds data; null when absent. */
    async accessVersion(path) {
      const { status, body } = await call(
        sitesWriterToken,
        `kv/metadata/${access(path)}`,
        {},
        [200, 404],
      )
      if (status === 404) return null
      const current = body?.data?.current_version
      if (!Number.isInteger(current) || current < 0)
        throw refuse('VAULT', 'OpenBao: непонятные метаданные доступа')
      const version = body.data.versions?.[String(current)]
      return {
        current,
        usable: current >= 1 && version?.destroyed === false && version?.deletion_time === '',
      }
    },
    async writeAccess(path, data, cas) {
      const { body } = await call(
        sitesWriterToken,
        `kv/data/${access(path)}`,
        { method: 'POST', body: { options: { cas }, data } },
        [200],
      )
      const version = body?.data?.version
      if (version !== cas + 1) throw refuse('VAULT', 'OpenBao: неожиданная версия доступа')
      return version
    },
    /** Creating a key that exists changes nothing on the server. */
    async ensureKey(name) {
      if (!/^ws-[0-9a-f-]{36}$/.test(name))
        throw refuse('VAULT', 'OpenBao: имя не является ключом рабочего пространства')
      await call(
        provisionerToken,
        `transit/keys/${name}`,
        { method: 'POST', body: { type: 'aes256-gcm96' } },
        [200, 204],
      )
    },
  }
}

/** One JSON exchange with Gitea over TLS; no redirect is followed, no body kept in an error. */
function httpsJson({ host, port, method, path, ca, headers, body }) {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((done, reject) => {
    const failure = () => reject(refuse('GITEA', 'Gitea не ответила по https'))
    const request = httpsRequest(
      { host, port, method, path, ca, headers, signal: AbortSignal.timeout(20_000) },
      (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > 1024 * 1024) request.destroy()
          else chunks.push(chunk)
        })
        response.on('error', failure)
        response.on('end', () => {
          let json = null
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            /* A body that is not JSON matters only to a caller that reads it. */
          }
          done({ status: response.statusCode, json })
        })
      },
    )
    request.once('error', failure)
    request.end(payload)
  })
}

/** Our Gitea on loopback, https only, as the bot or an operator token the caller provides. */
export function giteaPort({ origin, token, ca, requestImpl = httpsJson }) {
  const url = giteaAddress(origin)
  const call = (method, path, body) =>
    requestImpl({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || '443',
      method,
      path: `/api/v1${path}`,
      ca,
      headers: {
        accept: 'application/json',
        authorization: `token ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body,
    })
  const named = (...parts) => {
    if (!parts.every((part) => REPOSITORY_PART.test(part) && !part.includes('..')))
      throw refuse('GITEA', 'Gitea: неверное имя репозитория')
  }
  const refused = (status) => refuse('GITEA', `Gitea отклонила запрос (HTTP ${status})`)
  return {
    /** The repository with the head of its default branch; `head` is null when it is empty. */
    async repository(owner, name) {
      named(owner, name)
      const found = await call('GET', `/repos/${owner}/${name}`)
      if (found.status === 404) return null
      const defaultBranch = found.json?.default_branch
      if (
        found.status !== 200 ||
        typeof defaultBranch !== 'string' ||
        !REPOSITORY_PART.test(defaultBranch)
      )
        throw refused(found.status)
      if (found.json.empty === true) return { defaultBranch, head: null }
      const branch = await call('GET', `/repos/${owner}/${name}/branches/${defaultBranch}`)
      if (branch.status === 404) return { defaultBranch, head: null }
      const head = branch.json?.commit?.id
      if (branch.status !== 200 || typeof head !== 'string') throw refused(branch.status)
      return { defaultBranch, head }
    },
    /** A private repository with its first commit on `main`. */
    async createRepository(owner, name) {
      named(owner, name)
      const created = await call('POST', `/orgs/${owner}/repos`, {
        name,
        private: true,
        auto_init: true,
        default_branch: 'main',
      })
      if (created.status === 404)
        throw refuse('GITEA_ORGANIZATION', `Gitea: организации ${owner} нет — её создаёт оператор`)
      if (created.status !== 201) throw refused(created.status)
    },
  }
}

/** The origin of a site on this machine, in the form the role compares: `new URL(url).origin`. */
function localSiteOrigin(address) {
  const url = loopbackUrl(address, ['http:', 'https:'])
  if (!url || url.pathname !== '/')
    throw refuse(
      'SITE_NOT_LOCAL',
      'Адрес сайта не loopback: команда подключает только локальный сайт',
    )
  return url.origin
}

/**
 * The connection itself. Everything is read and checked first; then, in this order: WordPress
 * (install, fence), the access (Vault, then its reference), the binding of the plugin, the
 * workspace key, the repository, the activation. Each step is safe to repeat, and a run
 * stopped in the middle is finished by the next one: the binding is written only when the
 * access of this installation is stored, so a bound installation never hides an unfinished
 * access.
 */
export async function connectLocalSite(
  { db, installation, vault, gitea, adapters = getSiteContentAdapter },
  { siteId, appEnv, giteaOrigin },
) {
  if (appEnv === 'production')
    throw refuse('PRODUCTION', 'Команда локального подключения не работает в production')
  if (!['development', 'test'].includes(appEnv))
    throw refuse('SETTINGS', 'APP_ENV: задайте явно development или test')

  const site = await db.site(siteId)
  if (!site) throw refuse('SITE_NOT_FOUND', 'Сайт не найден: сначала создайте проект в кабинете')
  const origin = localSiteOrigin(site.url)
  // The steps below are WordPress steps (WP-CLI, the companion plugin): this file is a stand
  // tool of that stack. The platform side stays neutral — the access kind and the format of
  // the secret come from the adapter of the stack.
  if (site.stack !== 'wordpress')
    throw refuse('SITE_STACK', 'Команда подключает только локальный WordPress')
  const adapter = adapters(site.stack)
  if (site.dataClass !== 'synthetic')
    throw refuse('WORKSPACE_NOT_SYNTHETIC', 'Рабочее пространство сайта не synthetic')
  if (!['onboarding', 'active'].includes(site.status))
    throw refuse('SITE_STATUS', 'Сайт не в статусе onboarding или active')
  // A site of the wizard gets its repository and its first version from the import of core: this
  // command must not create another repository, nor make the site active, before that import ends.
  if (site.codeImport != null && site.codeImport !== 'succeeded')
    throw refuse(
      'SITE_SETUP',
      'Сайт ещё настраивается: дождитесь первоначальной версии в кабинете и запустите команду снова',
    )

  const accessPath = siteAccessPath(site.id, adapter.accessKind)
  const references = await db.accessRefs(site.id, adapter.accessKind)
  const reference = references[0]
  if (
    references.length > 1 ||
    (reference &&
      (reference.vaultPath !== accessPath || reference.workspaceId !== site.workspaceId))
  )
    throw refuse(
      'ACCESS_REFERENCE',
      'У сайта есть ссылки на доступ, которые роль mcp не примет: их разбирает оператор',
    )
  const repositories = await db.repositories(site.id)
  const known = repositories[0]
  if (
    repositories.length > 1 ||
    (known && (known.provider !== 'gitea' || known.owner !== ORGANIZATION))
  )
    throw refuse(
      'REPOSITORY_FOREIGN',
      'У сайта есть репозиторий не в организации sites нашей Gitea',
    )
  const repositoryName = known?.name ?? `site-${site.id}`

  if (!(await installation.ready()))
    throw refuse(
      'SITE_NOT_RUNNING',
      'WordPress профиля site не отвечает: поднимите профиль site (pnpm infra:up)',
    )
  const wasInstalled = await installation.installed()
  const bound = wasInstalled ? await installation.binding() : null
  const rebind = bound !== site.id
  if (bound && rebind && UUID.test(bound) && (await db.siteExists(bound)))
    throw refuse(
      'INSTALLATION_BOUND',
      'Этот WordPress привязан к другому сайту платформы: команда его не отнимает',
    )
  const stored = await vault.accessVersion(accessPath)
  let remote = await gitea.repository(ORGANIZATION, repositoryName)
  if (remote && !remote.head)
    throw refuse('REPOSITORY_EMPTY', 'Репозиторий сайта в Gitea пуст: в нём нет первого коммита')

  // Changes start here.
  if (!wasInstalled) await installation.install(origin)
  let fence = 'kept'
  if (rebind) {
    // The fence first, the binding last (below): a run stopped in between is rebound again.
    const stale = wasInstalled ? await installation.fenceOptions() : []
    if (stale.length > 0) {
      await installation.deleteOptions(stale)
      fence = 'reset'
    }
  }

  // The writer cannot read the secret back. An access is in place only when nothing is being
  // rebound and the reference names the current, undeleted version of the secret.
  let access = 'unchanged'
  let accessVersion = stored?.current
  if (
    !wasInstalled ||
    rebind ||
    !reference ||
    !stored?.usable ||
    reference.keyVersion !== stored.current
  ) {
    const username = await installation.administrator()
    const applicationPassword = await installation.issueApplicationPassword(username)
    const secret = adapter.accessSchema.safeParse({ v: '1', origin, username, applicationPassword })
    if (!secret.success) throw refuse('ACCESS_FORMAT', 'Доступ не проходит схему адаптера сайта')
    // Vault first, the reference second: until both agree the role uses neither.
    accessVersion = await vault.writeAccess(accessPath, secret.data, stored?.current ?? 0)
    await db.saveAccessRef({
      ...(reference ? { id: reference.id } : {}),
      siteId: site.id,
      workspaceId: site.workspaceId,
      kind: adapter.accessKind,
      vaultPath: accessPath,
      keyVersion: accessVersion,
    })
    access = 'written'
  }
  // Only now: until the access of this installation is stored, the installation stays unbound
  // (or bound to a site that is gone) and the next run writes the access again. Bound earlier,
  // a run stopped before Vault would leave a reference that agrees with a secret of the
  // previous installation, and the next run would take it for done.
  if (rebind) await installation.bind(site.id)

  await vault.ensureKey(workspaceTransitKey(site.workspaceId))

  let repository = 'present'
  if (!remote) {
    await gitea.createRepository(ORGANIZATION, repositoryName)
    repository = 'created'
    remote = await gitea.repository(ORGANIZATION, repositoryName)
    if (!remote?.head)
      throw refuse('REPOSITORY_EMPTY', 'Репозиторий сайта в Gitea создан без первого коммита')
  }
  if (!known)
    await db.saveRepository({
      siteId: site.id,
      provider: 'gitea',
      owner: ORGANIZATION,
      name: repositoryName,
      defaultBranch: remote.defaultBranch,
      url: `${giteaOrigin}/${ORGANIZATION}/${repositoryName}`,
    })

  const activation = await db.activate(site.id, [adapter.accessKind])
  if (activation.status === 'refused')
    throw refuse('ACTIVATION_REFUSED', `Сайт не переведён в active: ${activation.reason}`)

  return {
    siteId: site.id,
    wordpress: wasInstalled ? 'present' : 'installed',
    binding: rebind ? 'written' : 'unchanged',
    fence,
    access,
    accessVersion,
    workspaceKey: 'ensured',
    repository,
    activation: activation.status,
  }
}

/** A token from a private regular file of the caller; the final path component is not followed. */
export async function readPrivateFile(name, path) {
  const unreadable = () =>
    refuse('SETTINGS', `${name}: нужен собственный обычный файл с правами 0600 и одной строкой`)
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      process.getuid === undefined ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 1 ||
      stat.size > 8192
    )
      throw unreadable()
    const value = (await file.readFile('utf8')).replace(/\r?\n$/, '')
    if (!/^[\x21-\x7e]{1,8192}$/.test(value)) throw unreadable()
    return value
  } catch {
    throw unreadable()
  } finally {
    await file?.close().catch(() => undefined)
  }
}

/** PostgreSQL through the platform's own client and its neutral activation. */
async function databasePort(databaseUrl) {
  const { activateSite, createPrismaClient } = await import('../../../packages/db/src/index.ts')
  const prisma = createPrismaClient({ databaseUrl, log: [] })
  const reference = {
    id: true,
    siteId: true,
    workspaceId: true,
    kind: true,
    vaultPath: true,
    keyVersion: true,
  }
  return {
    close: () => prisma.$disconnect(),
    async site(id) {
      const row = await prisma.site.findUnique({
        where: { id },
        select: {
          id: true,
          workspaceId: true,
          url: true,
          stack: true,
          status: true,
          workspace: { select: { dataClass: true } },
          provisioningStages: { where: { stage: 'code_import' }, select: { status: true } },
        },
      })
      if (!row) return null
      const { workspace, provisioningStages, ...site } = row
      // null: a site made before the wizard, without the stage.
      const codeImport = provisioningStages[0]?.status ?? null
      return { ...site, dataClass: workspace.dataClass, codeImport }
    },
    siteExists: async (id) => (await prisma.site.count({ where: { id } })) > 0,
    accessRefs: (siteId, kind) =>
      prisma.credentialRef.findMany({ where: { siteId, kind }, select: reference, take: 3 }),
    saveAccessRef: ({ id, ...data }) =>
      id
        ? prisma.credentialRef.update({ where: { id }, data: { keyVersion: data.keyVersion } })
        : prisma.credentialRef.create({ data }),
    repositories: (siteId) =>
      prisma.gitRepository.findMany({
        where: { siteId },
        select: { siteId: true, provider: true, owner: true, name: true },
        take: 3,
      }),
    saveRepository: (data) => prisma.gitRepository.create({ data }),
    activate: (siteId, requiredAccess) => activateSite(prisma, { siteId, requiredAccess }),
  }
}

// A signal ends the command without leaving a WP-CLI container behind: the Docker CLI in
// flight gets SIGTERM (Compose stops and removes its one-off container), then the command
// exits. A run stopped between two steps is finished by the next one.
let wpInFlight
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  if (wpInFlight) wpInFlight.kill('SIGTERM')
  else process.exit(143)
}

/** WP-CLI in the compose service; stderr of WordPress is dropped, stdout stays in memory. */
function dockerWp({ composeProject, wpcliImage }, env) {
  const composeFile = fileURLToPath(new URL('../docker-compose.yml', import.meta.url))
  const base = composeWpArgs({ project: composeProject, composeFile })
  const dockerEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => ['PATH', 'HOME'].includes(name) || name.startsWith('DOCKER_'),
    ),
  )
  dockerEnv.COMPOSE_DISABLE_ENV_FILE = '1'
  if (wpcliImage) dockerEnv.SITE_WPCLI_IMAGE = wpcliImage
  return (args) =>
    new Promise((done, reject) => {
      const child = spawn('docker', [...base, ...args], {
        env: dockerEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      wpInFlight = child
      const output = []
      let size = 0
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
      child.stdout.on('data', (chunk) => {
        size += chunk.length
        if (size > 8 * 1024 * 1024) child.kill('SIGKILL')
        else output.push(chunk)
      })
      child.once('error', () => {
        clearTimeout(timer)
        wpInFlight = undefined
        reject(new Error('Docker could not start'))
      })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        wpInFlight = undefined
        if (stopping) process.exit(143)
        if (signal) reject(new Error('WP-CLI was stopped'))
        else done({ code, stdout: Buffer.concat(output).toString('utf8') })
      })
    })
}

const report = {
  wordpress: { installed: 'установлен', present: 'уже был установлен' },
  binding: { written: 'записана', unchanged: 'без изменений' },
  fence: { reset: 'сброшено (эпоха и квитанции прежней привязки)', kept: 'без изменений' },
  access: { written: 'записан', unchanged: 'без изменений' },
  repository: { created: 'создан', present: 'уже был' },
  activation: { activated: 'переведён в active', already_active: 'уже был active' },
}

async function main() {
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const settings = connectSettings({ argv: process.argv.slice(2), env: process.env })
  const [sitesWriterToken, provisionerToken, giteaToken] = await Promise.all([
    readPrivateFile('CONNECT_SITES_WRITER_TOKEN_FILE', settings.sitesWriterTokenFile),
    readPrivateFile('CONNECT_WORKSPACE_PROVISIONER_TOKEN_FILE', settings.provisionerTokenFile),
    readPrivateFile('CONNECT_GITEA_TOKEN_FILE', settings.giteaTokenFile),
  ])
  let ca
  if (settings.giteaCaFile)
    ca = await readFile(settings.giteaCaFile).catch(() => {
      throw refuse('SETTINGS', 'GIT_CA_FILE: файл CA не читается')
    })
  const db = await databasePort(settings.databaseUrl)
  try {
    const summary = await connectLocalSite(
      {
        db,
        installation: wordpressInstallation(dockerWp(settings, process.env)),
        vault: vaultPort({ address: settings.vaultAddress, sitesWriterToken, provisionerToken }),
        gitea: giteaPort({ origin: settings.giteaOrigin, token: giteaToken, ca }),
      },
      settings,
    )
    console.log(
      [
        `Сайт ${summary.siteId} подключён локально.`,
        `  WordPress: ${report.wordpress[summary.wordpress]}`,
        `  Привязка плагина к сайту: ${report.binding[summary.binding]}`,
        `  Ограждение плагина: ${report.fence[summary.fence]}`,
        `  Доступ в OpenBao: ${report.access[summary.access]}, версия ${summary.accessVersion}`,
        '  Ключ рабочего пространства: есть',
        `  Репозиторий в Gitea: ${report.repository[summary.repository]}`,
        `  Статус сайта: ${report.activation[summary.activation]}`,
      ].join('\n'),
    )
  } finally {
    await db.close().catch(() => undefined)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    // A refusal of this command says what to fix; anything else is named by its type only,
    // because a driver or HTTP error may quote an address or a value.
    console.error(
      error instanceof ConnectError
        ? `Подключение не выполнено: ${error.message} [${error.code}]`
        : `Подключение не выполнено: внутренняя ошибка (${error?.name ?? 'Error'}${error?.code ? ` ${error.code}` : ''})`,
    )
    process.exitCode = 1
  })
}
