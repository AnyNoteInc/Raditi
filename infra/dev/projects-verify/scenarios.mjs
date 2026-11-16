// The scenarios of the projects stand (README.md, «Сценарии»; docs/plan/84-projects.md, §6). Each
// PASS line is a fact read from the product — its database, the answers of web, the requests the
// synthetic Z.ai got — or from what the fake GitLab holds: its bare repositories, the requests it
// was sent, its merge requests and played jobs. The client acts only from outside: web over HTTP
// with a session cookie, as the cabinet calls it. The "agent" is the real OpenCode CLI on the
// scripted model (programs.mjs).
import { randomBytes, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CheckFailed, exchange } from '../browser-task-verify/runtime.mjs'
import { grantTariff, signUp, switchOnModel } from '../browser-task-verify/setup.mjs'
import { COM_HOST, OWN_HOST } from './fake-gitlab.mjs'
import { leakedIn } from './stand.mjs'

const ENDED = new Set(['done', 'failed', 'cancelled', 'rolled_back'])

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A one-page PDF whose page holds `text` (ASCII), with a correct cross-reference table. */
export function textPdf(text) {
  const stream = `BT /F1 18 Tf 40 120 Td (${text.replace(/[()\\]/g, '')}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

async function waitAnswered(
  stand,
  taskId,
  { results = 0, since = 0n, timeoutMs = 600_000, what } = {},
) {
  const { rt, db, model } = stand
  return rt.until(
    what ?? 'the chat to answer',
    async () => {
      const broken = model.current()?.broken
      if (broken) throw new CheckFailed(`the scripted model stopped: ${broken}`)
      const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
      if (ENDED.has(task.status)) throw new CheckFailed(`the chat ended ${task.status}`)
      if (task.status !== 'awaiting_user') return null
      const failure = await db.taskEvent.findFirst({
        where: { taskId, type: 'feed.failure', id: { gt: since } },
      })
      if (failure) throw new CheckFailed(`the pass failed: ${JSON.stringify(failure.payload)}`)
      const answered = await db.taskEvent.count({ where: { taskId, type: 'feed.result' } })
      return answered > results ? task : null
    },
    { timeoutMs, intervalMs: 1000, service: stand.processes.core },
  )
}

async function newChat(stand, { text, projectId, program, ctx = {} }) {
  const taskId = stand.modules.ids.uuidv7()
  stand.owned.chats.push(taskId)
  stand.model.script(program, ctx)
  const created = await stand.state.owner.mutate('task.create', { taskId, text, projectId })
  if (created.taskId !== taskId || !created.created)
    throw new CheckFailed('task.create made no chat')
  await waitAnswered(stand, taskId, { what: `the first turn (${program}) to answer` })
  const current = stand.model.current()
  if (!current.finished) throw new CheckFailed(`the program ${program} did not finish`)
  return { taskId, facts: current.facts }
}

async function say(stand, taskId, text, program, ctx = {}) {
  const results = await stand.db.taskEvent.count({ where: { taskId, type: 'feed.result' } })
  const last = await stand.db.taskEvent.findFirst({ where: { taskId }, orderBy: { id: 'desc' } })
  stand.model.script(program, ctx)
  await stand.state.owner.mutate('task.message', { taskId, requestId: randomUUID(), text })
  await waitAnswered(stand, taskId, {
    results,
    since: last?.id ?? 0n,
    what: `the turn of ${program} to answer`,
  })
  const current = stand.model.current()
  if (!current.finished) throw new CheckFailed(`the program ${program} did not finish`)
  return current.facts
}

/** The system text of the last request of the model that declared tools: the instructions of a turn. */
function lastInstructions(stand) {
  for (const raw of stand.model.requests.toReversed()) {
    const body = JSON.parse(raw)
    if (!Array.isArray(body.tools) || body.tools.length === 0) continue
    return (body.messages ?? [])
      .filter((message) => message.role === 'system')
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : (message.content ?? []).map((part) => part.text ?? '').join(''),
      )
      .join('\n')
  }
  return ''
}

/** Waits for a press of the author (`repo_actions`) to end; its row. */
async function actionDone(stand, projectId, actionId, what) {
  const { rt, state } = stand
  return rt.until(
    what,
    async () => {
      const action = await state.owner.query('projectRepo.action', { projectId, actionId })
      if (action.state === 'failed') throw new CheckFailed(`${what}: failed ${action.error}`)
      return action.state === 'done' ? action : null
    },
    { timeoutMs: 120_000, intervalMs: 1000, service: stand.processes.core },
  )
}

const marker = (name) => `${name}-${randomBytes(4).toString('hex')}`

// ─── S: the client and the model ──────────────────────────────────────────────

async function scenarioS(stand) {
  const { rt, db, state } = stand
  rt.begin('S', 'клиенты и модель')
  state.owner = await signUp(rt, {
    webUrl: stand.webUrl,
    db,
    address: '198.51.100.31',
    name: 'Анна',
    login: 'owner',
  })
  state.stranger = await signUp(rt, {
    webUrl: stand.webUrl,
    db,
    address: '198.51.100.32',
    name: 'Борис',
    login: 'stranger',
  })
  await switchOnModel(rt, {
    db,
    copy: stand.copy,
    context: stand.context,
    vault: stand.vault,
    directory: stand.directory,
  })
  rt.passed(
    'two clients signed up as web signs them up; the synthetic account and two profiles switched on by the operator commands',
  )
  rt.end()
}

// ─── A, B: a project with files, instructions and memory ──────────────────────

async function scenarioA(stand) {
  const { rt, db, state, model } = stand
  rt.begin('A', 'проект с файлами из окна, инструкции и память в инструкциях хода')
  const owner = state.owner
  state.markers = {
    text: marker('kontekst'),
    pdf: marker('PRICE'),
    project: marker('instrukcii-proekta'),
    client: marker('lichnye-instrukcii'),
    memory: marker('pamyat'),
  }
  const m = state.markers
  // The window of a new project: a text and a PDF before the project exists.
  const text = await owner.mutate('projectFile.addText', {
    title: 'Описание кофейни',
    text: `Кофейня «Зерно» на Садовой. Метка контекста: ${m.text}.`,
  })
  const pdfBytes = textPdf(`Price list ${m.pdf}`)
  const started = await owner.mutate('projectFile.start', {
    name: 'prais.pdf',
    size: pdfBytes.byteLength,
    type: 'application/pdf',
  })
  const upload = await owner.request(started.uploadPath, {
    method: 'PUT',
    headers: { 'content-type': 'application/pdf', 'content-length': String(pdfBytes.byteLength) },
    body: pdfBytes,
  })
  rt.check(
    upload.status >= 200 && upload.status < 300,
    `the PDF of the window is uploaded (${upload.status})`,
  )
  const projectId = stand.modules.ids.uuidv7()
  const made = await owner.mutate('project.create', {
    projectId,
    name: 'Кофейня «Зерно»',
    goal: 'Сайт кофейни и его меню',
    fileIds: [text.fileId, started.fileId],
  })
  rt.check(
    made.created && made.projectId === projectId,
    'project.create made the project with the two files of the window',
  )
  const again = await owner.mutate('project.create', { projectId, name: 'Кофейня «Зерно»' })
  rt.check(!again.created, 'a repeat of project.create with the same id makes no second project')
  state.projectId = projectId
  state.textFile = text.name
  state.pdfFile = started.name
  const files = await owner.query('projectFile.list', { projectId })
  rt.check(
    files.files.length === 2 && files.files.every((file) => file.status === 'ready'),
    'the project holds the two files, both ready',
    files.files.map((file) => [file.name, file.status]),
  )
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } })
  state.workspaceId = project.workspaceId
  await grantTariff(
    { db, billing: stand.modules.billing },
    { workspaceId: state.workspaceId, userId: owner.id },
  )
  await owner.mutate('project.setInstructions', {
    projectId,
    text: `Отвечайте коротко. Метка проекта: ${m.project}.`,
  })
  await owner.mutate('user.setAgentInstructions', {
    text: `Называйте меня Анной. Метка: ${m.client}.`,
  })
  const memory = await owner.mutate('projectMemory.add', {
    projectId,
    kind: 'fact',
    text: `Кофейня открыта с восьми утра. Метка памяти: ${m.memory}.`,
  })
  rt.check(memory !== null, 'a memory entry of the project added by the client')
  const secret = await owner.call('mutation', 'projectMemory.add', {
    projectId,
    kind: 'fact',
    text: `Пароль от админки: glpat-${randomBytes(12).toString('hex')}`,
  })
  rt.check(
    !secret.ok && secret.domainCode === 'MEMORY_HAS_SECRET',
    'an entry holding a token is refused (MEMORY_HAS_SECRET)',
    secret,
  )

  const chat = await newChat(stand, {
    text: 'Посмотрите файлы проекта.',
    projectId,
    program: 'readProjectFiles',
    ctx: { textFile: state.textFile, pdfFile: state.pdfFile },
  })
  state.chatA = chat.taskId
  const task = await db.task.findUniqueOrThrow({ where: { id: chat.taskId } })
  rt.check(task.projectId === projectId, 'the chat started in the project (task.projectId)')
  const instructions = lastInstructions(stand)
  const at = (needle) => instructions.indexOf(needle)
  const order = [
    at("## The client's own instructions"),
    at(m.client),
    at('## The project'),
    at(m.project),
    at('## Project files'),
    // The two files of the list, in the order the list keeps them.
    Math.min(at(state.textFile), at(state.pdfFile)),
    Math.max(at(state.textFile), at(state.pdfFile)),
    at('## Memory'),
    at(m.memory),
  ]
  rt.check(
    order.every((index) => index >= 0) &&
      order.every((index, i) => i === 0 || index > order[i - 1]),
    "the synthetic Z.ai saw in the system text the client's instructions, the project and its instructions, the list of its files and the memory, in this order",
    order,
  )
  rt.check(
    !instructions.includes('## The repository'),
    'a project without a repository has no section of a repository',
  )
  const output = chat.facts.output ?? ''
  rt.check(
    output.includes(m.text),
    'the text of the window is a file of /workspace/project the agent reads',
    output.slice(0, 600),
  )
  rt.check(output.includes(m.pdf), 'the PDF is read with pdftotext in the sandbox')
  state.firstWrite = /write=(\d+)/.exec(output)?.[1] ?? null
  rt.end()
}

async function scenarioB(stand) {
  const { rt, state } = stand
  rt.begin('B', '/workspace/project: изменения не сохраняются')
  const facts = await say(
    stand,
    state.chatA,
    'Посмотрите файлы ещё раз.',
    'readProjectFilesAgain',
    {
      textFile: state.textFile,
    },
  )
  const output = facts.output ?? ''
  rt.check(
    !output.includes('agent-note.txt') &&
      !output.includes('агент был здесь') &&
      output.includes(state.markers.text),
    `the next turn sees the files of the client as they were: no file and no line of the agent (the write itself answered ${state.firstWrite})`,
    output.slice(0, 400),
  )
  rt.end()
}

// ─── C: the memory of the project ─────────────────────────────────────────────

async function scenarioC(stand) {
  const { rt, state, db } = stand
  rt.begin('C', 'память: «запомните», предложение после команды, секрет, правка записи клиента')
  const owner = state.owner
  const asked = marker('zapomnit')
  await say(
    stand,
    state.chatA,
    'Запомните, пожалуйста: по понедельникам мы закрыты.',
    'rememberAsked',
    {
      note: `По понедельникам кофейня закрыта (${asked}).`,
    },
  )
  const saved = await rt.until(
    'the note to be applied at the end of the pass',
    async () =>
      db.memoryEntry.findFirst({
        where: { projectId: state.projectId, text: { contains: asked } },
      }),
    { timeoutMs: 30_000, intervalMs: 500 },
  )
  rt.check(
    saved.status === 'active' && saved.author === 'agent',
    `the note the client asked for is saved at once (${saved.status})`,
  )
  const clientEntry = await db.memoryEntry.findFirstOrThrow({
    where: { projectId: state.projectId, author: 'client' },
  })
  const proposedMark = marker('predlozheno')
  const facts = await say(
    stand,
    state.chatA,
    'Посмотрите заметки проекта.',
    'rememberAfterCommand',
    {
      note: `Решили сделать меню на доске (${proposedMark}).`,
      secretNote: `Токен деплоя: glpat-${randomBytes(12).toString('hex')}`,
      clientEntry: { id: clientEntry.id, version: clientEntry.version },
      changedText: 'Кофейня открыта с девяти утра.',
    },
  )
  rt.check(
    typeof facts.secret?.code === 'string' && /SECRET/.test(facts.secret.code),
    `a note with a token is refused to the agent (${facts.secret?.code})`,
    facts.secret,
  )
  const proposed = await rt.until(
    'the proposal to be applied',
    async () =>
      db.memoryEntry.findFirst({
        where: { projectId: state.projectId, text: { contains: proposedMark } },
      }),
    { timeoutMs: 30_000, intervalMs: 500 },
  )
  rt.check(
    proposed.status === 'proposed',
    `a note after a command the agent ran is only proposed (${proposed.status})`,
  )
  const after = await db.memoryEntry.findUniqueOrThrow({ where: { id: clientEntry.id } })
  rt.check(
    after.text === clientEntry.text &&
      after.pendingAction === 'update' &&
      after.pendingText === 'Кофейня открыта с девяти утра.',
    "the agent's change of the client's note is a proposal: the text stays until the client saves it",
    { text: after.text, pending: after.pendingAction },
  )
  await owner.mutate('projectMemory.confirm', {
    id: proposed.id,
    expectedVersion: proposed.version,
  })
  const confirmed = await db.memoryEntry.findUniqueOrThrow({ where: { id: proposed.id } })
  rt.check(
    confirmed.status === 'active' && confirmed.confirmedAt !== null,
    'the client confirms the proposal: it is active',
  )
  await say(stand, state.chatA, 'Что вы помните?', 'plainAnswer')
  const instructions = lastInstructions(stand)
  rt.check(
    instructions.includes(asked) && instructions.includes(proposedMark),
    'the next turn has both notes in its section «Memory»',
  )
  rt.end()
}

// ─── K: an own GitLab server by token ─────────────────────────────────────────

async function scenarioK(stand) {
  const { rt, state, gitlab } = stand
  rt.begin('K', 'свой сервер GitLab по токену: адрес, токен, репозитории')
  const owner = state.owner
  state.ownToken = rt.secret(`glpat-${randomBytes(12).toString('hex')}`)
  const user = gitlab.addUser(OWN_HOST, { username: 'klient', token: state.ownToken })
  state.repoSecret = `glpat-${randomBytes(10).toString('hex')}`
  state.ownProject = await gitlab.addProject(OWN_HOST, {
    path: 'kofeinya/sait',
    members: [user],
    logSecret: state.ownToken,
    files: {
      'README.md': '# Кофейня «Зерно»\n\nСайт кофейни.\n',
      'index.html': '<h1>Зерно</h1>\n',
      '.gitlab-ci.yml': 'stages:\n  - test\ntest:\n  stage: test\n  script: ["echo ok"]\n',
      'config/old-settings.env': `GITLAB_TOKEN=${state.repoSecret}\n`,
    },
  })
  for (const host of ['10.0.0.1', 'gitlab.invalid', '127.0.0.1']) {
    const refused = await owner.call('mutation', 'gitConnection.addToken', {
      host,
      token: state.ownToken,
    })
    rt.check(
      !refused.ok,
      `the address ${host} is refused before anything is written (${refused.domainCode ?? refused.code})`,
      refused,
    )
  }
  const wrong = await owner.mutate('gitConnection.addToken', {
    host: OWN_HOST,
    token: `glpat-${randomBytes(12).toString('hex')}`,
  })
  const refusedState = await rt.until(
    'core to check the wrong token',
    async () => {
      const list = await owner.query('gitConnection.list')
      const row = list.connections.find((item) => item.id === wrong.connectionId)
      return row && row.state !== 'checking' && row.state !== 'syncing' ? row : null
    },
    { timeoutMs: 60_000, intervalMs: 1000, service: stand.processes.core },
  )
  rt.check(
    refusedState.state !== 'ok',
    `a token GitLab does not know: the connection is ${refusedState.state}`,
    refusedState,
  )
  await owner.mutate('gitConnection.remove', { connectionId: wrong.connectionId })

  const added = await owner.mutate('gitConnection.addToken', {
    host: OWN_HOST,
    token: state.ownToken,
  })
  state.ownConnection = added.connectionId
  const connection = await rt.until(
    'core to check the token and list the repositories',
    async () => {
      const list = await owner.query('gitConnection.list')
      const row = list.connections.find((item) => item.id === added.connectionId)
      return row?.state === 'ok' ? row : null
    },
    { timeoutMs: 60_000, intervalMs: 1000, service: stand.processes.core },
  )
  rt.check(
    connection.login === 'klient' && connection.host === OWN_HOST,
    `the connection is ok as «${connection.login}» at ${connection.host}`,
  )
  const repos = await rt.until(
    'the repositories of the connection',
    async () => {
      const answer = await owner.query('gitConnection.repositories', {
        connectionId: added.connectionId,
      })
      return answer.state === 'ready' ? answer : null
    },
    { timeoutMs: 60_000, intervalMs: 1000 },
  )
  state.ownRepo = repos.items.find((item) => item.path === 'kofeinya/sait')
  rt.check(
    state.ownRepo !== undefined,
    'the repository of the client is in the list core read from GitLab',
    repos.items,
  )
  const strangers = await state.stranger.query('gitConnection.list')
  rt.check(strangers.connections.length === 0, 'another client sees no connection of the owner')
  const sent = gitlab.requests.filter(
    (entry) => entry.host === OWN_HOST && entry.path?.startsWith('/'),
  )
  rt.check(
    sent.every(
      (entry) =>
        !/variables|members|access_tokens|deploy_tokens|protected_branches/.test(entry.path),
    ),
    `the ${sent.length} requests to the own server are of the whitelist only`,
  )
  rt.end()
}

// ─── D: gitlab.com by OAuth with PKCE ─────────────────────────────────────────

async function scenarioD(stand) {
  const { rt, state, gitlab, certificates } = stand
  rt.begin('D', 'GitLab.com по OAuth с PKCE через подделку')
  const owner = state.owner
  const user = gitlab.addUser(COM_HOST, { username: 'anna-oauth', signsIn: true })
  await gitlab.addProject(COM_HOST, {
    path: 'anna/zerno-landing',
    members: [user],
    files: { 'README.md': 'Лендинг\n' },
  })
  const started = await owner.request('/api/git/gitlab/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: state.projectId }),
  })
  const startBody = await started.json().catch(() => null)
  rt.check(
    started.status === 200 && typeof startBody?.authorizationUrl === 'string',
    `the sign-in starts (${started.status})`,
    startBody,
  )
  const authorization = new URL(startBody.authorizationUrl)
  rt.check(
    authorization.origin === `https://localhost:${stand.context.git.fakePort}` &&
      authorization.searchParams.get('code_challenge_method') === 'S256',
    'the client goes to the fake of gitlab.com with a PKCE challenge (S256)',
  )
  const authorized = await exchange(authorization.href, { ca: certificates.ca })
  rt.check(
    authorized.status === 302,
    `the fake answers the authorization with the way back (${authorized.status})`,
  )
  // A return with another state is refused, and the sign-in of the same browser still works.
  const back = new URL(authorized.headers.location)
  const forged = new URL(back)
  forged.searchParams.set('state', 'forged')
  const refused = await owner.request(`${forged.pathname}${forged.search}`)
  rt.check(
    refused.status === 303 && /git=refused/.test(refused.headers.get('location') ?? ''),
    'a return with another state is refused (git=refused)',
  )
  const again = await owner.request('/api/git/gitlab/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: state.projectId }),
  })
  const second = await exchange((await again.json()).authorizationUrl, { ca: certificates.ca })
  const returned = new URL(second.headers.location)
  const finished = await owner.request(`${returned.pathname}${returned.search}`)
  rt.check(
    finished.status === 303 && /git=connected/.test(finished.headers.get('location') ?? ''),
    `the return of the same browser connects (${finished.headers.get('location')})`,
  )
  rt.check(
    user.pkce === true,
    'the fake exchanged the code only with the verifier of its challenge',
  )
  for (const token of user.oauthTokens ?? []) rt.secret(token)
  state.oauthTokens = user.oauthTokens ?? []
  const connection = await rt.until(
    'core to sync the gitlab.com connection',
    async () => {
      const list = await owner.query('gitConnection.list')
      const row = list.connections.find((item) => item.kind === 'gitlab_oauth')
      return row?.state === 'ok' ? row : null
    },
    { timeoutMs: 60_000, intervalMs: 1000, service: stand.processes.core },
  )
  const repos = await rt.until(
    'the repositories of gitlab.com',
    async () => {
      const answer = await owner.query('gitConnection.repositories', {
        connectionId: connection.id,
      })
      return answer.state === 'ready' ? answer : null
    },
    { timeoutMs: 60_000, intervalMs: 1000 },
  )
  rt.check(
    connection.login === 'anna-oauth' &&
      repos.items.some((item) => item.path === 'anna/zerno-landing'),
    'the gitlab.com connection is ok as the user of the sign-in, and its repository is listed',
  )
  const strangers = await state.stranger.query('gitConnection.list')
  rt.check(strangers.connections.length === 0, 'another client sees no connection of the owner')
  // A second project takes the repository of gitlab.com: its git goes to https://gitlab.com/… on
  // 443, pinned to the address of the fake (fakedGitlabCom), never to the real gitlab.com.
  const landing = stand.modules.ids.uuidv7()
  await owner.mutate('project.create', { projectId: landing, name: 'Лендинг «Зерно»' })
  const comRepo = repos.items.find((item) => item.path === 'anna/zerno-landing')
  await owner.mutate('projectRepo.attach', {
    projectId: landing,
    connectionId: connection.id,
    providerRepoId: comRepo.providerRepoId,
    defaultBranch: 'main',
  })
  const fetched = await rt.until(
    'core to fetch the repository of gitlab.com',
    async () => {
      const row = await owner.query('projectRepo.get', { projectId: landing })
      if (row?.refusal) throw new CheckFailed(`refused: ${JSON.stringify(row.refusal)}`)
      return row?.mirrorState === 'ready' ? row : null
    },
    { timeoutMs: 120_000, intervalMs: 1000, service: stand.processes.core },
  )
  const comFetches = gitlab.requests.filter(
    (entry) => entry.host === COM_HOST && entry.git === 'git-upload-pack' && entry.auth,
  )
  rt.check(
    fetched.host === COM_HOST && comFetches.length > 0,
    'the repository of gitlab.com is fetched by git with the OAuth token, at the fake',
  )
  rt.end()
}

