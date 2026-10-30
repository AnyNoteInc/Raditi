// The scenarios of the browser-task stand (README.md, «Сценарии»; docs/plan/57-browser-tasks.md,
// §5). Each PASS line is a fact read from the product — its database, its pages, the stream of its
// gateway, the API of its worker — or from what WordPress, S3 and Docker hold. The client acts
// only from outside: web over HTTP with a session cookie, the stream through the gateway, the
// cabinet in a real Chromium. The "agent" is the real OpenCode CLI on the scripted model
// (programs.mjs), which finds what to click in the observations the platform gives it.
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'

import { localVaultRequest } from '../../vault/bootstrap.mjs'
import { CheckFailed, exchange } from '../release-verify/runtime.mjs'
import { grantTariff } from '../release-verify/setup.mjs'
import { NODE_ERRNO_PROBE, isolatedAnswer } from '../release-verify/stand.mjs'
import {
  CABINET_TEXT,
  cabinetAvailable,
  cabinetBrowser,
  cabinetOperator,
  canvasPainted,
} from './cabinet.mjs'
import { signUp, switchOnModel, uploadFile } from './setup.mjs'
import { rawDocker } from './site.mjs'
import {
  FAKE_JPEG,
  SITE_ORIGIN,
  SWITCH,
  UPLOAD_LIMIT_BYTES,
  leakedIn,
  solidPng,
  syntheticPdf,
} from './stand.mjs'
import { jpegLooksPainted, openViewer, streamOperator, streamTools } from './stream.mjs'

const BROWSER_ONLY = Object.freeze({ repository: false, browser: true })
const ENDED = new Set(['done', 'failed', 'cancelled', 'rolled_back'])

// ─── Small readers ────────────────────────────────────────────────────────────

const rowsOf = async (db, taskId, type) =>
  (await db.taskEvent.findMany({ where: { taskId, type }, orderBy: { id: 'asc' } })).map(
    (row) => row.payload,
  )

const openSession = (db, taskId) =>
  db.browserSession.findFirst({ where: { taskId }, orderBy: { createdAt: 'desc' } })

/** The labelled containers and networks of a browser session, by Docker itself. */
async function sessionResources(rt, sessionId) {
  const quiet = { allowFailure: true }
  const list = async (args) =>
    (
      await rt.docker([...args, '--filter', `label=io.raditi.browser.session=${sessionId}`], quiet)
    ).output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  return { containers: await list(['ps', '-aq']), networks: await list(['network', 'ls', '-q']) }
}

/** The worker's own list of live sessions (`GET /v1/sessions`, its token). */
async function workerSessions(stand) {
  const answer = await exchange(`${stand.workerUrl}/v1/sessions`, {
    headers: { authorization: `Bearer ${stand.secrets.workerToken}` },
  })
  if (answer.status !== 200) throw new Error(`the worker's list answered ${answer.status}`)
  return answer.json.sessions
}

/** Polls the task until its status is one of `statuses`; a broken script fails at once. */
async function waitTask(stand, taskId, statuses, { timeoutMs = 600_000, what } = {}) {
  const { rt, db, model } = stand
  const wanted = new Set(statuses)
  return rt.until(
    what ?? `the task to reach ${statuses.join(' or ')}`,
    async () => {
      const broken = model.current()?.broken
      if (broken) throw new CheckFailed(`the scripted model stopped: ${broken}`)
      const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
      if (wanted.has(task.status)) return task
      if (ENDED.has(task.status) && !wanted.has(task.status))
        throw new CheckFailed(`the task ended ${task.status} instead of ${statuses.join(' or ')}`)
      return null
    },
    { timeoutMs, intervalMs: 1000, service: stand.processes.core },
  )
}

/**
 * The task answered: a pass ended with `feed.result` and the dialog stays open for the next
 * words (owner's answer of 26.10.2026: «Чат» like «Работа» — no result needs confirming, no
 * `done`). `results` — how many results the task had before the pass that is waited for.
 */
async function waitAnswered(stand, taskId, { results = 0, timeoutMs = 600_000, what } = {}) {
  const { rt, db, model } = stand
  return rt.until(
    what ?? 'the task to answer',
    async () => {
      const broken = model.current()?.broken
      if (broken) throw new CheckFailed(`the scripted model stopped: ${broken}`)
      const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
      if (ENDED.has(task.status)) throw new CheckFailed(`the task ended ${task.status}`)
      if (task.status !== 'awaiting_user') return null
      const answered = await db.taskEvent.count({ where: { taskId, type: 'feed.result' } })
      return answered > results ? task : null
    },
    { timeoutMs, intervalMs: 1000, service: stand.processes.core },
  )
}

// ─── Tasks and turns ──────────────────────────────────────────────────────────

/** A task in the browser through `task.create`, its first turn scripted beforehand. */
async function newBrowserTask(
  stand,
  client,
  { text, attachments = [], program = 'askToSignIn', ctx = {} },
) {
  const taskId = stand.modules.ids.uuidv7()
  stand.model.script(program, ctx)
  const created = await client.mutate('task.create', {
    siteId: stand.state.siteId,
    taskId,
    text,
    requirements: BROWSER_ONLY,
    ...(attachments.length > 0 ? { attachments } : {}),
  })
  if (created.taskId !== taskId || !created.created)
    throw new CheckFailed('task.create made no new task')
  return taskId
}

/** The Transit key of the owner's workspace as the operator reads it: 404 while there is none. */
const workspaceKey = (stand) =>
  localVaultRequest(
    stand.vault.root,
    `transit/keys/${stand.modules.domain.workspaceTransitKey(stand.state.workspaceId)}`,
  )

/** The first turn: the agent finds the sign-in page and asks the client to sign in. */
async function firstTurn(stand, taskId) {
  const task = await waitTask(stand, taskId, ['awaiting_user'], {
    what: 'the first turn to ask for a sign-in',
  })
  const program = stand.model.current()
  if (!program.finished) throw new CheckFailed('the first turn ended before its program did')
  return { task, facts: program.facts }
}

/** «Продолжить работу агента» of a waiting task, with the program of the next turn. */
async function resumeWith(stand, client, taskId, program, ctx) {
  stand.model.script(program, ctx)
  return client.mutate('task.resumeAgent', { taskId, requestId: randomUUID() })
}

/** The ticket of the stream of a task's browser, as the cabinet asks for it. */
const ticketOf = (client, taskId) => client.mutate('browser.streamTicket', { taskId })

/** A viewer of the task's browser through the gateway, once it has its id, a state and a frame. */
async function watch(stand, client, taskId, options = {}) {
  const { rt } = stand
  const ticket = await ticketOf(client, taskId)
  const viewer = openViewer(stand.streamTools, {
    url: ticket.url,
    origin: stand.webUrl,
    ticket: ticket.ticket,
    ...options,
  })
  await viewer.opened
  await rt.until(
    'the gateway to hand the viewer its id, a state and a frame',
    async () => {
      if (viewer.closed) throw new CheckFailed(`the stream closed ${viewer.closed.code}`)
      return viewer.viewerId !== null && viewer.state !== null && viewer.frames.length > 0
    },
    { timeoutMs: 20_000, intervalMs: 50 },
  )
  return Object.assign(viewer, { ticket })
}

async function stateWhere(stand, viewer, predicate, what, timeoutMs = 20_000) {
  return stand.rt.until(
    what,
    async () => {
      if (viewer.closed)
        throw new CheckFailed(`the stream closed ${viewer.closed.code} while waiting for ${what}`)
      return viewer.state && predicate(viewer.state) ? viewer.state : null
    },
    { timeoutMs, intervalMs: 50 },
  )
}

/** A refusal the viewer gets after its next message, by reason. */
async function refusedWith(stand, viewer, send, reason) {
  const before = viewer.refusals.length
  send()
  await stand.rt.until(
    `the worker to refuse with ${reason}`,
    async () => viewer.refusals.slice(before).includes(reason),
    { timeoutMs: 10_000, intervalMs: 50 },
  )
  return true
}

/**
 * The client signs in in the browser of the task, as `operator` acts — over a raw viewer of the
 * stream, or in the cabinet: «Взять управление», the sign-in page opened again (WordPress focuses
 * its first field), the login and the password typed, Tab and Enter pressed. The browser lands on
 * the list of posts; the operator keeps control.
 */
async function signIn(stand, operator, account) {
  await operator.take()
  await operator.navigate(
    `${SITE_ORIGIN}/wp-login.php?redirect_to=${encodeURIComponent(`${SITE_ORIGIN}/wp-admin/edit.php`)}`,
  )
  await stand.rt.until(
    'the sign-in page',
    async () => operator.state()?.url.includes('/wp-login.php') ?? false,
    { timeoutMs: 20_000, intervalMs: 50 },
  )
  // WordPress focuses the first field of its form a moment after the page loads.
  await stand.rt.pause(1500)
  await operator.type(account.login)
  await operator.press('Tab')
  await operator.type(account.password)
  await operator.press('Enter')
  await stand.rt.until(
    'the browser to land on the list of posts after the sign-in',
    async () => {
      const url = operator.state()?.url ?? ''
      return url.includes('/wp-admin/edit.php') && !url.includes('wp-login')
    },
    { timeoutMs: 30_000, intervalMs: 100 },
  )
  await stand.site.cookies()
}

