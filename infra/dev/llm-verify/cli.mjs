import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * The tag of the three images of the stands. A run without --no-build builds them under it;
 * RADITI_VERIFY_IMAGE_TAG names another build, so that a run leaves the images of an earlier
 * one as they are.
 */
export const imageTag = (env = process.env) => {
  const tag = env.RADITI_VERIFY_IMAGE_TAG || 'b13'
  assert.match(tag, /^[a-z0-9][a-z0-9._-]{0,31}$/, 'Invalid RADITI_VERIFY_IMAGE_TAG')
  return tag
}
export const CLI_IMAGE = `raditi-p3verify-cli:${imageTag()}`
// The production agent runtime (infra/sandbox/Dockerfile, target runtime) the CLI image builds on.
export const RUNTIME_IMAGE = `raditi-p3verify-runtime:${imageTag()}`
// The network guard of the sandbox VM (target network-guard of the same Dockerfile).
export const GUARD_IMAGE = `raditi-p3verify-guard:${imageTag()}`
export const CLI_VERSIONS = Object.freeze({ opencode: '1.18.34' })
const GATEWAY = 'http://sandbox-gw:8080'
const INSIDE = '/usr/local/lib/raditi/cli.mjs'
const SECRETS = '/run/raditi/secrets'
const MAX_OUTPUT = 8 * 1024 * 1024
const tokenPattern = /^[\x21-\x7e]{1,8192}$/

/**
 * The search that lists the files under `roots` holding any of `needles`: the arguments of
 * grep and what it reads on its input. A stand runs it inside the CLI container
 * (`docker exec -i`) to show that a secret of the platform is in no file of the sandbox. The
 * needles travel on the input alone: as arguments they would stand in the process list of the
 * host and of the very container that is searched, and in Docker's record of the exec. Binary
 * files are searched as text (`-a`): the session database of a CLI, the one thing a turn leaves
 * to the next and to the session snapshots, is such a file.
 */
export function filesHoldingSearch(needles, roots) {
  assert.ok(needles.length > 0 && roots.length > 0)
  // One fixed string a line; an empty line would match every file.
  for (const needle of needles) assert.match(needle, /^[^\r\n]+$/, 'Not one line to search for')
  for (const root of roots) assert.match(root, /^\/[A-Za-z0-9_./-]*$/, 'Not an absolute path')
  return { argv: ['grep', '-raFl', '-f', '-', '--', ...roots], input: `${needles.join('\n')}\n` }
}

/**
 * The files the search has listed. grep answers 0 when it found a file and 1 when it found
 * none; anything else — a root that is missing, a file or a directory it may not read, no grep
 * at all — is a search that did not read everything, and no answer.
 */
export function filesHoldingResult({ code, stdout, stderr = '' }) {
  assert.ok(
    code === 0 || code === 1,
    `The files could not be searched: ${stderr.trim().split('\n')[0] || `exit ${code}`}`,
  )
  return stdout.split('\n').filter(Boolean)
}

export function dockerCommand(args, { input, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let bytes = 0
    let timedOut = false
    let exceeded = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const capture = (chunks) => (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT) {
        exceeded = true
        child.kill('SIGKILL')
      } else chunks.push(chunk)
    }
    child.stdout.on('data', capture(stdout))
    child.stderr.on('data', capture(stderr))
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('Could not start the synthetic CLI container command'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        timedOut,
        exceeded,
      })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/** A driver's PreparedRun as the sandbox runtime applies it: files, tmpfs secrets, env, argv. */
export function preparedInvocation({ files, secrets, env, argv }) {
  const file = (item, roots) =>
    item &&
    typeof item.path === 'string' &&
    roots.some((root) => item.path.startsWith(root)) &&
    !item.path.split('/').includes('..') &&
    typeof item.content === 'string' &&
    (item.mode === undefined ||
      (Number.isInteger(item.mode) && item.mode >= 0 && item.mode <= 0o777))
  assert.ok(Array.isArray(files) && files.every((item) => file(item, ['/agent-home/'])))
  assert.ok(Array.isArray(secrets) && secrets.every((item) => file(item, [`${SECRETS}/`])))
  assert.ok(
    env && typeof env === 'object' && Object.values(env).every((v) => typeof v === 'string'),
  )
  assert.ok(Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === 'string'))
  return { files, secrets, env, argv }
}

