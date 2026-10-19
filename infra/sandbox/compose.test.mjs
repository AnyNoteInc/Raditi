import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const compose = await readFile(new URL('./docker-compose.yml', import.meta.url), 'utf8')

/** The lines of one top-level service, up to the next one. */
function service(name) {
  const lines = compose.split('\n')
  const start = lines.indexOf(`  ${name}:`)
  assert.notEqual(start, -1, `service ${name} is missing`)
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z][\w-]*:$/.test(line))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}

test('the runner opens no port and gets no platform credentials, only its read-only token', () => {
  const runner = service('runner')
  assert.doesNotMatch(runner, /^\s+(ports|expose):/m)
  assert.doesNotMatch(runner, /network_mode:\s*host/)
  assert.doesNotMatch(runner, /DATABASE_URL|REDIS_URL|VAULT_|(?<!RUNNER_)S3_/)
  assert.match(runner, /^\s+- \/etc\/raditi:\/etc\/raditi:ro$/m)
  assert.match(runner, /RUNNER_TOKEN_FILE: \/etc\/raditi\/runner-token/)
  // Presigned URLs only to the platform's S3.
  assert.match(runner, /RUNNER_S3_ORIGIN: \$\{RUNNER_S3_ORIGIN:-\}/)
  assert.match(runner, /SANDBOX_RUNTIME: runsc/)
  // The platform's own addresses reach the gateway's client egress proxy (plan 53, Р13).
  assert.match(runner, /SANDBOX_EGRESS_REFUSED_SUBNETS: \$\{SANDBOX_EGRESS_REFUSED_SUBNETS:-\}/)
  assert.match(runner, /read_only: true/)
  assert.match(runner, /cap_drop: \[ALL\]/)
  // Only on request, so that the watchdog alone still starts without a runner image.
  assert.match(runner, /profiles: \[runner\]/)
})

test("the runner's logs go to journald on the host: they outlive a recreated container", () => {
  const runner = service('runner')
  assert.match(
    runner,
    /^ {4}logging:\n {6}driver: journald\n {6}options:\n {8}tag: '\{\{\.Name\}\}'$/m,
  )
})

test('only the agent runtime receives the pinned CLI verified by the stand harness', async () => {
  const dockerfile = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8')
  const verifier = await readFile(
    new URL('../dev/llm-verify/cli.Dockerfile', import.meta.url),
    'utf8',
  )
  const stages = dockerfile.split(/^FROM /m).slice(1)
  const runtime = stages.find((stage) => stage.startsWith('base AS runtime\n'))
  assert.ok(runtime)
  for (const packageName of ['opencode-ai']) {
    const version = (source) =>
      new RegExp(`${packageName}@(\\d+\\.\\d+\\.\\d+)(?=\\s|$)`).exec(source)?.[1]
    const expected = version(verifier)
    assert.ok(expected, `the synthetic harness must pin ${packageName}`)
    assert.equal(version(runtime), expected, `${packageName} must match the verified version`)
    for (const stage of stages.filter((stage) => stage !== runtime))
      assert.ok(!stage.includes(packageName), `${packageName} must stay in the agent runtime`)
  }
  assert.match(runtime, /USER 10001:10001/)
  for (const stage of stages.filter((stage) => stage !== runtime)) {
    assert.doesNotMatch(stage, /^runtime AS /)
  }
})

/** The modules of this directory a module imports, itself among them, by relative name. */
async function localModules(name, seen = new Set()) {
  if (seen.has(name)) return seen
  seen.add(name)
  const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8')
  for (const [, imported] of source.matchAll(/^import [^;]*? from '\.\/([a-z-]+\.mjs)'$/gm))
    await localModules(imported, seen)
  return seen
}

test('each trusted image copies its entry module with every module it imports', async () => {
  const dockerfile = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8')
  const stages = dockerfile.split(/^FROM /m).slice(1)
  // node stops at an import whose file the image lacks: the gateway would never listen.
  for (const [target, entry] of [
    ['gateway', 'gateway.mjs'],
    ['client-egress', 'client-egress.mjs'],
    ['network-guard', 'network-guard.mjs'],
    ['watchdog', 'watchdog.mjs'],
  ]) {
    const stage = stages.find((item) => item.startsWith(`base AS ${target}\n`))
    assert.ok(stage, `the Dockerfile has the ${target} target`)
    const copied = [
      ...stage.matchAll(
        /^COPY ((?:infra\/sandbox\/[a-z-]+\.mjs )+)\/usr\/local\/lib\/raditi\/\S*$/gm,
      ),
    ]
      .flatMap(([, files]) => files.trim().split(' '))
      .map((file) => file.slice('infra/sandbox/'.length))
    for (const module of await localModules(entry))
      assert.ok(copied.includes(module), `the ${target} image lacks ${module}`)
  }
})

test('OpenCode stays in the agent runtime, at the version of the CLI lock file', async () => {
  const dockerfile = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8')
  const lock = JSON.parse(
    await readFile(
      new URL('../../packages/agent-drivers/cli/package-lock.json', import.meta.url),
      'utf8',
    ),
  )
  const stages = dockerfile.split(/^FROM /m).slice(1)
  const runtime = stages.find((stage) => stage.startsWith('base AS runtime\n'))
  const version = lock.packages['node_modules/opencode-ai']?.version
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/, 'the CLI lock file must pin opencode-ai')
  assert.ok(runtime.includes(`npm ls opencode-ai@${version} `), 'the build checks that version')
  // One path for the driver whatever the architecture of the sandbox VM.
  assert.match(runtime, /ln -s "[^"\n]+\/bin\/opencode" \/usr\/local\/bin\/opencode/)
  for (const stage of stages.filter((stage) => stage !== runtime))
    assert.ok(!/opencode/i.test(stage), 'OpenCode must stay in the agent runtime')
})
