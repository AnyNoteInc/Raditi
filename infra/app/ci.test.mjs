// The CI contract: what the workflows of .github/workflows run against the scripts they reach, and
// which changes start them. Text only: GitHub itself runs them after the branch is pushed.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, globSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')
const ci = read('.github/workflows/ci.yml')
// The workspaces of pnpm-workspace.yaml: a directory under apps/ or packages/ with a package.json.
// A folder left behind with only ignored build output (a deleted package's dist/) is not one.
const workspaces = ['apps', 'packages'].flatMap((directory) =>
  readdirSync(join(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${directory}/${entry.name}`)
    .filter((workspace) => existsSync(join(root, workspace, 'package.json'))),
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
  const [, passed] =
    /^ +run: pnpm test --concurrency=\d+ -- (--testTimeout=\d+) --maxWorkers=\d+$/m.exec(ci) ?? []
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

test('the test step of CI keeps its workers to the cores of the runner', () => {
  const [, workspaces, workers] =
    /^ +run: pnpm test --concurrency=(\d+) -- --testTimeout=\d+ --maxWorkers=(\d+)$/m.exec(ci) ?? []
  assert.ok(workspaces && workers, 'ci.yml bounds the workspaces and the workers of the test step')
  // ubuntu-latest of a public repository has four cores. Unbounded, turbo runs ten workspaces and
  // Vitest one worker less than the cores in each: tests that wait for a socket, a lock or a
  // child process missed their bounds by turns (28.10.2026, release of v1.10.0).
  assert.ok(Number(workspaces) * Number(workers) <= 4, `${workspaces} × ${workers} workers`)
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
const databaseApps = ['apps/core', 'apps/llm', 'apps/mcp', 'apps/preview']

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
  assert.ok(found['apps/preview'] >= 2, 'the access and entry suites of the preview gateway exist')

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
    // The worker of the role llm lives with the app it hosts.
    ...readdirSync(join(root, 'apps/llm/scripts'))
      .filter((name) => /^verify-.+\.mjs$/.test(name))
      .map((name) => `apps/llm/scripts/${name}`),
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
 * The environment variables a test file's skip conditions depend on: `skipIf(...)` and `runIf(...)`
 * of Vitest and `skip:` of node:test, through the `const` names they mention (to their
 * initialisers).
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
  for (const [, condition] of source.matchAll(/\b(?:skipIf|runIf)\(([^\n]*)\)\(/g)) scan(condition)
  for (const [, condition] of source.matchAll(/\bskip: ([^\n]*)/g)) scan(condition)
  return [...found]
}
const workflows = readdirSync(join(root, '.github/workflows'))
  .filter((name) => name.endsWith('.yml'))
  .map((name) => ({ name, source: read(`.github/workflows/${name}`) }))
// As an `env:` entry, or exported by a step (inline, or through $GITHUB_ENV).
const sets = (source, variable) =>
  new RegExp(`^ +${variable}: \\S|\\b${variable}=`, 'm').test(source)
/**
 * The values of the matrix of a job (or of a workflow of one job), as the workflows write them: one
 * line `key: [a, b]` under `matrix:`, a value quoted or not.
 */
function matrixOf(text) {
  const block = /^ {6}matrix:\n((?: {8}.*\n)+)/m.exec(text)?.[1] ?? ''
  return Object.fromEntries(
    [...block.matchAll(/^ {8}([\w-]+): \[(.*)\]$/gm)].map(([, key, list]) => [
      key,
      list
        .split(',')
        .map((value) => value.trim().replace(/^(['"])(.*)\1$/, '$2'))
        .filter(Boolean),
    ]),
  )
}
/** A text with every `${{ matrix.<key> }}` written out, once for each combination of the matrix. */
function expandMatrix(text, matrix) {
  let texts = [text]
  for (const [key, values] of Object.entries(matrix)) {
    const expression = new RegExp(`\\$\\{\\{ *matrix\\.${key} *\\}\\}`, 'g')
    if (!texts.some((each) => each.match(expression))) continue
    texts = texts.flatMap((each) => values.map((value) => each.replace(expression, value)))
  }
  return texts
}
/**
 * Whether one step of a workflow runs a test file with its variables set, by the step itself or by
 * the job or the workflow around it. Comment lines run nothing, and neither does the step's name.
 * An expression of the matrix in the step is written out for each value of the job's matrix: a
 * step runs the file of every value (docs/plan/62-slices/e3.md, Э3.8).
 */
function runsSuite(source, path, variables) {
  const live = source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
  const start = live.indexOf('\njobs:')
  const head = live.slice(0, start)
  return live
    .slice(start)
    .split(/^ {2}(?=[\w-]+:$)/m)
    .slice(1)
    .some((job) => {
      const around = job.slice(0, job.indexOf('\n    steps:'))
      return job
        .slice(job.indexOf('\n    steps:'))
        .split(/^ {6}- /m)
        .slice(1)
        .some((step) => {
          const run = /^(?: {8})?run: (.*(?:\n(?: {9,}.*)?)*)/m.exec(step)?.[1] ?? ''
          const inherited = `${head}\n${around}\n${step}`
          return (
            expandMatrix(run, matrixOf(`${around}\n`)).some((each) => each.includes(path)) &&
            variables.every((name) => sets(inherited, name))
          )
        })
    })
}

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

test('every build module a stand loads has its source in that app', () => {
  // Stands load classes from the build of an app (`../dist/<path>.js`, `../../<app>/dist/…`,
  // `apps/<app>/dist/…` from the root). Several run by hand only, with no workflow behind them
  // (verify:runner, verify:snapshots, verify:publication, verify:gitea): a source moved to another
  // folder would break them silently, until someone runs them. dist/<path>.js is built from
  // src/<path>.ts. Only what the repository tracks: a local file nobody committed decides nothing.
  const stands = execFileSync(
    'git',
    ['ls-files', '-z', '--', ':(glob)apps/*/scripts/*.mjs', ':(glob)infra/dev/**/*.mjs'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
  const loaded = new Map()
  for (const file of stands) {
    const text = read(file)
    // A relative literal, from the directory of the script; a template part names no one file.
    for (const [, , literal] of text.matchAll(
      /(['"`])((?:\.\.\/)+(?:[^'"`\s]*\/)?dist\/[^'"`\s]+\.js)\1/g,
    ))
      if (!literal.includes('${'))
        loaded.set(`${file}: ${literal}`, relative(root, join(root, dirname(file), literal)))
    // A path from the root of the repository, wherever it stands (an image's /app/apps/… too).
    for (const [path] of text.matchAll(/\bapps\/[a-z-]+\/dist\/[\w./-]+?\.js\b/g))
      loaded.set(`${file}: ${path}`, path)
  }
  for (const [where, path] of loaded) {
    const [, app, module] = /^apps\/([a-z-]+)\/dist\/(.+)\.js$/.exec(path) ?? []
    assert.ok(app, `${where} is not a module of an app's build`)
    assert.ok(
      existsSync(join(root, 'apps', app, 'src', `${module}.ts`)),
      `${where}: apps/${app}/src/${module}.ts does not exist`,
    )
  }
  // The manual stands among them: the runner's core side, the publication, the snapshots, Gitea.
  for (const stand of [
    'apps/core/scripts/verify-runner-core.mjs',
    'apps/core/scripts/verify-publication.mjs',
    'apps/core/scripts/verify-snapshots.mjs',
    'infra/dev/gitea-verify/scenario.mjs',
  ])
    assert.ok(
      [...loaded.keys()].some((where) => where.startsWith(`${stand}: `)),
      `${stand} was read`,
    )
  assert.ok(loaded.size >= 50, `only ${loaded.size} build modules of the stands were checked`)
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
    'pnpm verify:llm-gateway --rehearsal --compact --no-build',
    'pnpm verify:llm-gateway --rehearsal --init --no-build',
    'pnpm verify:llm-gateway --rehearsal --api --no-build',
  ])
  assert.deepEqual(stands('agent-content'), [
    'pnpm verify:agent-content',
    'pnpm verify:agent-content --rehearsal --no-build',
  ])
  // The options exist and mean what the steps take them for.
  const live = read('infra/dev/llm-verify/live.mjs')
  for (const option of [
    '--rehearsal',
    '--measure',
    '--results',
    '--compact',
    '--init',
    '--api',
    '--no-build',
  ])
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