/** A raw viewer of the task's stream as the client's operator (stream.mjs). */
async function streamOperatorOf(stand, client, taskId) {
  return streamOperator(stand, await watch(stand, client, taskId))
}

/**
 * A whole task of the scenarios G–J: created with its words and files, its first turn asks for the
 * sign-in, the client signs in over the stream with `account`, «Продолжить работу агента» starts
 * `program`, and the task ends as `until` says.
 */
async function taskWithProgram(
  stand,
  client,
  { text, attachments, account, program, ctx, until, before },
) {
  const taskId = await newBrowserTask(stand, client, { text, attachments })
  await firstTurn(stand, taskId)
  const operator = await streamOperatorOf(stand, client, taskId)
  await signIn(stand, operator, account)
  if (before) await before(taskId)
  await resumeWith(stand, client, taskId, program, ctx)
  await stateWhere(
    stand,
    operator.viewer,
    (state) => state.controller === 'agent',
    'the next turn to take the browser back',
    120_000,
  )
  operator.close()
  const task = await waitTask(stand, taskId, until, { what: `the turn of ${program} to end` })
  const current = stand.model.current()
  if (!current.finished) throw new CheckFailed(`the program ${program} did not finish`)
  return { taskId, task, facts: current.facts }
}

// ─── A: the site, its files, the task ─────────────────────────────────────────

const TEXT_F = Object.freeze({
  title: 'Мы открыли второй магазин',
  text: 'Наш второй магазин работает на Садовой улице каждый день с девяти до девяти.',
})

async function scenarioA(stand) {
  const { rt, db, state } = stand
  rt.begin('A', 'сайт без доступа к файлам и вложения')
  state.owner = await signUp(rt, {
    webUrl: stand.webUrl,
    db,
    address: '198.51.100.21',
    name: 'Анна',
    login: 'owner',
  })
  state.stranger = await signUp(rt, {
    webUrl: stand.webUrl,
    db,
    address: '198.51.100.22',
    name: 'Борис',
    login: 'stranger',
  })
  const created = await state.owner.mutate('project.create', {
    requestKey: randomUUID(),
    name: 'Цветочная лавка',
    url: SITE_ORIGIN,
    stack: 'wordpress',
    access: 'browser',
    agentNotes: 'Вход в админку — через /wp-login.php. Новости — это записи.',
  })
  rt.check(
    created.outcome === 'created',
    'project.create, browser variant: the site is created',
    created,
  )
  state.siteId = created.project.id
  stand.owned.siteId = state.siteId
  const site = await db.site.findUniqueOrThrow({ where: { id: state.siteId } })
  state.workspaceId = site.workspaceId
  const sources = await db.siteCodeSource.count({ where: { siteId: state.siteId } })
  const refs = await db.credentialRef.count({ where: { siteId: state.siteId } })
  const stages = await db.siteProvisioningStage.count({ where: { siteId: state.siteId } })
  rt.check(
    site.status === 'onboarding' &&
      site.url === SITE_ORIGIN &&
      site.agentNotes?.includes('/wp-login.php') &&
      sources === 0 &&
      refs === 0 &&
      stages === 0,
    'the site is `onboarding` with the hints for the agent, and has no file access, no Vault reference and no import stage (Б8)',
    { status: site.status, sources, refs, stages },
  )
  const project = await state.owner.query('project.get', { id: state.siteId })
  rt.check(
    project.capabilities?.browser === 'ready' && project.capabilities?.repository === 'absent',
    'project.get: the browser is ready, the repository absent (Б9)',
    project.capabilities,
  )
  // The Transit key of the workspace, which every turn seals its snapshot with: web makes it
  // before the first task (Б32), project.create makes none — the stand makes none either.
  const noKey = await workspaceKey(stand)
  rt.check(
    noKey.status === 404,
    'project.create makes no Transit key of the workspace: task.create does (Б32)',
    { status: noKey.status },
  )
  await grantTariff(
    { db, billing: stand.modules.billing },
    { workspaceId: state.workspaceId, userId: state.owner.id },
  )
  await switchOnModel(rt, {
    db,
    copy: stand.copy,
    context: stand.context,
    vault: stand.vault,
    directory: stand.directory,
  })
  rt.passed(
    'the tariff «Агентство» paid for the workspace; the synthetic account and the profiles switched on by the operator commands with the stand rates',
  )

  // The files of the task, as the cabinet uploads them.
  const files = [
    { name: 'magazin-fasad.png', type: 'image/png', bytes: solidPng(320, 200, [190, 60, 70]) },
    { name: 'magazin-vitrina.png', type: 'image/png', bytes: solidPng(240, 240, [40, 120, 200]) },
    { name: 'prais-list.pdf', type: 'application/pdf', bytes: syntheticPdf('Прайс-лист', 2000) },
  ]
  state.files = []
  for (const file of files) {
    const sent = await uploadFile(state.owner, { siteId: state.siteId, ...file })
    if (sent.upload?.status === 404)
      throw new CheckFailed(
        'PUT /api/attachments/<id> answered 404: the upload route of web is missing',
      )
    rt.check(
      sent.upload !== null && sent.upload.status >= 200 && sent.upload.status < 300,
      `PUT /api/attachments: ${file.name} (${file.bytes.byteLength} bytes) taken`,
      { started: sent.started.ok, upload: sent.upload },
    )
    state.files.push({ ...file, id: sent.id })
  }
  const rows = await db.attachment.findMany({
    where: { id: { in: state.files.map((file) => file.id) } },
  })
  const storage = await stand.storage()
  let same = true
  for (const file of state.files) {
    const row = rows.find((item) => item.id === file.id)
    const held = await readObject(storage, 'inbox', row?.s3Key ?? '')
    same &&=
      row?.status === 'ready' &&
      row.s3Key === `inbox/${state.workspaceId}/${file.id}` &&
      held?.equals(file.bytes)
  }
  rt.check(
    same,
    'the three files are `ready`, each at inbox/<workspace>/<id> of raditi-inbox with the very bytes sent (Б26)',
  )

  const fake = await uploadFile(state.owner, {
    siteId: state.siteId,
    name: 'podmena.jpg',
    type: 'image/jpeg',
    bytes: FAKE_JPEG,
  })
  const fakeRow = fake.id ? await db.attachment.findUnique({ where: { id: fake.id } }) : null
  rt.check(
    fake.upload !== null && fake.upload.status >= 400 && fakeRow?.status !== 'ready',
    `a text named .jpg is refused by its signature (${fake.upload?.status}), and the file is not ready`,
    { upload: fake.upload, status: fakeRow?.status },
  )

  // Another client's file: their own site and upload, then the owner's attempts.
  const strangerSite = await state.stranger.mutate('project.create', {
    requestKey: randomUUID(),
    name: 'Чужой сайт',
    url: 'http://other.raditi.test',
    stack: 'wordpress',
    access: 'browser',
  })
  state.strangerSiteId = strangerSite.project.id
  const foreign = await uploadFile(state.stranger, {
    siteId: state.strangerSiteId,
    name: 'chuzhoe.png',
    type: 'image/png',
    bytes: solidPng(64, 64, [10, 200, 10]),
  })
  state.foreignAttachment = foreign.id
  const replacement = solidPng(8, 8, [0, 0, 0])
  const intoForeign = await state.owner.request(foreign.uploadPath, {
    method: 'PUT',
    headers: { 'content-type': 'image/png', 'content-length': String(replacement.byteLength) },
    body: replacement,
  })
  rt.check(
    intoForeign.status >= 400 && intoForeign.status < 500,
    `PUT into another client's file is refused (${intoForeign.status})`,
  )

  // The task: the owner's words, the three files; and the refusal of the other client's file.
  const withForeign = await state.owner.call('mutation', 'task.create', {
    siteId: state.siteId,
    taskId: stand.modules.ids.uuidv7(),
    text: 'Добавьте новость с картинкой.',
    requirements: BROWSER_ONLY,
    attachments: [state.foreignAttachment],
  })
  rt.check(
    !withForeign.ok,
    "task.create with another client's file is refused, nothing is written",
    withForeign,
  )
  rt.end()
}