// ─── E: a repository attached, a turn that changes it ─────────────────────────

async function scenarioE(stand) {
  const { rt, state, gitlab, db } = stand
  rt.begin('E', 'репозиторий проекта: зеркало, gitleaks, ход публикует только в зеркало')
  const owner = state.owner
  const projectId = state.projectId
  await owner.mutate('projectRepo.attach', {
    projectId,
    connectionId: state.ownConnection,
    providerRepoId: state.ownRepo.providerRepoId,
    defaultBranch: 'main',
  })
  const repo = await rt.until(
    'core to fetch the repository into its mirror',
    async () => {
      const row = await owner.query('projectRepo.get', { projectId })
      if (row?.refusal)
        throw new CheckFailed(`the repository was refused: ${JSON.stringify(row.refusal)}`)
      return row?.mirrorState === 'ready' ? row : null
    },
    { timeoutMs: 120_000, intervalMs: 1000, service: stand.processes.core },
  )
  rt.check(
    repo.mode === 'write' && repo.defaultBranch === 'main',
    `the repository is attached for writing (${repo.mode}), its mirror ready`,
  )
  rt.check(
    repo.secretsFound.some((path) => path.includes('config/old-settings.env')),
    'gitleaks flagged the file with a token on the first fetch',
    repo.secretsFound,
  )
  const fetches = gitlab.requests.filter(
    (entry) => entry.git === 'git-upload-pack' && entry.host === OWN_HOST,
  )
  rt.check(
    fetches.length > 0 && fetches.every((entry) => entry.auth),
    'core fetched over git smart HTTP of the client with its token',
  )
  const mainBefore = (await gitlab.heads(state.ownProject)).main
  state.mainBefore = mainBefore

  const chat = await newChat(stand, {
    text: 'Добавьте в описание условия доставки и меню на неделю.',
    projectId,
    program: 'changeRepository',
    ctx: { host: OWN_HOST, path: 'kofeinya/sait' },
  })
  state.chatE = chat.taskId
  const facts = chat.facts
  rt.check(
    facts.seen?.includes('Сайт кофейни.'),
    'the agent reads the repository in /workspace/repo',
  )
  rt.check(
    !facts.seen?.includes(state.repoSecret),
    'the file gitleaks flagged never reaches the sandbox with its value',
    facts.seen?.split('---hidden')[1]?.slice(0, 200),
  )
  rt.check(
    /---env\n0/.test(facts.seen ?? ''),
    'no token of git is in the environment of the sandbox',
  )
  const pushed = /push=(\d+)/.exec(facts.attempts ?? '')?.[1]
  const curled = /curl=(\d+)/.exec(facts.attempts ?? '')?.[1]
  rt.check(
    pushed !== '0' && curled !== '0',
    `the agent cannot push nor reach GitLab itself (push=${pushed}, curl=${curled})`,
    facts.attempts,
  )
  const instructions = lastInstructions(stand)
  rt.check(
    instructions.includes('## The repository') && instructions.includes('kofeinya/sait'),
    'the instructions of the turn name the repository',
  )
  const branch = await rt.until(
    'the chat branch in the mirror',
    async () => {
      const row = await owner.query('projectRepo.branch', { taskId: chat.taskId })
      return row?.headSha ? row : null
    },
    { timeoutMs: 60_000, intervalMs: 1000 },
  )
  state.branch = branch
  rt.check(
    !branch.sent && branch.state === 'local',
    `the commit of the turn is in the mirror, not sent (${branch.branch})`,
  )
  const heads = await gitlab.heads(state.ownProject)
  rt.check(
    Object.keys(heads).join(',') === 'main' && heads.main === mainBefore,
    'nothing reached the client: the repository holds its main branch only, at the same commit',
    heads,
  )
  rt.check(
    gitlab.pushes.length === 0 &&
      !gitlab.requests.some((entry) => entry.git === 'git-receive-pack'),
    'no push of any kind reached the fake',
  )
  const row = await db.projectRepoBranch.findFirst({ where: { taskId: chat.taskId } })
  rt.check(
    row?.branch === branch.branch,
    'the branch of the chat is written in project_repo_branches',
  )
  rt.end()
}

