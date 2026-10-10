// The contract of the agent-content stand with its workflow: what starts it, which images it
// pulls and what it runs. Text only: GitHub itself runs the workflow after the branch is pushed.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')
const workflow = read('.github/workflows/agent-content.yml')
// The path filter of the pull_request trigger; `**` crosses directories, `*` does not.
const filter = [
  ...(/^ {4}paths:\n((?: {6}(?:- .+|#.*)\n)+)/m.exec(workflow)?.[1] ?? '').matchAll(
    /^ {6}- (.+)$/gm,
  ),
].map(([, pattern]) => pattern)
const starts = (file) =>
  filter.some((pattern) =>
    new RegExp(
      `^${pattern
        .split('**')
        .map((part) => part.replace(/[.+^$(){}|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*'))
        .join('.*')}$`,
    ).test(file),
  )
const scripts = readdirSync(join(root, 'apps/orchestrator/scripts'))
  .filter((name) => /^verify-agent-content.*\.mjs$/.test(name) && !name.endsWith('.test.mjs'))
  .map((name) => `apps/orchestrator/scripts/${name}`)

test('the stand is one command over its own scripts', () => {
  assert.deepEqual(scripts.sort(), [
    // The turns of the live mode, and the trusted return they end with.
    'apps/orchestrator/scripts/verify-agent-content-live.mjs',
    'apps/orchestrator/scripts/verify-agent-content-role.mjs',
    'apps/orchestrator/scripts/verify-agent-content-turns.mjs',
    'apps/orchestrator/scripts/verify-agent-content-undo.mjs',
    'apps/orchestrator/scripts/verify-agent-content.mjs',
  ])
  // `exec`: a signal sent to the command reaches the stand itself, which then removes its
  // stacks — in a live run the OpenBao container that holds the plan key.
  assert.equal(
    JSON.parse(read('package.json')).scripts['verify:agent-content'],
    'exec node apps/orchestrator/scripts/verify-agent-content.mjs',
  )
  // The role mcp is no worker of the stand: the shared launcher starts core and llm only.
  assert.doesNotMatch(read('infra/dev/llm-verify/workers.mjs'), /^ {2}mcp:/m)
  // No real subscription, site, env-file or key file can be named: the options are those of
  // live.mjs (standMode), and the plan key of a live run comes from the environment alone.
  const main = read('apps/orchestrator/scripts/verify-agent-content.mjs')
  assert.match(main, /const mode = standMode\(process\.argv\.slice\(2\), \{ stand: 'content' \}\)/)
  assert.doesNotMatch(main, /process\.argv\.slice\(2\)(?!, \{ stand: 'content' \}\))/)
  assert.doesNotMatch(
    scripts.map(read).join('\n'),
    /--env-file|\.codex|auth\.json|key-file|readFile[^\n]*ZAI/,
  )
})

test('every CLI of the stand is a row of one table and runs only what its driver prepared', () => {
  const turns = read('apps/orchestrator/scripts/verify-agent-content-turns.mjs')
  const main = read('apps/orchestrator/scripts/verify-agent-content.mjs')
  const rows = [
    ...turns.matchAll(/^ {2}([a-z]+): \{\n {4}name: '([A-Za-z]+)',\n {4}driver: (\w+),/gm),
  ]
  assert.deepEqual(
    rows.map(([, id, name, driver]) => [id, name, driver]),
    [
      ['codex', 'Codex', 'createCodexDriver'],
      ['kimi', 'Kimi', 'createKimiDriver'],
      ['opencode', 'OpenCode', 'createOpencodeDriver'],
    ],
  )
  // What a CLI needs differently is data of its row: the turns do not branch on its name.
  assert.doesNotMatch(turns, /driver ===|=== '(?:codex|kimi|opencode)'/)
  assert.match(turns, /await cli\.runPrepared\(\{ \.\.\.files, argv, timeoutMs: TURN_MS \}\)/)
  // No configuration of a CLI is written by the stand: the files are the driver's prepare.
  assert.doesNotMatch(scripts.map(read).join('\n'), /opencode\.json|config\.toml|cliInvocation/)
  // Codex and Kimi through the stand's proxy, Z.ai without one: one way per role process, so
  // the one role llm is started anew for the row that needs the other way.
  assert.deepEqual(
    [...turns.matchAll(/^ {4}path: '([a-z]+)',$/gm)].map(([, path]) => path),
    ['proxy', 'proxy', 'direct'],
  )
  assert.match(main, /const paths = \{ proxy: env, direct: zaiDirectEnvironment\(env, stack\) \}/)
  assert.match(turns, /await rolePath\(row\.path\)/)
  assert.equal(main.match(/startWorker\('llm'/g).length, 1)
  // The plan key of Z.ai is imported by the operator command, and its windows are the probe's
  // to write: the issuer asks the role llm for one, as core does.
  assert.match(main, /await zaiLogin\(zaiOperator\(stack, env\.LLM_UPSTREAM_CA_FILE\), \{/)
  assert.match(main, /probeAccounts: createPoolProbeClient\(/)
  const setup = read('apps/orchestrator/scripts/verify-llm-zai-setup.mjs')
  assert.match(setup, /'--plan',\s+'lite',/)
  assert.doesNotMatch(setup, /limitWindows|limitsSeenAt/)
  // What both stands of OpenCode need is one module, not a copy in each.
  assert.match(
    read('apps/orchestrator/scripts/verify-llm-zai.mjs'),
    /\} from '\.\/verify-llm-zai-setup\.mjs'/,
  )
})

test('the edit turn reads what the write and its repeat were answered, not only their statuses', () => {
  const turns = read('apps/orchestrator/scripts/verify-agent-content-turns.mjs')
  const edit = turns.slice(turns.indexOf('// Turn A:'), turns.indexOf('// Turn B'))
  // The role refuses a call after admission with HTTP 200 as well, so three statuses of 200 do
  // not say that the repeat was replayed. What the CLI handed the model is judged against the
  // journal row before the stand says so, for every row of the table.
  assert.match(edit, /const outputs = row\.wire\.toolOutputs\(edited\.provider\.at\(-1\)\.body\)/)
  const judged = edit.indexOf('replayProblem(outputs, kept)')
  assert.ok(judged > 0, 'the answers of the edit turn are judged')
  assert.ok(edit.indexOf('the repeat was answered from that row') > judged)
  // The CLI that hands the model the text of the role is held to the stored answer word for
  // word, and only then is the line about the repeat printed.
  const verbatim = edit.indexOf('replayProblem(outputs, kept, { verbatim: true })')
  assert.ok(verbatim > judged, 'the repeat is compared word for word')
  assert.ok(edit.indexOf('got the stored answer word for word') > verbatim)
})

test('a repeated signal cannot end the cleanup and a silent role cannot pass the log check', () => {
  const main = read('apps/orchestrator/scripts/verify-agent-content.mjs')
  // With `once` no listener is left after the first signal: the second one (a CI cancellation
  // sends two) ends the process in the middle of its cleanup and both stacks stay behind.
  assert.match(main, /process\.on\('SIGINT', interrupt\)\nprocess\.on\('SIGTERM', interrupt\)/)
  assert.doesNotMatch(main, /process\.once\('SIG/)
  assert.match(main, /process\.removeListener\('SIGTERM', interrupt\)\n\}\n$/)
  // The secrecy check reads the role's own log: the regular role writes with its own logger and
  // the stand refuses an empty log.
  assert.match(main, /'The role mcp logged nothing'/)
})

test('the role mcp is the regular one: the entry point of the build under its own AppRole', () => {
  const main = read('apps/orchestrator/scripts/verify-agent-content.mjs')
  const role = read('apps/orchestrator/scripts/verify-agent-content-role.mjs')
  // The trusted return of the live mode is the one script that puts the role's module
  // together: the product has no network channel to the role's trusted side yet (N8).
  const undo = 'apps/orchestrator/scripts/verify-agent-content-undo.mjs'
  const all = scripts
    .filter((name) => name !== undo)
    .map(read)
    .join('\n')
  // Not a composition of the stand: no module of the role is put together by its scripts.
  assert.match(role, /entry = \['dist\/main\.js'\],/)
  assert.doesNotMatch(all, /McpAppModule|mountMcp|NestFactory|wrapResolver/)
  // That one script serves no MCP: an application context that listens on nothing, the
  // regular resolver, and one call — the return by the fence of the turn lease.
  const helper = read(undo)
  assert.match(helper, /NestFactory\.createApplicationContext\(\n\s+McpAppModule\.forRoot\(\{/)
  assert.doesNotMatch(helper, /mountMcp|wrapResolver|\.listen\(|wpRest|authenticate/)
  assert.match(
    helper,
    /app\.get\(MCP_CONTENT\)\.undoTurn\(\{ fence: request\.fence, turn: request\.turn \}\)/,
  )
  assert.match(helper, /VAULT_DEV_ROOT_TOKEN, undefined/)
  // Only the live turns start it, with the environment of the role mcp.
  assert.equal(main.match(/verify-agent-content-undo\.mjs/g).length, 1)
  assert.match(main, /live: live\n\s+\? liveContentTurns\(\{/)
  // load-env.ts opens the repository .env unless NODE_ENV is production; APP_ENV stays test,
  // because the content profile is refused in production.
  assert.match(role, /^ {4}NODE_ENV: 'production',$/m)
  assert.match(role, /^ {4}APP_ENV: 'test',$/m)
  assert.match(role, /^ {4}ORCHESTRATOR_ROLES: 'mcp',$/m)
  assert.match(role, /^ {4}MCP_CONTENT_PROFILE: 'local',$/m)
  assert.match(role, /^ {4}VAULT_ROLE_ID: vault\.roleId,$/m)
  // Nothing of the launcher's environment is inherited, and no operator token is named.
  assert.doesNotMatch(role, /\.\.\.process\.env|VAULT_DEV_ROOT_TOKEN|X-Vault-Token/)
  assert.match(main, /env: roleEnvironment\(\{/)
  // AppRole mcp with the policy mcp-content; the site access by the writer of the connection
  // step; the stand's own snapshot reader is not the operator either.
  const stack = read('infra/dev/llm-verify/stack.mjs')
  assert.match(stack, /\.\.\.\(content \? \[\['mcp', 'mcp-content'\]\] : \[\]\),/)
  assert.match(
    stack,
    /\.\.\.\(content \? \['sites-writer', 'workspace-provisioner', 'core-transit'\] : \[\]\),/,
  )
  assert.match(main, /vault: \{ address: stack\.vaultAddress, \.\.\.stack\.roles\.mcp \},/)
  for (const policy of ['sites-writer', 'workspace-provisioner', 'core-transit'])
    assert.ok(main.includes(`token: stack.tokens['${policy}']`), `${policy} is used by the stand`)
  // The operator token is named once: as a marker that must not appear in logs or storage.
  assert.deepEqual(main.match(/stack\.root\b[^\n]*/g), ['stack.root.token,'])
  assert.doesNotMatch(main, /stack\.request\(/)
  // The site access is where the product keeps it, and the role is given none of it.
  assert.match(main, /const path = siteAccessPath\(site\.siteId, 'wp'\)/)
  assert.match(
    main,
    /kind: 'wp', workspaceId, siteId: site\.siteId, vaultPath: path, keyVersion: version/,
  )
  assert.doesNotMatch(role, /applicationPassword|username/)
})

test('a failure inside the stand is not reported as a failure of the WordPress fixture', () => {
  // The fixture names its stage in its FAIL line; the scenario of a stand is a stage of its own.
  assert.match(
    read('infra/dev/site-verify/verify-site.mjs'),
    /if \(scenario\) \{\n {4}stage = 'scenario of the calling stand'\n {4}await scenario\(/,
  )
})

test('the workflow starts on every source the stand runs', () => {
  assert.ok(filter.length > 10, 'agent-content.yml has a path filter')
  // The scripts, the helpers they import by path and the plugin the stand installs.
  const sources = new Set([
    '.github/workflows/agent-content.yml',
    'infra/wordpress/raditi-content.php',
  ])
  const packages = new Set()
  const builds = new Set()
  // The stand's scripts and what they import from beside them: the Z.ai setup of the gateway
  // stand, shared by both.
  const beside = scripts.flatMap((script) =>
    [...read(script).matchAll(/'\.\/(verify-[a-z-]+\.mjs)'/g)].map(
      ([, name]) => `apps/orchestrator/scripts/${name}`,
    ),
  )
  assert.ok(beside.includes('apps/orchestrator/scripts/verify-llm-zai-setup.mjs'))
  for (const script of new Set([...scripts, ...beside])) {
    sources.add(script)
    const text = read(script)
    for (const [, path] of text.matchAll(/'(?:\.\.\/)+(infra\/[A-Za-z0-9/_.-]+)'/g))
      sources.add(path)
    for (const [, name] of text.matchAll(/'(?:@repo|(?:\.\.\/)+packages)\/([a-z-]+)[/']/g))
      packages.add(name)
    for (const [, directory] of text.matchAll(/'\.\.\/(?:dist|src)\/([a-z-]+)\//g))
      builds.add(directory)
  }
  for (const path of [
    'infra/dev/llm-verify/stack.mjs',
    'infra/dev/llm-verify/cli.mjs',
    'infra/dev/llm-verify/workers.mjs',
    'infra/dev/llm-verify/fake-subscriptions.mjs',
    'infra/dev/llm-verify/fake-zai.mjs',
    'infra/dev/site-verify/verify-site.mjs',
  ])
    assert.ok(sources.has(path), `the stand imports ${path}`)
  // What the shared stack itself mounts and runs: compose, the gateway, the egress proxy,
  // the Vault bootstrap and the PostgreSQL role script.
  for (const path of [
    'infra/dev/llm-verify/compose.yml',
    'infra/dev/site-verify/compose.yml',
    'infra/sandbox/gateway.mjs',
    'infra/sandbox/Dockerfile',
    'infra/egress/llm-egress.mjs',
    'infra/vault/bootstrap.mjs',
    'infra/app/postgres/init-roles.sh',
    'packages/db/prisma/migrations/x/migration.sql',
  ])
    sources.add(path)
  for (const source of sources) assert.ok(starts(source), `${source} does not start the workflow`)
  for (const name of ['agent-drivers', 'db', 'domain', 'llm-backends', 'storage', 'vault'])
    assert.ok(packages.has(name), `the stand imports @repo/${name}`)
  // What the regular role loads from the build besides those.
  packages.add('site-adapters').add('observability')
  for (const name of packages)
    assert.ok(starts(`packages/${name}/src/index.ts`), `packages/${name}/** does not start it`)
  for (const directory of ['mcp', 'llm', 'llm-gateway', 'subscriptions'])
    assert.ok(builds.has(directory), `the stand loads the orchestrator's ${directory}`)
  for (const directory of builds) assert.ok(starts(`apps/orchestrator/src/${directory}/index.ts`))
})

test('the workflow pulls exactly the images the WordPress fixture refuses to pull', () => {
  // verify-site.mjs checks its images and never pulls; the B13 stack's compose pulls its own.
  const site = read('infra/dev/site-verify/verify-site.mjs')
  const block = /^const images = \{\n((?:.*\n)*?)\}/m.exec(site)?.[1] ?? ''
  const pinned = [...block.matchAll(/'(\S+@sha256:[a-f0-9]{64})'/g)].map(([, image]) => image)
  assert.equal(pinned.length, 4)
  const pull = /^ {6}- name: Pull the pinned images\n {8}run: \|\n((?: {10}.*\n)+)/m.exec(workflow)
  assert.ok(pull, 'agent-content.yml pulls the pinned images')
  assert.match(pull[1], /docker pull --quiet "\$image"/)
  assert.deepEqual(
    [...pull[1].matchAll(/(\S+@sha256:[a-f0-9]{64})/g)].map(([, image]) => image).sort(),
    pinned.sort(),
  )
  assert.doesNotMatch(workflow, /wordpress:cli-/)
  assert.doesNotMatch(read('infra/dev/llm-verify/compose.yml'), /pull_policy: never/)
})

test('the workflow runs the stand on a native Linux engine without secrets', () => {
  const runs = [...workflow.matchAll(/^ {8}run: (.+)$/gm)]
    .map(([, command]) => command)
    .filter((command) => command !== '|')
  // The orchestrator build inside the stand needs the generated Prisma client.
  assert.deepEqual(runs, ['pnpm db:generate', 'pnpm verify:agent-content'])
  assert.match(workflow, /^ {4}runs-on: ubuntu-latest$/m)
  assert.match(workflow, /^permissions:\n {2}contents: read$/m)
  assert.doesNotMatch(workflow, /secrets\./)
  // There sandbox-gw reaches the host through the bridge. The role itself listens on loopback,
  // as outside production it always does; the stand's hop in front of it listens on the bridge
  // gateway address, not on every interface.
  assert.match(
    read('apps/orchestrator/scripts/verify-agent-content.mjs'),
    /listenHost: process\.platform === 'linux' \? await bridgeGateway\(\) : '127\.0\.0\.1',/,
  )
  assert.doesNotMatch(read('apps/orchestrator/scripts/verify-agent-content-role.mjs'), /0\.0\.0\.0/)
})
