#!/usr/bin/env node
// The chat's way from the database to the screen, measured on a disposable PostgreSQL with
// pg_stat_statements (README.md). Synthetic chats only: nothing of a client, no .env, no model.
//
//   pnpm perf:chat [--out <file.json>] [--label <name>] [--keep]
//
// The measurements themselves are packages/trpc/src/routers/chat-feed.perf.test.ts, run by vitest
// with RADITI_PERF_BENCH=1; this script owns the database around them and prints their report.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '../../..')
const IMAGE =
  'postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
const LABEL = 'raditi.perf-verify'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    label: { type: 'string', default: 'run' },
    keep: { type: 'boolean', default: false },
  },
})

function run(program, args, { env = {}, input, allowFailure = false } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(program, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    if (input !== undefined) child.stdin.end(input)
    child.on('error', fail)
    child.on('close', (code) => {
      if (code !== 0 && !allowFailure)
        fail(new Error(`${program} ${args.join(' ')} exited ${code}\n${output.slice(-4000)}`))
      else done({ code, output: output.trim() })
    })
  })
}

const name = `raditi-perf-${randomBytes(4).toString('hex')}`
const password = randomBytes(18).toString('base64url')
const directory = await mkdtemp(join(tmpdir(), 'raditi-perf-'))
const out = values.out ? resolve(values.out) : join(directory, 'report.json')
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
    'postgres',
    '-c',
    'shared_preload_libraries=pg_stat_statements',
    '-c',
    'pg_stat_statements.track=all',
    '-c',
    'pg_stat_statements.max=10000',
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
  await run('docker', [
    'exec',
    name,
    'psql',
    '-U',
    'raditi',
    '-d',
    'raditi',
    '-c',
    'CREATE EXTENSION IF NOT EXISTS pg_stat_statements',
  ])
  const binding = (await run('docker', ['port', name, '5432/tcp'])).output.split('\n')[0]
  const databaseUrl = `postgresql://raditi:${password}@${binding}/raditi`
  const env = { DATABASE_URL: databaseUrl, NODE_ENV: 'test' }
  process.stdout.write(`[perf] database ${binding}: migrations and seed\n`)
  await run('pnpm', ['--filter', '@repo/db', 'exec', 'prisma', 'generate'], { env })
  await run('pnpm', ['--filter', '@repo/db', 'exec', 'prisma', 'migrate', 'deploy'], { env })
  await run('pnpm', ['--filter', '@repo/db', 'exec', 'node', 'prisma/seed.ts'], { env })
  process.stdout.write('[perf] measuring\n')
  const bench = await run(
    'pnpm',
    [
      '--filter',
      '@repo/trpc',
      'exec',
      'vitest',
      'run',
      'src/routers/chat-feed.perf.test.ts',
      '--testTimeout=1800000',
      '--hookTimeout=1800000',
    ],
    {
      env: {
        ...env,
        RADITI_PERF_BENCH: '1',
        RADITI_PERF_OUT: out,
        RADITI_PERF_LABEL: values.label,
      },
      allowFailure: true,
    },
  )
  if (bench.code !== 0) throw new Error(`the measurements failed\n${bench.output.slice(-6000)}`)
  const report = JSON.parse(await readFile(out, 'utf8'))
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n[perf] report: ${out}\n`)
} finally {
  if (started && !values.keep) await run('docker', ['rm', '-fv', name], { allowFailure: true })
  else if (started) process.stdout.write(`[perf] kept ${name}\n`)
  if (!values.out) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
}
