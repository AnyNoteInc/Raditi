import assert from 'node:assert/strict'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import test from 'node:test'

import {
  CLI_VERSIONS,
  RUNTIME_IMAGE,
  cliInvocation,
  compileCodexConfig,
  compileKimiConfig,
  createCliSession,
  removeMountedDirectory,
} from './cli.mjs'

const key = 'synthetic-turn-key-b13-only'
const prompt = 'Synthetic verification only.'
const reply = (stdout = '', code = 0) => ({ stdout, stderr: '', code, timedOut: false })

test('driver invocations isolate environment, keep keys out of argv, and preserve native resume', () => {
  const previous = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'must-not-be-inherited'
  try {
    for (const driver of ['codex', 'kimi']) {
      const command = cliInvocation({ driver, key, prompt, resume: 'synthetic-session' })
      assert.ok(!JSON.stringify(command.args).includes(key))
      assert.equal(command.env.OPENAI_API_KEY, undefined)
      assert.equal(command.env.HOME, '/agent-home')
      assert.ok(command.args.includes('synthetic-session'))
      if (driver === 'codex') {
        assert.deepEqual(command.args.slice(0, 2), ['exec', 'resume'])
        assert.equal(command.env.RADITI_LLM_TOKEN, key)
        assert.ok(!command.args.includes('--ephemeral'))
      } else {
        assert.equal(command.env.KIMI_MODEL_API_KEY, key)
        assert.equal(command.env.KIMI_MODEL_PROVIDER_TYPE, 'kimi')
        assert.equal(command.env.KIMI_MODEL_MAX_OUTPUT_SIZE, '65536')
        assert.equal(command.env.KIMI_MODEL_THINKING_EFFORT, 'low')
        assert.equal(command.env.KIMI_CODE_BUILTIN_PRODUCT_SKILLS, '0')
        assert.ok(!command.args.some((arg) => ['--yolo', '--auto', '--plan'].includes(arg)))
      }
    }
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous
  }
})

test('synthetic configs disable unrelated traffic and never contain credentials', () => {
  const config = compileCodexConfig()
  assert.match(config, /requires_openai_auth = false/)
  assert.match(config, /supports_websockets = false/)
  assert.match(config, /base_url = "http:\/\/sandbox-gw:8080\/codex"/)
  assert.match(config, /multi_agent = false/)
  assert.ok(!config.includes(key))
  assert.match(compileKimiConfig(), /auto_session_title = false/)
  assert.ok(!compileKimiConfig().includes('secondary_model'))
  assert.throws(() => compileCodexConfig({ model: 'model"\nmalicious=true' }))
  assert.throws(() => cliInvocation({ driver: 'unknown', key, prompt }))
  assert.throws(() => cliInvocation({ driver: 'kimi', key, prompt, outputSchema: {} }))
  assert.throws(
    () => cliInvocation({ driver: 'codex', key: 'bad\nsecret', prompt }),
    (error) => !error.message.includes('bad\nsecret'),
  )
})

