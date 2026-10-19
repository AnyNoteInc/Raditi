// What stands between the started services and the first scenario: the synthetic production
// site with its theme, pages and plugin; its repository in Gitea with the whole tree (the core
// and a little media, as the import of plan 39 leaves it) and the tag v0.0.0; the owner of the
// site as web signs them up; the site connected as the trusted connection step would leave it;
// a tariff with credits; the synthetic Z.ai account and its profile switched on.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { localVaultRequest } from '../../vault/bootstrap.mjs'
import { SYNTHETIC_ZAI_KEY } from '../llm-verify/fake-zai.mjs'
import { customerOf } from './runtime.mjs'
import {
  MEDIA_PATH,
  MEDIA_PNG,
  REPOSITORY_EXCLUDES,
  STAND_PROFILES,
  TEXT,
  THEME,
  operatorEnvironment,
  standRatesFile,
  themeFiles,
} from './stand.mjs'

/**
 * WordPress installed at the site's address, the theme of the stand active, the page
 * «Контакты» and one post published, the plugin «Радити» as a must-use plugin, one file of the
 * media library. The two default posts of WordPress are deleted: the front page shows the news.
 */
export async function installProductionSite(rt, site, { siteUrl }) {
  const installed = await site.wp([
    'core',
    'install',
    `--url=${siteUrl}`,
    `--title=${TEXT.siteName}`,
    '--admin_user=stand-admin',
    '--admin_email=admin@example.test',
    '--skip-email',
  ])
  // WP-CLI prints the password it generated; nothing of the stand uses it.
  const [, password] = /Admin password:\s*(\S+)/.exec(installed.output) ?? []
  if (password) rt.secret(password)
  for (const [path, content] of Object.entries(themeFiles())) await site.files.write(path, content)
  await site.wp(['theme', 'activate', THEME])
  await site.wp(['post', 'delete', '1', '2', '--force'], { allowFailure: true })
  const create = async (type, title, content) => {
    const created = await site.wp([
      'post',
      'create',
      `--post_type=${type}`,
      '--post_status=publish',
      `--post_title=${title}`,
      `--post_content=${content}`,
      '--porcelain',
    ])
    const id = Number(created.output.trim().split('\n').at(-1))
    assert.ok(Number.isInteger(id) && id > 0, `WordPress did not create the ${type}`)
    return id
  }
  const contactsId = await create('page', TEXT.contacts, '<p>Пишите нам через форму на сайте.</p>')
  const postId = await create('post', TEXT.post, '<p>Открылись после ремонта.</p>')
  const plugin = await readFile(join(rt.root, 'infra/wordpress/raditi-content.php'))
  await site.files.write('wp-content/mu-plugins/raditi-content.php', plugin)
  await site.files.write(MEDIA_PATH, MEDIA_PNG)
  const applicationPassword = rt.secret(
    (
      await site.wp([
        'user',
        'application-password',
        'create',
        'stand-admin',
        'raditi',
        '--porcelain',
      ])
    ).output
      .trim()
      .split('\n')
      .at(-1),
  )
  assert.ok(applicationPassword.length > 10, 'No application password of the site')
  return { contactsId, postId, applicationPassword }
}

/** A title of a post or page of production, as WordPress holds it. */
export async function productionTitle(site, id) {
  return (await site.wp(['post', 'get', String(id), '--field=post_title'])).output
    .trim()
    .split('\n')
    .at(-1)
}

/**
 * The owner of the site, as web signs them up: the form's sign-up with both required consents,
 * the address confirmed (the stand marks it in the database instead of reading the letter: the
 * money stand does that part), then the sign-in that opens the session.
 */
export async function signUpOwner(rt, { webUrl, db }) {
  const owner = customerOf(rt, { webUrl, address: '198.51.100.7' })
  const email = `owner-${randomBytes(4).toString('hex')}@example.ru`
  const password = rt.secret(randomBytes(18).toString('base64url'))
  const signUp = await owner.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Анна',
      lastName: 'Проверкина',
      email,
      password,
      acceptTerms: true,
      acceptPersonalData: true,
      marketing: false,
    }),
  })
  assert.equal(signUp.status, 200, `sign-up answered ${signUp.status}`)
  const user = await db.user.update({ where: { email }, data: { emailVerified: true } })
  const signIn = await owner.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  assert.equal(signIn.status, 200, `sign-in answered ${signIn.status}`)
  assert.ok(owner.cookie().includes('better-auth'), 'The sign-in opened no session')
  return { ...owner, id: user.id, email }
}

