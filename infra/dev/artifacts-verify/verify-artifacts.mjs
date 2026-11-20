#!/usr/bin/env node
// The stand of artifacts (docs/plan/88-artifacts.md, §10, it grows from stage Э1): a disposable
// PostgreSQL with the real migrations applied as production applies them (`prisma migrate deploy`
// on `public`), then a person and two chats of the agent write one document through @repo/db —
// the batch, the agent's write held until the check, its repeat, the signal raditi_artifact on a
// connection of its own, a version, the trash and the collector. Synthetic data only, no .env.
//
//   pnpm verify:artifacts [-- --keep] [--seconds 20] [--no-browsers]
//
// Slice 88.3 starts it with the database alone; 88.4 adds the check of core (`ArtifactChecks`):
// a write with a value of the workspace's variables is refused live, a clean one shown, a failed
// turn's writes dropped, the collector by the time of the write. The tools of mcp, the cabinet and
// the measurement under 8 turns come with their slices. 88.5 adds Redis: the relay of core carries
// raditi_artifact to the channel of the artifact, and the commit time of a person typing is
// measured under 8 turns writing and being checked in the same artifact (Ар20, plan 86, §4).
// 88.6 adds the agent's side: the family `artifacts` of mcp over this database — its synonyms
// doc_* of plan 69 mapped onto the operations, the news of every answer, the bounds of a chat and
// of a pass without its client — and the end of a turn of core with its version.
// 88.12 and 88.13 add the outbox of a turn into artifacts (`artifact_file_put`, `artifact_import`)
// and the frame of a mockup in real browsers (frames.mjs): its fonts, files, scripts and bridge,
// and the edit frame that runs nothing — Chromium and WebKit here, Firefox in Docker.
// 88.15–88.15в add the canvas and the brand of a project (canvas.mjs): its template, the brand in
// its frames, `artifact_layout` and `artifact_render` of mcp onto the renderer of apps/browser
// without network, the thumbnails of core and «Опубликовать как сайт».

import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '../../..')
const IMAGE =
  'postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
const REDIS_IMAGE = 'redis:8.10.2-alpine'
const LABEL = 'raditi.artifacts-verify'
const { values } = parseArgs({
  // `pnpm verify:artifacts -- --only canvas` hands the separator over as well.
  args: process.argv.slice(2).filter((value) => value !== '--'),
  options: {
    keep: { type: 'boolean', default: false },
    // The frames of mockups in Chromium, WebKit and Firefox (Docker): on by default.
    'no-browsers': { type: 'boolean', default: false },
    seconds: { type: 'string', default: '20' },
    // `canvas` — only the canvas, the brand and the renderer (88.15–88.15в), after the migrations.
    only: { type: 'string' },
  },
})

function run(program, args, { env = {}, allowFailure = false } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(program, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', fail)
    child.on('close', (code) => {
      if (code !== 0 && !allowFailure)
        fail(
          new Error(
            `${program} ${args.join(' ').replaceAll(password, '***')} exited ${code}\n${output.slice(-4000).replaceAll(password, '***')}`,
          ),
        )
      else done({ code, output: output.trim() })
    })
  })
}

