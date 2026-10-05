/* global process, URL */
// The engine gate of verify-llm-app.mjs, with a local executable in place of the Docker CLI: no
// daemon is reached and nothing is created.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const verifier = fileURLToPath(new URL('./verify-llm-app.mjs', import.meta.url))

// Answers what the verifier asks before it creates anything, and fails the first later call
// (`network ls`): a run that got that far has passed the engine gate.
const fakeDocker = ({ log, system, server }) => `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const format = args[args.indexOf('--format') + 1];
if (args[0] === 'context' && args[1] === 'inspect') console.log('unix:///tmp/raditi-llm-app-test.sock');
else if (args[0] === 'image' && args[1] === 'inspect') console.log('[]');
else if (args[0] === 'info' && format === '{{.OperatingSystem}}') console.log(${JSON.stringify(system)});
else if (args[0] === 'version' && format === '{{.Server.Version}}') console.log(${JSON.stringify(server)});
else process.exit(92);
`

async function invoke({ system = 'Ubuntu 24.04.4 LTS', server, args = [] }) {
  const directory = await mkdtemp(join(tmpdir(), 'raditi-llm-app-docker-test-'))
  try {
    const log = join(directory, 'calls.jsonl')
    await writeFile(log, '')
    await writeFile(join(directory, 'docker'), fakeDocker({ log, system, server }), { mode: 0o700 })
    const env = { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ''}` }
    for (const key of Object.keys(env)) if (key.startsWith('DOCKER_')) delete env[key]
    const result = spawnSync(process.execPath, [verifier, ...args], {
      env,
      encoding: 'utf8',
      timeout: 20_000,
    })
    const calls = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)[0])
    return { ...result, calls }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const refusal =
  /^Docker Engine (\S+|of an unknown version): the control call from core to llm needs Docker 29 or newer\. /m

test('native Linux: an engine before Docker 29 is refused by name before anything is created', async () => {
  // Neither a network nor a container, and no Compose project: only questions to the daemon.
  for (const [args, questions] of [
    [[], ['context', 'image', 'info', 'version']],
    [['--hairpin-only'], ['context', 'info', 'version']],
  ]) {
    const result = await invoke({ server: '28.0.4', args })
    assert.equal(result.status, 1)
    assert.equal(refusal.exec(result.stderr)?.[1], '28.0.4')
    assert.match(result.stdout, /^Docker Engine 28\.0\.4$/m)
    assert.deepEqual(result.calls, questions)
  }
})

test('native Linux: an engine whose version cannot be read is refused as well', async () => {
  for (const server of ['', 'dev', '0.0.0-dev']) {
    const result = await invoke({ server })
    assert.equal(result.status, 1)
    assert.match(result.stderr, refusal)
    assert.ok(!result.calls.includes('network'))
  }
})

test('native Linux: Docker 29 and newer pass the engine gate', async () => {
  for (const server of ['29.0.0', '29.5.2', '30.1.0']) {
    for (const args of [[], ['--hairpin-only']]) {
      const result = await invoke({ server, args })
      // The fake fails the first call after the gate.
      assert.equal(result.status, 1)
      assert.doesNotMatch(result.stderr, refusal)
      assert.equal(result.calls.at(-1), 'network')
    }
  }
})

test('Docker Desktop skips the control call, so its engine is not asked', async () => {
  const result = await invoke({ system: 'Docker Desktop', server: '28.0.4' })
  assert.doesNotMatch(result.stderr, refusal)
  assert.ok(!result.calls.includes('version'))
  assert.equal(result.calls.at(-1), 'network')
})
