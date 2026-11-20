// The scenarios of the browser-task stand (README.md, «Сценарии»; docs/plan/57-browser-tasks.md,
// §5; since plan 83 the chats without a project only). Each PASS line is a fact read from the
// product — its database, its pages, the stream of its gateway, the API of its worker — or from
// what S3 and Docker hold. The client acts
// only from outside: web over HTTP with a session cookie, the stream through the gateway, the
// cabinet in a real Chromium. The "agent" is the real OpenCode CLI on the scripted model
// (programs.mjs), which finds what to click in the observations the platform gives it.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { zstdDecompressSync } from 'node:zlib'

import { localVaultRequest } from '../../vault/bootstrap.mjs'
import { cabinetAvailable, cabinetBrowser, cabinetOperator } from './cabinet.mjs'
import { STAND_DOC, STAND_PAGE } from './programs.mjs'
import { CheckFailed, callerEnv, exchange } from './runtime.mjs'
import { grantTariff, signUp, switchOnModel, uploadFile } from './setup.mjs'
import {
  FAKE_JPEG,
  NODE_ERRNO_PROBE,
  PAGES_DOMAIN,
  PLATFORM_HOST,
  isolatedAnswer,
  leakedIn,
  solidPng,
  syntheticPdf,
} from './stand.mjs'
import { openViewer, streamOperator, streamTools } from './stream.mjs'

const ENDED = new Set(['done', 'failed', 'cancelled', 'rolled_back'])

/**
 * A Docker command whose output is read as it is: the runtime of the stand blacks out every
 * secret it knows in what its commands print, and the stand must see the very values it looks
 * for (the logs of a session's containers). Never printed.
 */
function rawDocker(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      'docker',
      args,
      { env: callerEnv, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code ?? 1) : 0, output: `${stdout}${stderr}` }),
    )
  })
}

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
 * words (owner's answer of 26.10.2026: a chat with the browser, like one with the repository —
 * no result needs confirming, no `done`). `results` — how many results the task had before the pass that is waited for.
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

/** A chat through `task.create`, its first turn scripted beforehand. */
async function newBrowserTask(
  stand,
  client,
  { text, attachments = [], program = 'holdTheBrowser', ctx = {} },
) {
  const taskId = stand.modules.ids.uuidv7()
  stand.model.script(program, ctx)
  const created = await client.mutate('task.create', {
    taskId,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
  })
  if (created.taskId !== taskId || !created.created)
    throw new CheckFailed('task.create made no new task')
  return taskId
}

/**
 * «Остановить» of a dialog that has answered, as the client presses it: its browser closes with it.
 * A workspace holds eight browsers at most (docs/plan/61-chats-first.md, К36; eight since 06.11.2026).
 */
async function closeDialog(stand, taskId) {
  await stand.state.owner.mutate('task.cancel', { taskId, requestId: randomUUID() })
  await waitTask(stand, taskId, ['cancelled'], {
    what: 'the dialog to close',
    timeoutMs: 120_000,
  })
}

/** The first turn: the agent opens its browser and answers. */
async function firstTurn(stand, taskId) {
  const task = await waitTask(stand, taskId, ['awaiting_user'], {
    what: 'the first turn to answer',
  })
  const program = stand.model.current()
  if (!program.finished) throw new CheckFailed('the first turn ended before its program did')
  return { task, facts: program.facts }
}

/** The ticket of the stream of a task's browser, as the cabinet asks for it. */
const ticketOf = (client, taskId) => client.mutate('browser.streamTicket', { taskId })