let passed = 0
function check(name, ok, detail = '') {
  if (!ok) throw new Error(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
  passed += 1
  process.stdout.write(`PASS ${name}\n`)
}

async function codeOf(act) {
  try {
    await act()
    return null
  } catch (error) {
    return error?.code ?? String(error)
  }
}

const name = `raditi-artifacts-${randomBytes(4).toString('hex')}`
const redisName = `${name}-redis`
const password = randomBytes(18).toString('base64url')
let started = false

try {
  started = true
  await run('docker', [
    'run',
    '-d',
    '--pull=never',
    '--name',
    name,
    '--label',
    `${LABEL}=1`,
    '--tmpfs',
    '/var/lib/postgresql/data:rw',
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_USER=raditi',
    '-e',
    'POSTGRES_DB=raditi',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    IMAGE,
  ])
  let ready = false
  for (let attempt = 0; attempt < 120 && !ready; attempt += 1) {
    const probe = await run(
      'docker',
      ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'raditi', '-d', 'raditi'],
      { allowFailure: true },
    )
    ready = probe.code === 0
    if (!ready) await sleep(500)
  }
  if (!ready) throw new Error('PostgreSQL did not become ready')
  const binding = (await run('docker', ['port', name, '5432/tcp'])).output.split('\n')[0]
  const databaseUrl = `postgresql://raditi:${password}@${binding}/raditi`
  process.stdout.write(`[artifacts] database ${binding}: migrations\n`)
  await run('pnpm', ['--filter', '@repo/db', 'exec', 'prisma', 'migrate', 'deploy'], {
    env: { DATABASE_URL: databaseUrl },
  })
  check('migrations apply on an empty PostgreSQL', true)
  const all = values.only === undefined
  if (all) await scenario(databaseUrl)
  await run('docker', [
    'run',
    '-d',
    '--pull=never',
    '--name',
    redisName,
    '--label',
    `${LABEL}=1`,
    '-p',
    '127.0.0.1::6379',
    REDIS_IMAGE,
    'redis-server',
    '--save',
    '',
    '--appendonly',
    'no',
  ])
  const redisBinding = (await run('docker', ['port', redisName, '6379/tcp'])).output.split('\n')[0]
  if (all) await channelAndMeasure(databaseUrl, `redis://${redisBinding}`)
  if (all) await outboxIntoArtifacts(databaseUrl)
  if (!values['no-browsers']) {
    // 88.15–88.15в: the canvas, the brand and the renderer of frames on a Chromium of this machine.
    const { canvasAndRender } = await import('./canvas.mjs')
    await canvasAndRender({ root, databaseUrl, check })
  }
  if (all && !values['no-browsers']) {
    const { framesInBrowsers } = await import('./frames.mjs')
    await framesInBrowsers({ root, databaseUrl, check })
  }
  process.stdout.write(`[artifacts] ${passed} checks passed\n`)
} finally {
  if (started && !values.keep)
    await run('docker', ['rm', '-fv', name, redisName], { allowFailure: true })
  else if (started) process.stdout.write(`[artifacts] kept ${name} ${redisName}\n`)
}

