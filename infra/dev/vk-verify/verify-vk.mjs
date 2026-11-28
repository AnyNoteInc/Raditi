// The stand of the VK community (docs/plan/99-vk-community.md, slice 99.8): `pnpm verify:vk`.
// A disposable PostgreSQL with every migration and the seeds, a disposable OpenBao with the
// platform's mounts, policies and AppRoles (infra/vault/bootstrap.mjs), and the fake of api.vk.com
// (fake-vk.mjs). The classes of core and mcp come from their `dist`, the packages from their
// sources; each side holds a Vault token of its own policy only, as in production. Nothing of the
// working `.env` is read. Six scenarios:
//   V1 the connection of a community: the key in Vault alone, the callback server of Raditi;
//   V2 what the agent reads: the wall, the comments without their authors, the stats;
//   V3 a post: the proposal, the card, the press, the publication — and a press nobody made;
//   V4 a reply to a comment by its card;
//   V5 a new comment: the notices of the owners, at most one in ten minutes;
//   V6 the switch and the disconnection: off means absent, the presses stay.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import { createRuntime, freeLoopbackPort } from '../browser-task-verify/runtime.mjs'
import { startOpenbao, startPostgres } from '../browser-task-verify/services.mjs'
import { OPENBAO_IMAGE, POSTGRES_IMAGE } from '../browser-task-verify/stand.mjs'
import { fakeVkState, startFakeVk } from './fake-vk.mjs'

const root = resolve(import.meta.dirname, '../../..')
const rt = createRuntime({ root })
/** A package of the repository from its sources (Node strips the types). */
const source = (path) => pathToFileURL(join(root, path)).href
const run = randomBytes(4).toString('hex')
export const VK_STAND_LABEL = 'io.raditi.vk-verify'
const stand = `raditi-vk-verify-${run}`
const names = {
  run,
  stand,
  label: `${VK_STAND_LABEL}=${run}`,
  containers: { postgres: `${stand}-postgres`, openbao: `${stand}-openbao` },
}

