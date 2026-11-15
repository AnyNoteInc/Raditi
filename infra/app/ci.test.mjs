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
    /^ +run: pnpm test \$\{\{ matrix\.filter \}\} --concurrency=\d+ -- (--testTimeout=\d+) --maxWorkers=\d+$/m.exec(
      ci,
    ) ?? []
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
    /^ +run: pnpm test \$\{\{ matrix\.filter \}\} --concurrency=(\d+) -- --testTimeout=\d+ --maxWorkers=(\d+)$/m.exec(
      ci,
    ) ?? []
  assert.ok(workspaces && workers, 'ci.yml bounds the workspaces and the workers of the test step')
  // ubuntu-latest of a public repository has four cores. Unbounded, turbo runs ten workspaces and
  // Vitest one worker less than the cores in each: tests that wait for a socket, a lock or a
  // child process missed their bounds by turns (28.10.2026, release of v1.10.0).
  assert.ok(Number(workspaces) * Number(workers) <= 4, `${workspaces} × ${workers} workers`)
})

test('the shards of the test job run every workspace with tests exactly once', () => {
  // Three shards name workspaces, the last one runs the rest: it excludes exactly what the others
  // name, so a new workspace lands in it without a line here.
  const shards = [...job('test').matchAll(/^ {10}- shard: (\S+)\n {12}filter: (.+)$/gm)].map(
    ([, shard, filter]) => ({
      shard,
      filters: [...filter.matchAll(/--filter=(\S+)/g)].map(([, name]) => name),
    }),
  )
  assert.ok(shards.length >= 2, 'ci.yml splits the tests into shards')
  const [rest, ...named] = [shards.at(-1), ...shards.slice(0, -1)]
  const included = named.flatMap(({ filters }) => filters)
  assert.ok(
    named.every(({ filters }) => filters.every((name) => !name.startsWith('!'))),
    'only the last shard excludes',
  )
  assert.equal(new Set(included).size, included.length, 'a workspace is in two shards')
  assert.deepEqual(
    rest.filters.toSorted(),
    included.map((name) => `!${name}`).toSorted(),
    'the last shard runs the workspaces the others do not name',
  )
  const names = new Map(
    workspaces.map((workspace) => [JSON.parse(read(`${workspace}/package.json`)).name, workspace]),
  )
  for (const name of included) {
    assert.ok(names.has(name), `the shard names ${name}, which is no workspace`)
    assert.ok(scripts(names.get(name)).test, `${name} has no test script`)
  }
  // The shards share the database steps of the job.
  for (const command of ['pnpm db:generate', 'pnpm db:deploy', 'pnpm db:seed'])
    assert.ok(job('test').includes(`run: ${command}`), `the test job lacks ${command}`)
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
  assert.ok(found['apps/core'] >= 3, 'the turn key, sweeper and pass suites exist')
  assert.ok(found['apps/llm'] >= 5, 'the gateway, pool, lock, login and retire suites exist')
  assert.ok(found['apps/mcp'] >= 2, 'the access and pages suites of the MCP gateway exist')
  assert.ok(found['apps/preview'] >= 1, 'the pages suite of the preview app exists')

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
  // (verify:runner, verify:snapshots): a source moved to another
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
  // The manual stands among them: the runner's core side and the snapshots.
  for (const stand of [
    'apps/core/scripts/verify-runner-core.mjs',
    'apps/core/scripts/verify-snapshots.mjs',
  ])
    assert.ok(
      [...loaded.keys()].some((where) => where.startsWith(`${stand}: `)),
      `${stand} was read`,
    )
  // Fewer since the stands of projects went (docs/plan/83-remove-projects.md).
  assert.ok(loaded.size >= 30, `only ${loaded.size} build modules of the stands were checked`)
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
  // No other workflow runs a rehearsal: the images and the build are those of its job.
  for (const { name, source } of workflows)
    if (name !== 'llm-gateway.yml')
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
  const oneByOne = ['RADITI_BROWSER_DOCKER_TESTS', 'RADITI_BROWSER_LOCAL_TESTS']
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
  assert.ok(checked >= 3, 'the suites are found')
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

test('images.yml checks every image of verify:images, one per job', async () => {
  const source = workflow('images')
  const { APPS } = await import(join(root, 'infra/app/verify-images.mjs'))
  assert.deepEqual(matrixOf(source).app, APPS)
  assert.match(
    source,
    /^ {8}run: node infra\/app\/verify-images\.mjs --only \$\{\{ matrix\.app \}\}$/m,
  )
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
  for (const variable of ['WEB_IMAGE', 'CORE_IMAGE', 'MIGRATE_IMAGE', 'LLM_IMAGE']) {
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
  // gates is skipped on a tree the pull request verified, and a skipped job skips the whole chain
  // after it unless the condition says !cancelled(): v1.28.2 shipped without images that way.
  assert.match(
    source,
    /^ {2}images:\n {4}needs: release\n {4}if: >-\n {6}!cancelled\(\) && needs\.release\.result == 'success' && needs\.release\.outputs\.tag != ''$/m,
  )
  assert.match(
    source,
    /^ {2}deploy:\n {4}needs: \[release, images\]\n {4}if: >-\n {6}!cancelled\(\) && needs\.images\.result == 'success' && needs\.release\.outputs\.tag != ''$/m,
  )
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