/**
 * The site's repository as the import leaves it: the document root of production without its
 * configuration, pushed by the bot as the first commit of `main`, and the tag v0.0.0 of the
 * import made by the release account through the API.
 */
export async function importRepository(rt, { gitea, site, repoName, directory, certificates }) {
  const tree = join(directory, 'import')
  await rm(tree, { recursive: true, force: true })
  await mkdir(tree, { recursive: true })
  await rt.docker(['cp', `${site.web}:/var/www/html/.`, tree], { timeoutMs: 300_000 })
  for (const excluded of REPOSITORY_EXCLUDES)
    await rm(join(tree, excluded), { recursive: true, force: true })
  await gitea.api('POST', '/orgs/sites/repos', {
    as: gitea.admin,
    body: { name: repoName, private: true, auto_init: false, default_branch: 'main' },
    expect: 201,
  })
  const env = {
    PATH: process.env.PATH,
    HOME: join(directory, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSL_CAINFO: certificates.caFile,
    GIT_AUTHOR_NAME: 'raditi-bot',
    GIT_AUTHOR_EMAIL: 'raditi-bot@example.test',
    GIT_COMMITTER_NAME: 'raditi-bot',
    GIT_COMMITTER_EMAIL: 'raditi-bot@example.test',
    GIT_AUTHOR_DATE: '2026-10-17T09:00:00Z',
    GIT_COMMITTER_DATE: '2026-10-17T09:00:00Z',
    // The token goes in the environment of git, never in its arguments.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`raditi-bot:${gitea.tokens.bot}`).toString('base64')}`,
  }
  rt.secret(env.GIT_CONFIG_VALUE_0)
  const git = (...args) => rt.run('git', ['-C', tree, ...args], { env, timeoutMs: 300_000 })
  await git('init', '-q', '-b', 'main')
  await git('add', '-A')
  await git('commit', '-q', '-m', 'Import of the site')
  const sha = (await git('rev-parse', 'HEAD')).output.trim()
  await git('push', '-q', `${gitea.base}/sites/${repoName}.git`, 'main')
  const files = Number((await git('ls-files')).output.split('\n').filter(Boolean).length)
  // Gitea takes a push in the background: a tag made before it registered the branch started
  // no run of the scoped workflows (measured 18.10.2026).
  await rt.until('Gitea registered the pushed main', async () => {
    const repository = await gitea.api('GET', `/repos/sites/${repoName}`, { as: gitea.admin })
    const branch = await gitea.api('GET', `/repos/sites/${repoName}/branches/main`, {
      as: gitea.admin,
    })
    return repository.json?.empty === false && branch.json?.commit?.id === sha
  })
  const tagged = await gitea.api('POST', `/repos/sites/${repoName}/tags`, {
    as: gitea.as('owner'),
    body: { tag_name: 'v0.0.0', target: sha },
    expect: 201,
  })
  assert.equal(tagged.json.commit.sha, sha)
  await rm(tree, { recursive: true, force: true })
  return { sha, files }
}

/**
 * The repository of the site as git sees it: a bare clone of the stand, fetched before each
 * read. Gitea's REST API names a commit's own sha as the sha of its tree; only git tells trees.
 */
export function repositoryReader(rt, { gitea, repoName, directory, certificates }) {
  const bare = join(directory, 'repository.git')
  const env = {
    PATH: process.env.PATH,
    HOME: join(directory, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSL_CAINFO: certificates.caFile,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`raditi-bot:${gitea.tokens.bot}`).toString('base64')}`,
  }
  rt.secret(env.GIT_CONFIG_VALUE_0)
  const git = (...args) => rt.run('git', ['--git-dir', bare, ...args], { env, timeoutMs: 120_000 })
  let cloned = false
  const fetch = async () => {
    if (!cloned) {
      await rt.run('git', ['clone', '-q', '--bare', `${gitea.base}/sites/${repoName}.git`, bare], {
        env,
        timeoutMs: 300_000,
      })
      cloned = true
    }
    await git('fetch', '-q', '--prune', '--tags', 'origin', '+refs/heads/*:refs/heads/*')
  }
  return {
    /** The tree of a commit, after a fetch. */
    async tree(sha) {
      await fetch()
      return (await git('rev-parse', `${sha}^{tree}`)).output.trim()
    },
    /** The parents of a commit, after a fetch. */
    async parents(sha) {
      await fetch()
      return (await git('rev-list', '--parents', '-n', '1', sha)).output.trim().split(' ').slice(1)
    },
  }
}

/**
 * The trusted connection step, with the tokens it has in the product: the accesses of the
 * hosting, the database and the plugin written to Vault by the writer (CAS 0, never read back)
 * with their references, the key of the workspace by the provisioner, the plugin bound to the
 * site, the repository recorded and the site turned `active` by `activateSite`; the version of
 * the import is the installed one.
 */
export async function connectSite(rt, deps) {
  const {
    db,
    dbModule,
    vault,
    site,
    siteId,
    workspaceId,
    siteUrl,
    hosting,
    applicationPassword,
    repo,
    gitea,
  } = deps
  const { siteAccessPath, workspaceTransitKey } = deps.domain
  const writer = { address: vault.address, token: vault.tokens['sites-writer'] }
  const write = async (kind, data) => {
    // The forms of the platform, as the role that reads each access checks it.
    const schema = {
      ssh: deps.domain.sshAccessSchema,
      db: deps.domain.dbAccessSchema,
      wp: deps.contentAccessSchema,
    }[kind]
    schema.parse(data)
    const path = siteAccessPath(siteId, kind)
    const written = await rt.until(`the ${kind} access in OpenBao`, async () => {
      const result = await localVaultRequest(writer, `kv/data/${path.replace(/^kv\//, '')}`, {
        method: 'POST',
        body: { options: { cas: 0 }, data },
      })
      return result.status === 200 ? result.body : null
    })
    return db.credentialRef.create({
      data: { kind, workspaceId, siteId, vaultPath: path, keyVersion: written.data.version },
    })
  }
  const ssh = await write('ssh', hosting.access)
  const database = await write('db', {
    v: '1',
    engine: 'mysql',
    host: '127.0.0.1',
    port: String(site.dbPort),
    tls: 'plain',
    database: 'wordpress',
    username: 'wordpress',
    password: site.dbPassword,
  })
  // The public rows the wizard keeps beside the accesses (plan 39): where the code of the site
  // is and where its database is. A release names the hosting by the first.
  await db.siteCodeSource.create({
    data: {
      siteId,
      kind: 'sftp',
      host: hosting.access.host,
      port: Number(hosting.access.port),
      rootPath: hosting.access.rootPath,
      hostKey: hosting.access.hostKey,
      credentialRefId: ssh.id,
    },
  })
  await db.siteDatabase.create({
    data: {
      siteId,
      engine: 'mysql',
      host: '127.0.0.1',
      port: site.dbPort,
      databaseName: 'wordpress',
      tls: 'plain',
      credentialRefId: database.id,
    },
  })
  await write('wp', { v: '1', origin: siteUrl, username: 'stand-admin', applicationPassword })
  const key = await localVaultRequest(
    { address: vault.address, token: vault.tokens['workspace-provisioner'] },
    `transit/keys/${workspaceTransitKey(workspaceId)}`,
    { method: 'POST', body: { type: 'aes256-gcm96' } },
  )
  assert.ok([200, 204].includes(key.status), 'The workspace key was not created')
  await site.wp(['option', 'update', 'raditi_content_site_id', siteId])
  await db.gitRepository.create({
    data: {
      siteId,
      provider: 'gitea',
      owner: 'sites',
      name: repo.name,
      defaultBranch: 'main',
      url: `${gitea.base}/sites/${repo.name}`,
    },
  })
  const activation = await dbModule.activateSite(db, {
    siteId,
    requiredAccess: ['wp', 'ssh', 'db'],
  })
  assert.equal(
    activation.status,
    'activated',
    `The site was not activated: ${JSON.stringify(activation)}`,
  )
  await db.site.update({
    where: { id: siteId },
    data: { installedVersion: 'v0.0.0', installedSha: repo.sha, installedAt: new Date() },
  })
}

