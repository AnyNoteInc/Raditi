import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
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
  CLI_IMAGE,
  CLI_VERSIONS,
  GUARD_IMAGE,
  RUNTIME_IMAGE,
  createCliSession,
  filesHoldingResult,
  filesHoldingSearch,
  imageTag,
  removeMountedDirectory,
} from './cli.mjs'

const key = 'synthetic-turn-key-only'
const reply = (stdout = '', code = 0) => ({ stdout, stderr: '', code, timedOut: false })
/** What the OpenCode driver prepares for a turn, in the shape the sandbox runtime applies. */
const prepared = {
  files: [
    { path: '/agent-home/opencode/.config/opencode/opencode.json', content: '{}\n', mode: 0o600 },
  ],
  secrets: [{ path: '/run/raditi/secrets/llm', content: key, mode: 0o400 }],
  env: { HOME: '/agent-home/opencode', NO_COLOR: '1' },
  argv: ['node', '/agent-home/opencode/run.mjs'],
}

test('session mounts only its private temporary tree and sends keys through exec stdin', async () => {
  const parentDirectory = await mkdtemp(join(tmpdir(), 'raditi-cli-test-'))
  const calls = []
  const docker = async (args, options) => {
    calls.push({ args, options })
    if (args[0] === 'network') return reply('true\n')
    if (args[0] === 'exec') return reply('{"type":"step_start","sessionID":"ses_synthetic"}\n')
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
    // Nothing is written for a CLI ahead of its driver: the home starts empty.
    assert.deepEqual(await readdir(session.home), [])
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
    // The parent of the working copy is the agent's to write, as in a sandbox: the OpenCode
    // driver keeps the site's own OpenCode files there while its CLI runs.
    assert.ok(
      startup.some((arg) => arg.startsWith('/workspace:rw,') && arg.includes('uid=10001')),
      'The parent of the working copy must be a tmpfs of the agent',
    )
    // The home of the OpenCode driver is a tmpfs as well, as the whole /agent-home is in a
    // sandbox: its wrapper closes directories by their mode, and a bind mount of a desktop
    // host does not hold the agent to that.
    assert.ok(
      startup.some(
        (arg) => arg.startsWith('/agent-home/opencode:rw,') && arg.includes('mode=0700'),
      ),
      'The home of the OpenCode driver must be a tmpfs',
    )
    assert.ok(
      startup.some((arg) => arg.startsWith('/run/raditi/secrets:') && arg.includes('mode=0700')),
    )
    // A driver's prepared run reaches the container only through exec stdin.
    const ran = await session.runPrepared(prepared)
    assert.deepEqual(ran.lines, [{ type: 'step_start', sessionID: 'ses_synthetic' }])
    const preparedExec = calls.filter((call) => call.args[0] === 'exec').at(-1)
    assert.ok(!JSON.stringify(preparedExec.args).includes(key))
    assert.deepEqual(JSON.parse(preparedExec.options.input), {
      action: 'prepared',
      ...prepared,
      timeoutMs: 180_000,
    })
    for (const unsafe of [
      { ...prepared, files: [{ path: '/workspace/repo/AGENTS.md', content: 'x' }] },
      { ...prepared, secrets: [{ path: '/agent-home/opencode/llm', content: key }] },
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
    const result = await session.runPrepared({ ...prepared, timeoutMs: 100 })
    assert.equal(result.timedOut, true)
    assert.ok(calls.some((args) => args[0] === 'rm' && args.includes(session.containerName)))
    assert.deepEqual(await readdir(parentDirectory), [])
    await assert.rejects(session.runPrepared(prepared), /closed or busy/)
  } finally {
    await rm(parentDirectory, { recursive: true, force: true })
  }
})

// What container uid 10001 leaves in its bind mounts on native Linux: a 0700 driver home the host
// user can neither list nor unlink. This host cannot chown, so mode 000 on an own directory stands
// in for it: the failing call (scandir without access) is the same.
const foreignTree = async (session) => {
  const data = join(session.home, 'opencode/.local/share/opencode')
  await mkdir(data, { recursive: true, mode: 0o700 })
  await writeFile(join(data, 'opencode.db'), 'synthetic\n')
  await writeFile(join(session.workspace, 'first.txt'), 'synthetic\n')
  // Enough siblings that a removal which is still running in the background after its first
  // refusal would race whoever empties the directory next.
  await mkdir(join(session.workspace, 'node_modules'))
  for (let index = 0; index < 400; index++)
    await writeFile(join(session.workspace, 'node_modules', `file-${index}.js`), '')
  await chmod(join(session.home, 'opencode'), 0o000)
}
// The fake of a process that owns those files: it may enter and delete them. Like `find
// -delete`, it fails on an entry that vanishes while it works.
const deleteAsOwner = async (session, roots) => {
  await chmod(join(session.home, 'opencode'), 0o700)
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
      if (session) await chmod(join(session.home, 'opencode'), 0o700).catch(() => {})
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
      if (session) await chmod(join(session.home, 'opencode'), 0o700).catch(() => {})
      await rm(parentDirectory, { recursive: true, force: true })
    }
  },
)