// ─── F: «Отправить в ветку» with a merge request ──────────────────────────────

async function scenarioF(stand) {
  const { rt, state, gitlab } = stand
  rt.begin('F', '«Открыть запрос на слияние»: ветка у клиента, текст обезврежен')
  const owner = state.owner
  const taskId = state.chatE
  const forged = await owner.call('mutation', 'projectRepo.confirmPush', {
    confirmToken: 'forged.token',
  })
  rt.check(!forged.ok, 'a press with a forged token is refused', forged)
  const card = await owner.mutate('projectRepo.preparePush', { taskId })
  rt.check(
    card.headSha === state.branch.headSha && card.stat.files >= 2,
    `the card names the head of the chat and ${card.stat.files} files`,
    card.stat,
  )
  const description =
    'Добавлены доставка и меню.\n/merge\n/assign @boss\n@all посмотрите, closes #3'
  const pressed = await owner.mutate('projectRepo.confirmPush', {
    confirmToken: card.confirmToken,
    mergeRequest: { title: 'Доставка и меню', description, draft: false, reservedId: null },
  })
  await actionDone(stand, state.projectId, pressed.actionId, 'the push of the card to end')
  const heads = await gitlab.heads(state.ownProject)
  rt.check(
    heads[card.branch] === card.headSha,
    `the branch ${card.branch} is at the client at the head of the card`,
  )
  rt.check(heads.main === state.mainBefore, 'the main branch of the client did not move')
  rt.check(
    (await gitlab.show(state.ownProject, card.branch, 'README.md'))?.includes('Доставка по городу'),
    'the branch at the client holds the change of the agent',
  )
  const replay = await owner.call('mutation', 'projectRepo.confirmPush', {
    confirmToken: card.confirmToken,
  })
  rt.check(!replay.ok, 'the token of a press works once', replay)
  const mr = await rt.until(
    'the merge request to open',
    async () => state.ownProject.mergeRequests[0] ?? null,
    { timeoutMs: 60_000, intervalMs: 1000 },
  )
  rt.check(
    mr.source === card.branch && mr.target === 'main',
    'the merge request goes from the branch of the chat into main',
  )
  rt.check(
    mr.description.split('\n').every((line) => !/^\s*\//.test(line)) &&
      !/@\w/.test(mr.description) &&
      !/\bcloses\b/i.test(mr.description),
    'its text is neutralised: no quick action, no mention, no closing word',
    mr.description,
  )
  const second = await say(stand, taskId, 'Спасибо!', 'plainAnswer')
  void second
  const after = await gitlab.heads(state.ownProject)
  rt.check(
    after[card.branch] === card.headSha && gitlab.pushes.length === 1,
    'the next turn sends nothing by itself',
  )
  rt.end()
}

// ─── G: a change of the build settings ────────────────────────────────────────

async function scenarioG(stand) {
  const { rt, state, gitlab } = stand
  rt.begin('G', 'настройки сборки: без карточки нет отправки, после карточки — уходит')
  const owner = state.owner
  const taskId = state.chatE
  await say(stand, taskId, 'Добавьте этап проверки в сборку.', 'changeBuildSettings')
  const branch = await rt.until(
    'the card of the build settings',
    async () => {
      const row = await owner.query('projectRepo.branch', { taskId })
      return row?.ciChange === 'needed' ? row : null
    },
    { timeoutMs: 60_000, intervalMs: 1000 },
  )
  rt.check(branch.ciChange === 'needed', 'the change of .gitlab-ci.yml asks for its own card')
  const card = await owner.call('mutation', 'projectRepo.preparePush', { taskId })
  const plain = card.ok
    ? await owner.call('mutation', 'projectRepo.confirmPush', {
        confirmToken: card.data.confirmToken,
      })
    : card
  let pushedPlain = false
  if (plain.ok) {
    const action = await rt.until(
      'the plain push to end',
      async () => {
        const row = await owner.query('projectRepo.action', {
          projectId: state.projectId,
          actionId: plain.data.actionId,
        })
        return row.state === 'done' || row.state === 'failed' ? row : null
      },
      { timeoutMs: 60_000, intervalMs: 1000 },
    )
    pushedPlain = action.state === 'done'
  }
  const heads = await gitlab.heads(state.ownProject)
  rt.check(
    !pushedPlain && heads[branch.branch] !== branch.headSha,
    `without the card of the build settings nothing is sent (${plain.ok ? 'the push failed' : plain.domainCode})`,
    plain,
  )
  const ci = await rt.until(
    'the card of the build settings with its lint',
    async () => {
      const answer = await owner.mutate('projectRepo.prepareCiChange', { taskId })
      return answer.state === 'ready' ? answer : null
    },
    { timeoutMs: 60_000, intervalMs: 2000 },
  )
  rt.check(
    ci.files.some((file) => file.path === '.gitlab-ci.yml') && ci.lint?.valid === true,
    'the card shows the diff of .gitlab-ci.yml and the CI Lint of GitLab (valid)',
    { files: ci.files.map((file) => file.path), lint: ci.lint },
  )
  rt.check(
    gitlab.lints.some((lint) => /deploy/.test(lint.content)),
    'CI Lint was asked with the content of the new head',
  )
  const pressed = await owner.mutate('projectRepo.confirmCiChange', {
    confirmToken: ci.confirmToken,
  })
  await actionDone(
    stand,
    state.projectId,
    pressed.actionId,
    'the push of the build settings to end',
  )
  const after = await gitlab.heads(state.ownProject)
  rt.check(
    after[branch.branch] === ci.headSha,
    'after «Разрешить и отправить» the branch with the build settings is at the client',
  )
  rt.check(
    (await gitlab.show(state.ownProject, branch.branch, '.gitlab-ci.yml'))?.includes('deploy'),
    'the client has the new .gitlab-ci.yml in the branch',
  )
  rt.end()
}

// ─── H: builds by polling, a masked log ───────────────────────────────────────

async function scenarioH(stand) {
  const { rt, state } = stand
  rt.begin('H', 'сборки опросом, журнал маскирован')
  const owner = state.owner
  const projectId = state.projectId
  const run = await rt.until(
    'core to poll the pipeline of the branch',
    async () => {
      const runs = await owner.query('projectRepo.runs', { projectId })
      return (
        runs.items.find((item) => item.ref.startsWith('raditi/') && item.status === 'success') ??
        null
      )
    },
    { timeoutMs: 180_000, intervalMs: 3000, service: stand.processes.core },
  )
  rt.check(
    run.chat?.id === state.chatE,
    `the pipeline of the branch is read by polling, success, tied to the chat (#${run.id})`,
  )
  const detail = await owner.query('projectRepo.run', { projectId, runId: run.id })
  const job = detail.jobs.find((item) => item.name === 'test')
  rt.check(job !== undefined, 'its job is listed')
  const log = await rt.until(
    'the log of the job',
    async () => {
      const answer = await owner.query('projectRepo.jobLog', {
        projectId,
        runId: run.id,
        jobId: job.id,
      })
      if (answer.state === 'failed') throw new CheckFailed('the log failed')
      return answer.state === 'ready' ? answer : null
    },
    { timeoutMs: 60_000, intervalMs: 1500 },
  )
  const raw = state.ownProject.pipelines.find((p) => String(p.id) === run.id)?.jobs[0]?.trace ?? ''
  rt.check(
    raw.includes(state.ownToken) && raw.includes('\u001b'),
    'control: the log GitLab gives holds the token of the connection and ANSI',
  )
  rt.check(
    log.text.includes('3 tests') &&
      !log.text.includes('\u001b') &&
      !log.text.includes(state.ownToken),
    'the log is kept without ANSI and without the token of the connection',
    log.text.slice(0, 300),
  )
  rt.end()
}

// ─── I: merge by the card ─────────────────────────────────────────────────────

async function scenarioI(stand) {
  const { rt, state, gitlab } = stand
  rt.begin('I', '«Принять в основную ветку»: слияние с sha головы')
  const owner = state.owner
  const card = await rt.until(
    'the card of the merge with the head of the branch',
    async () => {
      const answer = await owner.call('mutation', 'projectRepo.prepareMerge', {
        projectId: state.projectId,
        number: 1,
      })
      const heads = await gitlab.heads(state.ownProject)
      return answer.ok && answer.data.headSha === heads[answer.data.source] ? answer.data : null
    },
    { timeoutMs: 120_000, intervalMs: 3000 },
  )
  rt.check(
    card.target === 'main' && card.checks === 'success',
    `the card of merge request !1 into main, checks ${card.checks}`,
  )
  const pressed = await owner.mutate('projectRepo.confirmMerge', {
    confirmToken: card.confirmToken,
    mode: 'now',
    deleteBranch: true,
  })
  await actionDone(stand, state.projectId, pressed.actionId, 'the merge to end')
  const call = gitlab.mergeCalls.at(-1)
  rt.check(call?.sha === card.headSha, 'the merge went with the sha of the head of the card')
  const heads = await gitlab.heads(state.ownProject)
  const mr = state.ownProject.mergeRequests[0]
  rt.check(
    mr.state === 'merged' && heads.main === mr.mergeSha && heads[card.source] === undefined,
    'main is at the merge commit, the branch removed',
  )
  const parents = await gitlab.parents(state.ownProject, 'main')
  rt.check(
    parents.includes(state.mainBefore) && parents.includes(card.headSha),
    'the merge commit joins the old main and the head of the card',
  )
  const replay = await owner.call('mutation', 'projectRepo.confirmMerge', {
    confirmToken: card.confirmToken,
    mode: 'now',
    deleteBranch: true,
  })
  rt.check(
    !replay.ok && gitlab.mergeCalls.length === 1,
    'the token of the merge works once',
    replay,
  )
  state.mainAfter = heads.main
  rt.end()
}

// ─── J: deploy by the card ────────────────────────────────────────────────────

async function scenarioJ(stand) {
  const { rt, state, gitlab } = stand
  rt.begin('J', '«Выкатить»: ручное задание головы основной ветки')
  const owner = state.owner
  const deploy = await rt.until(
    'the manual jobs of the head of main',
    async () => {
      const answer = await owner.mutate('projectRepo.prepareDeploy', { projectId: state.projectId })
      return answer.state === 'ready' && answer.sha === state.mainAfter && answer.actions.length > 0
        ? answer
        : null
    },
    { timeoutMs: 120_000, intervalMs: 3000 },
  )
  const action = deploy.actions.find((item) => item.name === 'deploy')
  rt.check(
    action?.kind === 'manual_job',
    `the card offers the manual job «deploy» of ${deploy.sha.slice(0, 8)}`,
  )
  const pressed = await owner.mutate('projectRepo.confirmDeploy', {
    confirmToken: action.confirmToken,
  })
  await actionDone(stand, state.projectId, pressed.actionId, 'the deploy to start')
  rt.check(
    gitlab.played.length === 1 &&
      gitlab.played[0].sha === state.mainAfter &&
      gitlab.played[0].job === 'deploy',
    'the fake played the job deploy of the head of main, once',
    gitlab.played,
  )
  const again = await owner.call('mutation', 'projectRepo.confirmDeploy', {
    confirmToken: action.confirmToken,
  })
  rt.check(!again.ok && gitlab.played.length === 1, 'the token of the deploy works once', again)
  rt.end()
}

// ─── N: no token anywhere ─────────────────────────────────────────────────────

async function scenarioN(stand) {
  const { rt, state, db, directory } = stand
  rt.begin('N', 'ни одного токена git в модели, событиях, базе вне Vault и журналах')
  const secrets = {
    ownToken: state.ownToken,
    oauthClientSecret: stand.context.git.oauth.secret,
    confirmSecret: stand.secrets.confirm,
    ...Object.fromEntries(
      (state.oauthTokens ?? []).map((token, index) => [`oauth${index}`, token]),
    ),
  }
  rt.check(
    leakedIn(stand.model.requests.join('\n'), secrets).length === 0,
    `no token in the ${stand.model.requests.length} requests to the model`,
  )
  const events = await db.taskEvent.findMany()
  rt.check(
    leakedIn(
      JSON.stringify(events, (_, v) => (typeof v === 'bigint' ? String(v) : v)),
      secrets,
    ).length === 0,
    `no token in the ${events.length} events of the chats`,
  )
  const tables = await db.$queryRawUnsafe(
    "SELECT string_agg(t::text, E'\\n') AS dump FROM (SELECT row_to_json(r)::text AS t FROM (SELECT * FROM git_connections) r UNION ALL SELECT row_to_json(r)::text FROM (SELECT * FROM project_repositories) r UNION ALL SELECT row_to_json(r)::text FROM (SELECT * FROM repo_actions) r UNION ALL SELECT row_to_json(r)::text FROM (SELECT * FROM project_ci_logs) r) x",
  )
  rt.check(
    leakedIn(String(tables[0]?.dump ?? ''), secrets).length === 0,
    'no token in the rows of connections, repositories, presses and logs',
  )
  const logs = join(directory, 'logs')
  let leaks = []
  for (const file of await readdir(logs))
    leaks = leaks.concat(
      leakedIn(await readFile(join(logs, file), 'utf8'), secrets).map((name) => `${file}:${name}`),
    )
  rt.check(leaks.length === 0, 'no token in the logs of the processes', leaks)
  rt.end()
}

// ─── M: cleanup ───────────────────────────────────────────────────────────────

async function scenarioM(stand) {
  const { rt, db, state } = stand
  rt.begin('M', 'уборка: чаты закрыты, песочниц нет')
  if (state.workspaceId) {
    const open = await db.task.findMany({
      where: {
        workspaceId: state.workspaceId,
        status: { in: ['awaiting_user', 'awaiting_approval'] },
      },
      select: { id: true },
    })
    for (const { id } of open) {
      await state.owner.mutate('task.cancel', { taskId: id, requestId: randomUUID() })
      await rt.until(
        'the open chat to close',
        async () => (await db.task.findUniqueOrThrow({ where: { id } })).status === 'cancelled',
        { timeoutMs: 120_000, intervalMs: 1000 },
      )
    }
    const tasks = await db.task.findMany({ where: { workspaceId: state.workspaceId } })
    rt.check(
      tasks.every((task) => ENDED.has(task.status)),
      `every chat of the workspace ended (${tasks.length})`,
    )
  }
  const sandboxes = []
  for (const id of stand.owned.chats)
    sandboxes.push(
      ...(await rt.docker(['ps', '-aq', '--filter', `label=io.raditi.sandbox.siteId=${id}`])).output
        .split('\n')
        .filter(Boolean),
    )
  rt.check(sandboxes.length === 0, 'no sandbox of a turn is left')
  stand.owned.checkPlatformLeft = true
  rt.end()
}

const SCENARIOS = {
  S: scenarioS,
  A: scenarioA,
  B: scenarioB,
  C: scenarioC,
  K: scenarioK,
  D: scenarioD,
  E: scenarioE,
  F: scenarioF,
  G: scenarioG,
  H: scenarioH,
  I: scenarioI,
  J: scenarioJ,
  N: scenarioN,
  M: scenarioM,
}

export async function runScenarios(stand) {
  const full = { ...stand, state: {} }
  for (const id of stand.scenarios) await SCENARIOS[id](full)
}