/** The token of the release account in Vault (Р35), written by the operator of the stand. */
export async function storeOwnerToken(vault, token) {
  const result = await localVaultRequest(vault.root, 'kv/data/platform/gitea-org-owner', {
    method: 'POST',
    body: { data: { v: '1', token } },
  })
  assert.equal(result.status, 200, 'The token of the release account was not stored')
}

/**
 * A paid tariff «Агентство» for the current period, as a settled payment leaves it: the order,
 * the subscription and the credits of the period granted by `grantTariffCredits`. The money path
 * itself is `pnpm verify:billing`'s. The scenarios start ten dialogs (A–J), hold several of
 * them at once and retry one in `heavy` (120): more than the 300 tariff credits «Агентство» gives
 * a Moscow day (decision of 17.10.2026, D2). Two paid packs carry the rest, as a client goes on
 * the same day — pack credits are outside the day —, so every reserve is the full step of its
 * class; the day itself is `verify:billing`'s and the tests of @repo/billing.
 */
export async function grantTariff({ db, billing }, { workspaceId, userId }) {
  const plan = await db.plan.findFirstOrThrow({ where: { slug: 'agency' } })
  const pack = await db.plan.findFirstOrThrow({ where: { slug: 'pack' } })
  const start = new Date(Date.now() - 60 * 60_000)
  const end = new Date(start.getTime() + 30 * 24 * 60 * 60_000)
  await db.$transaction(async (tx) => {
    const subscription = await tx.subscription.create({
      data: {
        workspaceId,
        planId: plan.id,
        status: 'active',
        currentPeriodStart: start,
        currentPeriodEnd: end,
        periodAnchor: start,
      },
    })
    const order = await tx.order.create({
      data: {
        workspaceId,
        userId,
        planId: plan.id,
        subscriptionId: subscription.id,
        kind: 'subscription',
        amount: plan.price,
        status: 'paid',
        idempotenceKey: `release-verify-${randomBytes(6).toString('hex')}`,
        periodStart: start,
        periodEnd: end,
        paidAt: start,
      },
    })
    await billing.grantTariffCredits(tx, {
      workspaceId,
      orderId: order.id,
      credits: plan.creditsPerMonth,
    })
    for (let bought = 0; bought < 2; bought += 1) {
      const packOrder = await tx.order.create({
        data: {
          workspaceId,
          userId,
          planId: pack.id,
          kind: 'pack',
          amount: pack.price,
          status: 'paid',
          idempotenceKey: `release-verify-${randomBytes(6).toString('hex')}`,
          paidAt: start,
        },
      })
      await billing.grantPackCredits(tx, {
        workspaceId,
        orderId: packOrder.id,
        credits: pack.packCredits,
      })
    }
  })
  return plan
}

