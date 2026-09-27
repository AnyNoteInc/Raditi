import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { runProcess } from './process.ts'

const roots: string[] = []
const callers: ChildProcess[] = []
const nativePids: number[] = []
const env = { PATH: process.env.PATH, HOME: tmpdir(), LANG: 'C' }

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(20)
  }
  throw new Error('Owned native process did not reach its expected lifecycle state')
}

afterEach(async () => {
  for (const caller of callers.splice(0)) {
    caller.kill('SIGCONT')
    caller.kill('SIGKILL')
  }
  for (const pid of nativePids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // An already reaped fixture needs no cleanup.
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function hangingCaller(timeoutMs: number) {
  const root = await mkdtemp(join(tmpdir(), 'raditi-native-deadline-'))
  roots.push(root)
  const marker = join(root, 'owned-process.json')
  const nativeProgram = `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,supervisorPid:process.ppid}));setInterval(()=>{},1000)`
  const moduleUrl = new URL('./process.ts', import.meta.url).href
  const callerProgram = `import {runProcess} from ${JSON.stringify(moduleUrl)};await runProcess(process.execPath,['--input-type=module','-e',${JSON.stringify(nativeProgram)}],{cwd:${JSON.stringify(root)},env:${JSON.stringify(env)},timeoutMs:${timeoutMs}}).catch(()=>{});`
  const caller = spawn(process.execPath, ['--input-type=module', '-e', callerProgram], {
    cwd: root,
    env,
    stdio: 'ignore',
  })
  callers.push(caller)
  let owned: { pid: number; supervisorPid: number } | undefined
  await eventually(async () => {
    try {
      owned = JSON.parse(await readFile(marker, 'utf8')) as typeof owned
      return owned !== undefined
    } catch {
      return false
    }
  })
  if (!owned) throw new Error('Native fixture did not start')
  nativePids.push(owned.pid, owned.supervisorPid)
  return { caller, ...owned }
}

describe('trusted native command supervision', () => {
  it('preserves fast binary stdout and native nonzero exit status exactly', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write(Buffer.from([0,255,10,13,128]));process.exitCode=7'],
      { cwd: tmpdir(), env },
    )
    expect(result.code).toBe(7)
    expect(result.stdout).toEqual(Buffer.from([0, 255, 10, 13, 128]))
  })

  it('forwards a complete binary stdin stream without losing the native output tail', async () => {
    const input = Buffer.alloc(512 * 1024, 0xff)
    input[0] = 0
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      {
        cwd: tmpdir(),
        env,
        input,
      },
    )
    expect(result).toEqual({ code: 0, stdout: input })
  })

  it('fails closed with its own generic error when output exceeds its bound', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'process.stdout.write("synthetic-private-error")'], {
        cwd: tmpdir(),
        env,
        maxBytes: 2,
      }),
    ).rejects.toMatchObject({
      code: 'PROCESS_OUTPUT_LIMIT',
      message: 'Trusted command output exceeded its limit',
    })
  })

  it('keeps a generic infrastructure error for a failing command', async () => {
    await expect(
      runProcess('/nonexistent/raditi-binary', [], { cwd: tmpdir(), env }),
    ).rejects.toMatchObject({ code: 'GIT_OPERATION_FAILED' })
  })

  it('rejects deadlines outside the fixed native-command budget before spawning', async () => {
    for (const timeoutMs of [0, -1, NaN, Infinity, 60_001, 0.5])
      await expect(
        runProcess(process.execPath, [], { cwd: tmpdir(), env, timeoutMs }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('kills the native process promptly when its caller dies with SIGKILL', async () => {
    const owned = await hangingCaller(10_000)
    expect(alive(owned.pid)).toBe(true)
    owned.caller.kill('SIGKILL')
    await eventually(() => !alive(owned.pid) && !alive(owned.supervisorPid))
  })

  it('kills remaining descendants when their leader exits and they close inherited stdio', async () => {
    const result = await runProcess(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();process.stdout.write(JSON.stringify({pid:child.pid}));`,
      ],
      { cwd: tmpdir(), env, timeoutMs: 1_000 },
    )
    const { pid } = JSON.parse(result.stdout.toString()) as { pid: number }
    nativePids.push(pid)
    expect(result.code).toBe(0)
    await eventually(() => !alive(pid))
  })

  it('enforces its own hard deadline while the caller is paused and cannot run timers', async () => {
    const owned = await hangingCaller(1_000)
    owned.caller.kill('SIGSTOP')
    try {
      await eventually(() => !alive(owned.pid))
      expect(owned.caller.pid && alive(owned.caller.pid)).toBe(true)
    } finally {
      owned.caller.kill('SIGCONT')
    }
    // A stopped parent cannot reap its exited supervisor until it resumes.
    await eventually(() => !alive(owned.supervisorPid))
  })
})