async function scenario(databaseUrl) {
  const dbModule = await import(resolve(root, 'packages/db/src/index.ts'))
  const pg = await import(resolve(root, 'packages/db/node_modules/pg/lib/index.js'))
  const { uuidv7 } = await import(resolve(root, 'packages/db/src/uuidv7.ts'))
  const db = dbModule.createPrismaClient({ databaseUrl, log: [] })
  const listener = new pg.default.Client({ connectionString: databaseUrl })
  await listener.connect()
  const heard = []
  listener.on('notification', (message) => {
    if (message.channel === 'raditi_artifact') heard.push(message.payload)
  })
  await listener.query('LISTEN raditi_artifact')
  try {
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
    const chat = async () =>
      (
        await db.task.create({
          data: { id: uuidv7(), workspaceId: workspace.id, createdById: user.id },
          select: { id: true },
        })
      ).id
    const person = { kind: 'user', userId: user.id }
    const { id } = await dbModule.createArtifact(db, {
      workspaceId: workspace.id,
      kind: 'document',
      title: 'Прайс кофейни',
      actor: person,
    })
    const apply = (ops, actor = person, opId = randomUUID(), now = undefined) =>
      dbModule.applyArtifactOps(db, { batch: { artifactId: id, opId, ops }, actor, now })
    const section = (block, text, after = null) => ({
      op: 'insert',
      block,
      after,
      kind: 'section',
      content: text,
      props: { heading: `Раздел ${block}` },
    })
    const first = await apply(
      [section('coffee', 'Капучино — 250 ₽'), section('tea', 'Чай — 150 ₽', 'coffee')],
      person,
      'first',
    )
    check(
      'a person’s batch applies at once',
      first.blocks.every((block) => block.state === 'applied'),
    )
    const again = await apply(
      [section('coffee', 'Капучино — 250 ₽'), section('tea', 'Чай — 150 ₽', 'coffee')],
      person,
      'first',
    )
    check('the same batch again gets the same answer', again.repeated && again.seq === first.seq)
    check(
      'another batch under the same opId is refused',
      (await codeOf(() => apply([section('x', 'y')], person, 'first'))) === 'ARTIFACT_OP_REUSED',
    )
    const later = new Date(Date.now() + 60_000)
    const writer = await chat()
    const other = await chat()
    const agent = (taskId) => ({ kind: 'agent', taskId, turnNo: 1 })
    const written = await apply(
      [{ op: 'replace', block: 'coffee', ifRev: 1, content: 'Капучино — 270 ₽' }],
      agent(writer),
      undefined,
      later,
    )
    check('the agent’s write waits for the check', written.blocks[0]?.state === 'checking')
    const seen = await dbModule.readArtifact(db, { artifactId: id, actor: person })
    check('others read the checked text meanwhile', seen.blocks[0]?.content === 'Капучино — 250 ₽')
    check(
      'another chat is held off the block being checked',
      (await codeOf(() =>
        apply(
          [{ op: 'replace', block: 'coffee', ifRev: 2, content: 'x' }],
          agent(other),
          undefined,
          later,
        ),
      )) === 'ARTIFACT_BLOCK_HELD',
    )
    await dbModule.settleArtifactWrites(db, {
      taskId: writer,
      final: true,
      blocks: [{ artifactId: id, block: 'coffee', rev: 2, refusal: null }],
    })
    const checked = await dbModule.readArtifact(db, { artifactId: id, actor: person })
    check('after the check everyone reads it', checked.blocks[0]?.content === 'Капучино — 270 ₽')
    const version = await dbModule.saveArtifactVersion(db, {
      artifactId: id,
      actor: person,
      label: 'Перед акцией',
    })
    check('a named version keeps the blocks', version.no === 1)
    await sleep(300)
    check(
      'raditi_artifact carries the id alone, once per committed batch',
      heard.length > 0 && heard.every((payload) => payload === id) && heard.length <= 4,
      `heard ${heard.length}`,
    )
    await checksOfCore({ dbModule, db, id, person, agent, chat, apply })
    await agentTools({ dbModule, db, workspace, user, chat })
    await dbModule.trashArtifact(db, { artifactId: id, userId: user.id, by: 'client' })
    check(
      'an artifact in the trash is open to nobody',
      (await dbModule.artifactRole(db, { artifactId: id, userId: user.id })) === null,
    )
    const swept = await dbModule.sweepArtifacts(db, new Date(Date.now() + 31 * 24 * 3600 * 1000))
    check('the collector deletes it after 30 days', swept.purged === 1)
  } finally {
    await listener.end()
    await db.$disconnect()
  }
}