test('every suite switched on one by one is named in a step of a workflow', () => {
  // `test:db` takes its suites by a pattern. These variables switch on a suite only where a step
  // names its file: a variable set elsewhere leaves a suite no job ever runs.
  const oneByOne = [
    'RADITI_BROWSER_DOCKER_TESTS',
    'RADITI_BROWSER_LOCAL_TESTS',
    'RADITI_HOSTING_DOCKER_TESTS',
    'RADITI_PREVIEW_DOCKER_TESTS',
  ]
  let checked = 0
  const missing = []
  for (const file of testFiles) {
    if (file === 'infra/app/ci.test.mjs') continue
    // By the text, not by `gates()`: a condition over two lines or an exported const stays a suite.
    const source = read(file)
    const variables = oneByOne.filter((variable) => source.includes(variable))
    if (variables.length === 0) continue
    checked += 1
    const inWorkspace = file.replace(/^(?:apps|packages)\/[^/]+\//, '')
    if (!workflows.some((entry) => runsSuite(entry.source, inWorkspace, variables)))
      missing.push(file)
  }
  assert.deepEqual(missing, [], 'no step of a workflow runs these suites with their variable')
  assert.ok(checked >= 14, 'the suites are found')
  // `describe.runIf` is a skip condition too: the file that enables its suite that way.
  assert.ok(
    gates(read('packages/sandbox-providers/src/preview/staging.integration.test.ts')).includes(
      'RADITI_PREVIEW_DOCKER_TESTS',
    ),
  )
})

test('a suite counts as run only by a step that names it and sets its variable', () => {
  const file = 'src/sample.integration.test.ts'
  const variable = 'RADITI_SAMPLE_TESTS'
  const command = `pnpm --filter sample exec vitest run ${file}`
  const on = `        env:\n          ${variable}: '1'\n`
  const sample = ({ head = '', around = '', steps }) =>
    `name: Sample\n${head}jobs:\n  sample:\n    runs-on: ubuntu-latest\n${around}    steps:\n${steps}`
  const runs = (parts) => runsSuite(sample(parts), file, [variable])
  // The workflow as CI has it.
  assert.equal(
    runs({ steps: `      - name: Suite\n${on}        run: |\n          ${command}\n` }),
    true,
  )
  assert.equal(runs({ steps: `      - run: ${variable}=1 ${command}\n` }), true)
  assert.equal(
    runs({
      around: `    env:\n      ${variable}: '1'\n`,
      steps: `      - name: Suite\n        run: ${command}\n`,
    }),
    true,
  )
  assert.equal(
    runs({ head: `env:\n  ${variable}: '1'\n`, steps: `      - run: ${command}\n` }),
    true,
  )
  // A line commented out runs nothing.
  assert.equal(
    runs({ steps: `      - name: Suite\n${on}        run: |\n          # ${command}\n` }),
    false,
  )
  // The variable of another step leaves every case of the file skipped, and the step green.
  assert.equal(
    runs({
      steps: `      - name: Suite\n        run: ${command}\n      - name: Other\n${on}        run: pnpm other\n`,
    }),
    false,
  )
  // A name or a variable alone runs nothing.
  assert.equal(runs({ steps: `      - name: ${file}\n${on}        run: pnpm other\n` }), false)
  assert.equal(runs({ steps: `      - name: Suite\n        run: ${command}\n` }), false)
  // An expression of the matrix runs the file of each of its values, and of nothing else.
  const each = (values) => ({
    around: `    strategy:\n      matrix:\n        part: [${values}]\n`,
    steps: `      - name: Suite\n${on}        run: pnpm --filter sample exec vitest run src/\${{ matrix.part }}.integration.test.ts\n`,
  })
  const parts = (values, name) =>
    runsSuite(sample(each(values)), `src/${name}.integration.test.ts`, [variable])
  assert.equal(parts('sample', 'sample'), true)
  assert.equal(parts("other, 'sample'", 'sample'), true)
  assert.equal(parts('other', 'sample'), false)
  assert.equal(matrixOf(each("'7.4', 8.0").around).part.join(' '), '7.4 8.0')
})

test('the images the suites of previews run by tag are pulled at a pinned digest', () => {
  const pulled = new Map(
    [...workflow('preview').matchAll(/^ +(\S+:\S+) (sha256:[0-9a-f]{64})$/gm)].map(
      ([, tag, digest]) => [tag, digest],
    ),
  )
  // A suite runs a tag with no pull of its own: Docker would fetch whatever the tag is today.
  const suites = testFiles.filter(
    (file) =>
      file !== 'infra/app/ci.test.mjs' && read(file).includes('RADITI_PREVIEW_DOCKER_TESTS'),
  )
  const tags = new Set(
    suites.flatMap((file) =>
      [...read(file).matchAll(/\b(?:mariadb|mysql|wordpress):[\w.-]*\w/g)].map(([tag]) => tag),
    ),
  )
  assert.ok(tags.has('mysql:8.4'), 'the second server of the plugin’s suite is found')
  for (const tag of tags) assert.ok(pulled.has(tag), `preview.yml does not pull ${tag}`)
  // One digest of the server across the stands.
  const stand = /'mysql:8\.4@(sha256:[0-9a-f]{64})'/.exec(
    read('infra/dev/site-import-verify/stand.mjs'),
  )
  assert.equal(pulled.get('mysql:8.4'), stand?.[1])
})

/**
 * The files of the repository a script loads, through static imports, `export … from` and
 * `import('…')` of a literal path; packages by name (`@repo/<name>`) are not followed.
 */
function loads(entries) {
  const found = new Set()
  const queue = [...entries]
  while (queue.length) {
    const file = queue.pop()
    if (found.has(file)) continue
    found.add(file)
    for (const [, specifier] of read(file).matchAll(
      /(?:\bfrom|\bimport\()\s*'(\.{1,2}\/[^']+)'/g,
    )) {
      const target = relative(root, join(root, dirname(file), specifier))
      if (/\.(?:ts|mjs)$/.test(target)) queue.push(target)
    }
  }
  return [...found].sort()
}