test('session mounts only its private temporary tree and sends keys through exec stdin', async () => {
  const parentDirectory = await mkdtemp(join(tmpdir(), 'raditi-cli-test-'))
  const calls = []
  const docker = async (args, options) => {
    calls.push({ args, options })
    if (args[0] === 'network') return reply('true\n')
    if (args[0] === 'exec') return reply('{"type":"thread.started","thread_id":"synthetic-id"}\n')
    return reply()
  }
  try {
    const session = await createCliSession({
      parentDirectory,
      network: 'synthetic_cli',
      address: '172.30.45.10',
      gatewayIp: '172.30.45.2',
      docker,
    })
    assert.equal((await stat(session.directory)).mode & 0o777, 0o700)
    // Hand-written configs stay apart from the drivers' /agent-home/{codex,kimi}.
    assert.deepEqual(await readdir(session.home), ['b13'])
    assert.deepEqual((await readdir(join(session.home, 'b13'))).sort(), ['codex', 'kimi'])
    assert.ok(
      (await readFile(join(session.home, 'b13/codex/config.toml'), 'utf8')).includes('raditi'),
    )
    const startup = calls.find((call) => call.args[0] === 'run').args
    assert.ok(startup.includes('--read-only'))
    assert.ok(startup.includes('10001:10001'))
    assert.ok(startup.includes('--cap-drop=ALL'))
    assert.ok(startup.includes('sandbox-gw:172.30.45.2'))
    assert.ok(!startup.includes('--env'))
    for (let i = 0; i < startup.length; i++) {
      if (startup[i] === '--mount') assert.ok(startup[i + 1].includes(`src=${session.directory}/`))
    }
    assert.ok(startup.includes(`type=bind,src=${session.inbox},dst=/workspace/inbox,readonly`))
    assert.ok(
      startup.some((arg) => arg.startsWith('/run/raditi/secrets:') && arg.includes('mode=0700')),
    )
    const result = await session.run({
      driver: 'codex',
      key,
      prompt,
      outputSchema: { type: 'object' },
    })
    assert.equal(result.threadId, 'synthetic-id')
    const exec = calls.find((call) => call.args[0] === 'exec')
    assert.ok(!JSON.stringify(exec.args).includes(key))
    assert.equal(JSON.parse(exec.options.input).key, key)
    assert.deepEqual(
      JSON.parse(await readFile(join(session.home, 'b13/codex/output-schema.json'), 'utf8')),
      { type: 'object' },
    )
    // A driver's prepared run reaches the container only through exec stdin.
    const prepared = {
      files: [{ path: '/agent-home/codex/config.toml', content: 'model = "m"\n', mode: 0o600 }],
      secrets: [{ path: '/run/raditi/secrets/llm', content: key, mode: 0o400 }],
      env: { CODEX_HOME: '/agent-home/codex' },
      argv: ['node', '/agent-home/codex/run.mjs'],
    }
    const ran = await session.runPrepared(prepared)
    assert.deepEqual(ran.lines, [{ type: 'thread.started', thread_id: 'synthetic-id' }])
    const preparedExec = calls.filter((call) => call.args[0] === 'exec').at(-1)
    assert.ok(!JSON.stringify(preparedExec.args).includes(key))
    assert.deepEqual(JSON.parse(preparedExec.options.input), {
      action: 'prepared',
      ...prepared,
      timeoutMs: 180_000,
    })
    for (const unsafe of [
      { ...prepared, files: [{ path: '/workspace/repo/AGENTS.md', content: 'x' }] },
      { ...prepared, secrets: [{ path: '/agent-home/codex/llm', content: key }] },
      { ...prepared, files: [{ path: '/agent-home/../etc/passwd', content: 'x' }] },
      { ...prepared, argv: [] },
      { ...prepared, env: { KEY: 1 } },
    ])
      await assert.rejects(session.runPrepared(unsafe))
    await Promise.all([session.close(), session.close()])
    await session.close()
    assert.equal(calls.filter((call) => call.args[0] === 'rm').length, 1)
    assert.deepEqual(await readdir(parentDirectory), [])
  } finally {
    await rm(parentDirectory, { recursive: true, force: true })
  }
})

test('an external network is refused before any container or directory is created', async () => {
  const parentDirectory = await mkdtemp(join(tmpdir(), 'raditi-cli-test-'))
  const calls = []
  try {
    await assert.rejects(
      createCliSession({
        parentDirectory,
        network: 'unsafe',
        docker: async (args) => {
          calls.push(args)
          return reply('false')
        },
      }),
      /internal network/,
    )
    assert.equal(calls.length, 1)
    assert.deepEqual(await readdir(parentDirectory), [])
  } finally {
    await rm(parentDirectory, { recursive: true, force: true })
  }
})