/** Slice 88.4: the check of core on the agent's writes, as a turn runs and ends (Ар16, Ар19). */
async function checksOfCore({ dbModule, db, id, person, agent, chat, apply }) {
  const { ArtifactChecks } = await import(
    resolve(root, 'apps/core/src/artifacts/artifact-checks.ts')
  )
  const value = `synthetic-variable-${randomBytes(6).toString('hex')}`
  const refuses = (text) => (text.includes(value) ? 'client_value' : null)
  const lines = []
  const logger = { log: (line) => lines.push(line), warn: (line) => lines.push(line) }
  const checks = new ArtifactChecks({ db, logger })
  const after = new Date(Date.now() + 120_000)
  const read = async () =>
    Object.fromEntries(
      (await dbModule.readArtifact(db, { artifactId: id, actor: person })).blocks.map((block) => [
        block.key,
        block.content,
      ]),
    )
  const turn = await chat()
  const before = await read()
  const rev = (await dbModule.readArtifact(db, { artifactId: id, actor: person })).blocks
  const revOf = (key) => rev.find((block) => block.key === key).rev
  await apply(
    [
      { op: 'replace', block: 'coffee', ifRev: revOf('coffee'), content: 'Капучино — 290 ₽' },
      { op: 'replace', block: 'tea', ifRev: revOf('tea'), content: `Чай — ${value}` },
    ],
    agent(turn),
    undefined,
    after,
  )
  const live = await checks.checkLive(turn, 1, refuses)
  const now = await read()
  check(
    'core shows a clean write live and keeps the text before one with a variable',
    live.checked === 1 &&
      live.refused === 1 &&
      now.coffee === 'Капучино — 290 ₽' &&
      now.tea === before.tea,
    JSON.stringify(live),
  )
  check(
    'nothing the check found reaches its log',
    lines.every((line) => !line.includes(value)),
  )
  const failed = await chat()
  const current = (await dbModule.readArtifact(db, { artifactId: id, actor: person })).blocks
  await apply(
    [
      {
        op: 'replace',
        block: 'coffee',
        ifRev: current.find((block) => block.key === 'coffee').rev,
        content: 'Капучино — 999 ₽',
      },
    ],
    agent(failed),
    undefined,
    after,
  )
  const dropped = await checks.fail(failed, 1, null)
  check(
    'a turn that failed without its values drops its writes',
    dropped.dropped === 1 && (await read()).coffee === 'Капучино — 290 ₽',
  )
  const left = await chat()
  const latest = (await dbModule.readArtifact(db, { artifactId: id, actor: person })).blocks
  await apply(
    [
      {
        op: 'replace',
        block: 'tea',
        ifRev: latest.find((block) => block.key === 'tea').rev,
        content: 'Чай — 160 ₽',
      },
    ],
    agent(left),
    undefined,
    after,
  )
  await db.task.update({ where: { id: left }, data: { status: 'failed' } })
  const sweeper = new ArtifactChecks({
    db,
    logger,
    now: () => new Date(after.getTime() + 11 * 60_000),
  })
  check(
    'the collector drops a write left by a chat whose pass is over, by its time',
    (await sweeper.sweep()) === 1 && (await dbModule.pendingArtifactWrites(db, left)).length === 0,
  )
}