test('site-images.yml builds every PHP version of the table and sends nothing anywhere', async () => {
  const source = workflow('site-images')
  // One job per row of the table, in its order; a row added without a job is never built here.
  const versions = JSON.parse(read('infra/preview/site-bases.json')).versions.map(({ php }) => php)
  assert.ok(versions.length >= 8, 'the rows of site-bases.json were read')
  const matrix = /^ {8}php: \[(.+)\]$/m.exec(source)
  assert.ok(matrix, 'site-images.yml has a matrix of PHP versions')
  // Quoted: unquoted, 8.0 is a number to GitHub and `matrix.php` gives 8.
  const quoted = matrix[1].split(',').map((version) => version.trim())
  for (const version of quoted) assert.match(version, /^'[^']+'$/, `${version} is not quoted`)
  assert.deepEqual(
    quoted.map((version) => version.slice(1, -1)),
    versions,
  )
  assert.match(source, /^ {6}fail-fast: false$/m)
  assert.match(source, /^ {8}run: pnpm verify:site-images --only \$\{\{ matrix\.php \}\}$/m)
  // Nothing leaves the runner: publishing is M10 (Т23).
  for (const forbidden of [
    'docker push',
    'docker login',
    'push: true',
    'packages: write',
    'secrets.',
  ])
    assert.ok(!source.includes(forbidden), `site-images.yml names ${forbidden}`)
  assert.equal(/^permissions:\n((?: {2}.*\n)+)/m.exec(source)?.[1], '  contents: read\n')
  assert.doesNotMatch(source, /^ +permissions:/m, 'a job asks for permissions of its own')
  // Once a month on fresh packages, with a scan that never fails the job.
  assert.match(source, /^ {2}schedule:\n {4}- cron: '[^']+'$/m)
  const steps = source.split(/^ {6}- /m)
  const index = (name) => steps.findIndex((step) => step.startsWith(`name: ${name}\n`))
  // The stand finds the images it reads already pulled, by the digests its files name.
  const pull = index('Pull the images the stand reads')
  assert.ok(pull >= 0, 'site-images.yml pulls the images the stand reads')
  assert.ok(pull < index('Build and check the image'), 'the images are pulled before the stand')
  assert.ok(index('Docker with the containerd image store') < pull, 'into the containerd store')
  const stacks = readdirSync(join(root, 'infra/dev/preview-verify')).filter((name) =>
    /^site-[a-z0-9]+\.mjs$/.test(name),
  )
  assert.ok(stacks.length > 0, 'the files of stacks were found')
  for (const name of stacks) {
    const { treeImage } = await import(join(root, 'infra/dev/preview-verify', name))
    assert.match(treeImage, /@sha256:[0-9a-f]{64}$/, `${name} names its tree by digest`)
    assert.ok(
      steps[pull].includes(`docker pull -q ${treeImage}\n`),
      `site-images.yml does not pull ${treeImage} of ${name}`,
    )
  }
  assert.match(steps[pull], /^ {10}PHP_VERSION: \$\{\{ matrix\.php \}\}$/m)
  assert.match(steps[pull], /infra\/preview\/site-bases\.json\)\n {10}docker pull -q "\$base"\n/)
  const scanAt = index('Scan the image')
  assert.ok(scanAt >= 0, 'site-images.yml has the step of the scanner')
  const scan = steps[scanAt]
  // After the stand built the image of this job's version, and with the parameters of В1.
  assert.ok(index('Build and check the image') < scanAt, 'the scanner runs after the stand')
  assert.match(scan, /^ {10}PHP_VERSION: \$\{\{ matrix\.php \}\}$/m)
  assert.match(scan, /^ {8}if: github\.event_name != 'pull_request'$/m)
  assert.match(scan, /^ {8}continue-on-error: true$/m)
  assert.match(scan, /--exit-code 0\b/)
  assert.match(scan, /--scanners vuln\b/)
  assert.match(scan, /--severity HIGH,CRITICAL\b/)
  // The scanner sends no usage data and asks for no news of versions.
  assert.match(scan, /--disable-telemetry\b/)
  assert.match(scan, /--skip-version-check\b/)
  assert.match(scan, /^ {10}TRIVY_IMAGE: aquasec\/trivy@sha256:[0-9a-f]{64}$/m)
  // Every container of the step is the pinned scanner.
  const runsOf = [...scan.matchAll(/docker run [^\n]*/g)].map(([line]) => line)
  assert.equal(runsOf.length, 2, 'the scan and its table')
  for (const line of runsOf) assert.match(line, / "\$TRIVY_IMAGE" /, line)
  // The scanner reads the image the stand built and left under its tag.
  assert.match(scan, /"raditi-site-verify:\$PHP_VERSION"/)
  assert.ok(
    read('infra/dev/preview-verify/verify-site-images.mjs').includes(
      'const tag = `raditi-site-verify:${row.php}`',
    ),
    'the stand tags the image of a version as the scanner reads it',
  )
  const upload = steps.find((step) => step.startsWith('name: Upload the scan\n')) ?? ''
  assert.match(upload, /^ {10}name: site-image-scan-\$\{\{ matrix\.php \}\}$/m)
  // The engine of the sandbox VM, the same as preview.yml installs.
  const engine = (text) => /^ +SANDBOX_DOCKER_VERSION: (\S+)$/m.exec(text)?.[1]
  assert.ok(engine(workflow('preview')), 'preview.yml names the engine')
  assert.equal(engine(source), engine(workflow('preview')))
  // The workflow starts on every file the stand loads and every file its images copy; the
  // package @repo/domain stays narrow, to its preview folder.
  const filter = pathFilter(source)
  assert.ok(filter.includes('infra/preview/**'))
  assert.ok(filter.includes('packages/domain/src/preview/**'))
  const stand = loads([
    'infra/dev/preview-verify/verify-site-images.mjs',
    ...readdirSync(join(root, 'infra/dev/preview-verify'))
      .filter((name) => /^site-[a-z0-9]+\.mjs$/.test(name))
      .map((name) => `infra/dev/preview-verify/${name}`),
  ])
  assert.ok(
    stand.includes('packages/sandbox-providers/src/preview/runtime.ts'),
    'the stand loads the preview runtime',
  )
  for (const file of stand) assert.ok(starts(filter, file), `${file} does not start the workflow`)
  for (const file of copied('infra/sandbox/Dockerfile', 'network-guard'))
    assert.ok(starts(filter, file), `${file} (network-guard) does not start the workflow`)
})

/**
 * The files outside `folder` that its code (not its tests) imports by a relative path, followed
 * through every file found, in the order found.
 */
function importedOutside(folder) {
  const code = (file) => file.endsWith('.ts') && !/\.test\.ts$|\/fixtures\.ts$/.test(file)
  const queue = readdirSync(join(root, folder), { recursive: true })
    .map((name) => `${folder}/${name}`)
    .filter(code)
  const seen = new Set(queue)
  const outside = []
  while (queue.length > 0) {
    const file = queue.shift()
    for (const [, specifier] of read(file).matchAll(/\bfrom '(\.\.?\/[^']+)'/g)) {
      const target = relative(root, join(root, dirname(file), specifier))
      if (seen.has(target)) continue
      seen.add(target)
      assert.ok(existsSync(join(root, target)), `${file} imports ${specifier}, which is not there`)
      if (!target.startsWith(`${folder}/`)) outside.push(target)
      queue.push(target)
    }
  }
  return outside
}