async function readObject(storage, bucket, key) {
  if (!key) return null
  const body = await storage.get(bucket, key)
  if (body === null) return null
  const chunks = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

// ─── D: the first turn ────────────────────────────────────────────────────────

async function scenarioD(stand) {
  const { rt, db, state } = stand
  rt.begin('D', 'задача в браузере, первый ход: страница входа и просьба войти')
  // The task of A's files: created here, so a run of later scenarios alone has no task of A
  // running in the background.
  state.taskF = await newBrowserTask(stand, state.owner, {
    text: `Добавьте на сайт новость «${TEXT_F.title}»: ${TEXT_F.text} Первую фотографию вставьте в текст, вторую сделайте изображением записи, прайс приложите файлом. Опубликуйте.`,
    attachments: state.files.map((file) => file.id),
  })
  const task = await db.task.findUniqueOrThrow({ where: { id: state.taskF } })
  const bound = await db.attachment.count({ where: { taskId: state.taskF, status: 'bound' } })
  rt.check(
    task.needsBrowser === true && task.needsRepository === false && bound === 3,
    'task.create in the browser: needs_browser, no repository, the three files bound to the task in its transaction',
    { needsBrowser: task.needsBrowser, needsRepository: task.needsRepository, bound },
  )
  const key = (await workspaceKey(stand)).body?.data
  rt.check(
    key?.type === 'aes256-gcm96' && key.latest_version === 1 && key.exportable === false,
    'task.create made the Transit key of the workspace under web’s AppRole: aes256-gcm96, one version, not exportable (Б32)',
    { type: key?.type, version: key?.latest_version, exportable: key?.exportable },
  )
  const { facts } = await firstTurn(stand, state.taskF)
  rt.check(
    facts.dashboard === 'BROWSER_ACTION_DENIED',
    'web_open(/wp-admin/) — the dashboard is closed to the agent (Б31)',
    facts,
  )
  rt.check(
    facts.loginPage === true,
    'web_open(/wp-admin/edit.php) → web_observe: the agent read the WordPress sign-in form',
    facts,
  )
  rt.check(facts.help === 'requested', 'web_help(login) was taken by the platform', facts)
  const session = await openSession(db, state.taskF)
  state.sessionF = session.id
  rt.check(
    session.status === 'ready' && session.helpReason === 'login' && session.controller === 'agent',
    'browser_sessions: the session of the task is ready, held by the agent, with the help request `login`',
    { status: session.status, help: session.helpReason, controller: session.controller },
  )
  const questions = await rowsOf(db, state.taskF, 'feed.question')
  rt.check(
    questions.some((row) => row.kind === 'browser' && row.reason === 'login'),
    'the task waits (`awaiting_user`) with a `browser` question of reason `login` in its feed (Б23)',
    questions,
  )
  const feed = await state.owner.query('task.feed', { taskId: state.taskF })
  rt.check(
    feed.task.requirements?.browser === true &&
      feed.browser?.status === 'ready' &&
      feed.browser?.help?.reason === 'login' &&
      feed.commands.every((command) => command.id === 'cancel' || command.available === false),
    'task.feed: the head names the browser session, its help request, and only «Остановить» among the commands',
    { browser: feed.browser, commands: feed.commands },
  )
  const prompts = stand.model.requests.join('\n')
  rt.check(
    state.files.every((file) => prompts.includes(file.id)) &&
      !prompts.includes('inbox/') &&
      !/X-Amz-|presigned/i.test(prompts),
    'the model got the ids of the three files and the site, never a key or a link of S3',
  )
  if (stand.cabinet) await panelOpensOnLaunch(stand)
  else
    rt.note(
      'the cabinet has no browser pane in this build: the panel opening by itself as the browser of a dialog starts (И2) is not checked in this run',
    )
  rt.end()
}

/** What the client writes in «Новый диалог» of the cabinet in scenario D. */
const WATCHED_WORDS = 'Проверьте, открывается ли список записей в админке.'

/**
 * A dialog the client starts in «Новый диалог» of the cabinet and watches from its start
 * (docs/plan/59-dialog-tools-panel.md, И2, И3): its browser opens beside it by itself once, when
 * it starts — the start of the dialog speaks for its first answers, so it does not matter whether
 * the page read the feed before the session was ready or after —, and the focus stays where it
 * was. Hidden by the client, the panel does not come back while the turn goes on to ask for the
 * sign-in; a reload opens nothing. The dialog is then stopped, as the client stops it.
 */
async function panelOpensOnLaunch(stand) {
  const { rt, db, state } = stand
  const cabinet = await cabinetBrowser(stand, state.owner)
  let taskId
  try {
    stand.model.script('askToSignIn')
    const tab = await cabinet.start(WATCHED_WORDS)
    taskId = tab.taskId
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
    rt.check(
      task.siteId === state.siteId && task.needsBrowser === true && task.needsRepository === false,
      '«Новый диалог» in the cabinet: the page started a dialog in the browser (task.create with the id it invented: needs_browser, no repository) and moved to it',
      { needsBrowser: task.needsBrowser, needsRepository: task.needsRepository },
    )
    // Nothing is pressed from here on: the panel opens by itself, or not at all.
    await tab.panel.waitFor({ timeout: 180_000 })
    await tab.panel
      .getByRole('tab', { name: CABINET_TEXT.browserTab, selected: true })
      .waitFor({ timeout: 10_000 })
    const opened = await tab.seen()
    const session = await openSession(db, taskId)
    const appeared = opened.panels?.[0] ?? 0
    const ticketsBefore = tab.calls.filter(
      (call) => call.name === 'browser.streamTicket' && call.at < appeared,
    ).length
    // Which way it went: the page saw the session start, or the session was ready by the first
    // answer and the start of the dialog spoke for it (И3) — either opens the panel.
    const firstRead = tab.calls.find((call) => call.name === 'task.feed')?.at ?? null
    const lead =
      session?.readyAt && firstRead !== null ? session.readyAt.getTime() - firstRead : null
    const way =
      lead === null
        ? ''
        : lead >= 0
          ? ` — the page first read the dialog ${lead} ms before its browser was ready`
          : ` — its browser was ready ${-lead} ms before the page first read the dialog, and the start of the dialog spoke for it`
    rt.check(
      opened.panels?.length === 1 &&
        opened.focusIn === 0 &&
        !opened.focusInPanel &&
        session?.status === 'ready' &&
        ticketsBefore === 0,
      `the dialog watched from its start opened its panel «Инструменты диалога» by itself on «Браузер» once its browser was ready${way}: once, the focus never in the panel, nothing of the stream read before it (И2, И3, И11)`,
      {
        panels: opened.panels,
        focusIn: opened.focusIn,
        focusInPanel: opened.focusInPanel,
        session: session?.status,
        ticketsBefore,
      },
    )
    // The client hides it; the turn goes on, asks for the sign-in, and the panel stays closed.
    await tab.hidePanel()
    await rt.until('the focus to come back to «+»', () => tab.plusFocused(), {
      timeoutMs: 10_000,
      intervalMs: 100,
    })
    await firstTurn(stand, taskId)
    await tab.answers(2)
    const hidden = await tab.seen()
    const waiting = await tab.plus.getAttribute('aria-label')
    rt.check(
      hidden.panels?.length === 1 &&
        (await tab.panel.count()) === 0 &&
        waiting === CABINET_TEXT.toolsWaiting,
      `«Скрыть панель»: the panel goes and the focus is back on «+»; the turn went on to ask for the sign-in and the panel stayed closed — «+» says «${waiting}» (И2, И8, И13)`,
      { panels: hidden.panels, label: waiting },
    )
    // A reload: the browser is ready by the first answer of the new page, which opens nothing.
    const sockets = tab.sockets
    const calls = tab.calls.length
    await tab.reload()
    await tab.answers(2)
    const reloaded = await tab.seen()
    const label = await tab.plus.getAttribute('aria-label')
    rt.check(
      reloaded.panels?.length === 0 &&
        tab.sockets === sockets &&
        tab.called('browser.streamTicket', calls) === 0 &&
        label === CABINET_TEXT.toolsWaiting,
      'after a reload the panel stays closed though the browser is ready: no ticket and no socket of the stream, «+» keeps its dot (И1, И2, И11, И13)',
      {
        panels: reloaded.panels,
        sockets: tab.sockets - sockets,
        tickets: tab.called('browser.streamTicket', calls),
        label,
      },
    )
  } finally {
    await cabinet.close()
  }
  // Its browser closes with it; scenario M counts its session among the closed ones.
  await state.owner.mutate('task.cancel', { taskId, requestId: randomUUID() })
  await waitTask(stand, taskId, ['cancelled'], {
    what: 'the dialog started in the cabinet to close',
    timeoutMs: 120_000,
  })
}

// ─── B: no git ────────────────────────────────────────────────────────────────

async function scenarioB(stand) {
  const { rt, db, state } = stand
  rt.begin('B', 'нет git: ход без репозитория')
  rt.passed(
    'core runs without GITEA_URL, GITEA_TOKEN, GIT_CA_FILE and GIT_MIRROR_DIR (its environment, checked at start)',
  )
  const turns = await db.taskTurn.findMany({ where: { taskId: state.taskF } })
  rt.check(
    turns.length >= 1 &&
      turns.every(
        (turn) => turn.baseSha === null && turn.headSha === null && turn.status === 'completed',
      ),
    `task_turns of the task: ${turns.length} completed, base_sha and head_sha NULL`,
    turns.map((turn) => ({ status: turn.status, base: turn.baseSha, head: turn.headSha })),
  )
  const storage = await stand.storage()
  const manifests = []
  for (const turn of turns) {
    const bytes = await readObject(storage, 'sessions', `${turn.snapshotPrefix}manifest.json`)
    manifests.push(bytes ? JSON.parse(bytes.toString('utf8')) : null)
  }
  rt.check(
    manifests.length > 0 &&
      manifests.every(
        (manifest) =>
          manifest &&
          manifest.git === undefined &&
          manifest.parts.length === 1 &&
          manifest.parts[0].name === 'home',
      ),
    'the snapshot manifests of the turns in raditi-sessions have no `git` block and the `home` part alone (Б4)',
    manifests.map(
      (manifest) =>
        manifest && { git: manifest.git, parts: manifest.parts.map((part) => part.name) },
    ),
  )
  const coreLog = stand.processes.core.log()
  rt.check(
    !/\bgit (clone|fetch|push|bundle|init|checkout)\b/.test(coreLog),
    'the log of core names no git command',
  )
  rt.note(
    'the commands run in the sandbox are not logged by the local executor: «no git process in the sandbox» is proven by the manifest and the empty SHAs, not by an exec log',
  )
  rt.end()
}

// ─── C: the stream ────────────────────────────────────────────────────────────

async function scenarioC(stand) {
  const { rt, db, state } = stand
  rt.begin('C', 'трансляция: кадры, заголовок, переподключение')
  const ticket = await ticketOf(state.owner, state.taskF)
  rt.check(
    ticket.url === stand.streamUrl &&
      ticket.sessionId === state.sessionF &&
      /^[A-Za-z0-9_-]{43}$/.test(ticket.ticket),
    'browser.streamTicket: the address of the gateway, the session of the task and a one-time ticket',
    { url: ticket.url, session: ticket.sessionId },
  )
  const stored = await db.browserStreamTicket.findMany({ where: { sessionId: state.sessionF } })
  rt.check(
    stored.length >= 1 &&
      stored.every(
        (row) => row.tokenHash !== ticket.ticket && !JSON.stringify(row).includes(ticket.ticket),
      ),
    'the database keeps the hash of the ticket only (Б12)',
  )
  const started = Date.now()
  const viewer = openViewer(stand.streamTools, {
    url: ticket.url,
    origin: stand.webUrl,
    ticket: ticket.ticket,
  })
  await viewer.opened
  await rt.until('the first frame', async () => viewer.frames.length > 0, {
    timeoutMs: 15_000,
    intervalMs: 20,
  })
  const first = viewer.frames[0]
  rt.check(
    viewer.messages[0]?.t === 'viewer' &&
      viewer.messages.find((message) => message.t === 'state')?.session === state.sessionF,
    'the gateway sends `viewer` first, then the `state` of the session',
    viewer.messages.slice(0, 2).map((message) => message.t),
  )
  rt.check(
    first.sessionId === state.sessionF &&
      first.pageId === viewer.state.pageId &&
      first.viewportVersion === viewer.state.viewportVersion &&
      first.width === 1280 &&
      first.height === 800 &&
      first.controlEpoch === viewer.state.controlEpoch,
    `a frame right after connecting (${first.at - started} ms): its 48-byte header names the session, the page, the window 1280×800 and the epoch of the state`,
    { ...first, jpeg: first.jpeg.byteLength },
  )
  rt.check(
    jpegLooksPainted(first.jpeg),
    `the frame is a painted JPEG of the sign-in page (${first.jpeg.byteLength} bytes)`,
  )
  // The caret of the focused field repaints the page: frames keep coming while acknowledged.
  await rt.until('more frames', async () => viewer.frames.length >= 3, {
    timeoutMs: 20_000,
    intervalMs: 50,
  })
  const seqs = viewer.frames.map((frame) => frame.frameSeq)
  rt.check(
    seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]),
    `frames arrive with an increasing number (${seqs.slice(0, 6).join(', ')}…)`,
    seqs,
  )
  await rt.until(
    'a ping of the gateway',
    async () => viewer.messages.some((message) => message.t === 'ping'),
    { timeoutMs: 15_000, intervalMs: 100 },
  )
  rt.check(
    viewer.closed === null,
    'the gateway pings (every 10 s) and the answered connection stays open (Б14)',
  )
  const page = viewer.state.pageId
  viewer.close()
  await rt.until('the viewer to close', async () => viewer.closed !== null, {
    timeoutMs: 5_000,
    intervalMs: 20,
  })

  const again = await ticketOf(state.owner, state.taskF)
  const reconnected = Date.now()
  const second = openViewer(stand.streamTools, {
    url: again.url,
    origin: stand.webUrl,
    ticket: again.ticket,
  })
  await second.opened
  await rt.until('the first frame after reconnecting', async () => second.frames.length > 0, {
    timeoutMs: 10_000,
    intervalMs: 20,
  })
  rt.check(
    second.frames[0].pageId === page &&
      second.frames[0].sessionId === state.sessionF &&
      second.frames[0].at - reconnected < 5_000,
    `reconnect with a new ticket: a frame of the same page right away (${second.frames[0].at - reconnected} ms)`,
  )
  second.close()

  if (stand.cabinet) await canvasInCabinet(stand, state.taskF)
  else
    rt.note(
      'the cabinet has no browser pane in this build: the canvas of the dialog page is not checked in this run',
    )
  rt.end()
}