/** Slice 88.6: the family `artifacts` of mcp and the end of a turn of core (Ар3, Ар21–Ар24). */
async function agentTools({ dbModule, db, workspace, user, chat }) {
  const { McpArtifactsService } = await import(
    resolve(root, 'apps/mcp/src/artifacts/artifacts-service.ts')
  )
  const { postgresArtifactsStore } = await import(
    resolve(root, 'apps/mcp/src/artifacts/artifacts-store.ts')
  )
  const { ArtifactChecks } = await import(
    resolve(root, 'apps/core/src/artifacts/artifact-checks.ts')
  )
  const { uuidv7 } = await import(resolve(root, 'packages/db/src/uuidv7.ts'))
  const tools = new McpArtifactsService({ store: postgresArtifactsStore(db) })
  const value = `synthetic-variable-${randomBytes(6).toString('hex')}`
  const refuses = (text) => (text.includes(value) ? 'client_value' : null)
  const published = []
  const checks = new ArtifactChecks({
    db,
    logger: { log() {}, warn() {} },
    pages: {
      publishDocuments: async (taskId, _turnId, refused) => published.push([taskId, [...refused]]),
    },
  })
  const taskId = await chat()
  const scope = {
    keyId: randomUUID(),
    taskId,
    workspaceId: workspace.id,
    sessionId: 'synthetic',
    turn: 1,
    firstEpoch: 1,
    epoch: 1,
    requirements: { repository: false, browser: false },
  }
  const valueOf = (answer) => {
    if (!answer.ok) throw Object.assign(new Error(answer.message), { code: answer.code })
    return answer.value
  }
  const created = valueOf(
    await tools.docCreate(scope, {
      title: 'План работ',
      view: 'page',
      sections: [
        { id: 'intro', intent: 'Введение' },
        { id: 'steps', intent: 'Шаги' },
      ],
    }),
  )
  const docId = created.docId
  check(
    'doc_create makes a document of plan 88 with its skeleton',
    (await dbModule.artifactPlaceholders(db, docId)) === 2,
  )
  const early = await tools.docFinish(scope, { docId })
  check(
    'doc_finish waits while a placeholder is left',
    !early.ok && early.code === 'DOC_PENDING_SECTIONS',
  )
  valueOf(
    await tools.docWrite(scope, { docId, id: 'intro', heading: 'Введение', markdown: 'Начинаем.' }),
  )
  valueOf(
    await tools.docWrite(scope, { docId, id: 'steps', heading: 'Шаги', markdown: `Ключ ${value}` }),
  )
  const own = valueOf(await tools.docRead(scope, { docId }))
  check(
    'doc_read gives the chat its own writes before the check',
    own.sections.map((each) => each.markdown).join('|') === `Начинаем.|Ключ ${value}`,
  )
  const client = await dbModule.readChatDocument(db, {
    workspaceId: workspace.id,
    documentId: docId,
    reader: 'client',
  })
  check(
    'the client reads no text of the agent before the check',
    client.sections.every((each) => each.markdown === null),
  )
  check(
    'doc_finish is taken once every section is written',
    (await tools.docFinish(scope, { docId })).ok,
  )
  await db.task.update({ where: { id: taskId }, data: { status: 'running' } })
  const outcome = await checks.settle(taskId, 1, refuses)
  const after = await db.artifact.findUniqueOrThrow({
    where: { id: docId },
    include: { content: true },
  })
  check(
    'the end of the turn shows what passed, keeps out the value and makes the version',
    outcome.refused === 1 &&
      after.currentVersion === 1 &&
      after.content?.markdown.includes('Начинаем.') === true &&
      !after.content.markdown.includes(value),
    JSON.stringify(outcome),
  )
  check(
    'the publications of documents follow with the refused named',
    published.length === 1 && published[0][1].includes(docId),
  )
  const next = { ...scope, turn: 2 }
  const read = valueOf(await tools.read(next, { artifactId: docId }))
  check(
    'artifact_read tells the chat which of its writes the check sent back',
    read.refusedSinceYourRead.includes('steps'),
  )
  const rev = read.blocks.find((each) => each.id === 'intro').rev
  await dbModule.applyArtifactOps(db, {
    batch: {
      artifactId: docId,
      opId: 'person-1',
      ops: [{ op: 'edit', block: 'intro', find: 'Начинаем', replace: 'Начнём' }],
    },
    actor: { kind: 'user', userId: user.id },
  })
  const stale = await tools.edit(next, {
    artifactId: docId,
    opId: 'agent-1',
    ops: [{ op: 'replace', block: 'intro', ifRev: rev, content: 'Иначе', props: { heading: 'В' } }],
  })
  // The person's lease of 30 s holds the block first (Ар17); the revision is stale under it too.
  check(
    'a block a person just edited is theirs: the agent is held off it',
    !stale.ok && stale.code === 'ARTIFACT_BLOCK_HELD' && stale.details?.reason === 'human',
    JSON.stringify(stale),
  )
  const again = valueOf(await tools.read(next, { artifactId: docId, part: 'outline' }))
  check(
    'the next read names the block a person changed',
    again.changedSinceYourRead.blocks.includes('intro'),
  )
  const table = await tools.create(next, { kind: 'canvas', title: 'Экраны' })
  check(
    'a kind whose view has not shipped is refused',
    !table.ok && table.code === 'ARTIFACT_KIND_REFUSED',
  )
  const listed = valueOf(await tools.list(next, {}))
  check(
    'artifact_list names the chat’s document',
    listed.artifacts.some((each) => each.id === docId),
  )
  // A pass without its client writes only the client's own, without a project (Ар24).
  const project = await db.project.create({
    data: { id: uuidv7(), workspaceId: workspace.id, name: 'Проект', createdById: user.id },
  })
  const inProject = await dbModule.createArtifact(db, {
    workspaceId: workspace.id,
    kind: 'document',
    title: 'Проектный',
    projectId: project.id,
    actor: { kind: 'user', userId: user.id },
  })
  const scheduled = await chat()
  await db.task.update({ where: { id: scheduled }, data: { projectId: project.id } })
  const unattended = { ...scope, taskId: scheduled, unattended: true }
  const refused = await tools.edit(unattended, {
    artifactId: inProject.id,
    opId: 'sched-1',
    ops: [{ op: 'title', title: 'Другое' }],
  })
  check(
    'a pass without its client changes no artifact of a project',
    !refused.ok && refused.code === 'ARTIFACT_FORBIDDEN',
  )
  const foreign = await tools.read({ ...scope, taskId: await chat() }, { artifactId: inProject.id })
  check(
    'a chat outside the project does not open its artifact',
    !foreign.ok && foreign.code === 'ARTIFACT_NOT_FOUND',
  )
}