// The closed vendor of plan 62, in parts: this file would otherwise name it to itself.
const closedVendor = new RegExp(['bit', 'rix'].join(''), 'i')

test('site-stacks.yml runs М2 of every stack that has its suite, on archives of the run only', () => {
  // docs/plan/62-slices/e3.md, Э3.8: the matrix is read from the folder of the suites, no stack is
  // named here; each value starts the workflow by the files of its stack and runs its own file.
  const source = workflow('site-stacks')
  const suites = readdirSync(join(root, 'apps/core/src/previews'))
    .map((name) => /^([a-z0-9]+)-preview\.integration\.test\.ts$/.exec(name)?.[1])
    .filter(Boolean)
    .toSorted()
  assert.ok(suites.length > 0, 'a suite of a stack is found')
  const stacks = matrixOf(source).stack ?? []
  assert.deepEqual(stacks.toSorted(), suites)
  const filter = pathFilter(source)
  for (const stack of stacks) {
    assert.ok(filter.includes(`infra/${stack}/**`), `the filter does not name infra/${stack}/**`)
    assert.ok(
      filter.includes(`packages/site-adapters/src/${stack}/**`),
      `the filter does not name packages/site-adapters/src/${stack}/**`,
    )
    // What the adapter imports outside its folder, followed through those files: a change there
    // changes the adapter, so it starts the workflow as well.
    for (const file of importedOutside(`packages/site-adapters/src/${stack}`))
      assert.ok(
        starts(filter, file),
        `${file}, imported by the adapter of ${stack}, does not start the workflow`,
      )
    assert.ok(
      runsSuite(source, `src/previews/${stack}-preview.integration.test.ts`, [
        'RADITI_PREVIEW_DOCKER_TESTS',
        'RADITI_CMS_DIR',
      ]),
      `no step runs the suite of ${stack}`,
    )
  }
  // The archives live in the temporary folder of the runner: no cache, artifact or image keeps them.
  assert.match(source, /^ +RADITI_CMS_DIR: \$\{\{ runner\.temp \}\}\/raditi-cms$/m)
  assert.doesNotMatch(source, /actions\/cache|upload-artifact|docker push/)
  assert.match(
    source,
    /node infra\/dev\/stack-verify\/fetch-cms\.mjs --stack=\$\{\{ matrix\.stack \}\}/,
  )
  assert.doesNotMatch(source, closedVendor)
})