/** A viewer of the task's browser through the gateway, once it has its id, a state and a frame. */
export async function watch(stand, client, taskId, options = {}) {
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

/** A raw viewer of the task's stream as the client's operator (stream.mjs). */
export async function streamOperatorOf(stand, client, taskId) {
  return streamOperator(stand, await watch(stand, client, taskId))
}

// ─── S: the clients of the run and their files ────────────────────────────────

async function readObject(storage, bucket, key) {
  if (!key) return null
  const body = await storage.get(bucket, key)
  if (body === null) return null
  const chunks = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

/**
 * The owner and another client signed up as web signs them up; the owner's first file makes the
 * personal workspace (docs/plan/61-chats-first.md, К15), which gets a paid tariff, and the operator
 * switches on the synthetic account and its profiles. The files go as the cabinet uploads them;
 * another client's file is never the owner's.
 */
async function scenarioS(stand) {
  const { rt, db, state } = stand
  rt.begin('S', 'клиенты, личное рабочее пространство и вложения')
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
  const files = [
    { name: 'magazin-fasad.png', type: 'image/png', bytes: solidPng(320, 200, [190, 60, 70]) },
    { name: 'magazin-vitrina.png', type: 'image/png', bytes: solidPng(240, 240, [40, 120, 200]) },
    { name: 'prais-list.pdf', type: 'application/pdf', bytes: syntheticPdf('Прайс-лист', 2000) },
  ]
  state.files = []
  for (const file of files) {
    const sent = await uploadFile(state.owner, file)
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
  state.workspaceId = rows[0]?.workspaceId
  rt.check(
    typeof state.workspaceId === 'string' &&
      rows.every((row) => row.workspaceId === state.workspaceId) &&
      (await db.member.count({ where: { userId: state.owner.id } })) === 1,
    'the first file of the owner made the personal workspace, and the three files are in it',
  )
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

  const fake = await uploadFile(state.owner, {
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

  // Another client's file, then the owner's attempts.
  const foreign = await uploadFile(state.stranger, {
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
  const refusedTask = stand.modules.ids.uuidv7()
  const withForeign = await state.owner.call('mutation', 'task.create', {
    taskId: refusedTask,
    text: 'Посмотрите картинку.',
    attachments: [state.foreignAttachment],
  })
  const written = {
    tasks: await db.task.count({ where: { id: refusedTask } }),
    holds: await db.creditHold.count({ where: { taskId: refusedTask } }),
  }
  rt.check(
    !withForeign.ok &&
      withForeign.domainCode === 'ATTACHMENT_NOT_READY' &&
      written.tasks === 0 &&
      written.holds === 0,
    "task.create with another client's file is refused (ATTACHMENT_NOT_READY), no task and no hold is written",
    { withForeign, written },
  )
  rt.end()
}

// ─── K: isolation and access ──────────────────────────────────────────────────

async function scenarioK(stand) {
  const { rt, state, db } = stand
  rt.begin('K', 'изоляция и доступ')
  const taskId = await newBrowserTask(stand, state.owner, {
    text: 'Откройте, пожалуйста, страницу.',
    program: 'holdWithForeignFiles',
    // Another client's file, and a file of the owner this chat was not sent.
    ctx: { foreignAttachments: [state.foreignAttachment, state.files[0].id] },
  })
  stand.owned.chats.push(taskId)
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
    "web_upload through mcp of another client's file and of a file this chat was not sent is refused (BROWSER_ATTACHMENT_UNKNOWN)",
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
 * worker, OpenBao, S3) and the metadata address are unreachable, each with a control that reaches
 * it (the egress container, on the default bridge); through the egress proxy, the metadata
 * address, a public host on a port it does not open and a service of the host are refused, and a
 * public site answers (the stand needs the internet).
 */
async function networkProbes(stand, sessionId) {
  const { rt } = stand
  const containers = await sessionContainers(rt, sessionId)
  if (!containers.browser || !containers.egress)
    throw new CheckFailed('the session has no browser or egress container')
  // The address of the host as Docker names it (`host-gateway`): the egress container has no name
  // for it since BROWSER_EXTRA_HOSTS left with the sites (plan 83), so a throwaway container of the
  // tools image is asked.
  const hosts = (
    await rt.docker([
      ...['run', '--rm', '--pull', 'never', '--network', 'none', '--label', stand.names.label],
      ...['--add-host', 'stand-host:host-gateway', '--entrypoint', 'cat'],
      stand.context.images.tools,
      '/etc/hosts',
    ])
  ).output
  const gateway = /^(\d+\.\d+\.\d+\.\d+)\s+stand-host/m.exec(hosts)?.[1]
  if (!gateway) throw new CheckFailed('Docker names no address of the host (host-gateway)')
  const probe = (container, host, port) =>
    rt
      .docker(['exec', container, 'node', '-e', NODE_ERRNO_PROBE, host, String(port)], {
        allowFailure: true,
      })
      .then((answer) => answer.output.trim())
  const targets = ['core', 'web', 'mcp', 'llm', 'browser', 'vault', 's3'].map((name) => [
    name,
    gateway,
    stand.ports[name],
  ])
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
    `control: the egress container reaches every service of the host at ${gateway}`,
    control,
  )
  rt.check(
    blocked.length === 0,
    "Chromium's container reaches none of them: core, web, mcp, llm, the worker, OpenBao and S3 (unreachable, not refused)",
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
  const metadataProxy = await viaProxy('http://169.254.169.254/latest/meta-data/')
  const elsewhere = await viaProxy('CONNECT example.com:443')
  const otherPort = await viaProxy('CONNECT example.com:444')
  const hostService = await viaProxy(`http://host.docker.internal:${stand.ports.core}/health`)
  rt.check(
    elsewhere === '200',
    `control: through the egress proxy a public site answers (${elsewhere})`,
  )
  rt.check(
    [metadataProxy, otherPort, hostService].every((answer) => /^4\d\d$/.test(answer)),
    `through the egress proxy: the metadata address (${metadataProxy}), a public host on a port it does not open (${otherPort}) and a service of the host (${hostService}) are refused`,
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
  const { rt, db } = stand
  rt.begin('L', 'нет секретов платформы в модели, журналах, событиях и S3')
  // What no chat may carry anywhere: the token of the worker, the secrets of web and of the pages,
  // the SecretIDs of the AppRoles of the processes.
  const secrets = {
    'worker token': stand.secrets.workerToken,
    'auth secret': stand.secrets.auth,
    'pages cookie secret': stand.secrets.pagesCookie,
    'pages signing secret': stand.secrets.pagesSigning,
  }
  for (const [name, role] of Object.entries(stand.vault.roles))
    secrets[`SecretID of ${name}`] = role.secretId
  const model = stand.model.requests.join('\n')
  rt.check(
    leakedIn(model, secrets).length === 0,
    `${stand.model.requests.length} requests to the model hold none of them`,
    leakedIn(model, secrets),
  )
  // A process may name its own settings in its log at start, never the token of the worker or a
  // SecretID: those are checked in every log.
  const never = {
    'worker token': secrets['worker token'],
    ...Object.fromEntries(Object.entries(secrets).filter(([name]) => name.startsWith('SecretID'))),
  }
  for (const [name, service] of Object.entries(stand.processes))
    rt.check(
      leakedIn(service.log(), never).length === 0,
      `the log of ${name} holds neither the token of the worker nor a SecretID`,
      leakedIn(service.log(), never),
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

// ─── P: a chat without a project ──────────────────────────────────────────────

/** A chat of `client` without a project, its first turn scripted; a chat goes by its own id. */
async function newChat(stand, client, { text, attachments = [], program, ctx = {} }) {
  const taskId = stand.modules.ids.uuidv7()
  stand.owned.chats.push(taskId)
  stand.model.script(program, ctx)
  const created = await client.mutate('task.create', {
    taskId,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
  })
  if (created.taskId !== taskId || !created.created)
    throw new CheckFailed('task.create made no new chat')
  return taskId
}

/** Nothing of a browser for a chat, in the database, at the worker and in Docker. */
async function browserOf(stand, taskId) {
  const { rt, db } = stand
  const label = `label=io.raditi.browser.site=${taskId}`
  return {
    rows: await db.browserSession.count({ where: { taskId } }),
    live: (await workerSessions(stand)).filter((session) => session.taskId === taskId).length,
    containers: (await rt.docker(['ps', '-aq', '--filter', label])).output.trim(),
  }
}

async function scenarioP(stand) {
  const { rt, db, state } = stand
  rt.begin('P', 'чат без проекта: подарок, файл клиента, открытый интернет, чужой чат, лимит')
  const client = await signUp(rt, {
    webUrl: stand.webUrl,
    db,
    address: '198.51.100.23',
    name: 'Вера',
    login: 'no-project',
  })
  const member = () => db.member.count({ where: { userId: client.id } })
  rt.check((await member()) === 0, 'a new user has no workspace before the first chat')

  // The first words of a new client: no project, the gift pays, the browser stays closed.
  const first = await newChat(stand, client, {
    text: 'Здравствуйте, вы здесь?',
    program: 'plainAnswer',
  })
  await waitAnswered(stand, first, { what: 'the first chat of a new user to answer' })
  const chat = await db.task.findUniqueOrThrow({ where: { id: first } })
  rt.check(
    chat.needsBrowser === true,
    'task.create made the chat: no project, a browser on demand',
    { browser: chat.needsBrowser },
  )
  const gift = await db.creditLedger.findMany({
    where: { account: { workspaceId: chat.workspaceId, unit: 'credit_gift' } },
    orderBy: { createdAt: 'asc' },
  })
  // The gift is the product's number, not the stand's: 50 since the pricing of 06.11.2026.
  const { signupGiftCredits } = stand.modules.domain
  rt.check(
    gift.some((row) => row.kind === 'grant' && Number(row.amount) === signupGiftCredits) &&
      gift.some((row) => row.kind === 'charge' && row.taskId === first),
    'the chat created the workspace with the gift, and the gift paid for the answer',
    gift.map((row) => `${row.kind} ${row.amount}`),
  )
  const answered = (await rowsOf(db, first, 'feed.result')).at(-1)
  rt.check(
    answered?.site === 'none' && !answered.objects?.length && !answered.filesChanged,
    'the answer says nothing of a site or of files: `site: none`, no object, no file',
    answered,
  )
  const closed = await browserOf(stand, first)
  rt.check(
    closed.rows === 0 && closed.live === 0 && closed.containers === '',
    'a turn without `web_*` started no browser: no row, no session at the worker, no container',
    closed,
  )
  await grantTariff(
    { db, billing: stand.modules.billing },
    { workspaceId: chat.workspaceId, userId: client.id },
  )

  // Another client's chat is not there for them.
  const foreign = await state.stranger.call('query', 'task.feed', { taskId: first })
  const foreignTicket = await state.stranger.call('mutation', 'browser.streamTicket', {
    taskId: first,
  })
  rt.check(
    !foreign.ok &&
      /NOT_FOUND/.test(JSON.stringify(foreign)) &&
      !foreignTicket.ok &&
      /NOT_FOUND/.test(JSON.stringify(foreignTicket)),
    "another client's chat without a project → NOT_FOUND, its feed and its browser",
    { feed: foreign, ticket: foreignTicket },
  )

  // A file before the first words: core, the sandbox of the turn, the CLI's own tool.
  const word = `raditi-chat-file-${randomUUID().replaceAll('-', '')}`
  const bytes = Buffer.from(`Записка клиента: ${word}\n`)
  const file = await uploadFile(client, {
    name: 'zapiska.txt',
    type: 'text/plain',
    bytes,
  })
  rt.check(
    file.upload?.status === 200,
    'a file of a chat that has no project yet is uploaded before its first words',
    file.upload,
  )
  const withFile = await newChat(stand, client, {
    text: 'Прочитайте, пожалуйста, файл.',
    attachments: [file.id],
    program: 'readClientFile',
  })
  await waitAnswered(stand, withFile, { what: 'the chat with a file to answer' })
  const read = (await rowsOf(db, withFile, 'feed.result')).at(-1)
  const plan = (
    await db.turnAssignment.findFirstOrThrow({ where: { taskId: withFile, turnNo: 1 } })
  ).plan
  const noSession = await browserOf(stand, withFile)
  rt.check(
    JSON.stringify(read).includes(word) &&
      plan.input.attachments.length === 1 &&
      plan.input.attachments[0].startsWith('/workspace/inbox/') &&
      noSession.rows === 0,
    'the agent on the real OpenCode read the file under /workspace/inbox with its own tool and answered what it holds, with no browser and no `web_upload`',
    { attachments: plan.input.attachments, sessions: noSession.rows },
  )

  // The browser of a chat without a project: the open internet, no object of a task.
  const web = await newChat(stand, client, {
    text: 'Откройте несколько страниц.',
    program: 'openTheWeb',
    ctx: {
      refused: {
        http: 'http://example.com/',
        address: 'https://93.184.216.34/',
        port: 'https://example.com:444/',
        platform: `https://app.${PLATFORM_HOST}/`,
        path: '/wp-admin/',
      },
    },
  })
  await waitAnswered(stand, web, { what: 'the chat with the browser to answer' })
  const seen = stand.model.current().facts
  rt.check(
    seen.start === 'about:blank',
    'the browser of a chat without a project starts on an empty page',
    { start: seen.start },
  )
  rt.check(
    Object.values(seen.refused).every((code) => code === 'BROWSER_ADDRESS_DENIED'),
    '`web_open` refuses http://, an address by IP, another port, a name of the platform and a path',
    seen.refused,
  )
  rt.check(
    seen.example === true && seen.typed === null,
    'the agent opened example.com on the open internet, read it and typed on the page',
    seen,
  )
  rt.check(seen.objects === 0, '`web_verify` of a chat without a project: no object', seen.objects)
  const openSessionRow = await openSession(db, web)
  const checkpoints = await db.browserCheckpoint.count({ where: { sessionId: openSessionRow.id } })
  const webResult = (await rowsOf(db, web, 'feed.result')).at(-1)
  rt.check(
    checkpoints === 0 && openSessionRow.wroteAt !== null,
    'the session has not one row of `browser_checkpoints`, though the agent wrote',
    { checkpoints, wrote: openSessionRow.wroteAt !== null },
  )
  rt.check(
    webResult?.site === 'none' && !webResult.objects?.length,
    'the feed says no word of a site: `site: none`, no object',
    webResult,
  )
  const masks = await localVaultRequest(stand.vault.root, `kv/metadata/content-masks/${web}/${web}`)
  rt.check(masks.status === 404, 'no contact map is written for the chat (ДС3)', {
    map: masks.status,
  })

  // The address from the client, in the panel of the same browser: the address field of the
  // cabinet in Chromium («+» → «Браузер», «Взять управление»), over the stream when the build has
  // no pane.
  if (stand.cabinet) {
    const cabinet = await cabinetBrowser(stand, client)
    try {
      const tab = await cabinet.open(web)
      const operator = cabinetOperator(stand, tab)
      await operator.take()
      await refusedWith(
        stand,
        tab,
        () => operator.navigate('http://example.com/'),
        'address_denied',
      )
      await operator.navigate('https://example.com/?from=client')
      await stateWhere(
        stand,
        tab,
        (current) => current.url.startsWith('https://example.com/'),
        'the browser to take the address of the client',
        60_000,
      )
      rt.check(
        true,
        'the client opened an https:// address in the address field of the panel in the cabinet; http:// is refused there too',
      )
    } finally {
      await cabinet.close()
    }
  } else {
    rt.note('the cabinet has no browser pane in this build: the address goes over the stream')
    const operator = await streamOperatorOf(stand, client, web)
    await operator.take()
    await refusedWith(
      stand,
      operator.viewer,
      () => operator.viewer.send({ t: 'navigate', url: 'http://example.com/' }),
      'address_denied',
    )
    await operator.navigate('https://example.com/?from=client')
    await stateWhere(
      stand,
      operator.viewer,
      (current) => current.url.startsWith('https://example.com/'),
      'the browser to take the address of the client',
      60_000,
    )
    rt.check(
      true,
      'the client opened an https:// address over the stream; http:// is refused there too',
    )
    operator.close()
  }

  // The live browsers of a workspace: since 06.11.2026 up to `browserSessionLimits.perWorkspace`
  // (eight, owner's request); the stand opens three, the refusal past the bound is the database's
  // test (`openBrowserSession`, packages/db).
  stand.model.script('holdTheBrowser')
  const holds = await newChat(stand, client, {
    text: 'Откройте ещё одну страницу.',
    program: 'holdTheBrowser',
  })
  await waitAnswered(stand, holds, { what: 'the second browser of the workspace to open' })
  rt.check(
    stand.model.current().facts.code === null &&
      (await db.browserSession.count({ where: { taskId: holds, closedAt: null } })) === 1,
    'a second chat of the workspace holds a browser of its own',
    stand.model.current().facts,
  )
  const third = await newChat(stand, client, {
    text: 'И ещё одну.',
    program: 'holdTheBrowser',
  })
  await waitAnswered(stand, third, { what: 'the third browser of the workspace to open' })
  const bound = stand.modules.domain.browserSessionLimits.perWorkspace
  rt.check(
    bound === 8 &&
      stand.model.current().facts.code === null &&
      (await db.browserSession.count({ where: { taskId: third, closedAt: null } })) === 1,
    `a third chat of the workspace holds a browser too: the bound is ${bound} live browsers (06.11.2026)`,
    stand.model.current().facts,
  )

  // What the chats leave: a failure names the other sites, a closed chat leaves nothing.
  const cancelled = async (taskId) => {
    await client.mutate('task.cancel', { taskId, requestId: randomUUID() })
    await waitTask(stand, taskId, ['cancelled'], { what: 'the chat to close', timeoutMs: 120_000 })
    return (await rowsOf(db, taskId, 'feed.cancelled')).at(-1)
  }
  // The control of the cleanup below: a live session of a chat is found by its own id.
  const live = (
    await rt.docker(['ps', '-q', '--filter', `label=io.raditi.browser.site=${web}`])
  ).output.trim()
  rt.check(
    live !== '',
    'the live browser of the chat is found in Docker by the label of its own id: the check of the cleanup can see one',
  )
  const ended = await cancelled(web)
  rt.check(
    ended?.site === 'elsewhere',
    'a chat in whose browser the agent acted ends with `elsewhere`: its words name the other sites, not a site of the client',
    ended,
  )
  for (const taskId of [holds, third, first, withFile]) await cancelled(taskId)

  // A pass that fails after the agent typed in the browser: its failure names the other sites.
  const broken = await newChat(stand, client, {
    text: 'Напечатайте что-нибудь на странице.',
    program: 'failAfterWriting',
  })
  const failure = await rt.until(
    'the pass that wrote in the browser to fail',
    async () => (await rowsOf(db, broken, 'feed.failure')).at(-1) ?? null,
    { timeoutMs: 600_000, intervalMs: 1000, service: stand.processes.core },
  )
  const brokenSession = await db.browserSession.findFirst({ where: { taskId: broken } })
  rt.check(
    stand.model.current().facts.wrote === true &&
      brokenSession?.wroteAt !== null &&
      failure.site === 'elsewhere',
    'a pass that failed after the agent wrote in the browser of a chat without a project: `feed.failure` says `elsewhere`',
    failure,
  )
  await cancelled(broken)
  const chats = [first, withFile, web, holds, third, broken]
  const left = await rt.until(
    'the chats to leave nothing in Docker',
    async () => {
      const found = []
      for (const taskId of chats)
        for (const label of [
          'io.raditi.browser.site',
          'io.raditi.sandbox.siteId',
          'io.raditi.gateway.siteId',
        ]) {
          const filter = `label=${label}=${taskId}`
          found.push(
            ...(await rt.docker(['ps', '-aq', '--filter', filter])).output.split('\n'),
            ...(await rt.docker(['network', 'ls', '-q', '--filter', filter])).output.split('\n'),
          )
        }
      const rest = found.filter(Boolean)
      return rest.length === 0 ? rest : null
    },
    { timeoutMs: 120_000, intervalMs: 1000 },
  )
  const sessions = await db.browserSession.findMany({ where: { taskId: { in: chats } } })
  rt.check(
    left.length === 0 && sessions.every((session) => session.closedAt !== null),
    `the chats are cleaned up by their own ids: ${sessions.length} sessions closed, no container, no network`,
  )
  rt.end()
}

// ─── M: cleanup ───────────────────────────────────────────────────────────────

async function scenarioM(stand) {
  const { rt, db, state } = stand
  rt.begin('M', 'уборка: сессии закрыты, контейнеры и сети удалены')
  // A dialog stays open after an answer (26.10.2026): the client closes what is left with
  // «Остановить», and core closes the browser of each.
  const open = await db.task.findMany({
    where: {
      workspaceId: state.workspaceId,
      status: { in: ['awaiting_user', 'awaiting_approval'] },
    },
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
    'every session of the workspace to close',
    async () => {
      const rows = await db.browserSession.findMany({ where: { workspaceId: state.workspaceId } })
      return rows.every((session) => session.closedAt !== null) ? rows : null
    },
    { timeoutMs: 120_000, intervalMs: 1000, service: stand.processes.core },
  )
  const tasks = await db.task.findMany({ where: { workspaceId: state.workspaceId } })
  rt.check(
    tasks.every((task) => ENDED.has(task.status)),
    `every chat of the workspace ended (${tasks.map((task) => task.status).join(', ')})`,
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
  const sandboxes = []
  for (const { id } of tasks)
    sandboxes.push(
      ...(await rt.docker(['ps', '-aq', '--filter', `label=io.raditi.sandbox.siteId=${id}`])).output
        .split('\n')
        .filter(Boolean),
    )
  rt.check(sandboxes.length === 0, 'no sandbox of a turn is left for a chat of the workspace')
  stand.owned.checkPlatformLeft = true
  rt.end()
}

// ─── Sites of pages (docs/plan/73-pages-sites.md, scenario R) ───────────────────

/** A path of a site of pages as a viewer asks the pages' listener: its status, where to, its text. */
function pageAt(stand, slug, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: stand.ports.pages,
        path,
        method: 'GET',
        headers: { host: `${slug}.${PAGES_DOMAIN}:${stand.ports.pages}` },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            location: res.headers.location ?? null,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    req.setTimeout(10_000, () => req.destroy(new Error(`the page ${path} did not answer`)))
    req.end()
  })
}

/**
 * The rows of a kind a chat has, once there are `count` of them: the end of a turn writes its
 * answer first, then its files and pages below it, then the changes of its pages (pass-runner.ts).
 */
async function rowsAtLeast(stand, taskId, type, count, what) {
  return stand.rt.until(
    what,
    async () => {
      const rows = await rowsOf(stand.db, taskId, type)
      return rows.length >= count ? rows : null
    },
    { timeoutMs: 30_000, intervalMs: 500, service: stand.processes.core },
  )
}

/** The client's words to a chat that answered, with the program of the next turn. */
async function sayNext(stand, client, taskId, text, program, ctx = {}) {
  stand.model.script(program, ctx)
  await client.mutate('task.message', { taskId, requestId: randomUUID(), text })
}

/**
 * Scenario R (docs/plan/73-pages-sites.md, slice 73.10): a site of pages by the agent on the real
 * OpenCode — three pages of one site linked from the root, a rename that leaves its former
 * addresses leading on, a deletion the client asked for, and «Вернуть» of the client — each read
 * from outside: the pages' listener of the preview app, the feed, the cabinet's tRPC.
 */
async function scenarioR(stand) {
  const { rt, db } = stand
  rt.begin('R', 'сайт из страниц: три страницы со ссылками, переименование, удаление и «Вернуть»')
  const client = await signUp(rt, {
    webUrl: stand.webUrl,
    db,
    address: '198.51.100.41',
    name: 'Ольга',
    login: 'pages-site',
  })
  const word = `raditi-site-${randomUUID().slice(0, 8)}`
  const taskId = await newChat(stand, client, {
    text: 'Сделайте, пожалуйста, сайт из трёх страниц: главная, услуги и ремонт.',
    program: 'publishSite',
    ctx: { word },
  })
  await waitAnswered(stand, taskId, { what: 'the agent to publish the site' })
  const published = stand.model.current().facts.published ?? []
  const rows = await rowsAtLeast(stand, taskId, 'feed.page', 3, 'the three pages below the answer')
  rt.check(
    rows.length === 3 &&
      rows.map((row) => row.path ?? '/').join(' ') === '/ /uslugi /uslugi/remont' &&
      new Set(rows.map((row) => row.slug)).size === 1 &&
      rows.every((row) => row.version === 1 && !row.warnings),
    'three publications of one turn made one site: its home page, /uslugi and /uslugi/remont under it, v1 each, no link of theirs leads nowhere',
    rows.map((row) => ({ path: row.path ?? '/', version: row.version, warnings: row.warnings })),
  )
  const slug = rows[0]?.slug
  const tree = await db.pageTree.findMany({
    where: {
      workspaceId: (await db.task.findUniqueOrThrow({ where: { id: taskId } })).workspaceId,
    },
  })
  rt.check(tree.length === 1, 'the workspace holds one site', { sites: tree.length })
  const home = await pageAt(stand, slug, '/')
  const uslugi = await pageAt(stand, slug, '/uslugi')
  const remont = await pageAt(stand, slug, '/uslugi/remont')
  const slash = await pageAt(stand, slug, '/uslugi/')
  rt.check(
    home.status === 200 &&
      home.text.includes(word) &&
      home.text.includes('href="/uslugi/remont"') &&
      uslugi.status === 200 &&
      uslugi.text.includes('<h1>Услуги</h1>') &&
      remont.status === 200 &&
      remont.text.includes('<h1>Ремонт</h1>') &&
      slash.status === 308 &&
      slash.location?.endsWith('/uslugi'),
    'the pages listener serves each page of the site at its path under one host, the links of the agent from the root; a path with a slash at its end leads to its page',
    {
      home: home.status,
      uslugi: uslugi.status,
      remont: remont.status,
      slash: [slash.status, slash.location],
    },
  )
  rt.check(
    published.length === 3 &&
      published.every((page) => page.url?.includes(`${slug}.${PAGES_DOMAIN}`)),
    'page_publish gave the agent the address of each page at once, on the host of its site',
    published.map((page) => page.url),
  )

  // The second turn: «Услуги» becomes «Цены» at /ceny, the page below goes with it.
  await sayNext(
    stand,
    client,
    taskId,
    'Переименуйте, пожалуйста, «Услуги» в «Цены», адрес — /ceny.',
    'renameServices',
  )
  await waitAnswered(stand, taskId, { results: 1, what: 'the agent to rename the page' })
  await rowsAtLeast(stand, taskId, 'feed.page_change', 1, 'the change of the rename')
  const ceny = await pageAt(stand, slug, '/ceny')
  const formerly = await pageAt(stand, slug, '/uslugi')
  const below = await pageAt(stand, slug, '/uslugi/remont')
  const moved = await pageAt(stand, slug, '/ceny/remont')
  const changes = await rowsOf(db, taskId, 'feed.page_change')
  rt.check(
    ceny.status === 200 &&
      formerly.status === 308 &&
      formerly.location?.endsWith('/ceny') &&
      below.status === 308 &&
      below.location?.endsWith('/ceny/remont') &&
      moved.status === 200 &&
      changes.at(-1)?.change === 'updated' &&
      changes.at(-1)?.title === 'Цены',
    'page_update at the end of the turn: the page and the one below it serve at their new paths, their former addresses lead on (308), the feed says the agent changed «Цены»',
    {
      ceny: ceny.status,
      formerly: [formerly.status, formerly.location],
      below: [below.status, below.location],
      moved: moved.status,
      change: changes.at(-1),
    },
  )

  // The third turn: the client asked to delete «Ремонт»; it goes to the trash.
  await sayNext(stand, client, taskId, 'Удалите, пожалуйста, страницу «Ремонт».', 'deleteRepair')
  await waitAnswered(stand, taskId, { results: 2, what: 'the agent to delete the page' })
  const repairId = stand.model.current().facts.pageId
  await rowsAtLeast(stand, taskId, 'feed.page_change', 2, 'the change of the deletion')
  const deleted = await pageAt(stand, slug, '/ceny/remont')
  const trashed = (await rowsOf(db, taskId, 'feed.page_change')).at(-1)
  rt.check(
    deleted.status === 410 &&
      trashed?.change === 'trashed' &&
      trashed?.pages === 1 &&
      (await pageAt(stand, slug, '/ceny')).status === 200,
    'page_delete with the client’s word: the page answers 410 «удалена», its parent serves, the feed says it went to the trash and can come back',
    { deleted: deleted.status, change: trashed },
  )

  // «Вернуть» of the client in the cabinet: the page serves again at its path.
  const listed = await client.call('query', 'pages.list', {})
  const inTrash = listed.ok ? listed.data.pages.find((page) => page.pageId === repairId) : null
  rt.check(
    inTrash?.trash !== null && inTrash?.trash !== undefined && inTrash?.path === '/ceny/remont',
    '«Страницы» shows the page in the trash at its path, the site of the chat beside it',
    { listed: listed.ok, trash: inTrash?.trash ?? null },
  )
  const returned = await client.call('mutation', 'pages.returnDeleted', { pageId: repairId })
  const back = await pageAt(stand, slug, '/ceny/remont')
  rt.check(
    returned.ok && back.status === 200 && back.text.includes('<h1>Ремонт</h1>'),
    '«Вернуть» of the client: the page serves again at its path',
    { returned: returned.ok, status: back.status },
  )
  rt.end()
}

// ─── The run ──────────────────────────────────────────────────────────────────

// ─── Q: pages and documents of the agent ──────────────────────────────────────

/**
 * A page as a viewer gets it from the pages listener of the preview app: `GET` of its address,
 * sent to the loopback port with the Host of the address (`*.localhost` is the stand's own).
 */
function viewPage(stand, url) {
  const address = new URL(url)
  return new Promise((resolve, reject) => {
    const asked = httpRequest(
      {
        host: '127.0.0.1',
        port: stand.ports.pages,
        path: address.pathname,
        method: 'GET',
        headers: { host: address.host },
        signal: AbortSignal.timeout(15_000),
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    asked.on('error', reject)
    asked.end()
  })
}

/** The headers the domain names for a page, as the listener sent them: every one, byte for byte. */
const sameHeaders = (got, expected) =>
  Object.entries(expected).every(([name, value]) => got[name.toLowerCase()] === value)

/** Words to a chat that waits, with the program of the turn they start. */
async function say(stand, client, taskId, text, program, ctx = {}) {
  const results = await stand.db.taskEvent.count({ where: { taskId, type: 'feed.result' } })
  stand.model.script(program, ctx)
  await client.mutate('task.message', { taskId, requestId: randomUUID(), text })
  await waitAnswered(stand, taskId, { results, what: `the turn of ${program} to answer` })
  const current = stand.model.current()
  if (!current.finished) throw new CheckFailed(`the program ${program} did not finish`)
  return current.facts
}

/**
 * Scenario Q (docs/plan/69-pages.md, §7, slice 69.10): the agent of a chat without a project
 * publishes a page of its outbox and writes a document section by section; the end of the turn
 * makes their versions; the viewer reads them at the pages listener; the client publishes the
 * document by link. The tools are the real ones of `mcp`, the end of the turn is core's.
 */
async function scenarioQ(stand) {
  const { rt, db } = stand
  const { domain, docRender } = stand.modules
  rt.begin(
    'Q',
    'страницы и документы агента: адрес сразу, версия в конце хода, разделы, «Опубликовать по ссылке»',
  )
  const client = await signUp(rt, {
    webUrl: stand.webUrl,
    db,
    address: '198.51.100.24',
    name: 'Глеб',
    login: 'pages',
  })

  // A page of the outbox: the address at once, the version at the end of the turn.
  const taskId = await newChat(stand, client, {
    text: 'Сделайте страницу с прайсом и дайте ссылку',
    program: 'publishPage',
  })
  await waitAnswered(stand, taskId, { what: 'the turn that publishes a page' })
  const page = stand.model.current().facts
  rt.check(
    page.code === null &&
      /^http:\/\/[a-z2-7]{26}\.pages\.localhost:\d+\/$/.test(page.url ?? '') &&
      page.version === 1,
    'page_publish answers the address of the page at once, version 1, its own subdomain',
    page,
  )
  const chat = await db.task.findUniqueOrThrow({ where: { id: taskId } })
  await grantTariff(
    { db, billing: stand.modules.billing },
    { workspaceId: chat.workspaceId, userId: client.id },
  )
  const told = (await rowsOf(db, taskId, 'feed.page')).at(-1)
  rt.check(
    told?.version === 1 && told.kind === 'html' && page.url.includes(told.slug ?? '-'),
    'the end of the turn made the version: `feed.page` names the page and version 1',
    told,
  )
  rt.check(
    (await rowsOf(db, taskId, 'feed.file')).length === 0,
    'the file the page was reserved for is the page, not a file of the chat',
  )
  const viewed = await viewPage(stand, page.url)
  rt.check(
    viewed.status === 200 &&
      // The shell's heredoc ends the file with a line feed: the page is the file, byte for byte.
      viewed.body === `${STAND_PAGE.html}\n` &&
      sameHeaders(viewed.headers, domain.pageResponseHeaders('html')),
    'the pages listener serves the bytes of the outbox under the headers of the domain, byte for byte',
    { status: viewed.status, csp: viewed.headers['content-security-policy'] },
  )
  const other = await viewPage(stand, `${page.url}v2`)
  rt.check(other.status === 404, 'another path of the page answers 404 (Ст16)', other.status)

  // A document by sections: the role refuses a token, `doc_finish` waits for every section.
  const writing = await say(stand, client, taskId, 'Напишите аудит скорости сайта', 'writeDocument')
  rt.check(
    writing.docId !== null &&
      writing.written === null &&
      writing.token === 'PAGE_CONTENT_REFUSED' &&
      writing.early === 'DOC_PENDING_SECTIONS',
    'doc_create makes the skeleton; a section is written; one with a JWT is refused by the role; doc_finish with a placeholder is refused',
    writing,
  )
  const docId = writing.docId
  const card = await client.query('pages.doc', { docId })
  rt.check(
    card.version === 0 &&
      card.progress.written === 1 &&
      card.progress.total === 2 &&
      card.sections.map((section) => section.state).join(',') === 'shown,pending' &&
      !JSON.stringify(card).includes('eyJhbGci'),
    'the card after the end of the turn: «Разделы: 1 из 2», the checked section shown, the refused one a placeholder, no token anywhere',
    { progress: card.progress, states: card.sections.map((section) => section.state) },
  )
  rt.check(
    (await rowsOf(db, taskId, 'feed.doc')).some((row) => row.docId === docId),
    'the feed carries the card of the document (`feed.doc`)',
  )

  // The last section, the version and the link the agent asked for.
  const finished = await say(
    stand,
    client,
    taskId,
    'Допишите документ и дайте ссылку',
    'finishDocument',
    {
      docId,
    },
  )
  rt.check(
    finished.written === null && finished.finish === null && finished.code === null && finished.url,
    'the last section, doc_finish and page_publish of the document are taken, the address comes at once',
    finished,
  )
  const version = await db.artifact.findUniqueOrThrow({
    where: { id: docId },
    // The host of a page is its site's since plan 73 (Дер11): the client no longer has `pages.slug`.
    include: { content: true, page: { include: { tree: true } } },
  })
  rt.check(
    version.currentVersion === 1 &&
      version.page?.state === 'live' &&
      version.page.currentVersion === 1 &&
      finished.url.includes(version.page.tree.name ?? version.page.tree.slug),
    'the end of the turn made version 1 of the document and drew it as version 1 of its page',
    { document: version.currentVersion, page: version.page?.currentVersion },
  )
  const expectedReading = await docRender.readingPage({
    title: STAND_DOC.title,
    markdown: version.content.markdown,
  })
  const reading = await viewPage(stand, finished.url)
  rt.check(
    reading.status === 200 &&
      reading.body === expectedReading &&
      sameHeaders(reading.headers, domain.pageResponseHeaders('reading')) &&
      !/<script/i.test(reading.body),
    'the page of the document is the page for reading of its version, under PAGE_READING_CSP, without a script',
    { status: reading.status, csp: reading.headers['content-security-policy'] },
  )
  const download = await client.request(`/api/documents/${docId}/markdown`)
  const downloaded = await download.text()
  rt.check(
    download.status === 200 && downloaded === version.content.markdown,
    '«Скачать .md» is the Markdown of the version, byte for byte',
    { status: download.status },
  )

  // A section written again: the next version; the client publishes it by link, same address.
  const edited = await say(stand, client, taskId, 'Поправьте итог', 'editDocument', { docId })
  rt.check(
    edited.written === null && edited.finish === null,
    'the edit and doc_finish are taken',
    edited,
  )
  const second = await db.artifact.findUniqueOrThrow({
    where: { id: docId },
    include: { content: true, page: true },
  })
  rt.check(
    second.currentVersion === 2 && second.page?.currentVersion === 1,
    'the edit made version 2 of the document; its page keeps version 1 until it is published again',
    { document: second.currentVersion, page: second.page?.currentVersion },
  )
  const byLink = await client.mutate('pages.publishDoc', { docId })
  const republished = await viewPage(stand, byLink.url)
  rt.check(
    byLink.url === finished.url &&
      byLink.version === 2 &&
      republished.status === 200 &&
      republished.body.includes(STAND_DOC.edited) &&
      !republished.body.includes(STAND_DOC.summary),
    '«Опубликовать по ссылке» puts version 2 at the same address; the former text is gone',
    { url: byLink.url === finished.url, version: byLink.version },
  )
  const stranger = await stand.state.stranger.call('mutation', 'pages.publishDoc', { docId })
  rt.check(
    !stranger.ok && /NOT_FOUND/.test(JSON.stringify(stranger)),
    "another client's publication of the document → NOT_FOUND",
    stranger,
  )
  rt.end()
}

const SCENARIOS = Object.freeze({
  S: scenarioS,
  P: scenarioP,
  K: scenarioK,
  L: scenarioL,
  Q: scenarioQ,
  R: scenarioR,
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