/** `artifact_file_put` and `artifact_import` of mcp, then the outbox of the turn in core (88.12). */
async function outboxIntoArtifacts(databaseUrl) {
  const dbModule = await import(resolve(root, 'packages/db/src/index.ts'))
  const { McpArtifactsService } = await import(
    resolve(root, 'apps/mcp/src/artifacts/artifacts-service.ts')
  )
  const { postgresArtifactsStore } = await import(
    resolve(root, 'apps/mcp/src/artifacts/artifacts-store.ts')
  )
  const { ArtifactOutbox } = await import(
    resolve(root, 'apps/core/src/artifacts/artifact-outbox.ts')
  )
  const { packOutbox } = await import(resolve(root, 'packages/snapshots/src/index.ts'))
  const { uuidv7 } = await import(resolve(root, 'packages/db/src/uuidv7.ts'))
  const db = dbModule.createPrismaClient({ databaseUrl, log: [] })
  try {
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic outbox', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
    const taskId = (
      await db.task.create({
        data: { id: uuidv7(), workspaceId: workspace.id, createdById: user.id, status: 'running' },
        select: { id: true },
      })
    ).id
    const scope = {
      keyId: randomUUID(),
      taskId,
      workspaceId: workspace.id,
      sessionId: 'synthetic',
      turn: 1,
      firstEpoch: 1,
      epoch: 1,
      requirements: { repository: false, browser: false },
    }
    const tools = new McpArtifactsService({ store: postgresArtifactsStore(db) })
    const created = await tools.create(scope, { kind: 'mockup', title: 'Лендинг' })
    check('the agent creates a mockup without a skeleton', created.ok, JSON.stringify(created))
    const mockupId = created.value.artifactId
    const put = await tools.filePut(scope, { artifactId: mockupId, file: 'logo.png' })
    check(
      'artifact_file_put gives a reference at once',
      put.ok && /^artifact-file:[0-9a-f-]{36}$/.test(put.value.ref),
      JSON.stringify(put),
    )
    const imported = await tools.import(scope, { file: 'price.csv', title: 'Прайс' })
    check(
      'artifact_import names the new artifact now',
      imported.ok && imported.value.kind === 'table',
    )
    const objects = []
    const outbox = await packOutbox([
      {
        name: 'logo.png',
        bytes: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      },
      { name: 'price.csv', bytes: 'Название;Цена\nХлеб;120\nБатон;90\n' },
      { name: 'report.pdf', bytes: '%PDF-1.4' },
    ])
    const taken = await new ArtifactOutbox({
      db,
      storage: { put: async (_bucket, key) => objects.push(key) },
    }).take({ taskId, turn: 1, outbox })
    check(
      'core takes the reserved files of the outbox, the rest stays for the chat',
      [...taken].toSorted().join() === 'logo.png,price.csv' && objects.length === 1,
    )
    const table = await dbModule.readArtifact(db, {
      artifactId: imported.value.artifactId,
      actor: { kind: 'agent', taskId, turnNo: 1 },
    })
    check(
      'the CSV became a table of the agent’s writes waiting for the check',
      table.kind === 'table' &&
        table.blocks.map((block) => block.kind).join() === 'columns,row,row' &&
        table.blocks.every((block) => block.checking),
    )
    check(
      'the picture is a ready file of the mockup',
      (await db.artifactFile.count({ where: { artifactId: mockupId, state: 'ready' } })) === 1,
    )
  } finally {
    await db.$disconnect()
  }
}

function percentile(sorted, share) {
  return sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]
}

function summary(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const fixed = (value) => value.toFixed(1)
  return `${label}: n=${sorted.length} p50=${fixed(percentile(sorted, 0.5))} p95=${fixed(percentile(sorted, 0.95))} max=${fixed(sorted.at(-1) ?? 0)} ms`
}