test('site-stacks.yml runs verify:stack of every stack on Linux, its groups named, never live', async () => {
  // docs/plan/62-slices/e3.md, Э3.13: М3 and М4 in CI for the stacks of the matrix, under runc. The
  // groups are named: without --group the stand runs every group of a stack, and `browser` (Э8)
  // and `safety-browser` stay local (§5.5).
  const source = workflow('site-stacks')
  const stand = /^ {2}stand:\n(?:(?: {4}.*)?\n)+/m.exec(`${source}\n`)?.[0] ?? ''
  assert.ok(stand, 'site-stacks.yml has the job stand')
  assert.match(stand, /^ {4}needs: preview$/m)
  assert.match(stand, /^ {4}timeout-minutes: 90$/m)
  assert.deepEqual(matrixOf(stand).stack, matrixOf(source).stack)
  const steps = stand.split(/^ {6}- /m).slice(1)
  const runOf = (step) => /^ {8}run: (.*(?:\n(?: {9,}.*)?)*)/m.exec(step)?.[1] ?? ''
  const verifying = steps.filter((step) => runOf(step).includes('pnpm verify:stack'))
  assert.equal(verifying.length, 1, 'one step runs the stand')
  const [step] = verifying
  const command = runOf(step).trim()
  assert.match(
    command,
    /^pnpm verify:stack -- --stack=\$\{\{ matrix\.stack \}\}(?: --group=[a-z-]+)+$/,
  )
  const groups = [...command.matchAll(/--group=([a-z-]+)/g)].map(([, group]) => group)
  // М3 and М4 always; `safety` is what Э11.4 adds to this step; `browser` and `safety-browser`
  // stay local (§5.5): any other group here is refused.
  for (const group of ['import', 'preview', 'release'])
    assert.ok(groups.includes(group), `the step does not name the group ${group}`)
  for (const group of groups)
    assert.ok(
      ['import', 'preview', 'release', 'safety'].includes(group),
      `CI runs the group ${group}`,
    )
  assert.equal(new Set(groups).size, groups.length, 'a group is named twice')
  // runc: the option that would select gVisor is never passed here (М7 is a run by hand, Т69).
  assert.doesNotMatch(stand, /--runtime|runsc/)
  assert.match(step, /^ {10}RADITI_CMS_DIR: \$\{\{ runner\.temp \}\}\/raditi-cms$/m)
  for (const forbidden of ['--live', 'ZAI_API_KEY'])
    assert.equal(source.includes(forbidden), false, `site-stacks.yml names ${forbidden}`)
  assert.doesNotMatch(source, /\$\{\{\s*secrets\./, 'site-stacks.yml reads a secret')
  // The engine and the image store of the job preview: the stand needs repository digests of its
  // own builds, and only the containerd store gives them.
  for (const text of [
    '"docker-ce=$package" "docker-ce-cli=$package"',
    '"containerd-snapshotter": true',
  ])
    assert.ok(stand.includes(text), `the job stand lacks ${text}`)
  // In this order: the images are pulled into the containerd store after the restart of Docker,
  // and Gitleaks and the browsers are there before the stand. A red stand is a red job: no step
  // of the job, nor the job, is skipped by a condition or let fail.
  const index = (name) => steps.findIndex((each) => each.startsWith(`name: ${name}\n`))
  const order = [
    'Docker Engine of the sandbox VM',
    'Docker with the containerd image store',
    'Pull the pinned images',
    'Gitleaks of the core image',
    'Chromium and WebKit of Playwright',
    'Import, preview and release of every build of the stack',
  ].map(index)
  assert.ok(!order.includes(-1), `a step of the job stand is missing: ${order}`)
  assert.deepEqual(
    order,
    order.toSorted((a, b) => a - b),
    'the steps of the job stand are out of order',
  )
  assert.equal(steps.indexOf(step), order.at(-1), 'the stand runs in its own step')
  assert.doesNotMatch(stand, /^ +continue-on-error:/m, 'the job stand lets a step fail')
  assert.doesNotMatch(stand, /^ +if:/m, 'the job stand skips a step by a condition')
  // A failed images.mjs fails the pull: without pipefail the loop would end the pipe with 0.
  assert.match(
    steps[order[2]],
    /^ {10}set -o pipefail\n {10}node infra\/dev\/stack-verify\/images\.mjs/m,
  )
  // The pinned images of the stand, by digest, from the one list the stand checks itself.
  assert.match(
    stand,
    /node infra\/dev\/stack-verify\/images\.mjs --stack=\$\{\{ matrix\.stack \}\}[^\n]*\n[^\n]*docker pull --quiet "\$image"/,
  )
  assert.match(
    read('infra/dev/stack-verify/verify-stack.mjs'),
    /const pinned = pinnedImagesOf\(/,
    'the stand checks the list the job pulls',
  )
  assert.ok(stand.includes('playwright install --with-deps chromium webkit'))
  // Gitleaks of the pinned image of apps/core/Dockerfile: no second pin to drift, and its tag is the
  // version the stand requires (the stand checks the binary's output, verify-stack.mjs).
  const { GITLEAKS_VERSION } = await import(join(root, 'infra/dev/site-import-verify/stand.mjs'))
  assert.match(GITLEAKS_VERSION, /^\d+\.\d+\.\d+$/)
  assert.match(
    read('apps/core/Dockerfile'),
    new RegExp(
      `^ARG GITLEAKS_IMAGE=ghcr\\.io/gitleaks/gitleaks:v${GITLEAKS_VERSION.replaceAll('.', '\\.')}@sha256:[0-9a-f]{64}$`,
      'm',
    ),
  )
  assert.match(
    read('infra/dev/stack-verify/verify-stack.mjs'),
    /import \{ GITLEAKS_VERSION \} from '\.\.\/site-import-verify\/stand\.mjs'/,
  )
  assert.ok(stand.includes("sed -n 's/^ARG GITLEAKS_IMAGE=//p' apps/core/Dockerfile"))
  assert.ok(sets(stand, 'P2_GITLEAKS_BINARY'), 'the job gives the stand its Gitleaks')
  // A change of the import or the release starts М3 and М4; tasks and mcp change in almost every
  // pull request and are covered by the weekly run.
  assert.match(source, /^ {2}schedule:\n {4}- cron: '37 3 \* \* 1'$/m)
  const filter = pathFilter(source)
  for (const pattern of [
    'apps/core/src/site-provisioning/**',
    'apps/core/src/releases/**',
    'apps/core/src/release-api/**',
    'apps/core/src/deploy-step/**',
    'apps/preview/**',
    'packages/site-connections/src/hosting/**',
    'packages/site-content/**',
    'ci/**',
  ])
    assert.ok(filter.includes(pattern), `${pattern} is not in the path filter`)
  for (const pattern of ['apps/core/src/tasks/**', 'apps/mcp/**'])
    assert.equal(filter.includes(pattern), false, `${pattern} starts the hour-long job`)
  // Every file the stand loads by a relative import, beyond its own folder too, starts the workflow.
  const loaded = loads([
    'infra/dev/stack-verify/verify-stack.mjs',
    'infra/dev/stack-verify/images.mjs',
  ])
  assert.ok(loaded.includes('infra/dev/release-verify/services.mjs'), 'the stand was read')
  for (const file of loaded)
    assert.ok(starts(filter, file), `${file}, loaded by the stand, does not start the workflow`)
  // The images the stand builds: their Dockerfiles — apps/core/Dockerfile is the deploy runner of
  // `release` — and what their stages copy from the repository (`COPY . .` of core is the tree, its
  // folders are named above).
  const { BUILT_IMAGES } = await import(join(root, 'infra/dev/release-verify/stand.mjs'))
  const { COPY_MODULES, STACK_BUILT_IMAGES } = await import(
    join(root, 'infra/dev/stack-verify/stand.mjs')
  )
  const images = [...Object.values(BUILT_IMAGES), ...Object.values(STACK_BUILT_IMAGES)]
  assert.ok(
    images.some((image) => image.file === 'apps/core/Dockerfile'),
    'the images were read',
  )
  for (const { file, target, context } of images) {
    assert.ok(starts(filter, file), `${file}, built by the stand, does not start the workflow`)
    if (file === 'apps/core/Dockerfile') continue
    for (const source of copied(file, target)) {
      const path = context ? join(context, source) : source
      assert.ok(starts(filter, path), `${path} (${file}, ${target}) does not start the workflow`)
    }
  }
  // Prisma and billing of the copy set the stand up and change in almost every pull request: only
  // the weekly run covers them. A module added to the copy is a decision of its own.
  assert.deepEqual(Object.values(COPY_MODULES).toSorted(), [
    'packages/billing/src/index.ts',
    'packages/db/src/index.ts',
  ])
  for (const file of Object.values(COPY_MODULES))
    assert.equal(starts(filter, file), false, `${file} starts the hour-long job`)
  // What the import and the release run in core beside their own folders starts the workflow, but
  // the frame every pull request touches — the weekly run covers it. A folder newly imported is a
  // decision of its own.
  const product = ['site-provisioning', 'releases', 'release-api', 'deploy-step']
  const weekly = ['config', 'infra', 'leases', 'metrics', 'queue', 'site-env']
  const reached = new Set()
  for (const folder of product)
    for (const name of readdirSync(join(root, 'apps/core/src', folder), { recursive: true })) {
      if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name)) continue
      const file = join('apps/core/src', folder, name)
      for (const [, specifier] of read(file).matchAll(/\bfrom\s*'(\.{1,2}\/[^']+)'/g)) {
        const target = relative(join(root, 'apps/core/src'), join(root, dirname(file), specifier))
        const [top] = target.split('/')
        if (target.includes('/') && !top.startsWith('.')) reached.add(top)
      }
    }
  assert.ok(reached.has('git-workspace'), 'the imports of the release were read')
  for (const folder of reached) {
    if (weekly.includes(folder)) continue
    assert.ok(
      filter.includes(`apps/core/src/${folder}/**`),
      `apps/core/src/${folder}/** is reached by the import or the release and does not start the workflow`,
    )
  }
  for (const folder of weekly)
    assert.ok(
      reached.has(folder),
      `apps/core/src/${folder} is no longer reached: drop it from weekly`,
    )
  // The download of a site at the import (`siteSource`) and the writing on the hosting.
  for (const file of [
    'packages/site-connections/src/index.ts',
    'packages/site-connections/src/sources/sftp.ts',
    'packages/site-connections/src/sources/ftp.ts',
    'packages/site-connections/src/hosting/index.ts',
  ])
    assert.ok(
      existsSync(join(root, file)) && starts(filter, file),
      `${file} does not start the workflow`,
    )
})

