#!/usr/bin/env node
// The stand of artifacts (docs/plan/88-artifacts.md, §10, it grows from stage Э1): a disposable
// PostgreSQL with the real migrations applied as production applies them (`prisma migrate deploy`
// on `public`), then a person and two chats of the agent write one document through @repo/db —
// the batch, the agent's write held until the check, its repeat, the signal raditi_artifact on a
// connection of its own, a version, the trash and the collector. Synthetic data only, no .env.
//
//   pnpm verify:artifacts [-- --keep]
//
// Slice 88.3 starts it with the database alone; the check of core, the tools of mcp, the cabinet
// and the measurement under 8 turns come with their slices.

import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '../../..')
const IMAGE =
  'postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
const LABEL = 'raditi.artifacts-verify'
const { values } = parseArgs({ options: { keep: { type: 'boolean', default: false } } })

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
  await scenario(databaseUrl)
  process.stdout.write(`[artifacts] ${passed} checks passed\n`)
} finally {
  if (started && !values.keep) await run('docker', ['rm', '-fv', name], { allowFailure: true })
  else if (started) process.stdout.write(`[artifacts] kept ${name}\n`)
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