/**
 * Slice 88.5: raditi_artifact → the relay of core → Redis, and the time of a commit of a person
 * typing alone, then under 8 turns that write and are checked in the same artifact (Ар20).
 */
async function channelAndMeasure(databaseUrl, redisUrl) {
  const dbModule = await import(resolve(root, 'packages/db/src/index.ts'))
  const pg = await import(resolve(root, 'packages/db/node_modules/pg/lib/index.js'))
  const { default: Redis } = await import(
    resolve(root, 'apps/core/node_modules/ioredis/built/index.js')
  )
  const { TaskSignalRelay } = await import(
    resolve(root, 'apps/core/src/task-signals/task-signal-relay.ts')
  )
  const { ArtifactChecks } = await import(
    resolve(root, 'apps/core/src/artifacts/artifact-checks.ts')
  )
  const db = dbModule.createPrismaClient({ databaseUrl, log: [] })
  const publisher = new Redis(redisUrl, { maxRetriesPerRequest: 1 })
  const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: 1 })
  const relay = new TaskSignalRelay({
    listener: () => new pg.default.Client({ connectionString: databaseUrl }),
    publish: (channel, message) => publisher.publish(channel, message),
    logger: { log: () => undefined, warn: () => undefined },
  })
  try {
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
    const person = { kind: 'user', userId: user.id }
    const { id } = await dbModule.createArtifact(db, {
      workspaceId: workspace.id,
      kind: 'document',
      title: 'Замер',
      actor: person,
    })
    const turns = []
    for (let index = 0; index < 8; index += 1)
      turns.push(
        (
          await db.task.create({
            data: { workspaceId: workspace.id, createdById: user.id, status: 'running' },
            select: { id: true },
          })
        ).id,
      )
    const keys = ['human', ...turns.map((_, index) => `agent${index}`)]
    await dbModule.applyArtifactOps(db, {
      batch: {
        artifactId: id,
        opId: randomUUID(),
        ops: keys.map((key, index) => ({
          op: 'insert',
          block: key,
          after: index === 0 ? null : keys[index - 1],
          kind: 'section',
          content: `Начало ${key}`,
          props: { heading: key },
        })),
      },
      actor: person,
    })

    // The channel: a committed batch reaches the Redis channel of the artifact as `changes`.
    const heard = []
    subscriber.on('message', (channel, message) =>
      heard.push({ channel, message, at: performance.now() }),
    )
    await subscriber.subscribe(`raditi:artifact:${id}`)
    relay.start()
    for (let attempt = 0; attempt < 50 && heard.length === 0; attempt += 1) {
      await dbModule
        .applyArtifactOps(db, {
          batch: {
            artifactId: id,
            opId: randomUUID(),
            ops: [{ op: 'props', block: 'human', props: {} }],
          },
          actor: person,
        })
        .catch(() => undefined)
      await sleep(100)
    }
    heard.length = 0
    const sent = performance.now()
    let rev = (await dbModule.readArtifact(db, { artifactId: id, actor: person })).blocks.find(
      (block) => block.key === 'human',
    ).rev
    const answer = await dbModule.applyArtifactOps(db, {
      batch: {
        artifactId: id,
        opId: randomUUID(),
        ops: [{ op: 'replace', block: 'human', ifRev: rev, content: 'Человек печатает' }],
      },
      actor: person,
    })
    rev = answer.blocks[0].rev
    for (let attempt = 0; attempt < 40 && heard.length === 0; attempt += 1) await sleep(25)
    check(
      'a batch reaches the Redis channel of its artifact as `changes`, through the relay of core',
      heard.length === 1 && heard[0].message === 'changes',
      JSON.stringify(heard),
    )
    const firstLag = heard[0].at - sent

    // The measurement: a person types (a replace every 100 ms) alone, then beside 8 turns.
    const seconds = Number(values.seconds)
    const human = async (until, samples, lags) => {
      while (performance.now() < until) {
        const before = performance.now()
        heard.length = 0
        const done = await dbModule.applyArtifactOps(db, {
          batch: {
            artifactId: id,
            opId: randomUUID(),
            ops: [
              {
                op: 'replace',
                block: 'human',
                ifRev: rev,
                content: `Человек печатает ${randomBytes(4).toString('hex')}`,
              },
            ],
          },
          actor: person,
        })
        const committed = performance.now()
        samples.push(committed - before)
        rev = done.blocks[0].rev
        for (let wait = 0; wait < 20 && heard.length === 0; wait += 1) await sleep(5)
        if (heard.length > 0) lags.push(heard[0].at - committed)
        await sleep(Math.max(0, 100 - (performance.now() - before)))
      }
    }
    const alone = []
    const aloneLags = []
    await human(performance.now() + Math.min(5, seconds) * 1000, alone, aloneLags)

    const checks = new ArtifactChecks({
      db,
      logger: { log: () => undefined, warn: () => undefined },
    })
    const refuses = () => null
    const loaded = []
    const loadedLags = []
    const agentWrites = []
    const checkTimes = []
    const refusedAgent = []
    const until = performance.now() + seconds * 1000
    const agent = async (taskId, index) => {
      let blockRev = null
      // 8 turns at once: each writes its block every 250 ms, under 120 writes a turn.
      let writes = 0
      while (performance.now() < until && writes < 110) {
        const before = performance.now()
        if (blockRev === null)
          blockRev = (
            await dbModule.readArtifact(db, { artifactId: id, actor: person })
          ).blocks.find((block) => block.key === `agent${index}`).rev
        try {
          const done = await dbModule.applyArtifactOps(db, {
            batch: {
              artifactId: id,
              opId: randomUUID(),
              ops: [
                {
                  op: 'replace',
                  block: `agent${index}`,
                  ifRev: blockRev,
                  content: `Агент ${index}: ${randomBytes(16).toString('hex')}`,
                },
              ],
            },
            actor: { kind: 'agent', taskId, turnNo: 1 },
            // Past the person's lease of the blocks they inserted for the agents (30 s).
            now: new Date(Date.now() + 60_000),
          })
          blockRev = done.blocks[0].rev
          writes += 1
        } catch (error) {
          refusedAgent.push(error?.code ?? 'unknown')
          blockRev = null
        }
        agentWrites.push(performance.now() - before)
        await sleep(Math.max(0, 250 - (performance.now() - before)))
      }
    }
    const checker = async (taskId) => {
      while (performance.now() < until) {
        const before = performance.now()
        await checks.checkLive(taskId, 1, refuses)
        checkTimes.push(performance.now() - before)
        await sleep(1500)
      }
    }
    await Promise.all([
      human(until, loaded, loadedLags),
      ...turns.map((taskId, index) => agent(taskId, index)),
      ...turns.map((taskId) => checker(taskId)),
    ])
    for (const taskId of turns) await checks.settle(taskId, 1, refuses)
    const lines = [
      `first signal ${firstLag.toFixed(1)} ms`,
      summary('person alone, commit', alone),
      summary('person alone, commit → next signal in Redis', aloneLags),
      summary('person beside 8 turns, commit', loaded),
      summary('person beside 8 turns, commit → next signal in Redis', loadedLags),
      summary('agent write', agentWrites),
      summary('live check of a turn', checkTimes),
      `agent writes refused: ${refusedAgent.length} (${[...new Set(refusedAgent)].join(', ') || 'none'})`,
    ]
    for (const line of lines) process.stdout.write(`[measure] ${line}\n`)
    const p95 = percentile(
      [...loaded].sort((a, b) => a - b),
      0.95,
    )
    check(
      'a person’s commit beside 8 turns stays under 250 ms at p95',
      loaded.length > 0 && p95 < 250,
      `p95 ${p95.toFixed(1)} ms`,
    )
    check(
      'the 8 turns wrote all the while, none of them refused',
      agentWrites.length > 8 * seconds && refusedAgent.length === 0,
      `${agentWrites.length} writes, ${refusedAgent.length} refused`,
    )
    check(
      'every agent write passed the live check, nothing waits after the end of the turns',
      (await db.artifactBlock.count({
        where: { documentId: id, pendingTaskId: { not: null } },
      })) === 0,
    )
  } finally {
    await relay.stop()
    publisher.disconnect()
    subscriber.disconnect()
    await db.$disconnect()
  }
}