test(
  'a stand directory the host cannot empty is emptied by a throwaway container, once',
  { skip: hostIsRoot },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'raditi-cli-test-'))
    const locked = join(directory, 'cli-left/home/opencode')
    const calls = []
    try {
      await mkdir(join(locked, '.local'), { recursive: true })
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

test('the CLI image is the production agent runtime with the verified CLI, run as non-root', async () => {
  const source = await readFile(new URL('./cli.Dockerfile', import.meta.url), 'utf8')
  // No CLI install of its own: the lockfile-built runtime stage of infra/sandbox/Dockerfile.
  assert.match(source, /^ARG RUNTIME_IMAGE=raditi-p3verify-runtime:b13$/m)
  assert.equal(RUNTIME_IMAGE, `raditi-p3verify-runtime:${imageTag()}`)
  assert.match(source, /^FROM \$\{RUNTIME_IMAGE\}$/m)
  assert.doesNotMatch(source, /npm (install|i|ci)\b/)
  assert.deepEqual(CLI_VERSIONS, { opencode: '1.18.34' })
  const packages = { opencode: 'opencode-ai' }
  for (const [name, version] of Object.entries(CLI_VERSIONS)) {
    // The build fails unless the runtime holds exactly the verified version.
    assert.ok(source.includes(`npm ls ${packages[name]}@${version} `), packages[name])
  }
  assert.match(source, /^USER 10001:10001$/m)
})

test('the stands name their three images by one tag, which a run may choose', () => {
  // Unset or empty, the tag a run without --no-build has always built.
  for (const env of [{}, { RADITI_VERIFY_IMAGE_TAG: '' }]) assert.equal(imageTag(env), 'b13')
  assert.equal(imageTag({ RADITI_VERIFY_IMAGE_TAG: 'g8' }), 'g8')
  // A tag, never a repository, a digest or an option of docker.
  for (const tag of ['g8:latest', 'other/image', '-f', 'a b', 'G8', 'x'.repeat(33), 'a@sha256'])
    assert.throws(() => imageTag({ RADITI_VERIFY_IMAGE_TAG: tag }), /RADITI_VERIFY_IMAGE_TAG/)
  const tag = imageTag()
  assert.deepEqual(
    [RUNTIME_IMAGE, CLI_IMAGE, GUARD_IMAGE],
    [
      `raditi-p3verify-runtime:${tag}`,
      `raditi-p3verify-cli:${tag}`,
      `raditi-p3verify-guard:${tag}`,
    ],
  )
})

test('the search for a secret in the files of a sandbox reads binary files as well', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'raditi-cli-search-'))
  const home = join(directory, 'home')
  try {
    const needle = 'synthetic-needle-for-the-search'
    await mkdir(join(home, '.local/share'), { recursive: true })
    // As the session database of a CLI, the one thing a turn leaves to the next: text among
    // bytes that a search for text lines alone would skip.
    await writeFile(
      join(home, '.local/share/session.db'),
      Buffer.concat([
        Buffer.from('SQLite format 3\0\0\u0001'),
        Buffer.from(needle),
        Buffer.from([0, 255, 0]),
      ]),
    )
    await writeFile(join(home, 'plain.log'), `first line\n${needle}\n`)
    await writeFile(join(home, 'other.log'), 'nothing of the kind\n')
    const search = (needles, roots) => {
      const { argv, input } = filesHoldingSearch(needles, roots)
      // A secret searched for stands in no argument of a process.
      for (const word of needles) assert.equal(argv.join(' ').includes(word), false)
      const [program, ...args] = argv
      const { status, stdout, stderr } = spawnSync(program, args, { input, encoding: 'utf8' })
      return { code: status, stdout, stderr }
    }
    const found = (needles, roots) => filesHoldingResult(search(needles, roots)).sort()
    // Nothing a shell would have to quote is a word here: the strings are data on the input.
    assert.deepEqual(found(["an'other $(needle)", needle], [home]), [
      join(home, '.local/share/session.db'),
      join(home, 'plain.log'),
    ])
    assert.deepEqual(found(['absent-needle'], [directory]), [])

    // A search that could not read everything is no answer, whatever it did find.
    const missing = search([needle], [home, join(directory, 'missing')])
    assert.match(missing.stdout, /plain\.log/)
    assert.throws(() => filesHoldingResult(missing), /could not be searched.*missing/)
    // A mode closes nothing to root.
    if (process.getuid?.() !== 0) {
      await chmod(join(home, 'plain.log'), 0o000)
      assert.throws(() => found([needle], [home]), /could not be searched.*plain\.log/)
      await chmod(join(home, 'plain.log'), 0o600)
      await chmod(join(home, '.local'), 0o000)
      assert.throws(() => found([needle], [home]), /could not be searched.*\.local/)
    }
    // No grep to run at all, as Docker reports it.
    assert.throws(
      () => filesHoldingResult({ code: 127, stdout: '', stderr: '' }),
      /could not be searched: exit 127/,
    )

    // An empty line would match every file; a root is a path, never an option of grep.
    for (const word of ['', 'two\nlines', 'a\r'])
      assert.throws(() => filesHoldingSearch([word], ['/tmp']), /one line/)
    for (const root of ['-rf', 'relative/path', '/tmp; id', ''])
      assert.throws(() => filesHoldingSearch(['a'], [root]), /absolute path/)
    assert.throws(() => filesHoldingSearch([], ['/tmp']))
    assert.throws(() => filesHoldingSearch(['a'], []))
  } finally {
    await chmod(join(home, '.local'), 0o700).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})