test('a stuck exec removes its owned container instead of abandoning a running CLI', async () => {
  const parentDirectory = await mkdtemp(join(tmpdir(), 'raditi-cli-test-'))
  const calls = []
  const docker = async (args) => {
    calls.push(args)
    if (args[0] === 'network') return reply('true')
    if (args[0] === 'exec') return reply('', 124)
    return reply()
  }
  try {
    const session = await createCliSession({ parentDirectory, network: 'synthetic', docker })
    const result = await session.run({ driver: 'codex', key, prompt, timeoutMs: 100 })
    assert.equal(result.timedOut, true)
    assert.ok(calls.some((args) => args[0] === 'rm' && args.includes(session.containerName)))
    assert.deepEqual(await readdir(parentDirectory), [])
    await assert.rejects(session.run({ driver: 'codex', key, prompt }), /closed or busy/)
  } finally {
    await rm(parentDirectory, { recursive: true, force: true })
  }
})

// What container uid 10001 leaves in its bind mounts on native Linux: a 0700 driver home the host
// user can neither list nor unlink. This host cannot chown, so mode 000 on an own directory stands
// in for it: the failing call (scandir without access) is the same.
const foreignTree = async (session) => {
  const sessions = join(session.home, 'codex/sessions')
  await mkdir(sessions, { recursive: true, mode: 0o700 })
  await writeFile(join(sessions, 'rollout.jsonl'), '{}\n')
  await writeFile(join(session.workspace, 'b13-first.txt'), 'synthetic\n')
  // Enough siblings that a removal which is still running in the background after its first
  // refusal would race whoever empties the directory next.
  await mkdir(join(session.workspace, 'node_modules'))
  for (let index = 0; index < 400; index++)
    await writeFile(join(session.workspace, 'node_modules', `file-${index}.js`), '')
  await chmod(join(session.home, 'codex'), 0o000)
}
// The fake of a process that owns those files: it may enter and delete them. Like `find
// -delete`, it fails on an entry that vanishes while it works.
const deleteAsOwner = async (session, roots) => {
  await chmod(join(session.home, 'codex'), 0o700)
  const remove = async (path) => {
    if ((await lstat(path)).isDirectory()) {
      for (const entry of await readdir(path)) await remove(join(path, entry))
      await rmdir(path)
    } else await unlink(path)
  }
  for (const root of roots) for (const entry of await readdir(root)) await remove(join(root, entry))
}
const hostIsRoot = process.getuid?.() === 0 && 'root lists any directory'

test(
  'close() has the container empty its mounts as their owner before the host removes them',
  { skip: hostIsRoot },
  async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), 'raditi-cli-test-'))
    const calls = []
    let session
    const docker = async (args) => {
      calls.push(args)
      if (args[0] === 'network') return reply('true\n')
      if (args[0] === 'exec' && args.includes('find')) {
        assert.ok(!calls.some((call) => call[0] === 'rm'), 'the container is still there')
        await deleteAsOwner(session, [session.home, session.workspace])
      }
      return reply()
    }
    try {
      session = await createCliSession({ parentDirectory, network: 'synthetic', docker })
      await foreignTree(session)
      await session.close()
      assert.deepEqual(
        calls.slice(2).map((args) => args.join(' ')),
        [
          `exec ${session.containerName} find /agent-home /workspace/repo -mindepth 1 -delete`,
          `rm -f ${session.containerName}`,
        ],
      )
      assert.deepEqual(await readdir(parentDirectory), [])
    } finally {
      if (session) await chmod(join(session.home, 'codex'), 0o700).catch(() => {})
      await rm(parentDirectory, { recursive: true, force: true })
    }
  },
)