test('no file of the stands of the site stacks names the closed vendor but their README', () => {
  // The core of that CMS is never fetched, unpacked or run here (plan 62): a table of archives,
  // a stand or a fixture that names it is refused before it is used.
  const folder = 'infra/dev/stack-verify'
  const files = readdirSync(join(root, folder), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'README.md')
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
  assert.ok(files.includes(`${folder}/cms-archives.json`), 'the files of the stand are read')
  for (const file of files) assert.doesNotMatch(read(file), closedVendor, file)
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
  ])
    assert.ok(filter.includes(pattern), `${pattern} is in the path filter`)
  // The plugin, every script of the stand and the helpers it imports start the workflow. The
  // worker and its scenarios drive the mcp app alone and live in its scripts (plan 56).
  const workers = readdirSync(join(root, 'apps/mcp/scripts'))
    .filter((name) => name.startsWith('verify-content-'))
    .map((name) => `apps/mcp/scripts/${name}`)
  assert.ok(workers.includes('apps/mcp/scripts/verify-content-worker.mjs'))
  const stand = [
    'infra/wordpress/raditi-content.php',
    'apps/core/scripts/verify-agent-supervisor.mjs',
    ...readdirSync(join(root, 'infra/dev/site-verify')).map(
      (name) => `infra/dev/site-verify/${name}`,
    ),
    ...workers,
  ]
  assert.ok(stand.length >= 9)
  for (const file of stand) assert.ok(starts(filter, file), `${file} does not start the workflow`)
  // As for the gateway stand: the packages its scripts import, by name or by a path into their
  // sources, the modules of the apps they load from the builds and the app sources they load as
  // they are. `../dist/` and `../src/` are the build and the sources of the script's own app.
  // The journal tables, the snapshot storage and the turn undo are this path as much as the
  // plugin is.
  const imported = new Set()
  for (const script of stand.filter((file) => file.endsWith('.mjs'))) {
    const app = /^apps\/([a-z-]+)\/scripts\//.exec(script)?.[1]
    const text = read(script)
    for (const [, name] of text.matchAll(/'(?:@repo|(?:\.\.\/)+packages)\/([a-z-]+)[/']/g))
      imported.add(`packages/${name}/src/index.ts`)
    if (!app) continue
    // A module of the app's own build: its directory, or the app itself for one at the root.
    for (const [, directory] of text.matchAll(/'\.\.\/dist\/(?:([a-z-]+)\/)?/g))
      imported.add(`apps/${app}/src/${directory ? `${directory}/` : ''}index.ts`)
    // The builds of the other apps, by directory: ../../core/dist/turns/ and the like.
    for (const [, other, directory] of text.matchAll(
      /'\.\.\/\.\.\/([a-z-]+)\/dist\/(?:([a-z-]+)\/)?/g,
    ))
      imported.add(`apps/${other}/src/${directory ? `${directory}/` : ''}index.ts`)
    for (const [, file] of text.matchAll(/'\.\.\/src\/([^']+\.ts)'/g))
      imported.add(`apps/${app}/src/${file}`)
  }
  for (const source of [
    'packages/db/src/index.ts',
    'packages/storage/src/index.ts',
    'packages/domain/src/index.ts',
    'packages/site-adapters/src/index.ts',
    'apps/mcp/src/index.ts',
    'apps/mcp/src/content/index.ts',
    // The turn supervisor of core's build drives the trusted rollback of the mcp app.
    'apps/core/src/turns/index.ts',
    // The sample ids of the turns the stand makes up.
    'apps/mcp/src/testing/ids.ts',
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

test('the required CI job checks the syntax of every PHP file of infra', () => {
  // The content plugin and the preview files of every stack, and the prologue of a generated
  // configuration (docs/plan/62-site-stacks.md, Т12, Т21): the step walks infra/*/ and names no
  // file, so the folder of a new stack is checked without a new line.
  const gates = job('gates')
  const files = globSync('infra/*/*.php', { cwd: root })
  assert.ok(files.length > 0)
  assert.ok(files.includes('infra/preview/prologue.php'))
  for (const file of files) assert.ok(read(file).startsWith('<?php'), file)
  const step = gates.slice(gates.indexOf('- name: PHP syntax of infra'))
  assert.ok(step.length < gates.length, 'the gates job has the step PHP syntax of infra')
  const run = step.slice(0, step.indexOf('\n      - name: '))
  assert.match(run, /^ {10}for file in infra\/\*\/\*\.php; do$/m)
  assert.match(run, /^ {14}php -l "\$file"$/m)
  assert.doesNotMatch(run, /infra\/(?!\*)/, 'the step names no folder of infra')
  // A runner without PHP uses the PHP of the pinned WordPress image, offline and read-only.
  const [, image] =
    /docker run --rm --network none --entrypoint php -v "\$PWD\/infra:\/infra:ro" \\\n +(\S+) -l "\/\$file"/.exec(
      run,
    ) ?? []
  assert.equal(
    image,
    siteImages.find((name) => name.startsWith('wordpress:7.')),
  )
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
    // The catalogues of the chat keep their words in functions too; a domain test reads no file.
    'packages/domain/src/tasks/client-feed-labels.ts': [
      'apps/web/src/components/chat/chat-texts.test.ts',
    ],
    'packages/domain/src/tasks/client-feed-failures.ts': [
      'apps/web/src/components/chat/chat-texts.test.ts',
    ],
    'packages/domain/src/release/chat-commands.ts': [
      'apps/web/src/components/chat/chat-texts.test.ts',
    ],
    // The LLM paths of sandbox-gw against the routes of the registry and the base URL of each.
    'infra/sandbox/gateway.mjs': [
      'apps/llm/src/gateway/sandbox-routes.contract.test.ts',
      'apps/core/src/llm/backends.test.ts',
    ],
    // The policy of the WordPress database copy, against the file the copier is tested with
    // (plan 53, R5b). The embedded files of the stacks are the next test.
    'packages/site-connections/src/database-copy/wordpress-policy.fixture.json': [
      'packages/site-adapters/src/wordpress-db-copy.test.ts',
    ],
    // The stand of Joomla and the table of the archives of the CMS, against the suite of М2 and
    // its harness (docs/plan/62-slices/e3.md, Э3.8); the inputs name the folder of the stand and
    // every folder under it.
    'infra/dev/stack-verify/joomla.mjs': [
      'apps/core/src/previews/joomla-preview.integration.test.ts',
    ],
    'infra/dev/stack-verify/cms-archives.json': ['apps/core/src/testing/stack-preview.ts'],
    // The files of the production container the harness copies (`**` takes the folder prod/).
    'infra/dev/stack-verify/prod/entry.sh': ['apps/core/src/testing/stack-preview.ts'],
    'infra/dev/stack-verify/prod/apache.conf': ['apps/core/src/testing/stack-preview.ts'],
    // The token command of the runner image (the runbook issues it on the sandbox VM), against
    // the RUNNER_TOKENS entries core accepts.
    'apps/runner/scripts/runner-token.mjs': ['apps/core/src/runner-api/runner-auth.test.ts'],
    // The llm service of the app VM's compose against the one extra CA the production role takes.
    'infra/app/docker-compose.yml': ['apps/llm/src/config/llm-config.contract.test.ts'],
  }
  // An input names the file itself or a pattern of its folder (`*` does not cross a folder, `**` does).
  const root$ = '$TURBO_ROOT$/'
  const isInput = (file) =>
    inputs.some((input) => input.startsWith(root$) && starts([input.slice(root$.length)], file))
  for (const [file, readers] of Object.entries(outside)) {
    assert.ok(isInput(file), `${file} is not an input of test`)
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

test('a cached test run sees a change of any file of a stack', () => {
  // stack-files.test.ts holds the constants of every folder of EMBEDDED to the files of
  // infra/<stack>/ through stack-files.mjs (docs/plan/62-site-stacks.md, Т12). The inputs walk
  // infra/*/ as the script does, so a new stack needs no new line here.
  const { inputs = [] } = JSON.parse(read('turbo.json')).tasks.test
  for (const pattern of ['infra/*/*.php', 'infra/*/*.conf', 'infra/*/*.ini'])
    assert.ok(inputs.includes(`$TURBO_ROOT$/${pattern}`), `${pattern} is not an input of test`)
  assert.ok(!inputs.some((input) => input.startsWith('$TURBO_ROOT$/infra/wordpress/')))
  const reader = 'packages/site-adapters/src/stack-files.test.ts'
  assert.ok(read(reader).includes("from '../scripts/stack-files.mjs'"), `${reader} reads no files`)
  assert.match(
    read('packages/site-adapters/scripts/stack-files.mjs'),
    /const EMBEDDABLE = \/\\\.\(\?:php\|conf\|ini\)\$\//,
  )
})

test('a cached typecheck or test of core sees a change of the runner engine its tests drive', () => {
  // core's cross-app tests compile and run the runner engine with core's sources through the one
  // file of core that imports the runner app (plan 56, decision 1). The engine files may import
  // each other (dependency-cruiser: runner-engine-speaks-the-protocol-only), so what the gateway
  // reaches can grow among them without a new import of its own: core names every engine file.
  const gateway = 'apps/core/src/testing/runner-side.ts'
  const { forbidden } = createRequire(import.meta.url)('../../.dependency-cruiser.cjs')
  const rule = forbidden.find(({ name }) => name === 'runner-engine-speaks-the-protocol-only')
  const isEngine = new RegExp(rule.from.path)
  const engine = readdirSync(join(root, 'apps/runner/src'), { recursive: true })
    .map((file) => `apps/runner/src/${file}`)
    .filter((file) => isEngine.test(file))
    .toSorted()
  assert.ok(engine.length > 0, 'dependency-cruiser names the engine files')
  // The gateway's imports and, through theirs, every runner file core compiles.
  const reached = new Set()
  const pending = [gateway]
  while (pending.length > 0) {
    const file = pending.pop()
    for (const [, specifier] of read(file).matchAll(/from '(\.{1,2}\/[^']+\.ts)'/g)) {
      const target = relative(root, join(root, dirname(file), specifier))
      if (!target.startsWith('apps/runner/') || reached.has(target)) continue
      reached.add(target)
      pending.push(target)
    }
  }
  assert.ok(reached.size > 0, `${gateway} imports the runner engine`)
  for (const file of reached) assert.ok(engine.includes(file), `${gateway} reaches ${file}`)
  const runnerFiles = (inputs = []) =>
    inputs
      .filter((input) => input.startsWith('$TURBO_ROOT$/apps/runner/src/'))
      .map((input) => input.slice('$TURBO_ROOT$/'.length))
      .toSorted()
  const shared = JSON.parse(read('turbo.json')).tasks
  assert.deepEqual(runnerFiles(shared.test.inputs), engine, 'test names the engine files')
  // Only core compiles them: its own configuration names them for typecheck, so a change of the
  // engine leaves the cached typecheck of every other workspace alone.
  assert.equal(shared.typecheck.inputs, undefined, 'the typecheck of every workspace names none')
  const core = JSON.parse(read('apps/core/turbo.json'))
  assert.deepEqual(core.extends, ['//'], 'core extends the configuration of the repository')
  const { inputs } = core.tasks.typecheck
  assert.ok(inputs.includes('$TURBO_DEFAULT$'), "core's typecheck keeps the files of its package")
  assert.deepEqual(runnerFiles(inputs), engine, "core's typecheck names the engine files")
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

test('publish-images.yml builds every app image of a release and names its digest', () => {
  const source = workflow('publish-images')
  const matrix = [
    ...source.matchAll(
      /^ {10}- image: (\S+)\n {12}file: (\S+)\n {12}target: (\S+)\n {12}variable: (\S+)$/gm,
    ),
  ].map(([, image, file, target, variable]) => ({ image, file, target, variable }))
  const ofApps = matrix.filter(({ file }) => file.startsWith('apps/'))
  // Every app with a Dockerfile ships its runtime image; core ships its migrate image as well.
  const apps = readdirSync(join(root, 'apps')).filter((app) =>
    existsSync(join(root, 'apps', app, 'Dockerfile')),
  )
  assert.ok(apps.length >= 7, 'the Dockerfiles of the apps were read')
  assert.deepEqual(
    ofApps
      .filter(({ target }) => target === 'runtime')
      .map(({ image, file }) => [image, file])
      .sort(),
    apps.map((app) => [app, `apps/${app}/Dockerfile`]).sort(),
  )
  assert.deepEqual(
    ofApps.filter(({ target }) => target !== 'runtime'),
    [
      {
        image: 'migrate',
        file: 'apps/core/Dockerfile',
        target: 'migrate',
        variable: 'MIGRATE_IMAGE',
      },
    ],
  )
  // images.env names what the matrix built, in its order, and the app VM reads the same names.
  const pairs = /for pair in ((?:[^;]|\\\n)+); do/.exec(source)
  assert.ok(pairs, 'the digests job lists the images')
  assert.deepEqual(
    pairs[1].split(/\s+|\\/).filter(Boolean),
    matrix.map(({ image, variable }) => `${image}:${variable}`),
  )
  const deployed = read('infra/app/env.example')
  for (const variable of [
    'WEB_IMAGE',
    'CORE_IMAGE',
    'MIGRATE_IMAGE',
    'LLM_IMAGE',
    'PREVIEW_GATEWAY_IMAGE',
  ]) {
    assert.ok(
      matrix.some((entry) => entry.variable === variable),
      `${variable} is not built`,
    )
    assert.match(deployed, new RegExp(`^${variable}=`, 'm'), `env.example deploys no ${variable}`)
  }
  // The sandbox side and the browser session, as the single server runs them (infra/server):
  // BROWSER_IMAGE is the Chromium of a session (infra/preview), the worker is BROWSER_WORKER_IMAGE.
  assert.deepEqual(
    matrix
      .filter(({ file }) => !file.startsWith('apps/'))
      .map(({ file, target, variable }) => `${file}#${target}:${variable}`),
    [
      'infra/sandbox/Dockerfile#runtime:SANDBOX_IMAGE',
      'infra/sandbox/Dockerfile#gateway:SANDBOX_GATEWAY_IMAGE',
      'infra/sandbox/Dockerfile#network-guard:SANDBOX_NETWORK_GUARD_IMAGE',
      'infra/sandbox/Dockerfile#watchdog:SANDBOX_WATCHDOG_IMAGE',
      'infra/sandbox/Dockerfile#client-egress:BROWSER_EGRESS_IMAGE',
      'infra/preview/Dockerfile#tools:BROWSER_FORWARDER_IMAGE',
      'infra/preview/Dockerfile#browser:BROWSER_IMAGE',
    ],
  )
  // infra/preview builds from its own folder (COPY forward.mjs …), the rest from the root
  assert.equal((source.match(/^ {12}context: infra\/preview$/gm) ?? []).length, 2)
  assert.match(source, /^ {10}context: \$\{\{ matrix\.context \|\| '\.' \}\}$/m)
  assert.equal(new Set(matrix.map(({ variable }) => variable)).size, matrix.length)
  // A release tag only, and the build uses the commit the version job resolved.
  assert.match(source, /\^v\(0\|\[1-9\]\[0-9\]\*\)/)
  assert.match(source, /^ {10}ref: \$\{\{ needs\.version\.outputs\.revision \}\}$/m)
  assert.match(source, /^ {10}platforms: linux\/amd64$/m)
  // The tag a person typed reaches a script only through env, after the check of its form.
  assert.deepEqual(
    source
      .split('\n')
      .filter((line) => /inputs\.tag|github\.ref_name/.test(line) && !/^ +(?:if|tag):/.test(line))
      .map((line) => line.trim().split(':')[0]),
    ['group', 'TAG'],
  )
})

test('release.yml publishes the images of the release semantic-release made', () => {
  const source = workflow('release')
  const order = [
    'run: git tag --points-at HEAD',
    'run: pnpm exec semantic-release',
    'comm -13 "$RUNNER_TEMP/tags-before" "$RUNNER_TEMP/tags-after"',
    'uses: ./.github/workflows/publish-images.yml',
  ].map((text) => source.indexOf(text))
  assert.ok(order[0] >= 0, 'the release job remembers the tags first')
  assert.deepEqual(
    order,
    order.toSorted((left, right) => left - right),
  )
  assert.match(source, /^ {4}if: needs\.release\.outputs\.tag != ''$/m)
  assert.match(source, /^ {6}tag: \$\{\{ needs\.release\.outputs\.tag \}\}$/m)
  assert.match(source, /^ {6}packages: write$/m)
})

// Plan 62 of the site stacks: slices and records in the code cite its decisions, so all of it lives
// in the repository, and nothing in it may lead to the machine it was written on.
const stackPlan = 'docs/plan/62-site-stacks.md'
const stackScreens = 'docs/plan/62-onboarding.md'
const stackSlices = 'docs/plan/62-slices'
const stackReports = 'docs/research/2026-11-site-stacks'
const stackSliceFiles = [
  'after.md',
  'e0.md',
  'e1.md',
  'e2.md',
  'e3.md',
  'e4.md',
  'e5.md',
  'e6a.md',
  'e8.md',
]
// The files of the platform the contracts of Э3, Э4 and Э5 take as their sample.
const stackPlatformFiles = {
  joomla: ['platform/configuration.php', 'policy.mjs', 'rewrite.conf'],
  modx3: [
    'platform/config.core.php',
    'platform/connectors/config.core.php',
    'platform/core/config/config.inc.php',
    'platform/manager/config.core.php',
    'policy.mjs',
    'rewrite.conf',
  ],
  opencart3: ['platform/admin/config.php', 'platform/config.php', 'policy.mjs', 'rewrite.conf'],
}
const filesUnder = (folder) =>
  readdirSync(join(root, folder), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
const stackPlanFiles = [
  stackPlan,
  stackScreens,
  ...stackSliceFiles.map((file) => `${stackSlices}/${file}`),
  ...filesUnder(stackReports),
]

test('the plan of the site stacks is in the repository and CLAUDE.md names all of it', () => {
  for (const path of [stackPlan, stackScreens, `${stackReports}/README.md`]) {
    assert.ok(existsSync(join(root, path)), `${path} is not in the repository`)
  }
  assert.deepEqual(readdirSync(join(root, stackSlices)).toSorted(), stackSliceFiles)
  for (const [build, expected] of Object.entries(stackPlatformFiles)) {
    const folder = `${stackReports}/scripts/boot-spike/cms/${build}`
    assert.deepEqual(
      filesUnder(folder)
        .map((file) => relative(folder, file))
        .toSorted(),
      expected,
      `${build}: files of the platform`,
    )
  }
  const rows = read('CLAUDE.md').split('\n')
  const row = (path) => rows.find((line) => line.startsWith(`| \`${path}`)) ?? ''
  for (const path of [stackPlan, stackScreens, `${stackReports}/`]) {
    assert.ok(row(path), `the table of CLAUDE.md does not name ${path}`)
  }
  for (const file of stackSliceFiles) {
    assert.ok(row(`${stackSlices}/`).includes(`\`${file}\``), `CLAUDE.md does not name ${file}`)
  }
})

test('the plan of the site stacks carries no path of the machine it was written on', () => {
  // Built from parts: this file would otherwise describe itself. The word boundary of the domain
  // keeps `site.runtimeVersion` of the contracts out.
  const machinePaths = ['/Us' + 'ers/', '/pri' + 'vate/tmp', '/var/' + 'folders', 'o' + 'c-work']
  const removedDomain = new RegExp('\\bsite' + '\\.ru\\b')
  // Where the fix that removed the example speaks of the domain itself.
  const domainLines = new Map([
    [stackPlan, 1],
    [stackScreens, 4],
    [`${stackReports}/review/plan-decisions.md`, 1],
  ])
  for (const file of domainLines.keys()) {
    assert.ok(stackPlanFiles.includes(file), `${file} is not in the repository`)
  }
  for (const file of stackPlanFiles) {
    const text = read(file)
    for (const path of machinePaths) {
      assert.ok(!text.includes(path), `${file} names ${path}`)
    }
    assert.equal(
      text.split('\n').filter((line) => removedDomain.test(line)).length,
      domainLines.get(file) ?? 0,
      `${file}: lines with the removed domain`,
    )
  }
})

test('every file the plan of the site stacks names is in the repository', () => {
  // A path followed by a template part ({a,b}, *, <stage>) names no one file, so it is left out.
  const named = /docs\/(?:research\/2026-11-site-stacks|plan\/62-)[\w./-]*(?![\w./{*<-])/g
  for (const file of stackPlanFiles) {
    for (const [match] of read(file).matchAll(named)) {
      const path = match.replace(/\.+$/, '')
      assert.ok(existsSync(join(root, path)), `${file} names ${path}`)
    }
  }
  // The index of the reports links each of them, so a report that is gone is a broken link.
  const index = `${stackReports}/README.md`
  for (const [, link] of read(index).matchAll(/\]\((?!https?:)([^)#\s]+)\)/g)) {
    assert.ok(existsSync(join(root, stackReports, link)), `${index} links ${link}`)
  }
})

test('the import builds its path policy from every field of the rules of an adapter', () => {
  // Plan 62, Т57: `importPolicyOf` passes `documentFolders` along with `exclude`; a direct call
  // of the bare policy would close no folder of documents, or forget a field the next stage adds.
  const policyFile = 'packages/domain/src/site-connection/import-policy.ts'
  const sources = workspaces.flatMap((workspace) =>
    existsSync(join(root, workspace, 'src'))
      ? readdirSync(join(root, workspace, 'src'), { recursive: true })
          .filter((name) => /\.(?:ts|tsx|mts|mjs)$/.test(name))
          .filter((name) => !/\.(?:test|spec)\.(?:ts|tsx|mts|mjs)$/.test(name))
          .map((name) => `${workspace}/src/${name}`)
      : [],
  )
  assert.ok(sources.includes(policyFile), `${policyFile} is a source file`)
  const callers = sources.filter((file) => read(file).includes('createImportPathPolicy('))
  assert.deepEqual(callers, [policyFile])
})

test('the core of the smoke labels its turn containers apart from `pnpm dev`', () => {
  // With the label `local` of .env.example, core of `pnpm e2e` would collect the turns of
  // `pnpm dev` on the same Docker daemon and they its own (SANDBOX_DEPLOYMENT, Э0и).
  const config = read('apps/e2e/playwright.config.ts')
  assert.match(config, /TURN_EXECUTOR: 'local',/)
  const label = /SANDBOX_DEPLOYMENT: '([^']+)'/.exec(config)?.[1]
  assert.ok(label, 'the smoke core sets SANDBOX_DEPLOYMENT')
  assert.notEqual(label, /^SANDBOX_DEPLOYMENT=(.*)$/m.exec(read('.env.example'))?.[1])
  assert.notEqual(label, 'local')
})