/**
 * The dialog page of the task in a real Chromium, as the client opens it: the chat alone — no panel
 * and nothing of the stream read, though the browser of the task is ready
 * (docs/plan/59-dialog-tools-panel.md, И1, И11). «+» → «Браузер» opens the panel on the browser:
 * its stream starts, the canvas draws the frames it gets (many colours, opaque) and acknowledges
 * them. A reload starts with the chat alone again, and the browser opened once more — a new
 * ticket, a new connection — draws the same page at once.
 */
async function canvasInCabinet(stand, taskId) {
  const { rt, state } = stand
  const cabinet = await cabinetBrowser(stand, state.owner)
  try {
    const tab = await cabinet.load(taskId)
    // A dialog opened with a live browser opens nothing by itself (И2): a few answers of its feed
    // and still no panel, no ticket and no socket.
    await tab.answers(2)
    const loaded = await tab.seen()
    rt.check(
      loaded.panels?.length === 0 && tab.sockets === 0 && tab.called('browser.streamTicket') === 0,
      'the dialog page opens with the chat alone though the browser of the task is ready: no panel «Инструменты диалога», no ticket and no socket of the stream (И1, И11)',
      {
        panels: loaded.panels,
        sockets: tab.sockets,
        tickets: tab.called('browser.streamTicket'),
      },
    )
    await tab.showBrowser()
    await rt.until(
      'the pane to get frames and acknowledge them',
      async () => tab.frames.length >= 2 && tab.acks >= 1,
      {
        timeoutMs: 60_000,
        intervalMs: 100,
      },
    )
    let painted = null
    const paintedBy = Date.now() + 30_000
    do {
      painted = await canvasPainted(tab)
      if (painted.colours > 20 && painted.drawn > 0.3) break
      await rt.pause(250)
    } while (Date.now() < paintedBy)
    rt.check(
      painted.colours > 20 && painted.drawn > 0.3,
      `«+» → «Браузер» opens the panel on the browser, and its canvas is painted from real frames: ${painted.colours} colours, ${Math.round(painted.drawn * 100)}% of its ${painted.width}×${painted.height} drawn (the rest is the letterbox)`,
      painted,
    )
    const seqs = tab.frames.map((frame) => frame.frameSeq)
    rt.check(
      tab.frames.every((frame) => frame.sessionId === state.sessionF) &&
        seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]) &&
        tab.acks >= 1,
      `the pane's own WebSocket: frames of the session with an increasing number (${seqs.slice(0, 5).join(', ')}…), each acknowledged after drawing (${tab.acks} acks)`,
    )
    // A reload: the chat alone again, nothing of the stream until the client opens the browser.
    const sockets = tab.sockets
    const calls = tab.calls.length
    const before = tab.frames.findLast((frame) => frame.socket <= sockets)
    await tab.reload()
    await tab.answers(2)
    const reloaded = await tab.seen()
    rt.check(
      reloaded.panels?.length === 0 &&
        tab.sockets === sockets &&
        tab.called('browser.streamTicket', calls) === 0,
      'after a reload of the page the panel is closed again: no ticket and no socket until the client opens the browser (И1, И11)',
      {
        panels: reloaded.panels,
        sockets: tab.sockets - sockets,
        tickets: tab.called('browser.streamTicket', calls),
      },
    )
    const chosen = Date.now()
    await tab.showBrowser()
    const frame = await rt.until(
      'a frame of the browser opened again after the reload',
      async () => tab.frames.find((one) => one.socket > sockets) ?? null,
      { timeoutMs: 60_000, intervalMs: 100 },
    )
    rt.check(
      tab.called('browser.streamTicket', calls) >= 1 &&
        frame.sessionId === state.sessionF &&
        frame.pageId === before?.pageId,
      `opened again after the reload, the browser takes a new ticket and a new connection and draws the same page at once (${frame.at - chosen} ms after «Браузер» was chosen)`,
    )
  } finally {
    await cabinet.close()
  }
}

// ─── E: the client signs in, writes in Russian, two tabs ──────────────────────

const OWNER_DRAFT = 'Черновик владельца: ёжик и щука в тумане'