const GROUP_KEY = rt.secret(`vk1.a.${randomBytes(24).toString('hex')}`)
const WEAK_KEY = rt.secret(`vk1.a.${randomBytes(24).toString('hex')}`)
const SERVICE_KEY = rt.secret(randomBytes(24).toString('hex'))
const CONFIRM_SECRET = rt.secret(randomBytes(32).toString('base64url'))
const mac = (material) => createHmac('sha256', CONFIRM_SECRET).update(material).digest('base64url')
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** A UUID v7 — the id of a chat must be one (CHECK `tasks_chat_id_check`). */
function v7() {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const owned = { directory: null, fake: null, db: null }

async function preflight() {
  for (const image of [POSTGRES_IMAGE, OPENBAO_IMAGE]) {
    const inspected = await rt.docker(['image', 'inspect', image], { allowFailure: true })
    if (inspected.code !== 0)
      throw new Error(`The pinned image is not pulled: docker pull ${image}`)
  }
  for (const dist of ['apps/core/dist/vk/vk-actions.js', 'apps/mcp/dist/vk/vk-service.js']) {
    const built = await rt.run('test', ['-f', join(root, dist)], { allowFailure: true })
    if (built.code !== 0) throw new Error(`Build first: pnpm --filter core --filter mcp build`)
  }
}

async function scoped(vault, policy) {
  const answer = await vault.request('auth/token/create', {
    method: 'POST',
    body: { policies: [policy], no_default_policy: true, ttl: '1h', renewable: false },
  })
  return rt.secret(answer.auth.client_token)
}

async function main() {
  rt.setStage('preflight')
  await preflight()
  owned.directory = await mkdtemp(join(tmpdir(), 'raditi-vk-verify-'))

  rt.setStage('services')
  const postgres = await startPostgres(rt, names, owned.directory)
  const vault = await startOpenbao(rt, names, await freeLoopbackPort())
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CI: '1',
    DATABASE_URL: postgres.url,
  }
  for (const step of ['db:deploy', 'db:seed']) {
    const done = await rt.run('pnpm', ['--filter', '@repo/db', step], { env, timeoutMs: 300_000 })
    if (done.code !== 0) throw new Error(`${step} failed`)
  }
  rt.passed(
    'disposable PostgreSQL with every migration and the seeds, OpenBao with the policies and AppRoles of the platform',
  )

  // The packages from their sources, the classes of the apps from their dist.
  process.env.DATABASE_URL = postgres.url
  process.env.APP_ENV = 'test'
  const {
    createPrismaClient,
    enabledBuiltinMcp,
    enqueueVkCommentNotices,
    reserveVkProposal,
    workingVkCommunities,
    workingVkCommunity,
  } = await import(source('packages/db/src/index.ts'))
  const { createCaller } = await import(source('packages/trpc/src/index.ts'))
  const { createVaultSecretStore } = await import(source('packages/vault/src/index.ts'))
  const { VkHttpApi } = await import(source('packages/vk/src/index.ts'))
  const domain = await import(source('packages/domain/src/index.ts'))
  const { VkActions } = await import('../../../apps/core/dist/vk/vk-actions.js')
  const { VkNotify } = await import('../../../apps/core/dist/vk/vk-notify.js')
  const { VkChanges } = await import('../../../apps/core/dist/tasks/vk-turns.js')
  const { NotificationDelivery } =
    await import('../../../apps/core/dist/tasks/notification-delivery.js')
  const { McpVkService } = await import('../../../apps/mcp/dist/vk/vk-service.js')
  const { VkServiceKey } = await import('../../../apps/mcp/dist/vk/vk-service-key.js')

  const db = createPrismaClient({ databaseUrl: postgres.url, log: [] })
  owned.db = db
  const storeOf = async (policy) =>
    createVaultSecretStore({ addr: vault.address, token: await scoped(vault, policy) })
  const writer = await storeOf('sites-writer')
  const coreVk = await storeOf('core-vk')
  const mcpContent = await storeOf('mcp-content')
  const llm = await storeOf('llm-subscriptions')
  const subsWriter = await storeOf('subscriptions-writer')

  const state = fakeVkState({
    groupId: 1001,
    name: 'Кофейня у дома',
    screenName: 'coffee',
    groupKey: GROUP_KEY,
    serviceKey: SERVICE_KEY,
    rights: ['manage', 'wall'],
  })
  state.keys.set(WEAK_KEY, { kind: 'group', rights: ['wall'] })
  owned.fake = await startFakeVk(state)
  const vk = new VkHttpApi({ baseUrl: owned.fake.baseUrl, minIntervalMs: 0 })

  const user = await db.user.create({
    data: { name: 'VK verification', email: `${randomUUID()}@vk-verify.example.ru` },
  })
  await db.userConsent.createMany({
    data: domain.legalDocuments.flatMap((document) =>
      document.required && document.consentType
        ? [
            {
              userId: user.id,
              documentType: document.consentType,
              documentVersion: document.version,
              granted: true,
              source: 'sign_up',
            },
          ]
        : [],
    ),
  })
  const caller = createCaller({
    prisma: db,
    headers: new Headers(),
    user,
    session: {
      id: randomUUID(),
      userId: user.id,
      token: `vk-verify-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      ipAddress: null,
      userAgent: null,
    },
    billing: null,
    chat: { appEnv: 'test', browser: null, storage: () => ({}), secrets: () => ({}) },
    builtinMcp: {
      secrets: {
        kvWrite: (path, data, options) => writer.kvWrite(path, data, options),
        kvMetadata: (path) => writer.kvMetadata(path),
      },
      vk,
      confirmMac: mac,
      callbackUrl: (id) => `https://raditi.test${domain.vkCallbackPath(id)}`,
    },
  })

  // --- V1 -------------------------------------------------------------------------------------
  rt.begin('V1', 'the connection of a community')
  rt.check(
    (await caller.builtinMcp.list({})).servers[0]?.enabled === false,
    '«ВКонтакте» is off before a key',
  )
  const view = await caller.builtinMcp.vkConnect({ token: GROUP_KEY })
  const workspaceId = view.workspaceId
  const group = view.servers[0].communities[0]
  rt.check(
    view.servers[0].enabled && group?.name === 'Кофейня у дома' && group.notices,
    'the key of the community turns «ВКонтакте» on, with the notices of comments',
    view.servers[0],
  )
  const path = domain.vkCommunitySecretPath(workspaceId, group.id)
  rt.check(
    (await coreVk.kvRead(path))?.data.token === GROUP_KEY,
    'the key lies in Vault, and core reads it by `core-vk`',
  )
  const row = await db.vkCommunity.findUniqueOrThrow({ where: { id: group.id } })
  rt.check(
    !JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).includes(GROUP_KEY),
    'the row of the community holds no key',
  )
  for (const [policy, store] of [
    ['sites-writer', writer],
    ['mcp-content', mcpContent],
    ['llm-subscriptions', llm],
  ])
    rt.check(
      (await store.kvRead(path).then(
        () => 'read',
        (error) => String(error.status ?? error.message),
      )) !== 'read',
      `${policy} cannot read the key of a community`,
    )
  const server = state.servers[0]
  rt.check(
    server?.url === `https://raditi.test/api/webhooks/vk/${group.id}` &&
      server.secret === domain.vkCallbackSecret(group.id, mac) &&
      row.callbackCode === 'fakec0de',
    'the callback server of Raditi is registered with the derived secret, and its code is kept',
  )
  rt.end()

  // --- V2 -------------------------------------------------------------------------------------
  rt.begin('V2', 'what the agent reads')
  await subsWriter.kvWrite(domain.VK_SERVICE_KEY_PATH, { token: SERVICE_KEY }, { cas: 0 })
  rt.check(
    (await llm.kvRead(domain.VK_SERVICE_KEY_PATH).then(
      () => 'read',
      () => 'refused',
    )) === 'refused',
    'llm-subscriptions cannot read the service key of VK',
  )
  state.posts.push({
    id: 10,
    date: Math.floor(Date.now() / 1000) - 3600,
    text: 'Новое меню',
    views: { count: 120 },
    likes: { count: 7 },
    reposts: { count: 1 },
    comments: { count: 1 },
  })
  state.comments.push({
    id: 3,
    from_id: 777,
    post_id: 10,
    date: Math.floor(Date.now() / 1000) - 600,
    text: 'Когда открываетесь?',
  })
  const task = await db.task.create({
    data: {
      id: v7(),
      workspaceId,
      createdById: user.id,
      status: 'awaiting_user',
      title: 'Новости кофейни',
    },
  })
  const scope = {
    keyId: randomUUID(),
    taskId: task.id,
    workspaceId,
    sessionId: 'vk-verify',
    turn: 1,
    firstEpoch: 1,
    epoch: 1,
    requirements: { repository: false, browser: false },
    builtinMcp: ['vk'],
  }
  const mcp = new McpVkService({
    // The store of VkModule of mcp, from the same functions of @repo/db.
    store: {
      communities: (id) => workingVkCommunities(db, id),
      community: (id, communityId) => workingVkCommunity(db, id, communityId),
      reserve: (input) => reserveVkProposal(db, input),
    },
    api: vk,
    serviceKey: new VkServiceKey(mcpContent),
  })
  const posts = await mcp.posts(scope, { communityId: group.id })
  rt.check(
    posts.ok && posts.posts[0]?.postId === 10 && posts.posts[0].views === 120,
    'vk_posts reads the wall by the service key from Vault',
    posts,
  )
  const comments = await mcp.comments(scope, { communityId: group.id, postId: 10 })
  rt.check(
    comments.ok &&
      comments.comments[0]?.author === 'reader 1' &&
      !JSON.stringify(comments).includes('777'),
    'vk_comments names the commenter «reader 1», never their id in VK',
    comments,
  )
  const stats = await mcp.stats(scope, { communityId: group.id, days: 7 })
  rt.check(stats.ok && stats.posts === 1 && stats.totals.views === 120, 'vk_stats sums the posts')
  const wallCalls = state.calls.filter((call) => call.method.startsWith('wall.get'))
  rt.check(
    wallCalls.every((call) => call.key === 'service'),
    'the wall and its comments were read by the service key only',
  )
  rt.end()

  // --- V3 -------------------------------------------------------------------------------------
  rt.begin('V3', 'a post: the proposal, the card, the press, the publication')
  const proposed = await mcp.proposePost(scope, { communityId: group.id, text: 'Мы открылись!' })
  rt.check(
    proposed.ok && state.calls.every((call) => call.method !== 'wall.post'),
    'vk_post_propose reserves and publishes nothing',
  )
  const changes = new VkChanges({ db })
  await changes.apply(task.id, 1)
  const card = await db.taskEvent.findFirst({
    where: { taskId: task.id, type: 'feed.vk_proposal' },
  })
  rt.check(
    card?.payload?.reservedId === proposed.reservedId && card.payload.text === 'Мы открылись!',
    'the end of the turn shows the card «Опубликовать во ВКонтакте»',
  )
  const pressed = await caller.builtinMcp.vkPublish({
    reservedId: proposed.reservedId,
    text: 'Мы открылись! Ждём вас с 9:00.',
  })
  const job = await db.outboxEvent.findFirst({ where: { topic: 'vk', type: 'vk.action' } })
  rt.check(job !== null, 'the press writes one row of vk_actions and the job of core')
  const actions = new VkActions({ db, secrets: coreVk, api: vk, mac })
  await actions.run(pressed.actionId)
  const published = state.calls.filter((call) => call.method === 'wall.post')
  rt.check(
    published.length === 1 &&
      published[0].key === 'group' &&
      published[0].form.message === 'Мы открылись! Ждём вас с 9:00.' &&
      published[0].form.from_group === '1',
    'core publishes the edited text from the community, with the key it read from Vault',
  )
  const told = await db.taskEvent.findFirst({
    where: { taskId: task.id, type: 'feed.vk_action' },
  })
  rt.check(
    told?.payload?.state === 'done' && /^https:\/\/vk\.com\/wall-1001_\d+$/.test(told.payload.url),
    'the chat is told the post is out, with its address',
  )
  let again = 'published'
  await caller.builtinMcp
    .vkPublish({ reservedId: proposed.reservedId, text: 'Ещё раз' })
    .catch((error) => {
      again = error.cause?.code ?? error.code
    })
  rt.check(again === 'VK_ALREADY_PUBLISHED', 'a card publishes once')
  // A row nobody pressed: written straight into the database with a token of a wrong secret.
  const second = await mcp.proposePost(scope, { communityId: group.id, text: 'Подделка' })
  await changes.apply(task.id, 1)
  const forged = domain.signVkConfirmToken(
    {
      kind: 'post',
      userId: user.id,
      workspaceId,
      communityId: group.id,
      reservationId: second.reservedId,
      taskId: task.id,
      textSha256: sha256('Подделка'),
      publishAt: null,
      nonce: randomBytes(16).toString('hex'),
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    },
    (material) => createHmac('sha256', 'not-the-secret').update(material).digest('base64url'),
  )
  const forgedId = randomUUID()
  await db.vkAction.create({
    data: {
      id: forgedId,
      workspaceId,
      taskId: task.id,
      communityId: group.id,
      reservationId: second.reservedId,
      createdById: user.id,
      kind: 'post',
      args: { token: forged, text: 'Подделка' },
      tokenSha256: sha256(forged),
    },
  })
  await actions.run(forgedId)
  const forgedRow = await db.vkAction.findUniqueOrThrow({ where: { id: forgedId } })
  rt.check(
    forgedRow.state === 'failed' &&
      forgedRow.error === 'VK_CONFIRM_INVALID' &&
      state.calls.filter((call) => call.method === 'wall.post').length === 1,
    'a row nobody pressed is refused by core, and nothing goes to VK',
  )
  rt.end()

  // --- V4 -------------------------------------------------------------------------------------
  rt.begin('V4', 'a reply to a comment')
  const reply = await mcp.proposeReply(scope, {
    communityId: group.id,
    postId: 10,
    commentId: 3,
    text: 'С 9:00, ждём вас!',
  })
  await changes.apply(task.id, 1)
  const replyPress = await caller.builtinMcp.vkPublish({
    reservedId: reply.reservedId,
    text: 'С 9:00, ждём вас!',
  })
  await actions.run(replyPress.actionId)
  const answered = state.calls.filter((call) => call.method === 'wall.createComment')
  rt.check(
    answered.length === 1 &&
      answered[0].key === 'group' &&
      answered[0].form.post_id === '10' &&
      answered[0].form.reply_to_comment === '3',
    'the reply goes under the comment of its card, from the community',
  )
  rt.end()

  // --- V5 -------------------------------------------------------------------------------------
  rt.begin('V5', 'a new comment: the notices of the owners')
  const now = new Date()
  const queued = await enqueueVkCommentNotices(db, { id: group.id, workspaceId }, now)
  const queuedAgain = await enqueueVkCommentNotices(db, { id: group.id, workspaceId }, now)
  rt.check(queued === 1 && queuedAgain === 0, 'one job per owner in a window of ten minutes')
  const delivery = new NotificationDelivery({
    db,
    appUrl: 'https://raditi.test',
    push: null,
    logger: { log() {}, warn() {} },
  })
  const notify = new VkNotify({ db, delivery })
  await notify.run({ communityId: group.id, userId: user.id })
  await notify.run({ communityId: group.id, userId: user.id })
  const notices = await db.chatNotification.findMany({
    where: { userId: user.id, kind: 'vk_comment' },
  })
  rt.check(
    notices.length === 1 && notices[0].vkCommunityId === group.id && !notices[0].emailed,
    'the notice is one row of chat_notifications for the community, no letter, one in ten minutes',
  )
  rt.end()

  // --- V6 -------------------------------------------------------------------------------------
  rt.begin('V6', 'the switch and the disconnection')
  await caller.builtinMcp.switch({ server: 'vk', enabled: false })
  rt.check(
    (await enabledBuiltinMcp(db, workspaceId)).length === 0,
    'off: the admission of mcp offers no family vk',
  )
  await caller.builtinMcp.switch({ server: 'vk', enabled: true })
  rt.check((await enabledBuiltinMcp(db, workspaceId)).includes('vk'), 'on again without a new key')
  await caller.builtinMcp.vkDisconnect({ communityId: group.id })
  const erased = await coreVk.kvRead(path)
  rt.check(
    erased === null || erased.data.token === undefined,
    'the disconnection erases the key in Vault',
  )
  rt.check(
    (await enabledBuiltinMcp(db, workspaceId)).length === 0,
    'the last community turns «ВКонтакте» off',
  )
  const kept = await db.vkAction.count({ where: { workspaceId, communityId: null } })
  rt.check(kept >= 2, 'the presses and what they did stay after the disconnection')
  rt.end()
  rt.note('the webhook of web (Next, server-only) is proven by its unit tests, not here')
}

async function cleanup() {
  const quiet = { allowFailure: true, cleanup: true }
  await owned.fake?.close().catch(() => {})
  await owned.db?.$disconnect().catch(() => {})
  const ids = (await rt.docker(['ps', '-aq', '--filter', `label=${names.label}`], quiet)).output
    .split('\n')
    .filter(Boolean)
  if (ids.length > 0) await rt.docker(['rm', '-f', '-v', ...ids], quiet)
  if (owned.directory) await rm(owned.directory, { recursive: true, force: true })
  const left = (await rt.docker(['ps', '-aq', '--filter', `label=${names.label}`], quiet)).output
  return left.trim() === ''
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => rt.controller.abort())

try {
  await main()
  console.log(
    `PASS the VK stand: ${rt.rows.map((row) => `${row.id} ${row.checks}`).join(', ')} checks`,
  )
} catch (error) {
  console.error(`FAIL the VK stand at ${rt.stage}: ${rt.redact(error.message ?? String(error))}`)
  process.exitCode = 1
} finally {
  if (await cleanup()) console.log('PASS disposable PostgreSQL, OpenBao and the fake of VK removed')
  else {
    console.error('FAIL cleanup of the VK stand: containers are left')
    process.exitCode = 1
  }
}
