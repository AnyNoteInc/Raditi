// The CI contract: what the workflows of .github/workflows run against the scripts they reach, and
// which changes start them. Text only: GitHub itself runs them after the branch is pushed.
import assert from 'node:assert/strict'
import { existsSync, globSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')
const ci = read('.github/workflows/ci.yml')
const workspaces = ['apps', 'packages'].flatMap((directory) =>
  readdirSync(join(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${directory}/${entry.name}`),
)
const scripts = (workspace) => JSON.parse(read(`${workspace}/package.json`)).scripts ?? {}
// One job of the workflow, from its key to the next key of the same depth.
const job = (name) => new RegExp(`^  ${name}:\\n(?:(?:    .*)?\\n)+`, 'm').exec(ci)?.[0] ?? ''
const workflow = (name) => read(`.github/workflows/${name}.yml`)
// The path filter of a workflow's pull_request trigger.
const pathFilter = (source) =>
  [
    ...(/^ {4}paths:\n((?: {6}(?:- .+|#.*)\n)+)/m.exec(source)?.[1] ?? '').matchAll(
      /^ {6}- (.+)$/gm,
    ),
  ].map(([, pattern]) => pattern)
// GitHub's filter patterns as these workflows use them: `**` crosses directories, `*` does not.
const starts = (filter, file) =>
  filter.some((pattern) =>
    new RegExp(
      `^${pattern
        .split('**')
        .map((part) => part.replace(/[.+^$(){}|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*'))
        .join('.*')}$`,
    ).test(file),
  )
// What one stage of a Dockerfile copies from the build context.
const copied = (dockerfile, target) => {
  const stage = new RegExp(`^FROM \\S+ AS ${target}\\n((?:(?!FROM ).*\\n)*)`, 'm').exec(
    read(dockerfile),
  )
  assert.ok(stage, `${dockerfile} has the ${target} stage`)
  return [...stage[1].matchAll(/^COPY (?!--from)(.+) \S+$/gm)].flatMap(([, sources]) =>
    sources.split(' '),
  )
}

test('the Vitest timeout of CI reaches Vitest in every workspace', () => {
  const [, passed] = /^ +run: pnpm test -- (--testTimeout=\d+)$/m.exec(ci) ?? []
  assert.ok(passed, 'ci.yml passes --testTimeout to the test task')
  let checked = 0
  for (const workspace of workspaces) {
    const { test: script } = scripts(workspace)
    if (!script) continue
    // Turbo appends pass-through arguments to the end of the script: only the last command of
    // an `&&` chain receives them, and `node --test <files> --flag` silently ignores the flag.
    const commands = script.split('&&').map((command) => command.trim())
    assert.match(commands.at(-1), /^vitest run( |$)/, `${workspace}: ${script}`)
    for (const command of commands.slice(0, -1))
      assert.doesNotMatch(command, /\bvitest\b/, `${workspace}: ${script}`)
    checked++
  }
  assert.ok(checked > 10)
})

// schema.prisma against the database the migrations have just built: a model changed without a
// migration generates and deploys cleanly, and no test selects the missing object.
const schemaDiff =
  'pnpm --filter @repo/db exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code'

test('CI fails when schema.prisma and the deployed migrations differ', () => {
  const runs = [...job('gateway-db').matchAll(/^ {8}run: (.+)$/gm)].map(([, command]) => command)
  // Right after the deploy, on a database nothing else has written to.
  assert.equal(runs[runs.indexOf('pnpm db:deploy') + 1], schemaDiff)
  // `pnpm --filter @repo/db exec` runs in packages/db: the relative schema path is its own.
  assert.ok(read('packages/db/prisma/schema.prisma').includes('datasource db'))
  assert.match(read('packages/db/prisma.config.ts'), /url: process\.env\.DATABASE_URL/)
  // The local gate makes the same comparison on its disposable database.
  assert.match(
    read('infra/dev/db-verify/verify-db.mjs'),
    /'migrate',\n\s+'diff',\n\s+'--from-config-datasource',\n\s+'--to-schema',\n.*\n\s+'--exit-code',/,
  )
})

// The apps whose own opt-in database suites run in the one gateway-db job, in the order of its steps.
const databaseApps = ['apps/core', 'apps/llm', 'apps/mcp']

test('CI runs every opt-in database test of the role apps on its own PostgreSQL', () => {
  const found = {}
  for (const app of databaseApps) {
    const source = join(root, app, 'src')
    const gated = readdirSync(source, { recursive: true })
      .filter((name) => name.endsWith('.test.ts'))
      .filter((name) =>
        readFileSync(join(source, name), 'utf8').includes('RADITI_GATEWAY_DB_TESTS'),
      )
    found[app] = gated.length
    const [, filter] = /^vitest run (\S+)$/.exec(scripts(app)['test:db'] ?? '') ?? []
    assert.ok(filter, `${app} has a test:db script with one Vitest file filter`)
    for (const name of gated) assert.ok(name.includes(filter), `${app}: ${name} is outside test:db`)
  }
  assert.ok(found['apps/core'] >= 3, 'the turn key, sweeper and release suites exist')
  assert.ok(found['apps/llm'] >= 5, 'the gateway, pool, lock, login and retire suites exist')
  assert.ok(found['apps/mcp'] >= 3, 'the access, undo and preview suites of the MCP gateway exist')

  const database = job('gateway-db')
  assert.ok(database, 'ci.yml has the gateway-db job')
  // Collectors in these suites scan shared tables: no other package may use this database.
  assert.match(database, /^ {6}postgres:\n {8}image: postgres:17\./m)
  assert.match(database, /^ {6}DATABASE_URL: postgresql:\/\/raditi:raditi@localhost:5432\/raditi$/m)
  assert.match(database, /^ {6}RADITI_GATEWAY_DB_TESTS: '1'$/m)
  const runs = [...database.matchAll(/^ {8}run: (.+)$/gm)].map(([, command]) => command)
  // Migrated and seeded: the suites look the seeded providers up. pnpm, unlike Turbo, hands a
  // `--` on to Vitest, which then reads the flag after it as a file filter.
  assert.deepEqual(runs.slice(0, 4), [
    'pnpm db:generate',
    'pnpm db:deploy',
    schemaDiff,
    'pnpm db:seed',
  ])
  databaseApps.forEach((app, index) => {
    const name = JSON.parse(read(`${app}/package.json`)).name
    assert.match(runs[4 + index], new RegExp(`^pnpm --filter ${name} test:db --testTimeout=\\d+$`))
  })
  // The shared job keeps them skipped: Turbo runs @repo/db, @repo/trpc and orchestrator at once.
  assert.doesNotMatch(job('gates'), /RADITI_GATEWAY_DB_TESTS/)
})

test('CI runs the opt-in database tests of every other workspace in the same job', () => {
  // `test:db` of a role app reaches only its own files, and the gates job keeps the flag
  // unset: a suite gated by it in another workspace runs in CI only when a step names its file.
  const gated = workspaces
    .filter((workspace) => !databaseApps.includes(workspace))
    .flatMap((workspace) =>
      readdirSync(join(root, workspace), { recursive: true })
        .filter((file) => /\.test\.tsx?$/.test(file))
        .filter((file) => !/(^|\/)(node_modules|dist|\.next|\.turbo)\//.test(file))
        .filter((file) => read(`${workspace}/${file}`).includes('RADITI_GATEWAY_DB_TESTS'))
        .map((file) => ({ name: JSON.parse(read(`${workspace}/package.json`)).name, file })),
    )
  // The approval of the credit rate: it reads the whole catalogue and locks `credit_rates`.
  assert.ok(
    gated.some(
      ({ name, file }) => name === '@repo/billing' && file === 'src/credit-rate-approval.test.ts',
    ),
    'the approval of the credit rate is an opt-in suite of @repo/billing',
  )
  const runs = [...job('gateway-db').matchAll(/^ {8}run: (.+)$/gm)].map(([, command]) => command)
  // After the orchestrator's suites, one step per workspace: Vitest in the package, the files
  // by name, and the timeout of CI without a `--` before it.
  const named = runs.slice(4 + databaseApps.length).flatMap((command) => {
    const [, name, files] =
      /^pnpm --filter (\S+) exec vitest run ((?:\S+\.test\.tsx? )+)--testTimeout=\d+$/.exec(
        command,
      ) ?? []
    assert.ok(name, `${command} is not a run of named test files`)
    return files
      .trim()
      .split(' ')
      .map((file) => ({ name, file }))
  })
  assert.deepEqual(
    named.map(({ name, file }) => `${name} ${file}`).sort(),
    gated.map(({ name, file }) => `${name} ${file}`).sort(),
  )
})

test('the subscription gateway workflow starts on every source its stand runs', () => {
  const filter = pathFilter(workflow('llm-gateway'))
  assert.ok(filter.length > 10, 'llm-gateway.yml has a path filter')
  const stand = [
    ...readdirSync(join(root, 'apps/core/scripts'))
      .filter((name) => /^verify-llm-.+\.mjs$/.test(name))
      .map((name) => `apps/core/scripts/${name}`),
    ...readdirSync(join(root, 'infra/dev/llm-verify'))
      .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
      .map((name) => `infra/dev/llm-verify/${name}`),
  ]
  // The packages the stand's scripts import, by name or by a path into their sources.
  const packages = new Set()
  for (const script of stand) {
    assert.ok(starts(filter, script), `${script} does not start the workflow`)
    for (const [, name] of read(script).matchAll(/'(?:@repo|(?:\.\.\/)+packages)\/([a-z-]+)[/']/g))
      packages.add(name)
  }
  // B13 is the only run of the drivers' real prepare and command against the gateway's policy.
  for (const name of ['agent-drivers', 'llm-backends', 'db', 'vault'])
    assert.ok(packages.has(name), `the stand imports @repo/${name}`)
  for (const name of packages)
    assert.ok(
      starts(filter, `packages/${name}/src/index.ts`),
      `packages/${name}/** does not start the workflow`,
    )
  // The images the stand builds: every file they copy from the repository.
  const main = read('apps/core/scripts/verify-llm-gateway.mjs')
  const targets = [...main.matchAll(/'--target',\n\s+'([a-z-]+)',/g)].map(([, target]) => target)
  assert.deepEqual(targets, ['runtime', 'network-guard'])
  for (const target of targets) {
    const sources = copied('infra/sandbox/Dockerfile', target)
    assert.ok(sources.length > 0, `${target} copies from the repository`)
    for (const source of sources)
      assert.ok(starts(filter, source), `${source} (${target}) does not start the workflow`)
  }
})

// Every `*.test.*` file of the repository outside dependencies and build output.
const testFiles = ['apps', 'packages', 'infra'].flatMap((directory) =>
  readdirSync(join(root, directory), { recursive: true })
    .filter((name) => /\.(test|spec)\.(ts|tsx|mjs)$/.test(name))
    .filter((name) => !/(^|\/)(node_modules|dist|\.next|\.turbo)\//.test(name))
    .map((name) => `${directory}/${name}`),
)
/**
 * The environment variables a test file's skip conditions depend on: `skipIf(...)` of Vitest and
 * `skip:` of node:test, through the `const` names they mention (to their initialisers).
 */
function gates(source) {
  const found = new Set()
  const seen = new Set()
  const scan = (expression) => {
    for (const [, name] of expression.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) found.add(name)
    for (const [identifier] of expression.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (seen.has(identifier)) continue
      seen.add(identifier)
      // A top-level const: its initialiser runs to the next line that is not indented.
      const declared = new RegExp(`^const ${identifier} =((?:.*\\n)(?:[ \\t].*\\n)*)`, 'm').exec(
        source,
      )
      if (declared) scan(declared[1])
    }
  }
  for (const [, condition] of source.matchAll(/\bskipIf\(([^\n]*)\)\(/g)) scan(condition)
  for (const [, condition] of source.matchAll(/\bskip: ([^\n]*)/g)) scan(condition)
  return [...found]
}
const workflows = readdirSync(join(root, '.github/workflows'))
  .filter((name) => name.endsWith('.yml'))
  .map((name) => ({ name, source: read(`.github/workflows/${name}`) }))
// As an `env:` entry, or exported by a step (inline, or through $GITHUB_ENV).
const sets = (source, variable) =>
  new RegExp(`^ +${variable}: \\S|\\b${variable}=`, 'm').test(source)

test('every path filter of a workflow names files the repository has', () => {
  // A filter left behind by a removed stand starts nothing and hides that a moved file no
  // longer starts its workflow.
  let checked = 0
  for (const { name, source } of workflows) {
    const filter = pathFilter(source)
    if (filter.includes(`.github/workflows/${name}`)) checked += 1
    for (const pattern of filter) {
      const found = pattern.endsWith('/**')
        ? existsSync(join(root, pattern.slice(0, -3)))
        : !pattern.includes('**') && globSync(pattern, { cwd: root }).length > 0
      assert.ok(found, `${name}: the path filter ${pattern} matches no file`)
    }
  }
  // Every filtered workflow starts on a change to itself, under the name it has now.
  assert.equal(checked, workflows.filter(({ source }) => pathFilter(source).length > 0).length)
  assert.ok(checked >= 6, 'the workflows with a path filter were read')
})

test('every package script a workflow runs exists', () => {
  // `pnpm <script>` of the root and `pnpm --filter <package> <script>`; pnpm's own commands
  // (install, exec, dlx) are not scripts. A script removed with its stand fails here, not on
  // GitHub after the push.
  const own = new Set(['install', 'exec', 'dlx'])
  const names = new Map(
    workspaces.map((workspace) => [JSON.parse(read(`${workspace}/package.json`)).name, workspace]),
  )
  const sources = [
    ...workflows,
    { name: 'actions/setup', source: read('.github/actions/setup/action.yml') },
  ]
  let checked = 0
  for (const { name, source } of sources)
    for (const [, command] of source.matchAll(
      /^ +(?:run: )?(pnpm (?:--filter \S+ )*[a-z][\w:.-]*)/gm,
    )) {
      const words = command.split(' ').slice(1)
      const script = words.at(-1)
      if (own.has(script)) continue
      const filters = words.filter((_, index) => words[index - 1] === '--filter')
      for (const workspace of filters.length ? filters.map((filter) => names.get(filter)) : ['.']) {
        assert.ok(workspace, `${name}: ${command} names an unknown package`)
        assert.ok(
          scripts(workspace)[script],
          `${name}: ${command} — ${workspace}/package.json has no script ${script}`,
        )
        checked += 1
      }
    }
  // A floor that only shows the loop read the workflows: a step removed is not a defect.
  assert.ok(checked >= 20, `only ${checked} scripts of the workflows were checked`)
})

test('the live mode of the stands never runs in CI: no workflow names it or the provider key', () => {
  // A live run sends requests to the real provider, on a plan with windows or on the paid API
  // (infra/dev/llm-verify/live.mjs), with the one key ZAI_API_KEY. It is started by a person who
  // holds the key; a workflow has neither the option nor the variable, and the stand refuses to
  // start when CI is set.
  for (const { name, source } of workflows) {
    assert.equal(source.includes('--live'), false, `${name} names --live`)
    assert.equal(/ZAI_API_KEY/i.test(source), false, `${name} names ZAI_API_KEY`)
  }
  // The key variable of a live run is the one the rule above catches.
  assert.match(read('infra/dev/llm-verify/live.mjs'), /export const LIVE_KEY_NAME = 'ZAI_API_KEY'/)
  assert.match(
    read('infra/dev/llm-verify/live.mjs'),
    /if \(set\('CI'\)\) return 'CI is set: the live mode never runs in CI'/,
  )
})

test('the rehearsals of the live mode run in CI, each after the deterministic pass of its stand', () => {
  // The code of a live run is executed by nobody but a person with the plan key; its rehearsal
  // runs the same code on the synthetic Z.ai, without a key (infra/dev/llm-verify/README.md).
  // In a workflow it follows the deterministic pass of the same job, which built the
  // orchestrator and the images: a rehearsal builds neither (`--no-build`, assertImages).
  const stands = (name) =>
    [...workflow(name).matchAll(/^ {8}run: (pnpm verify:\S+(?: --\S+)*)$/gm)].map(
      ([, command]) => command,
    )
  assert.deepEqual(stands('llm-gateway'), [
    'pnpm verify:llm-gateway',
    'pnpm verify:llm-gateway --rehearsal --no-build',
    'pnpm verify:llm-gateway --rehearsal --measure --no-build',
    'pnpm verify:llm-gateway --rehearsal --results --no-build',
    'pnpm verify:llm-gateway --rehearsal --api --no-build',
  ])
  assert.deepEqual(stands('agent-content'), [
    'pnpm verify:agent-content',
    'pnpm verify:agent-content --rehearsal --no-build',
  ])
  // The options exist and mean what the steps take them for.
  const live = read('infra/dev/llm-verify/live.mjs')
  for (const option of ['--rehearsal', '--measure', '--results', '--api', '--no-build'])
    assert.ok(live.includes(`['${option}', '`), `${option} is an option of the stands`)
  // GitHub sets CI in every job: that refuses a live run and must not refuse its rehearsal.
  assert.match(
    read('apps/core/scripts/verify-llm-live-run.mjs'),
    /let refusal = rehearsal \? null : liveStartRefusal\(process\.env\)/,
  )
  // No other workflow runs a rehearsal: the images and the build are those of these two jobs.
  for (const { name, source } of workflows)
    if (!['llm-gateway.yml', 'agent-content.yml'].includes(name))
      assert.equal(source.includes('--rehearsal'), false, `${name} runs a rehearsal`)
})

test('every test suite enabled by an environment variable is enabled by a workflow', () => {
  // Suites no workflow enables by their variable, each with the reason it is acceptable.
  const elsewhere = {
    // The same check, `verifyLlmFirewall`, is what `pnpm verify:llm-firewall` runs in llm-app.yml.
    RADITI_LLM_FIREWALL_PACKET_TEST: () =>
      assert.match(workflow('llm-app'), /^ +run: pnpm verify:llm-firewall$/m),
  }
  const gated = new Map()
  for (const file of testFiles)
    for (const variable of gates(read(file)))
      gated.set(variable, [...(gated.get(variable) ?? []), file])
  for (const variable of [
    'DATABASE_URL',
    'RADITI_GATEWAY_DB_TESTS',
    'RADITI_DOCKER_TEST_IMAGE',
    'SANDBOX_GATEWAY_IMAGE',
    'SANDBOX_NETWORK_GUARD_IMAGE',
    'S3_ENDPOINT',
  ])
    assert.ok(gated.has(variable), `${variable} gates a suite`)
  for (const [variable, files] of gated) {
    if (elsewhere[variable]) {
      elsewhere[variable]()
      continue
    }
    const enabling = workflows.filter(({ source }) => sets(source, variable))
    assert.ok(enabling.length > 0, `no workflow sets ${variable}: ${files.join(', ')} never run`)
    // A change to the suite itself must start a workflow that enables it.
    for (const file of files)
      assert.ok(
        enabling.some(({ source }) => {
          const filter = pathFilter(source)
          return filter.length === 0 || starts(filter, file)
        }),
        `a change to ${file} starts no workflow that sets ${variable}`,
      )
  }
  for (const variable of Object.keys(elsewhere))
    assert.ok(gated.has(variable), `${variable} no longer gates a suite: drop the exception`)
})

test('CI runs the Docker isolation suites of the sandbox provider on a real daemon', () => {
  const source = workflow('agent-driver')
  const isolation = /^ {2}sandbox-isolation:\n(?:(?: {4}.*)?\n)+/m.exec(`${source}\n`)?.[0] ?? ''
  assert.ok(isolation, 'agent-driver.yml has the sandbox-isolation job')
  // The provider takes images by digest only; the three it needs come from one Dockerfile.
  for (const target of ['runtime', 'gateway', 'network-guard'])
    assert.ok(copied('infra/sandbox/Dockerfile', target), target)
  assert.match(isolation, /for target in runtime gateway network-guard; do/)
  assert.match(isolation, /docker build -f infra\/sandbox\/Dockerfile --target "\$target"/)
  assert.match(isolation, /--format '\{\{index \.RepoDigests 0\}\}'/)
  for (const variable of [
    'RADITI_DOCKER_TEST_IMAGE',
    'SANDBOX_GATEWAY_IMAGE',
    'SANDBOX_NETWORK_GUARD_IMAGE',
    // Gateway containers reach the test's upstream on the runner through docker0.
    'RADITI_DOCKER_TEST_UPSTREAM_HOST',
  ])
    assert.ok(sets(isolation, variable), `the job exports ${variable}`)
  // The engine of the sandbox VM, not the one of the runner image: the gateway manager's fixed
  // addresses on a subnet Docker picks need Docker Engine 29.1 (the runner image ships 28.0.4).
  const [, major, minor] = /^ {6}SANDBOX_DOCKER_VERSION: (\d+)\.(\d+)\.\d+$/m.exec(isolation) ?? []
  assert.ok(major, 'the job pins the version of Docker Engine')
  assert.ok(+major > 29 || (+major === 29 && +minor >= 1), `Docker Engine ${major}.${minor}`)
  // Installed, then checked on the daemon after its last restart, before the images are built.
  const order = [
    'grep -F ":$SANDBOX_DOCKER_VERSION-"',
    '"docker-ce=$package" "docker-ce-cli=$package"',
    'sudo systemctl restart docker',
    `test "$(docker version --format '{{.Server.Version}}')" = "$SANDBOX_DOCKER_VERSION"`,
    'docker build -f infra/sandbox/Dockerfile',
    'pnpm --filter @repo/sandbox-providers test',
  ].map((text) => isolation.indexOf(text))
  assert.deepEqual(
    order,
    order.toSorted((left, right) => left - right),
  )
  assert.ok(order[0] >= 0, 'the job installs the pinned engine')
  assert.equal(isolation.match(/sudo systemctl restart docker/g)?.length, 1)
  // The record printed when a suite fails holds names, actions and exit codes: no exec event,
  // whose action carries the command line, and no labels or environment.
  const [, record] = /^ {10}nohup docker events ((?:.*\\\n)+.*)$/m.exec(isolation) ?? []
  assert.ok(record, 'the job records daemon events')
  assert.deepEqual(
    [...record.matchAll(/--filter event=(\S+)/g)].map(([, event]) => event),
    ['create', 'start', 'die', 'destroy', 'connect', 'disconnect'],
  )
  assert.deepEqual(
    [...record.matchAll(/\{\{(.+?)\}\}/g)].map(([, field]) => field),
    [
      '.Time',
      '.Type',
      '.Action',
      'index .Actor.Attributes "name"',
      'index .Actor.Attributes "exitCode"',
    ],
  )
  assert.match(
    isolation,
    /^ {8}if: failure\(\)\n {8}run: \|\n(?: {10}.*\n)*? {10}tail -n \d+ "\$RUNNER_TEMP\/docker-events\.log"/m,
  )
  // runc: the variable that would select gVisor is not set on a GitHub runner.
  assert.ok(!sets(isolation, 'SANDBOX_RUNTIME'))
  // The one-line commands: what runs once the images are built and pinned.
  const runs = [...isolation.matchAll(/^ {8}run: (.+)$/gm)]
    .map(([, command]) => command)
    .filter((command) => command !== '|')
  assert.deepEqual(runs, [
    'pnpm --filter @repo/sandbox-providers test',
    'node --test infra/sandbox/watchdog.integration.test.mjs',
  ])
  assert.equal(scripts('packages/sandbox-providers').test, 'vitest run')
  // The provider, the gateway, the guard and the watchdog all start the workflow.
  const filter = pathFilter(source)
  for (const file of [
    'packages/sandbox-providers/src/docker.ts',
    'packages/sandbox-providers/src/gateway/manager.ts',
    'packages/sandbox-providers/runtime/runtime.mjs',
    'infra/sandbox/gateway.mjs',
    'infra/sandbox/network-guard.mjs',
    'infra/sandbox/watchdog.mjs',
    'infra/sandbox/Dockerfile',
  ])
    assert.ok(starts(filter, file), `${file} does not start the workflow`)
})

test('CI runs the real OpenCode CLI of the sandbox image, without a key or a network', () => {
  const source = workflow('agent-driver')
  // One shell, one job with a real CLI: the workflow is named after the driver port, not a shell.
  assert.deepEqual(
    [...source.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map(([, name]) => name),
    ['verify-opencode', 'sandbox-isolation'],
  )
  const opencode = /^ {2}verify-opencode:\n(?:(?: {4}.*)?\n)+/m.exec(`${source}\n`)?.[0] ?? ''
  assert.ok(opencode, 'agent-driver.yml has the verify-opencode job')
  // The stand takes an image that exists already: the job builds the one it looks for.
  const stand = read('packages/agent-drivers/scripts/verify-opencode.mjs')
  const [, image] = /image: \{ type: 'string', default: '([^']+)' \}/.exec(stand) ?? []
  assert.ok(image, 'the stand names its default image')
  const runs = [...opencode.matchAll(/^ {8}run: (.+)$/gm)].map(([, command]) => command)
  assert.deepEqual(runs, [
    `docker build -f infra/sandbox/Dockerfile --target runtime -t ${image} .`,
    'pnpm verify:opencode',
  ])
  assert.equal(
    JSON.parse(read('package.json')).scripts['verify:opencode'],
    'exec node packages/agent-drivers/scripts/verify-opencode.mjs',
  )
  // The CLI of the image comes from the lock file; on x64 it is the build that needs no AVX2.
  const runtime = read('infra/sandbox/Dockerfile')
  assert.match(runtime, /npm ls [^\n]*opencode-ai@\d+\.\d+\.\d+/)
  assert.match(runtime, /opencode-linux-x64-baseline/)
  // No key of a plan, no secret of the repository, no option of a live run.
  assert.doesNotMatch(opencode, /secrets\.|ZAI_|--live/)
  assert.ok(!sets(opencode, 'SANDBOX_RUNTIME'))
  const filter = pathFilter(source)
  for (const file of [
    'packages/agent-drivers/scripts/verify-opencode.mjs',
    'packages/agent-drivers/src/opencode-wrapper.ts',
    'packages/agent-drivers/cli/package-lock.json',
    'infra/sandbox/Dockerfile',
    'package.json',
  ])
    assert.ok(starts(filter, file), `${file} does not start the workflow`)
})

// Images pinned by digest in the object literal that follows `declaration` in a script.
const pinnedImages = (script, declaration) => {
  const source = read(script)
  const block = source.slice(source.indexOf(declaration)).split(/^\}\)?$/m)[0]
  return [...block.matchAll(/'([^'\s]+@sha256:[a-f0-9]{64})'/g)].map(([, image]) => image)
}
const siteImages = pinnedImages('infra/dev/site-verify/verify-site.mjs', 'const images = {')

test('the WordPress content path runs on a real WordPress in CI', () => {
  const source = workflow('wordpress-content')
  const filter = pathFilter(source)
  for (const pattern of [
    '.github/workflows/wordpress-content.yml',
    'infra/wordpress/**',
    'infra/dev/site-verify/**',
    'packages/site-adapters/**',
    'apps/mcp/**',
    'apps/core/scripts/verify-content-*.mjs',
  ])
    assert.ok(filter.includes(pattern), `${pattern} is in the path filter`)
  // The plugin, every script of the stand and the helpers it imports start the workflow.
  const stand = [
    'infra/wordpress/raditi-content.php',
    'apps/core/scripts/verify-agent-supervisor.mjs',
    ...readdirSync(join(root, 'infra/dev/site-verify')).map(
      (name) => `infra/dev/site-verify/${name}`,
    ),
    ...readdirSync(join(root, 'apps/core/scripts'))
      .filter((name) => name.startsWith('verify-content-'))
      .map((name) => `apps/core/scripts/${name}`),
  ]
  assert.ok(stand.length >= 9)
  for (const file of stand) assert.ok(starts(filter, file), `${file} does not start the workflow`)
  // As for the gateway stand: the packages its scripts import, by name or by a path into their
  // sources, the orchestrator modules they load from the build and the orchestrator sources
  // they load as they are. The journal tables, the snapshot storage and the turn undo are this
  // path as much as the plugin is.
  const imported = new Set()
  for (const script of stand.filter((file) => file.endsWith('.mjs'))) {
    const text = read(script)
    for (const [, name] of text.matchAll(/'(?:@repo|(?:\.\.\/)+packages)\/([a-z-]+)[/']/g))
      imported.add(`packages/${name}/src/index.ts`)
    for (const [, directory] of text.matchAll(/'\.\.\/dist\/([a-z-]+)\//g))
      imported.add(`apps/core/src/${directory}/index.ts`)
    // The builds of the other apps: apps/mcp/dist and apps/llm/dist.
    for (const [, app] of text.matchAll(/'\.\.\/\.\.\/([a-z-]+)\/dist\//g))
      imported.add(`apps/${app}/src/index.ts`)
    for (const [, file] of text.matchAll(/'\.\.\/src\/([^']+\.ts)'/g))
      imported.add(`apps/core/src/${file}`)
  }
  for (const source of [
    'packages/db/src/index.ts',
    'packages/storage/src/index.ts',
    'packages/domain/src/index.ts',
    'packages/site-adapters/src/index.ts',
    'apps/mcp/src/index.ts',
    'apps/core/src/turns/index.ts',
    // The sample ids of the turns the stand makes up.
    'apps/core/src/testing/ids.ts',
  ])
    assert.ok(imported.has(source), `the stand loads ${source.replace('/index.ts', '')}`)
  for (const source of imported)
    assert.ok(starts(filter, source), `${source.replace('index.ts', '**')} does not start it`)
  // The stand configures its OpenBao with the real bootstrap of infra/vault and runs the role
  // `mcp` under the real policies: a change of either must run the stand.
  assert.match(
    read('infra/dev/site-verify/verify-content.mjs'),
    /from '\.\.\/\.\.\/vault\/bootstrap\.mjs'/,
  )
  const policies = readdirSync(join(root, 'infra/vault/policies'))
  assert.ok(policies.includes('mcp-content.hcl') && policies.includes('sites-writer.hcl'))
  for (const file of ['bootstrap.mjs', ...policies.map((name) => `policies/${name}`)])
    assert.ok(starts(filter, `infra/vault/${file}`), `infra/vault/${file} does not start it`)
  // The MCP modules are what the stand runs for real, against its own OpenBao, S3 and
  // PostgreSQL: every workspace package they import starts it too (the contact masks live in
  // the KV client of @repo/vault, and no other workflow exercises them on a real OpenBao).
  const mcp = join(root, 'apps/mcp/src')
  const packages = new Set(
    readdirSync(mcp, { recursive: true })
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .flatMap((name) => [
        ...readFileSync(join(mcp, name), 'utf8').matchAll(/from '@repo\/([a-z-]+)'/g),
      ])
      .map(([, name]) => name),
  )
  assert.ok(packages.has('vault') && packages.has('db'), 'the MCP modules use Vault and the DB')
  for (const name of packages)
    assert.ok(
      starts(filter, `packages/${name}/src/index.ts`),
      `packages/${name}/** (imported by the MCP modules) does not start it`,
    )
  // The stand applies the real migrations to its PostgreSQL.
  assert.match(
    read('apps/core/scripts/verify-agent-supervisor.mjs'),
    /'packages\/db\/prisma\/migrations'/,
  )
  assert.ok(starts(filter, 'packages/db/prisma/migrations/x/migration.sql'))
  assert.match(
    read('infra/dev/site-verify/verify-content.mjs'),
    /from '\.\.\/\.\.\/\.\.\/apps\/core\/scripts\/verify-agent-supervisor\.mjs'/,
  )

  // The stand never pulls (--pull=never, `compose up --pull never`): CI pulls exactly what the
  // scripts pin, by digest. The WP-CLI image is the verified digest, never its mutable tag.
  const services = pinnedImages(
    'apps/core/scripts/verify-agent-supervisor.mjs',
    'export const serviceImages = Object.freeze({',
  )
  assert.equal(services.length, 3)
  assert.equal(siteImages.length, 4)
  const pull = /^ {6}- name: Pull the pinned images\n {8}run: \|\n((?: {10}.*\n)+)/m.exec(source)
  assert.ok(pull, 'wordpress-content.yml pulls the pinned images')
  assert.match(pull[1], /docker pull --quiet "\$image"/)
  assert.deepEqual(
    [...pull[1].matchAll(/(\S+@sha256:[a-f0-9]{64})/g)].map(([, image]) => image).sort(),
    [...services, ...siteImages].sort(),
  )
  assert.doesNotMatch(source, /wordpress:cli-/)

  const runs = [...source.matchAll(/^ {8}run: (.+)$/gm)]
    .map(([, command]) => command)
    .filter((command) => command !== '|')
  // The orchestrator build inside the stand's command needs the generated Prisma client.
  assert.deepEqual(runs, ['pnpm db:generate', 'pnpm verify:mcp-content'])
  assert.equal(
    JSON.parse(read('package.json')).scripts['verify:mcp-content'],
    // `exec`: a signal sent to pnpm must reach the stand, or its cleanup runs outside the stand lock.
    'pnpm --filter core --filter mcp build && exec node infra/dev/site-verify/verify-content.mjs',
  )
  // On the runner the engine is native Linux Docker, not Docker Desktop.
  assert.match(source, /^ {4}runs-on: ubuntu-latest$/m)
  assert.match(
    read('infra/dev/site-verify/verify-content.mjs'),
    /nativeLinux: process\.platform === 'linux'/,
  )
})

test('CI runs the presigned-URL suite of the storage adapter on a real S3', () => {
  const storage = job('storage-s3')
  assert.ok(storage, 'ci.yml has the storage-s3 job')
  // The suite runs only against a loopback endpoint outside production, with path-style URLs.
  assert.match(
    read('packages/storage/src/s3-presign.integration.test.ts'),
    /describe\.skipIf\(!local\)\(/,
  )
  assert.match(storage, /^ {6}APP_ENV: test$/m)
  assert.match(storage, /^ {6}S3_ENDPOINT: http:\/\/127\.0\.0\.1:8333$/m)
  assert.match(storage, /^ {6}S3_FORCE_PATH_STYLE: 'true'$/m)
  // The synthetic development identity: the file the job mounts is the one it takes the keys of.
  const [{ credentials }] = JSON.parse(read('infra/dev/seaweedfs-s3.json')).identities
  assert.match(storage, new RegExp(`^ {6}S3_ACCESS_KEY_ID: ${credentials[0].accessKey}$`, 'm'))
  assert.match(storage, new RegExp(`^ {6}S3_SECRET_ACCESS_KEY: ${credentials[0].secretKey}$`, 'm'))
  assert.match(storage, /-v "\$PWD\/infra\/dev\/seaweedfs-s3\.json:\/etc\/seaweedfs\/s3\.json:ro"/)
  // The S3 server the stands pin, by digest, published on loopback only.
  const [, s3] = pinnedImages(
    'apps/core/scripts/verify-agent-supervisor.mjs',
    'export const serviceImages = Object.freeze({',
  )
  assert.match(s3, /^chrislusf\/seaweedfs:/)
  assert.ok(storage.includes(` ${s3} `), 'the job starts the pinned SeaweedFS image')
  assert.match(storage, /-p 127\.0\.0\.1:8333:8333 /)
  // The suite writes to the sessions bucket under its default name: the job creates that one.
  assert.match(
    read('packages/storage/src/config.ts'),
    /S3_BUCKET_SESSIONS: bucket\('raditi-sessions'\)/,
  )
  assert.match(storage, /s3\.bucket\.create -name raditi-sessions/)
  assert.ok(!sets(storage, 'S3_BUCKET_SESSIONS'))
  const runs = [...storage.matchAll(/^ {8}run: (.+)$/gm)]
    .map(([, command]) => command)
    .filter((command) => command !== '|')
  assert.deepEqual(runs, ['pnpm --filter @repo/storage test'])
  assert.equal(scripts('packages/storage').test, 'vitest run')
  // The shared job has no S3: there the suite stays skipped, and no other package sees S3_*.
  assert.ok(!sets(job('gates'), 'S3_ENDPOINT'))
})

test('the required CI job checks the syntax of the WordPress plugin', () => {
  const gates = job('gates')
  // Every PHP file there: the content plugin, and the wp-config.php and mu-plugin of a preview.
  const files = readdirSync(join(root, 'infra/wordpress'))
    .filter((name) => name.endsWith('.php'))
    .sort()
  assert.deepEqual(files, ['preview-wp-config.php', 'raditi-content.php', 'raditi-preview.php'])
  for (const file of files) {
    const name = file.replaceAll('.', '\\.')
    assert.ok(read(`infra/wordpress/${file}`).startsWith('<?php'))
    assert.match(gates, new RegExp(`^ {12}php -l infra/wordpress/${name}$`, 'm'))
    // A runner without PHP uses the PHP of the pinned WordPress image, offline and read-only.
    const [, image] =
      new RegExp(
        `docker run --rm --network none --entrypoint php \\\\\\n +-v "\\$PWD/infra/wordpress:/plugin:ro" \\\\\\n +(\\S+) -l /plugin/${name}`,
      ).exec(gates) ?? []
    assert.equal(
      image,
      siteImages.find((name) => name.startsWith('wordpress:7.')),
      file,
    )
  }
})

test('a cached gate sees a source change in a package it depends on', () => {
  // Packages export their TypeScript sources, so a dependant's typecheck, lint and tests read
  // them. Turbo hashes a task by the files of its own package and by the tasks it depends on:
  // each of the three hangs on `transit`, a task without a script that chains the files of
  // every dependency in. Without it the local gates replay a stale result from the cache.
  const { tasks } = JSON.parse(read('turbo.json'))
  assert.deepEqual(tasks.transit, { dependsOn: ['^transit'] })
  for (const name of ['typecheck', 'lint', 'test'])
    assert.ok(tasks[name].dependsOn?.includes('transit'), `${name} does not depend on transit`)
  // A script of that name would run, and its outputs would be cached, in every package.
  for (const workspace of workspaces)
    assert.equal(scripts(workspace).transit, undefined, `${workspace} has a transit script`)
})

test('a cached test run sees a change of a file its tests read outside their package', () => {
  // Turbo hashes `test` by the files of the package itself. These tests hold a file of another
  // package or of the repository root to the code: without the file among the inputs of the task
  // the local gates replay a green result after the file alone has changed — the offer's table of
  // tariffs without the seed, a default of .env.example without the texts and configs it repeats.
  const { inputs = [] } = JSON.parse(read('turbo.json')).tasks.test
  // Naming inputs replaces the default: without it the package's own files would leave the hash.
  assert.ok(inputs.includes('$TURBO_DEFAULT$'), 'test keeps the files of its package as inputs')
  const outside = {
    '.env.example': [
      'apps/core/src/config/config.test.ts',
      'apps/web/src/lib/legal-content.test.ts',
    ],
    'apps/web/content/legal/public-offer.md': ['packages/db/prisma/seed/data.test.ts'],
    // The LLM paths of sandbox-gw against the routes of the registry and the base URL of each.
    'infra/sandbox/gateway.mjs': [
      'apps/llm/src/gateway/sandbox-routes.contract.test.ts',
      'packages/turn-keys/src/backends.test.ts',
    ],
    // The files a WordPress preview gets, embedded in the adapter, against their sources; the
    // policy of its database copy, against the file the copier is tested with (plan 53, R5b).
    'infra/wordpress/raditi-content.php': ['packages/site-adapters/src/wordpress-preview.test.ts'],
    'infra/wordpress/raditi-preview.php': ['packages/site-adapters/src/wordpress-preview.test.ts'],
    'infra/wordpress/preview-wp-config.php': [
      'packages/site-adapters/src/wordpress-preview.test.ts',
    ],
    'infra/wordpress/preview-apache.conf': ['packages/site-adapters/src/wordpress-preview.test.ts'],
    'packages/site-connections/src/database-copy/wordpress-policy.fixture.json': [
      'packages/site-adapters/src/wordpress-db-copy.test.ts',
    ],
    // The token command of the runner image (the runbook issues it on the sandbox VM), against
    // the RUNNER_TOKENS entries core accepts.
    'apps/runner/scripts/runner-token.mjs': ['apps/core/src/runner-api/runner-auth.test.ts'],
    // The llm service of the app VM's compose against the one extra CA the production role takes.
    'infra/app/docker-compose.yml': ['apps/llm/src/llm-config.contract.test.ts'],
  }
  for (const [file, readers] of Object.entries(outside)) {
    assert.ok(inputs.includes(`$TURBO_ROOT$/${file}`), `${file} is not an input of test`)
    for (const reader of readers)
      assert.ok(
        read(reader).includes(`'${relative(dirname(reader), file)}'`),
        `${reader} no longer reads ${file}`,
      )
  }
  // A file the readers above load through an import of theirs: its readers are theirs too.
  const imported = { 'infra/sandbox/client-egress.mjs': 'infra/sandbox/gateway.mjs' }
  for (const [file, importer] of Object.entries(imported)) {
    assert.ok(inputs.includes(`$TURBO_ROOT$/${file}`), `${file} is not an input of test`)
    assert.ok(
      read(importer).includes(`'./${relative(dirname(importer), file)}'`),
      `${importer} no longer imports ${file}`,
    )
  }
})

test('the llm profile of the app VM is verified on the engine of the VM, without the userland proxy', () => {
  const source = workflow('llm-app')
  // core reaches llm through the port llm publishes for another bridge network. With the
  // userland proxy off Docker 28, which the runner image ships, drops that path by its
  // inter-network isolation; the VM's preflight and the stand refuse such an engine by name.
  const [, major] = /^ {6}APP_DOCKER_VERSION: (\d+)\.\d+\.\d+$/m.exec(source) ?? []
  assert.ok(major, 'the job pins the version of Docker Engine')
  const [, required] =
    /^const APP_ENGINE_MAJOR = (\d+)$/m.exec(read('infra/app/verify-llm-app.mjs')) ?? []
  assert.equal(required, '29')
  assert.ok(+major >= +required, `Docker Engine ${major}`)
  assert.match(
    read('infra/app/preflight.sh'),
    new RegExp(
      `^ {2}\\[ "\\$\\{server%%\\.\\*\\}" -ge ${required} \\] 2>/dev/null \\|\\|\\n +fail "Docker server ${required} or newer is required with the llm profile"$`,
      'm',
    ),
  )
  // Installed from Docker's repository under its release key, the proxy switched off, the engine
  // checked after its last restart; then the packet filter, the production image and the stand.
  assert.match(source, /"\$fingerprint" != 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 \]/)
  const order = [
    'grep -F ":$APP_DOCKER_VERSION-"',
    '"docker-ce=$package" "docker-ce-cli=$package"',
    `jq '. + {"userland-proxy": false}'`,
    'sudo systemctl restart docker',
    'if pgrep -x docker-proxy; then',
    `test "$(docker version --format '{{.Server.Version}}')" = "$APP_DOCKER_VERSION"`,
    'run: pnpm verify:llm-firewall',
    'run: docker build -f apps/llm/Dockerfile --target runtime -t raditi-p3verify-llm:b14 .',
    'run: pnpm verify:llm-app',
  ].map((text) => source.indexOf(text))
  assert.deepEqual(
    order,
    order.toSorted((left, right) => left - right),
  )
  assert.ok(order[0] >= 0, 'the job installs the pinned engine')
  assert.equal(source.match(/sudo systemctl restart docker/g)?.length, 1)
  // The stand takes the image the job builds, and its engine gate has tests of its own.
  assert.match(
    read('infra/app/verify-llm-app.mjs'),
    /^ {4}image: \{ type: 'string', default: 'raditi-p3verify-llm:b14' \},$/m,
  )
  assert.match(source, /^ {8}run: node --test .* infra\/app\/verify-llm-app\.test\.mjs$/m)
  const filter = pathFilter(source)
  for (const file of [
    '.github/workflows/llm-app.yml',
    'infra/app/verify-llm-app.mjs',
    'infra/app/preflight.sh',
    'infra/app/docker-compose.yml',
    'apps/llm/Dockerfile',
  ])
    assert.ok(starts(filter, file), `${file} does not start the workflow`)
})