async function scenarioE(stand) {
  const { rt, db, site, state } = stand
  rt.begin('E', 'ручной вход в том же браузере, русский ввод, параллельное управление')
  const before = await db.browserSession.findUniqueOrThrow({ where: { id: state.sessionF } })
  let cabinet = null
  let operator
  if (stand.cabinet) {
    cabinet = await cabinetBrowser(stand, state.owner)
    operator = cabinetOperator(stand, await cabinet.open(state.taskF))
  } else {
    rt.note(
      'the cabinet has no browser pane in this build: the client acts over the stream as the canvas would',
    )
    operator = await streamOperatorOf(stand, state.owner, state.taskF)
  }
  const how =
    operator.kind === 'cabinet'
      ? 'in the cabinet (real key events into the pane)'
      : 'over the stream'
  try {
    if (operator.kind === 'cabinet') {
      // «Взять управление» works with the panel closed (docs/plan/59-dialog-tools-panel.md, И12):
      // the button of the card of the request opens the browser and takes the control there, so
      // the client has the page to sign in on.
      const { tab } = operator
      await tab.hidePanel()
      const sockets = tab.sockets
      await tab.takeFromCard()
      rt.check(
        tab.holds() && tab.sockets > sockets,
        '«Скрыть панель», then «Взять управление» on the card of the request in the feed: the panel opens again on «Браузер», on a new connection, and this tab holds the control (И8, И12)',
        { sockets: tab.sockets - sockets, state: tab.state },
      )
    }
    await signIn(stand, operator, site.accounts.owner)
    const held = await db.browserSession.findUniqueOrThrow({ where: { id: state.sessionF } })
    rt.check(
      held.controller === 'user' && held.controlEpoch > before.controlEpoch,
      `«Взять управление» ${how}: the session is the client's, epoch ${before.controlEpoch} → ${held.controlEpoch} (Б15)`,
    )
    const cookies = await site.cookies()
    rt.check(
      operator.state().url.includes('/wp-admin/edit.php') && cookies.length >= 2,
      `the client signed in in the same browser ${how}: login and password typed, the list of posts open, the site set its sign-in cookies`,
      { url: operator.state().url, cookies: cookies.length },
    )
    // Russian in the block editor, saved with Ctrl+S.
    await operator.navigate(`${SITE_ORIGIN}/wp-admin/post-new.php`)
    await rt.until(
      'the editor of a new post',
      async () => operator.state()?.url.includes('/wp-admin/post-new.php') ?? false,
      {
        timeoutMs: 20_000,
        intervalMs: 100,
      },
    )
    await rt.pause(5000)
    // The welcome guide of the editor closes with Escape; the title field then has the focus.
    await operator.press('Escape')
    await rt.pause(800)
    await operator.type(OWNER_DRAFT)
    await rt.pause(500)
    await operator.press('Control+s')
    const draft = await rt.until(
      'the draft with the Russian title in the database of the site',
      async () =>
        (await site.objects()).find(
          (row) => row.type === 'post' && row.title === OWNER_DRAFT && row.status === 'draft',
        ) ?? null,
      { timeoutMs: 30_000, intervalMs: 1000 },
    )
    rt.check(
      Boolean(draft),
      `Russian text typed ${how} and Ctrl+S: WordPress holds the draft «${OWNER_DRAFT}» (post ${draft.id})`,
    )
    state.ownerDraft = draft.id

    // A second tab of the cabinet is refused while the first holds, then takes over.
    const other = await watch(stand, state.owner, state.taskF)
    await refusedWith(stand, other, () => other.text('x'), 'not_holder')
    rt.passed("a second viewer's input is refused while the first holds control (`not_holder`)")
    const oldEpoch = other.state.controlEpoch
    other.send({ t: 'take' })
    await stateWhere(stand, other, () => other.holds(), 'the second viewer to take control')
    rt.check(
      other.state.controlEpoch > oldEpoch,
      `the second viewer took control explicitly: epoch ${oldEpoch} → ${other.state.controlEpoch}`,
    )
    if (operator.kind === 'cabinet') {
      await rt.until(
        'the first tab to show the control is elsewhere',
        async () => operator.otherTabShown(),
        { timeoutMs: 10_000, intervalMs: 100 },
      )
      rt.passed(
        'the first tab of the cabinet says the browser is controlled in another tab and sends nothing',
      )
      await operator.tab.page
        .getByLabel(CABINET_TEXT.keyboard)
        .focus()
        .catch(() => {})
      await refusedWith(
        stand,
        other,
        () => other.input({ kind: 'text', text: 'z' }, { ...other.state, controlEpoch: oldEpoch }),
        'stale_epoch',
      )
      rt.passed('input stamped with the epoch before the hand-over is refused (`stale_epoch`)')
    } else {
      await refusedWith(stand, operator.viewer, () => operator.viewer.text('y'), 'not_holder')
      await refusedWith(
        stand,
        other,
        () => other.input({ kind: 'text', text: 'z' }, { ...other.state, controlEpoch: oldEpoch }),
        'stale_epoch',
      )
      rt.passed(
        "the first viewer's input is refused now (`not_holder`), and input stamped with the epoch before the hand-over is refused (`stale_epoch`)",
      )
    }

    // «Продолжить работу агента» of the waiting task: the next turn takes control. The pass that
    // asked for the sign-in completed and was charged (owner's answer of 26.10.2026: every
    // completed pass is paid), so the press opens the next attempt with a reserve of its own;
    // while that charge waits for the usage of the key, it continues the same attempt.
    const attempt = (await db.task.findUniqueOrThrow({ where: { id: state.taskF } })).attempt
    const charged =
      (await db.creditHold.count({ where: { taskId: state.taskF, attempt, status: 'active' } })) ===
      0
    if (operator.kind === 'cabinet') {
      // The first tab takes the browser back and gives it to the agent with its own button.
      await operator.take()
      stand.model.script('publishNews', { words: TEXT_F })
      await operator.resume()
    } else await resumeWith(stand, state.owner, state.taskF, 'publishNews', { words: TEXT_F })
    await stateWhere(
      stand,
      other,
      (current) => current.controller === 'agent',
      'the next turn to take the browser back',
      120_000,
    )
    const requests = await rowsOf(stand.db, state.taskF, 'feed.request')
    const resumed = await db.task.findUniqueOrThrow({ where: { id: state.taskF } })
    rt.check(
      requests.some((row) => row.kind === 'resume') &&
        resumed.attempt === (charged ? attempt + 1 : attempt),
      `«Продолжить работу агента» ${operator.kind === 'cabinet' ? 'pressed in the cabinet' : '(task.resumeAgent)'}: a \`resume\` request in the feed, ${charged ? 'the next attempt after the charged pass' : 'the same attempt'}, and the next turn takes the browser back (Б16)`,
    )
    other.close()
  } finally {
    await Promise.resolve()
      .then(() => operator.close())
      .catch(() => {})
    await cabinet?.close().catch(() => {})
  }
  rt.end()
}

// ─── F: the post with two images and a PDF ────────────────────────────────────

async function scenarioF(stand) {
  const { rt, db, site, state } = stand
  rt.begin('F', 'новость с двумя картинками и PDF: публикация и проверка')
  const baseline = state.ownerDraft ?? 0
  const task = await waitAnswered(stand, state.taskF, {
    what: 'the task to answer',
    timeoutMs: 900_000,
  })
  const facts = stand.model.current().facts
  rt.check(
    facts.featured === true,
    'the agent set the featured image in the media window of the editor',
  )
  rt.check(
    (facts.held ?? 0) >= 1,
    `the worker held a second commit back until web_verify read the post (BROWSER_CHECKPOINT_UNVERIFIED, ${facts.held}×), and the agent went on after the check (Б22)`,
    facts,
  )
  const results = await rowsOf(db, state.taskF, 'feed.result')
  const result = results.at(-1)
  const object = result?.objects?.find((item) => item.status === 'published')
  rt.check(
    task.status === 'awaiting_user' &&
      result?.next === 'awaiting_user' &&
      object &&
      object.kind === 'post' &&
      object.title === TEXT_F.title &&
      typeof object.url === 'string' &&
      object.url.startsWith(SITE_ORIGIN),
    `the task answered with feed.result naming the post as the site shows it: «${object?.title}», published, ${object?.url}; the dialog stays open`,
    result,
  )
  rt.check(result.site === 'changed', 'the result says the site changed')
  const holds = await db.creditHold.findMany({ where: { taskId: state.taskF } })
  const charged = holds.reduce((sum, hold) => sum + Number(hold.charged ?? 0), 0)
  const audit = await db.auditLog.findFirst({
    where: { action: 'billing.task.charge', targetId: state.taskF },
  })
  rt.check(
    charged >= 5 && audit !== null && holds.every((hold) => hold.status !== 'active'),
    `every pass is charged from its token usage when it ends: ${charged} credits, the reserves settled (billing.task.charge)`,
    holds.map((hold) => ({ status: hold.status, charged: hold.charged })),
  )
  const objects = await site.objects({ after: baseline })
  const posts = objects.filter((row) => row.type === 'post' && row.status === 'publish')
  const post = posts[0]
  const files = objects.filter((row) => row.type === 'attachment' && row.parent === post?.id)
  const thumbnail = post ? Number(await site.meta(post.id, '_thumbnail_id')) : 0
  rt.check(
    posts.length === 1 && post.title === TEXT_F.title,
    `WordPress: exactly one new published post «${post?.title}» (id ${post?.id})`,
    objects,
  )
  rt.check(
    files.length === 3 &&
      files.filter((row) => row.mime === 'image/png').length === 2 &&
      files.some((row) => row.mime === 'application/pdf'),
    'WordPress: three attachments of the post — the two images and the PDF',
    files,
  )
  rt.check(
    files.some((row) => row.id === thumbnail && row.mime === 'image/png'),
    `WordPress: the featured image of the post is one of its images (attachment ${thumbnail})`,
  )
  const content = await site.content(post.id)
  rt.check(
    content.includes(TEXT_F.text) && content.includes('wp:image') && content.includes('wp:file'),
    'the content of the post holds the text, an Image block and a File block',
  )
  const page = await site.page(`/?p=${post.id}`)
  rt.check(
    page.status === 200 && page.text.includes(TEXT_F.title),
    `the post is public: /?p=${post.id} answers 200 with its title`,
  )
  const session = await db.browserSession.findUniqueOrThrow({ where: { id: state.sessionF } })
  rt.check(
    session.closedAt === null && ['starting', 'ready'].includes(session.status),
    'the session lives on after the answer for the next words: it closes on its idle time or with the dialog (Б18)',
    { status: session.status, reason: session.closeReason },
  )
  rt.end()
}