const successful = (result, action) => {
  assert.equal(result.code, 0, `Synthetic CLI ${action} failed`)
  return result
}

/**
 * Removes a stand directory that was bind-mounted into containers. Files written by container
 * uid 10001 belong to it on native Linux: the host user can neither list nor unlink them, so when
 * the host fails a throwaway root container empties the directory first.
 */
export async function removeMountedDirectory(
  directory,
  { docker = dockerCommand, image = CLI_IMAGE } = {},
) {
  assert.ok(isAbsolute(directory), 'An absolute owned directory is required')
  // Synchronous on purpose: fs.promises.rm removes siblings in parallel and rejects on the first
  // refusal while the others are still being deleted, under the container that empties the rest.
  const remove = () => rmSync(directory, { recursive: true, force: true })
  try {
    remove()
  } catch (error) {
    if (!['EACCES', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error
    successful(
      await docker([
        'run',
        '--rm',
        '--pull=never',
        '--network',
        'none',
        '--user',
        '0',
        '--mount',
        `type=bind,src=${directory},dst=/x`,
        '--entrypoint',
        'find',
        image,
        '/x',
        '-mindepth',
        '1',
        '-delete',
      ]),
      'directory cleanup',
    )
    remove()
  }
}

/** Only this newly created child directory is mounted. No host auth/config is consulted. */
export async function createCliSession({
  parentDirectory,
  network,
  address,
  gatewayIp,
  image = CLI_IMAGE,
  docker = dockerCommand,
} = {}) {
  assert.ok(isAbsolute(parentDirectory), 'An absolute private parent directory is required')
  assert.match(network, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
  if (address !== undefined) assert.equal(isIP(address), 4, 'Invalid CLI address')
  if (gatewayIp !== undefined) assert.equal(isIP(gatewayIp), 4, 'Invalid gateway address')
  assert.match(image, /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,255}$/)
  const inspected = successful(
    await docker(['network', 'inspect', network, '--format', '{{.Internal}}']),
    'network inspection',
  )
  assert.equal(inspected.stdout.trim(), 'true', 'The synthetic CLI needs an internal network')
  const directory = await mkdtemp(join(parentDirectory, 'cli-'))
  await chmod(directory, 0o700)
  const workspace = join(directory, 'repo')
  const home = join(directory, 'home')
  const inbox = join(directory, 'inbox')
  const containerName = `raditi-p3verify-cli-${randomUUID()}`
  let created = false
  let closed = false
  let busy = false
  let closing
  const close = () =>
    (closing ??= (async () => {
      closed = true
      if (created) {
        // The owner empties its mounts while the container exists. A failure is not final: the
        // container may be gone, or a CLI that outlived a killed exec may still be writing.
        await docker([
          'exec',
          containerName,
          'find',
          '/agent-home',
          '/workspace/repo',
          '-mindepth',
          '1',
          '-delete',
        ]).catch(() => {})
        successful(await docker(['rm', '-f', containerName]), 'cleanup')
      }
      created = false
      closed = true
      await removeMountedDirectory(directory, { docker, image })
    })())
  try {
    // The outer 0700 directory protects host files. Inner mount roots must be writable by
    // container uid 10001 even when the desktop host has a different uid (e.g. macOS 501).
    for (const path of [workspace, home]) {
      await mkdir(path)
      await chmod(path, 0o777)
    }
    // Client attachments (SANDBOX_INBOX): written by the host, read-only for the agent.
    await mkdir(inbox, { mode: 0o755 })
    await chmod(inbox, 0o755)
    created = true
    successful(
      await docker([
        'run',
        '-d',
        '--pull=never',
        '--name',
        containerName,
        '--label',
        'io.raditi.p3-cli-verification=true',
        '--network',
        network,
        ...(address ? ['--ip', address] : []),
        ...(gatewayIp ? ['--add-host', `sandbox-gw:${gatewayIp}`] : []),
        '--read-only',
        '--user',
        '10001:10001',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=512',
        '--cpus=2',
        '--memory=4g',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=128m',
        // As in a sandbox, the parent of the working copy belongs to the agent: the OpenCode
        // driver keeps the site's own OpenCode files there while its CLI runs.
        '--tmpfs',
        '/workspace:rw,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0755',
        // The home of the OpenCode driver, a tmpfs as /agent-home is in a sandbox: its wrapper
        // closes the CLI's configuration directories by their mode, and the bind mount below
        // does not hold the agent to that on a desktop host.
        '--tmpfs',
        '/agent-home/opencode:rw,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=0700',
        // Per-turn secrets of the drivers, like the sandbox's tmpfs: never on a bind mount.
        '--tmpfs',
        `${SECRETS}:rw,nosuid,nodev,noexec,size=1m,uid=10001,gid=10001,mode=0700`,
        '--mount',
        `type=bind,src=${workspace},dst=/workspace/repo`,
        '--mount',
        `type=bind,src=${inbox},dst=/workspace/inbox,readonly`,
        '--mount',
        `type=bind,src=${home},dst=/agent-home`,
        image,
      ]),
      'startup',
    )
    const execute = async (payload, timeoutMs = 120_000) => {
      assert.ok(!closed && !busy, 'The synthetic CLI session is closed or busy')
      assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 10 * 60_000)
      busy = true
      try {
        const result = await docker(['exec', '-i', containerName, 'node', INSIDE, '--inside'], {
          input: JSON.stringify({ ...payload, timeoutMs }),
          timeoutMs: timeoutMs + 5000,
        })
        if (result.code === 124) result.timedOut = true
        // Killing docker exec alone leaves its process running. Remove the owned container.
        if (result.timedOut || result.exceeded) await close()
        return result
      } finally {
        busy = false
      }
    }
    const lines = (stdout) =>
      stdout.split('\n').flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
    return {
      directory,
      workspace,
      home,
      inbox,
      containerName,
      close,
      /** Runs exactly what a driver prepared (prepare + command), as the sandbox runtime does. */
      async runPrepared({ timeoutMs = 180_000, ...prepared }) {
        assert.ok(!closed && !busy, 'The synthetic CLI session is closed or busy')
        const result = await execute(
          { action: 'prepared', ...preparedInvocation(prepared) },
          timeoutMs,
        )
        return { ...result, lines: lines(result.stdout) }
      },
      async request({ key, path, method = 'POST', headers = {}, body, timeoutMs = 10_000 }) {
        assert.ok(typeof key === 'string' && tokenPattern.test(key), 'Invalid synthetic CLI key')
        assert.ok(typeof path === 'string' && path.startsWith('/') && !path.startsWith('//'))
        const result = successful(
          await execute({ action: 'request', key, path, method, headers, body }, timeoutMs),
          'request',
        )
        return JSON.parse(result.stdout)
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

async function inside() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    assert.ok(bytes <= 4 * 1024 * 1024)
    chunks.push(chunk)
  }
  const options = JSON.parse(Buffer.concat(chunks).toString())
  let launch
  if (options.action === 'prepared') {
    // What LocalTurnExecutor does through the sandbox runtime: files, then the tmpfs secrets
    // (read-only for their owner), then the command in the working copy with the image env.
    const { files, secrets, env, argv } = preparedInvocation(options)
    for (const [file, mode] of [
      ...files.map((item) => [item, item.mode ?? 0o600]),
      ...secrets.map((item) => [item, (item.mode ?? 0o400) & 0o600]),
    ]) {
      mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 })
      rmSync(file.path, { force: true })
      writeFileSync(file.path, file.content, { mode })
      chmodSync(file.path, mode)
    }
    launch = { binary: argv[0], args: argv.slice(1), env: { ...process.env, ...env } }
  }
  if (options.action === 'request') {
    const response = await fetch(`${GATEWAY}${options.path}`, {
      method: options.method,
      headers: { ...options.headers, authorization: `Bearer ${options.key}` },
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: 'error',
    })
    process.stdout.write(
      JSON.stringify({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      }),
    )
    return
  }
  assert.ok(launch, 'Unknown synthetic CLI action')
  const { binary, args, env } = launch
  const child = spawn(binary, args, {
    cwd: '/workspace/repo',
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  })
  let timedOut = false
  const kill = () => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, options.timeoutMs)
  process.once('SIGTERM', kill)
  process.once('SIGINT', kill)
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => clearTimeout(timer))
  process.exitCode = timedOut ? 124 : (code ?? 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.deepEqual(process.argv.slice(2), ['--inside'])
  inside().catch(() => {
    process.stderr.write('Synthetic CLI operation failed\n')
    process.exitCode = 1
  })
}