/**
 * The synthetic Z.ai account through the operator's own command, then what an operator switches
 * on: the provider, the standard and the heavy profile («Попробовать ещё», S10) and the account;
 * then the operator's `billing:rates` writes the stand rates of the profiles and the provisional
 * credit rate with one moment — the one command that writes either (CLAUDE.md, «Команды»).
 */
export async function switchOnModel(rt, { db, copy, context, vault, directory }) {
  const writerFile = join(directory, 'subscriptions-writer.token')
  await writeFile(writerFile, vault.tokens['subscriptions-writer'], { mode: 0o400 })
  const scripts = join(copy, 'apps/orchestrator')
  const login = await rt.run(
    process.execPath,
    [
      join(scripts, 'scripts/subscription-login.mjs'),
      ...['--backend', 'zai-coding', '--label', 'release-verify', '--plan', 'lite'],
      ...['--vault-token-file', writerFile],
    ],
    { cwd: scripts, env: operatorEnvironment(context), input: `${SYNTHETIC_ZAI_KEY}\n` },
  )
  const accountId = JSON.parse(login.output.slice(login.output.indexOf('{'))).accountId
  const provider = await db.llmProvider.update({
    where: { slug: 'zai-coding' },
    data: { enabled: true },
  })
  const profiles = []
  for (const slug of STAND_PROFILES)
    profiles.push(await db.llmModel.findFirstOrThrow({ where: { providerId: provider.id, slug } }))
  await db.subscriptionAccount.update({ where: { id: accountId }, data: { enabled: true } })
  await db.llmModel.updateMany({
    where: { id: { in: profiles.map((profile) => profile.id) } },
    data: { enabled: true },
  })
  const ratesFile = join(directory, 'stand-rates.json')
  await writeFile(ratesFile, JSON.stringify(standRatesFile(), null, 2), { mode: 0o600 })
  // The stand's tariff costs more than half of its price at these rates: confirmed, as an
  // operator confirms it.
  const rates = await rt.run(
    process.execPath,
    [
      join(scripts, 'scripts/billing-rates.mjs'),
      ...['--file', ratesFile, '--reason', 'Стенд выпуска: ставки профиля и курс кредита'],
      ...['--confirm-exposure', '--operator', 'release-verify'],
    ],
    { cwd: scripts, env: operatorEnvironment(context) },
  )
  const rate = await db.creditRate.findFirst({ orderBy: { effectiveFrom: 'desc' } })
  for (const profile of profiles) {
    const price = await db.llmModelPrice.findFirst({ where: { modelId: profile.id } })
    assert.ok(
      price && rate && price.effectiveFrom.getTime() === rate.effectiveFrom.getTime(),
      `billing:rates wrote no rate and price of ${profile.slug} of one moment: ${rt.redact(rates.output).slice(-600)}`,
    )
  }
  return { accountId, modelId: profiles[0].id }
}