// ─── G: a draft ───────────────────────────────────────────────────────────────

async function scenarioG(stand) {
  const { rt, site, state, db } = stand
  rt.begin('G', 'черновик по поручению: ничего не опубликовано')
  const words = {
    title: 'Скоро распродажа тюльпанов',
    text: 'В субботу продаём тюльпаны со скидкой.',
  }
  const baseline = await site.lastId()
  const { taskId, task, facts } = await taskWithProgram(stand, state.owner, {
    text: `Подготовьте новость «${words.title}»: ${words.text} Сохраните черновик, не публикуйте.`,
    account: site.accounts.owner,
    program: 'keepDraft',
    ctx: { words, foreignAttachment: state.foreignAttachment },
    until: ['awaiting_user'],
  })
  rt.check(
    facts.foreign === 'BROWSER_ATTACHMENT_UNKNOWN',
    "web_upload with another client's file is refused by mcp (BROWSER_ATTACHMENT_UNKNOWN)",
    facts,
  )
  const result = (await rowsOf(db, taskId, 'feed.result')).at(-1)
  const object = result?.objects?.[0]
  rt.check(
    task.status === 'awaiting_user' &&
      result?.next === 'awaiting_user' &&
      object?.status === 'draft' &&
      object.url === undefined &&
      object.title === words.title,
    'the answer names the draft as the site shows it: status draft, no public address',
    result,
  )
  const objects = await site.objects({ after: baseline })
  rt.check(
    objects.filter((row) => row.type === 'post').length === 1 &&
      objects.some(
        (row) => row.type === 'post' && row.status === 'draft' && row.title === words.title,
      ) &&
      !objects.some((row) => row.status === 'publish'),
    'WordPress: one new post, a draft; nothing published',
    objects,
  )
  rt.end()
}

// ─── H: an account that cannot publish ────────────────────────────────────────

async function scenarioH(stand) {
  const { rt, site, state, db } = stand
  rt.begin('H', 'недостаточно прав: «Submit for Review», не публикация')
  const words = {
    title: 'Новые горшки для рассады',
    text: 'Привезли глиняные горшки трёх размеров.',
  }
  const baseline = await site.lastId()
  const { taskId, task, facts } = await taskWithProgram(stand, state.owner, {
    text: `Опубликуйте новость «${words.title}»: ${words.text}`,
    account: site.accounts.contributor,
    program: 'submitForReview',
    ctx: { words },
    until: ['awaiting_user'],
  })
  rt.check(
    facts.submitButton === true && facts.publishButton === false,
    'the editor offers the contributor «Submit for Review», not «Publish»',
    facts,
  )
  const result = (await rowsOf(db, taskId, 'feed.result')).at(-1)
  rt.check(
    task.status === 'awaiting_user' &&
      result?.objects?.[0]?.status === 'pending' &&
      Boolean(facts.pending) &&
      /отправили «.+» на утверждение/.test(result.message),
    'the result is honest: the post is pending review, the client is told it waits for an editor',
    result,
  )
  const objects = await site.objects({ after: baseline })
  rt.check(
    objects.some((row) => row.type === 'post' && row.status === 'pending') &&
      !objects.some((row) => row.status === 'publish'),
    'WordPress: the post is pending; nothing published',
    objects,
  )
  rt.end()
}

// ─── I: the site refuses the PDF; the task is stopped ─────────────────────────

async function scenarioI(stand) {
  const { rt, site, state, db } = stand
  rt.begin('I', 'сайт не принял файл; «Остановить» с объектами и «проверьте сайт»')
  const words = {
    title: 'Прайс на осень',
    text: 'Осенние цены на луковицы — в приложенном файле.',
    refusal: 'Файл больше 20 КБ',
  }
  const big = await uploadFile(state.owner, {
    siteId: state.siteId,
    name: 'prais-osen.pdf',
    type: 'application/pdf',
    bytes: syntheticPdf('Осенний прайс', UPLOAD_LIMIT_BYTES + 10_000),
  })
  rt.check(
    big.upload?.status >= 200 && big.upload.status < 300,
    "the large PDF is taken by the platform (the site's limit is the site's)",
  )
  await site.switches.on(SWITCH.uploadLimit)
  const baseline = await site.lastId()
  try {
    const { taskId, task, facts } = await taskWithProgram(stand, state.owner, {
      text: `Опубликуйте новость «${words.title}»: ${words.text} Приложите PDF.`,
      attachments: [big.id],
      account: site.accounts.owner,
      program: 'uploadRefused',
      ctx: { words },
      until: ['awaiting_user'],
    })
    rt.check(
      facts.refusalShown === true,
      'the site refused the PDF with its own words, and the agent read them in the editor',
      facts,
    )
    const questions = await rowsOf(db, taskId, 'feed.question')
    const results = await rowsOf(db, taskId, 'feed.result')
    rt.check(
      task.status === 'awaiting_user' &&
        questions.at(-1)?.kind === 'browser' &&
        questions.at(-1)?.reason === 'other' &&
        results.length === 0,
      'the agent reported the refusal and asked the client (`web_help`, reason other); the task waits, nothing is done',
      { questions, results },
    )
    const objects = await site.objects({ after: baseline })
    rt.check(
      !objects.some((row) => row.status === 'publish') &&
        !objects.some((row) => row.mime === 'application/pdf') &&
        objects.some(
          (row) => row.type === 'post' && row.status === 'draft' && row.title === words.title,
        ),
      'WordPress: the draft only — no published post, no PDF in the media library',
      objects,
    )
    const session = await openSession(db, taskId)
    await state.owner.mutate('task.cancel', { taskId, requestId: randomUUID() })
    const cancelled = await waitTask(stand, taskId, ['cancelled'], {
      what: 'the cancellation of the task',
      timeoutMs: 120_000,
    })
    const row = (await rowsOf(db, taskId, 'feed.cancelled')).at(-1)
    rt.check(
      cancelled.status === 'cancelled' &&
        row?.site === 'check' &&
        row?.objects?.some((item) => item.status === 'draft' && item.title === words.title),
      '«Остановить»: feed.cancelled names the draft as the site shows it and says to check the site (Б24, Б28)',
      row,
    )
    const closed = await db.browserSession.findUniqueOrThrow({ where: { id: session.id } })
    const left = await rt.until(
      'the containers of the cancelled session to go',
      async () => {
        const found = await sessionResources(rt, session.id)
        return found.containers.length === 0 && found.networks.length === 0 ? found : null
      },
      { timeoutMs: 60_000, intervalMs: 1000 },
    )
    rt.check(
      closed.status === 'closed' &&
        closed.closeReason === 'task_cancelled' &&
        left.containers.length === 0,
      "the cancelled task's session is closed (task_cancelled) and its containers and network are gone; nothing on the site was deleted",
    )
    const still = await site.objects({ after: baseline })
    rt.check(
      still.some(
        (item) => item.type === 'post' && item.status === 'draft' && item.title === words.title,
      ),
      'the draft is still on the site after the cancellation',
    )
  } finally {
    await site.switches.off(SWITCH.uploadLimit)
  }
  rt.end()
}

// ─── J: a publish slower than the agent waits ─────────────────────────────────

async function scenarioJ(stand) {
  const { rt, site, state, db } = stand
  rt.begin('J', 'нет дубликата после долгой публикации')
  const words = {
    title: 'Ярмарка саженцев в воскресенье',
    text: 'Ждём всех на ярмарке саженцев у магазина.',
  }
  const baseline = await site.lastId()
  const { taskId, task, facts } = await taskWithProgram(stand, state.owner, {
    text: `Опубликуйте новость «${words.title}»: ${words.text}`,
    account: site.accounts.owner,
    program: 'publishAfterTimeout',
    ctx: { words },
    until: ['awaiting_user'],
    before: () => site.switches.on(SWITCH.publishDelay),
  })
  rt.check(
    facts.waitMatched === false,
    'the site held the publish longer than the agent waited for it (web_wait: not published)',
    facts,
  )
  rt.check(
    facts.newPostRefused === 'BROWSER_CHECKPOINT_UNVERIFIED' &&
      ['BROWSER_CHECKPOINT_UNVERIFIED', 'none'].includes(facts.secondPublish),
    `the worker refused a new post while the publish was unconfirmed (BROWSER_CHECKPOINT_UNVERIFIED); a second publish: ${facts.secondPublish}`,
    facts,
  )
  rt.check(Boolean(facts.published), 'web_verify read the post published once the site finished')
  rt.check(
    !(await site.switches.isOn(SWITCH.publishDelay)),
    'the slow publish of the site happened (its switch was spent)',
  )
  const objects = await site.objects({ after: baseline })
  const posts = objects.filter((row) => row.type === 'post' && row.title === words.title)
  rt.check(
    task.status === 'awaiting_user' && posts.length === 1 && posts[0].status === 'publish',
    'WordPress: exactly one post, published — no duplicate',
    objects,
  )
  const result = (await rowsOf(db, taskId, 'feed.result')).at(-1)
  rt.check(
    result?.objects?.some((item) => item.status === 'published'),
    'the answer names the published post',
    result,
  )
  rt.end()
}