test(
  'close() empties the mounts with a throwaway root container when its own one is already gone',
  { skip: hostIsRoot },
  async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), 'raditi-cli-test-'))
    const calls = []
    let session
    const docker = async (args) => {
      calls.push(args)
      if (args[0] === 'network') return reply('true\n')
      // The container died: exec finds nothing to run in.
      if (args[0] === 'exec') return reply('', 1)
      if (args[0] === 'run' && args.includes('--rm'))
        await deleteAsOwner(session, [session.directory])
      return reply()
    }
    try {
      session = await createCliSession({
        parentDirectory,
        network: 'synthetic',
        image: 'synthetic-cli:test',
        docker,
      })
      await foreignTree(session)
      await session.close()
      assert.deepEqual(
        calls.slice(2).map((args) => args.join(' ')),
        [
          `exec ${session.containerName} find /agent-home /workspace/repo -mindepth 1 -delete`,
          `rm -f ${session.containerName}`,
          'run --rm --pull=never --network none --user 0 ' +
            `--mount type=bind,src=${session.directory},dst=/x ` +
            '--entrypoint find synthetic-cli:test /x -mindepth 1 -delete',
        ],
      )
      assert.deepEqual(await readdir(parentDirectory), [])
    } finally {
      if (session) await chmod(join(session.home, 'codex'), 0o700).catch(() => {})
      await rm(parentDirectory, { recursive: true, force: true })
    }
  },
)

test(
  'a stand directory the host cannot empty is emptied by a throwaway container, once',
  { skip: hostIsRoot },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'raditi-cli-test-'))
    const locked = join(directory, 'cli-left/home/codex')
    const calls = []
    try {
      await mkdir(join(locked, 'sessions'), { recursive: true })
      await chmod(locked, 0o000)
      await removeMountedDirectory(directory, {
        image: 'synthetic-cli:test',
        docker: async (args) => {
          calls.push(args)
          await chmod(locked, 0o700)
          await rm(join(directory, 'cli-left'), { recursive: true })
          return reply()
        },
      })
      assert.equal(calls.length, 1)
      await assert.rejects(stat(directory), { code: 'ENOENT' })
      // A directory the host owns entirely needs no container at all.
      const own = await mkdtemp(join(tmpdir(), 'raditi-cli-test-'))
      await writeFile(join(own, 'compose.env'), 'synthetic\n')
      await removeMountedDirectory(own, { docker: () => assert.fail('no container is needed') })
      await assert.rejects(stat(own), { code: 'ENOENT' })
      // A container that cannot empty it is reported, not hidden.
      const stuck = await mkdtemp(join(tmpdir(), 'raditi-cli-test-'))
      await mkdir(join(stuck, 'home/kept'), { recursive: true })
      await chmod(join(stuck, 'home'), 0o000)
      try {
        await assert.rejects(
          removeMountedDirectory(stuck, { docker: async () => reply('', 125) }),
          /cleanup failed/,
        )
      } finally {
        await chmod(join(stuck, 'home'), 0o700)
        await rm(stuck, { recursive: true, force: true })
      }
    } finally {
      await chmod(locked, 0o700).catch(() => {})
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test('the CLI image is the production agent runtime with the verified CLIs, run as non-root', async () => {
  const source = await readFile(new URL('./cli.Dockerfile', import.meta.url), 'utf8')
  // No CLI install of its own: the lockfile-built runtime stage of infra/sandbox/Dockerfile.
  assert.match(source, /^ARG RUNTIME_IMAGE=raditi-p3verify-runtime:b13$/m)
  assert.equal(RUNTIME_IMAGE, 'raditi-p3verify-runtime:b13')
  assert.match(source, /^FROM \$\{RUNTIME_IMAGE\}$/m)
  assert.doesNotMatch(source, /npm (install|i|ci)\b/)
  for (const [name, version] of Object.entries(CLI_VERSIONS)) {
    const pkg = name === 'codex' ? '@openai/codex' : '@moonshot-ai/kimi-code'
    // The build fails unless the runtime holds exactly the verified version.
    assert.ok(source.includes(`npm ls ${pkg}@${version} `), pkg)
  }
  assert.match(source, /^USER 10001:10001$/m)
})
