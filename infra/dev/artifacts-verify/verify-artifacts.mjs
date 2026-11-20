#!/usr/bin/env node
// The stand of artifacts (docs/plan/88-artifacts.md, §10, it grows from stage Э1): a disposable
// PostgreSQL with the real migrations applied as production applies them (`prisma migrate deploy`
// on `public`), then a person and two chats of the agent write one document through @repo/db —
// the batch, the agent's write held until the check, its repeat, the signal raditi_artifact on a
// connection of its own, a version, the trash and the collector. Synthetic data only, no .env.
//
//   pnpm verify:artifacts [-- --keep] [--seconds 20]
//
// Slice 88.3 starts it with the database alone; 88.4 adds the check of core (`ArtifactChecks`):
// a write with a value of the workspace's variables is refused live, a clean one shown, a failed
// turn's writes dropped, the collector by the time of the write. The tools of mcp, the cabinet and
// the measurement under 8 turns come with their slices. 88.5 adds Redis: the relay of core carries
// raditi_artifact to the channel of the artifact, and the commit time of a person typing is
// measured under 8 turns writing and being checked in the same artifact (Ар20, plan 86, §4).

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
  options: {
    keep: { type: 'boolean', default: false },
    seconds: { type: 'string', default: '20' },
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
  await scenario(databaseUrl)
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
  await channelAndMeasure(databaseUrl, `redis://${redisBinding}`)
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