// ─── K: isolation and access ──────────────────────────────────────────────────

async function scenarioK(stand) {
  const { rt, state, db } = stand
  rt.begin('K', 'изоляция и доступ')
  const taskId = await newBrowserTask(stand, state.owner, {
    text: 'Проверьте, открывается ли админка сайта.',
    // Another client's file, and a file of another task of the same client.
    ctx: { foreignAttachments: [state.foreignAttachment, state.files[0].id] },
  })
  await firstTurn(stand, taskId)
  const session = await openSession(db, taskId)
  state.taskK = taskId
  const foreign = await state.stranger.call('mutation', 'browser.streamTicket', { taskId })
  rt.check(
    !foreign.ok && /NOT_FOUND/.test(JSON.stringify(foreign)),
    "browser.streamTicket of another client's task → NOT_FOUND",
    foreign,
  )

  const ticket = await ticketOf(state.owner, taskId)
  const first = openViewer(stand.streamTools, {
    url: ticket.url,
    origin: stand.webUrl,
    ticket: ticket.ticket,
  })
  await first.opened
  await rt.until('the first viewer', async () => first.frames.length > 0, {
    timeoutMs: 15_000,
    intervalMs: 50,
  })
  const reused = openViewer(stand.streamTools, {
    url: ticket.url,
    origin: stand.webUrl,
    ticket: ticket.ticket,
  })
  await reused.opened
  await rt.until('the reused ticket to be refused', async () => reused.closed !== null, {
    timeoutMs: 15_000,
    intervalMs: 50,
  })
  rt.check(
    reused.closed.code === 4401 && reused.frames.length === 0,
    `a used ticket is refused: closed ${reused.closed.code}, no frame`,
  )
  first.close()

  const fresh = await ticketOf(state.owner, taskId)
  const evil = openViewer(stand.streamTools, {
    url: fresh.url,
    origin: 'http://evil.example',
    ticket: fresh.ticket,
  })
  const refused = await evil.opened.then(
    () => null,
    (error) => error,
  )
  rt.check(
    refused?.status === 403,
    `a connection from another Origin is refused before the upgrade (${refused?.status})`,
  )
  const silent = openViewer(stand.streamTools, {
    url: fresh.url,
    origin: stand.webUrl,
    ticket: fresh.ticket,
    hello: false,
  })
  await silent.opened
  await rt.until('no hello to be closed', async () => silent.closed !== null, {
    timeoutMs: 20_000,
    intervalMs: 100,
  })
  rt.check(
    silent.closed.code === 4401 && silent.frames.length === 0,
    `a connection without hello gets nothing and is closed (${silent.closed.code})`,
  )

  const bare = await exchange(`${stand.workerUrl}/v1/sessions`)
  const wrong = await exchange(`${stand.workerUrl}/v1/sessions`, {
    headers: { authorization: 'Bearer not-the-token-of-the-worker-at-all-0000' },
  })
  const act = await exchange(`${stand.workerUrl}/v1/sessions/${session.id}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId, assignmentId: randomUUID(), action: { tool: 'web_observe' } }),
  })
  rt.check(
    bare.status === 401 && wrong.status === 401 && act.status === 401,
    'the worker API without its token (and with a wrong one) answers 401, the actions endpoint included',
  )
  const facts = stand.model.current().facts
  rt.check(
    facts.foreignAll?.length === 2 &&
      facts.foreignAll.every((code) => code === 'BROWSER_ATTACHMENT_UNKNOWN'),
    "web_upload through mcp of another client's file and of another task's file is refused (BROWSER_ATTACHMENT_UNKNOWN)",
    facts,
  )

  await networkProbes(stand, session.id)
  stand.state.sessionLogs = await sessionContainerLogs(rt, session.id)
  await state.owner.mutate('task.cancel', { taskId, requestId: randomUUID() })
  await waitTask(stand, taskId, ['cancelled'], {
    what: 'the cancellation of task K',
    timeoutMs: 120_000,
  })
  rt.end()
}

/** The three containers of a session by their role label. */
async function sessionContainers(rt, sessionId) {
  const out = {}
  for (const role of ['browser', 'egress', 'forwarder']) {
    const id = (
      await rt.docker([
        'ps',
        '-q',
        '--filter',
        `label=io.raditi.browser.session=${sessionId}`,
        '--filter',
        `label=io.raditi.browser.role=${role}`,
      ])
    ).output.trim()
    out[role] = id || null
  }
  return out
}

async function sessionContainerLogs(rt, sessionId) {
  const containers = await sessionContainers(rt, sessionId)
  let text = ''
  for (const id of Object.values(containers)) if (id) text += (await rawDocker(['logs', id])).output
  return text
}

/**
 * From the session's Chromium container: the services of the host (core, web, mcp, llm, the
 * worker, OpenBao, S3, the site's published port) and the metadata address are unreachable, each
 * with a control that reaches it (the egress container, on the default bridge); through the egress
 * proxy, an unlisted host and the metadata address are refused, the site of the task answers.
 */
async function networkProbes(stand, sessionId) {
  const { rt } = stand
  const containers = await sessionContainers(rt, sessionId)
  if (!containers.browser || !containers.egress)
    throw new CheckFailed('the session has no browser or egress container')
  const hosts = (await rt.docker(['exec', containers.egress, 'cat', '/etc/hosts'])).output
  const gateway = /^(\d+\.\d+\.\d+\.\d+)\s+host\.docker\.internal/m.exec(hosts)?.[1]
  if (!gateway) throw new CheckFailed('the egress container has no host.docker.internal')
  const probe = (container, host, port) =>
    rt
      .docker(['exec', container, 'node', '-e', NODE_ERRNO_PROBE, host, String(port)], {
        allowFailure: true,
      })
      .then((answer) => answer.output.trim())
  const targets = ['core', 'web', 'mcp', 'llm', 'browser', 'vault', 's3', 'site'].map((name) => [
    name,
    gateway,
    stand.ports[name],
  ])
  // The web server of the site itself, where the egress proxy reaches it.
  const [siteIp, sitePort] = stand.site.target.split(':')
  targets.push(['the site on the bridge', siteIp, Number(sitePort)])
  const blocked = []
  const control = []
  for (const [name, host, port] of targets) {
    const answer = await probe(containers.browser, host, port)
    if (!isolatedAnswer(answer)) blocked.push(`${name}:${answer}`)
    const reached = await probe(containers.egress, host, port)
    if (reached !== 'open') control.push(`${name}:${reached}`)
  }
  rt.check(
    control.length === 0,
    `control: the egress container reaches every service of the host at ${gateway} and the site's web server`,
    control,
  )
  rt.check(
    blocked.length === 0,
    "Chromium's container reaches none of them: core, web, mcp, llm, the worker, OpenBao, S3, the site's published port and its web server (unreachable, not refused)",
    blocked,
  )
  const metadata = await probe(containers.browser, '169.254.169.254', 80)
  rt.check(
    isolatedAnswer(metadata),
    `Chromium's container does not reach 169.254.169.254 (${metadata})`,
  )
  const egressIp = (
    await rt.docker([
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
      containers.egress,
    ])
  ).output
    .trim()
    .split(/\s+/)
  const browserNet = (
    await rt.docker([
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
      containers.browser,
    ])
  ).output
    .trim()
    .split(/\s+/)[0]
  const proxy = egressIp.find(
    (ip) => ip.split('.').slice(0, 3).join('.') === browserNet.split('.').slice(0, 3).join('.'),
  )
  const viaProxy = (target) =>
    rt
      .docker(['exec', containers.browser, 'node', '-e', PROXY_PROBE, proxy, target], {
        allowFailure: true,
      })
      .then((answer) => answer.output.trim())
  const site = await viaProxy(`${SITE_ORIGIN}/wp-login.php`)
  const metadataProxy = await viaProxy('http://169.254.169.254/latest/meta-data/')
  const unlisted = await viaProxy('CONNECT example.com:443')
  const hostService = await viaProxy(`http://host.docker.internal:${stand.ports.core}/health`)
  rt.check(
    site === '200',
    `control: through the egress proxy the site of the task answers (${site})`,
  )
  rt.check(
    metadataProxy !== '200' &&
      unlisted !== '200' &&
      hostService !== '200' &&
      [metadataProxy, unlisted, hostService].every((answer) => /^4\d\d$/.test(answer)),
    `through the egress proxy: the metadata address (${metadataProxy}), an unlisted host (${unlisted}) and a service of the host (${hostService}) are refused`,
  )
}

/** One request through the proxy from the browser's container: the status, or the error. */
const PROXY_PROBE = [
  "const http = require('http'); const [proxy, target] = process.argv.slice(1);",
  'const done = (text) => { process.stdout.write(String(text)); process.exit(0) };',
  "if (target.startsWith('CONNECT ')) { const req = http.request({ host: proxy, port: 3128, method: 'CONNECT', path: target.slice(8), timeout: 8000 });",
  "  req.on('connect', (res) => done(res.statusCode)); req.on('response', (res) => done(res.statusCode)); req.on('error', (e) => done('error:' + e.code)); req.on('timeout', () => done('timeout')); req.end(); }",
  "else { const url = new URL(target); const req = http.request({ host: proxy, port: 3128, method: 'GET', path: target, headers: { host: url.host }, timeout: 8000 },",
  "  (res) => { res.resume(); done(res.statusCode) }); req.on('error', (e) => done('error:' + e.code)); req.on('timeout', () => done('timeout')); req.end(); }",
].join('\n')

// ─── L: no secrets anywhere ───────────────────────────────────────────────────

async function scenarioL(stand) {
  const { rt, db, site } = stand
  rt.begin('L', 'нет секретов входа в модели, журналах, событиях и S3')
  const cookies = await site.cookies()
  const secrets = {}
  for (const [key, account] of Object.entries(site.accounts))
    secrets[`password of ${key}`] = account.password
  cookies.forEach((value, index) => {
    secrets[`cookie ${index + 1}`] = value
    const [, , token, hmac] = value.split('|')
    if (token) secrets[`cookie ${index + 1} token`] = token
    if (hmac) secrets[`cookie ${index + 1} hmac`] = hmac
  })
  rt.check(
    cookies.length >= 2 && Object.keys(secrets).length >= 4,
    `the stand knows ${cookies.length} sign-in cookie values the site set and the passwords of its two accounts`,
  )
  const model = stand.model.requests.join('\n')
  rt.check(
    leakedIn(model, secrets).length === 0,
    `${stand.model.requests.length} requests to the model hold no password and no cookie value`,
    leakedIn(model, secrets),
  )
  for (const [name, service] of Object.entries(stand.processes))
    rt.check(
      leakedIn(service.log(), secrets).length === 0,
      `the log of ${name} holds none of them`,
      leakedIn(service.log(), secrets),
    )
  if (stand.state.sessionLogs !== undefined)
    rt.check(
      leakedIn(stand.state.sessionLogs, secrets).length === 0,
      "the logs of a session's containers (Chromium, egress, forwarder) hold none of them",
    )
  const events = await db.taskEvent.findMany({})
  rt.check(
    leakedIn(events.map((event) => JSON.stringify(event.payload)).join('\n'), secrets).length === 0,
    `${events.length} task_events of every task hold none of them`,
  )
  const sessions = await db.browserSession.findMany({})
  rt.check(
    leakedIn(JSON.stringify(sessions), secrets).length === 0,
    'browser_sessions rows hold none of them',
  )
  const scanned = await scanS3(stand, secrets)
  rt.check(
    scanned.leaks.length === 0 && scanned.homes > 0,
    `S3: ${scanned.objects} objects of the run (raw) and ${scanned.homes} decrypted session homes hold none of them`,
    scanned.leaks,
  )
  rt.end()
}

/** Every object of every bucket, as stored and — the session homes — decrypted. */
async function scanS3(stand, secrets) {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = stand.s3Sdk
  const client = new S3Client({
    endpoint: stand.s3.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: stand.s3.accessKey, secretAccessKey: stand.s3.secretKey },
  })
  const leaks = []
  let objects = 0
  let homes = 0
  try {
    for (const bucket of [
      'raditi-inbox',
      'raditi-sessions',
      'raditi-logs',
      'raditi-artifacts',
      'raditi-backups',
      'raditi-platform',
    ]) {
      let token
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
        )
        for (const item of page.Contents ?? []) {
          const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: item.Key }))
          const bytes = Buffer.from(await object.Body.transformToByteArray())
          objects += 1
          const found = leakedIn(bytes.toString('latin1'), secrets)
          if (found.length > 0) leaks.push(`${bucket}/${item.Key}: ${found.join(', ')}`)
          if (bucket === 'raditi-sessions' && item.Key.endsWith('manifest.json')) {
            const home = await openHome(
              stand,
              client,
              GetObjectCommand,
              JSON.parse(bytes.toString('utf8')),
            )
            homes += 1
            const inside = leakedIn(home.toString('latin1'), secrets)
            if (inside.length > 0) leaks.push(`${item.Key} (decrypted home): ${inside.join(', ')}`)
          }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (token)
    }
  } finally {
    client.destroy()
  }
  return { leaks, objects, homes }
}

/** The home part of a session snapshot, decrypted with its data key from Transit and unpacked. */
async function openHome(stand, client, GetObjectCommand, manifest) {
  const part = manifest.parts.find((item) => item.name === 'home')
  const object = await client.send(
    new GetObjectCommand({ Bucket: 'raditi-sessions', Key: part.key }),
  )
  const body = Buffer.from(await object.Body.transformToByteArray())
  const unwrapped = await stand.vault.request(`transit/decrypt/${part.encryption.keyId}`, {
    method: 'POST',
    body: { ciphertext: part.encryption.wrappedKey },
  })
  const key = Buffer.from(unwrapped.data.plaintext, 'base64')
  const { parts: _parts, ...base } = manifest
  const { decryptPart, snapshotAad } = stand.modules.snapshots
  try {
    const plain = decryptPart(
      body,
      key,
      snapshotAad(base, 'home'),
      part.encryption.iv,
      part.encryption.tag,
    )
    return zstdDecompressSync(Buffer.from(plain))
  } finally {
    key.fill(0)
  }
}

// ─── M: cleanup ───────────────────────────────────────────────────────────────

async function scenarioM(stand) {
  const { rt, db, state } = stand
  rt.begin('M', 'уборка: сессии закрыты, контейнеры и сети удалены')
  // A dialog stays open after an answer (26.10.2026): the client closes what is left with
  // «Остановить», and core closes the browser of each.
  const open = await db.task.findMany({
    where: { siteId: state.siteId, status: { in: ['awaiting_user', 'awaiting_approval'] } },
    select: { id: true },
  })
  for (const { id } of open) {
    await state.owner.mutate('task.cancel', { taskId: id, requestId: randomUUID() })
    await waitTask(stand, id, ['cancelled'], {
      what: 'the open dialog to close',
      timeoutMs: 120_000,
    })
  }
  const sessions = await rt.until(
    'every session of the site to close',
    async () => {
      const rows = await db.browserSession.findMany({ where: { siteId: state.siteId } })
      return rows.every((session) => session.closedAt !== null) ? rows : null
    },
    { timeoutMs: 120_000, intervalMs: 1000, service: stand.processes.core },
  )
  const tasks = await db.task.findMany({ where: { siteId: state.siteId } })
  rt.check(
    tasks.every((task) => ENDED.has(task.status)),
    `every task of the site ended (${tasks.map((task) => task.status).join(', ')})`,
  )
  const unclosed = sessions.filter((session) => session.closedAt === null)
  rt.check(
    unclosed.length === 0,
    `browser_sessions: all ${sessions.length} sessions closed (${[...new Set(sessions.map((session) => session.closeReason))].join(', ')})`,
  )
  const live = await workerSessions(stand)
  rt.check(live.length === 0, 'the worker holds no session (GET /v1/sessions)', live)
  const left = await rt.until(
    'every container and network of the sessions to go',
    async () => {
      const found = []
      for (const session of sessions) {
        const resources = await sessionResources(rt, session.id)
        found.push(...resources.containers, ...resources.networks)
      }
      return found.length === 0 ? found : null
    },
    { timeoutMs: 60_000, intervalMs: 1000 },
  )
  rt.check(left.length === 0, 'Docker holds no container and no network of any session of the run')
  const sandboxes = (
    await rt.docker(['ps', '-aq', '--filter', `label=io.raditi.sandbox.siteId=${state.siteId}`])
  ).output.trim()
  rt.check(sandboxes === '', 'no sandbox of a turn is left for the site')
  stand.owned.checkPlatformLeft = true
  rt.end()
}

// ─── The run ──────────────────────────────────────────────────────────────────

const SCENARIOS = Object.freeze({
  A: scenarioA,
  D: scenarioD,
  B: scenarioB,
  C: scenarioC,
  E: scenarioE,
  F: scenarioF,
  G: scenarioG,
  H: scenarioH,
  I: scenarioI,
  J: scenarioJ,
  K: scenarioK,
  L: scenarioL,
  M: scenarioM,
})

export async function runScenarios(stand) {
  const { createRequire } = await import('node:module')
  const require = createRequire(`${stand.copy}/packages/storage/package.json`)
  const s3Sdk = require('@aws-sdk/client-s3')
  let storage = null
  const full = {
    ...stand,
    state: {},
    s3Sdk,
    streamTools: streamTools(stand.copy, stand.modules.domain),
    storage: async () => {
      if (storage) return storage
      const { createS3ObjectStorage } = await import(`${stand.copy}/packages/storage/src/index.ts`)
      storage = createS3ObjectStorage({
        endpoint: stand.s3.endpoint,
        region: 'us-east-1',
        accessKeyId: stand.s3.accessKey,
        secretAccessKey: stand.s3.secretKey,
        forcePathStyle: true,
        buckets: {
          inbox: 'raditi-inbox',
          sessions: 'raditi-sessions',
          logs: 'raditi-logs',
          artifacts: 'raditi-artifacts',
          backups: 'raditi-backups',
          platform: 'raditi-platform',
        },
      })
      return storage
    },
  }
  full.cabinet = !stand.streamOnly && (await cabinetAvailable(full))
  for (const id of stand.scenarios) await SCENARIOS[id](full)
}
