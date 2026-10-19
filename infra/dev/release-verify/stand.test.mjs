// Contract of the pure parts of the release stand (pnpm test:infra): what its containers and its
// processes are given, the deploy runner and the loopback mirror its jobs see the host through,
// and the answers of the scripted model. Nothing here starts Docker or a process.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeZaiState } from '../llm-verify/fake-zai.mjs'
import { roundOf } from './fake-model.mjs'
import {
  BUILT_IMAGES,
  DIGEST_REFERENCE,
  LARGE_USAGE,
  NODE_ERRNO_PROBE,
  PHP_ERRNO_PROBE,
  STAND_RATES,
  STYLE_PATH,
  FOOTER_PATH,
  GITEA_IMAGE,
  HOSTING_IMAGE,
  MARIADB_IMAGE,
  MIRROR_SCRIPT,
  MODEL_TURNS,
  NOTICE_PATH,
  OPENBAO_IMAGE,
  POSTGRES_IMAGE,
  PULLED_TAGS,
  REDIS_IMAGE,
  RUNNER_IMAGE,
  S3_IMAGE,
  TEXT,
  WORDPRESS_IMAGE,
  WPCLI_IMAGE,
  expectedCharge,
  isolatedAnswer,
  localDigestReference,
  mirrorArgs,
  roleEnvironment,
  runnerArgs,
  runnerConfig,
  s3Args,
  undoTrap,
  undoTrapPath,
  siteWebEnvFile,
  standNames,
  standOptions,
  standRatesFile,
  summaryTable,
  themeFiles,
  versionAbove,
  webEnvironment,
} from './stand.mjs'

const names = standNames('0123abcd')
const digest = `raditi-release-verify/orchestrator@sha256:${'a'.repeat(64)}`
const ports = {
  gitea: 40001,
  vault: 40002,
  s3: 40003,
  site: 40004,
  ssh: 40005,
  web: 40006,
  core: 40007,
  mcp: 40008,
  llm: 40009,
  preview: 40010,
  releaseApi: 40011,
  zai: 40012,
}
const context = {
  path: '/usr/bin',
  directory: '/tmp/raditi-release-verify-run',
  ports,
  databaseUrl: 'postgresql://raditi:synthetic@127.0.0.1:5432/raditi',
  redisUrl: 'redis://default:synthetic@127.0.0.1:6379',
  vault: { address: 'http://127.0.0.1:40002' },
  roles: Object.fromEntries(
    ['core', 'mcp', 'llm', 'web'].map((role) => [
      role,
      { roleId: `${role}-id`, secretId: `${role}-secret` },
    ]),
  ),
  s3: {
    endpoint: 'http://127.0.0.1:40003',
    accessKey: 'synthetic-key',
    secretKey: 'synthetic-secret',
  },
  secrets: {
    metrics: 'm'.repeat(48),
    auth: 'a'.repeat(48),
    previewSession: 'p'.repeat(48),
    botToken: 'b'.repeat(40),
  },
  caFile: '/tmp/raditi-release-verify-run/ca.pem',
  socket: '/var/run/docker.sock',
  images: Object.fromEntries(
    Object.keys(BUILT_IMAGES).map((name) => [
      name,
      `raditi-release-verify/${name}@sha256:${'b'.repeat(64)}`,
    ]),
  ),
}

test('the stand takes --no-build and --keep only: never a database, a Gitea or a key', () => {
  assert.deepEqual(standOptions([]), { build: true, keep: false })
  assert.deepEqual(standOptions(['--', '--no-build', '--keep']), { build: false, keep: true })
  for (const argv of [['--live'], ['--database=postgresql://x'], ['--only=S1']])
    assert.throws(() => standOptions(argv), /accepts --no-build and --keep only/)
})

test('every resource of a run is named by the run and labelled with it', () => {
  assert.equal(names.label, 'io.raditi.release-verify=0123abcd')
  for (const name of [
    ...Object.values(names.containers),
    names.network,
    ...Object.values(names.volumes),
  ])
    assert.match(name, /^raditi-release-verify-0123abcd-/)
  assert.throws(() => standNames('nope'), /Invalid run id/)
})

test('every image is named by digest, and the built ones under names of the stand', () => {
  for (const image of [
    POSTGRES_IMAGE,
    REDIS_IMAGE,
    S3_IMAGE,
    OPENBAO_IMAGE,
    GITEA_IMAGE,
    RUNNER_IMAGE,
    HOSTING_IMAGE,
  ])
    assert.match(image, /@sha256:[a-f0-9]{64}$/)
  for (const image of [WORDPRESS_IMAGE, MARIADB_IMAGE, WPCLI_IMAGE])
    assert.match(image, DIGEST_REFERENCE)
  for (const image of [WORDPRESS_IMAGE, MARIADB_IMAGE, WPCLI_IMAGE, S3_IMAGE])
    assert.ok(PULLED_TAGS[image])
  for (const image of Object.values(BUILT_IMAGES))
    assert.match(image.tag, /^raditi-release-verify\/[a-z-]+:local$/)
  assert.equal(
    localDigestReference(
      'raditi-release-verify/gateway:local',
      JSON.stringify([`raditi-release-verify/gateway@sha256:${'c'.repeat(64)}`]),
    ),
    `raditi-release-verify/gateway@sha256:${'c'.repeat(64)}`,
  )
  assert.throws(
    () => localDigestReference('raditi-release-verify/gateway:local', '[]'),
    /containerd image store/,
  )
  // The context of the preview images is their own folder (infra/preview/Dockerfile).
  assert.equal(BUILT_IMAGES.tools.context, 'infra/preview')
  assert.equal(BUILT_IMAGES.browser.context, 'infra/preview')
})

test('deploy jobs run on the network of the Docker VM, with no socket, no privileges and the CA only', () => {
  const config = runnerConfig({ names, ports })
  assert.match(config, /^ {2}network: host$/m)
  assert.match(config, /^ {2}docker_host: '-'$/m)
  assert.match(config, /^ {2}privileged: false$/m)
  assert.match(config, /^ {4}RADITI_VAULT_ADDR: http:\/\/127\.0\.0\.1:40002$/m)
  assert.match(config, /^ {4}RADITI_RELEASE_API_URL: http:\/\/127\.0\.0\.1:40011$/m)
  assert.match(config, /^ {4}- raditi-release-verify-0123abcd-ca$/m)
  assert.doesNotMatch(config, /docker\.sock/)
  const runner = runnerArgs({ names, ports, deployImage: digest, socket: '/var/run/docker.sock' })
  assert.ok(runner.includes(`GITEA_RUNNER_LABELS=deploy:docker://${digest}`))
  assert.throws(
    () => runnerArgs({ names, ports, deployImage: 'orchestrator:latest', socket: '/x' }),
    /deploy image/,
  )
})

test('the mirror forwards the ports it is given from the loopback of the Docker VM to the Mac', () => {
  const args = mirrorArgs({ names, image: digest, ports: [40011] })
  for (const flag of ['--network', '--read-only', '--cap-drop', '--add-host'])
    assert.ok(args.includes(flag))
  assert.ok(args.includes('MIRROR_PORTS=[40011]'))
  assert.match(MIRROR_SCRIPT, /host\.docker\.internal/)
  assert.match(MIRROR_SCRIPT, /'127\.0\.0\.1'/)
  assert.throws(() => mirrorArgs({ names, image: digest, ports: [80] }), /Invalid port/)
})

test('S3 holds the buckets of the platform on small volumes', () => {
  const args = s3Args({ names, port: 40003 })
  assert.ok(args.includes('-master.volumeSizeLimitMB=64'))
  assert.ok(args.includes('127.0.0.1:40003:8333'))
})

test('each process of the platform is its own role with its own AppRole, and never reads a .env', () => {
  const roles = ['llm', 'mcp', 'preview', 'core'].map((role) => [
    role,
    roleEnvironment(role, context),
  ])
  for (const [role, env] of roles) {
    assert.equal(env.NODE_ENV, 'production', `${role} would look for a .env`)
    assert.equal(env.APP_ENV, 'test')
    assert.equal(env.ORCHESTRATOR_ROLES, role)
    assert.equal(env.ZAI_API_KEY, undefined)
    assert.equal(env.VAULT_DEV_ROOT_TOKEN, undefined)
    if (env.VAULT_ROLE_ID) assert.equal(env.VAULT_ROLE_ID, `${role}-id`)
  }
  const [, mcp] = roles.find(([role]) => role === 'mcp')
  assert.equal(mcp.MCP_CONTENT_PROFILE, 'local')
  assert.equal(mcp.MCP_BROWSER_PROFILE, 'local')
  assert.equal(mcp.PREVIEW_BASE_DOMAIN, 'localhost')
  const [, core] = roles.find(([role]) => role === 'core')
  assert.equal(core.TURN_EXECUTOR, 'local')
  assert.equal(core.SANDBOX_RUNTIME, 'runc')
  assert.equal(core.PREVIEW_EXECUTOR, 'local')
  for (const name of [
    'SANDBOX_IMAGE',
    'SANDBOX_GATEWAY_IMAGE',
    'SANDBOX_NETWORK_GUARD_IMAGE',
    'PREVIEW_FORWARDER_IMAGE',
    'PREVIEW_BROWSER_IMAGE',
    'PREVIEW_EGRESS_IMAGE',
  ])
    assert.match(core[name], DIGEST_REFERENCE)
  assert.equal(core.RELEASE_API_PUBLIC_URL, 'http://127.0.0.1:40011')
  const [, llm] = roles.find(([role]) => role === 'llm')
  assert.equal(llm.LLM_BACKEND_URL_ZAI_CODING, 'https://localhost:40012')
  const web = webEnvironment(context)
  assert.equal(web.NODE_ENV, 'production')
  assert.equal(web.APP_URL, 'http://127.0.0.1:40006')
  assert.equal(web.VAULT_ROLE_ID, 'web-id')
  assert.equal(web.PREVIEW_PUBLIC_PORT, String(ports.preview))
})

test('the production site is a local WordPress without cron, whose application passwords work over http', () => {
  const env = siteWebEnvFile('synthetic-password')
  assert.match(env, /DISABLE_WP_CRON/)
  assert.match(env, /WP_ENVIRONMENT_TYPE', 'local'/)
  const files = themeFiles()
  assert.match(files[FOOTER_PATH], new RegExp(TEXT.footer(0)))
  assert.match(files[FOOTER_PATH], /get_template_part\( 'notice' \)/)
  assert.equal(files[NOTICE_PATH], undefined)
})

test('the scripted turns call tools the CLI declares and end with a result of the contract', () => {
  const turns = [
    MODEL_TURNS.first({ contactsId: 4 }),
    MODEL_TURNS.clarification(),
    MODEL_TURNS.breaking({ postId: 5 }),
    MODEL_TURNS.conflicting({ contactsId: 4 }),
    MODEL_TURNS.stale(),
    MODEL_TURNS.footerConflict(),
    MODEL_TURNS.question(),
    MODEL_TURNS.allKinds({ postId: 5 }),
    MODEL_TURNS.team(),
    MODEL_TURNS.breakingDb(),
    MODEL_TURNS.retryBase(),
    MODEL_TURNS.retryKilled(),
    MODEL_TURNS.retryDone(),
  ]
  const state = createFakeZaiState({})
  for (const turn of turns) {
    // The synthetic Z.ai takes each as a scenario.
    state.setScenario(turn)
    for (const round of turn.rounds ?? [])
      for (const call of round) assert.match(call.name, /^(bash|raditi_[a-z_]+)$/)
    const result = JSON.parse(turn.text)
    assert.deepEqual(Object.keys(result).sort(), [
      'change_type',
      'client_message',
      'files_changed',
      'needs_approval',
      'questions',
      'risk',
      'summary',
    ])
  }
  // The change S5 releases breaks only where the preview's constant is not defined, and its
  // turn starts the browser of its dialog (S6a attacks the neighbour from it).
  const breaking = MODEL_TURNS.breaking({ postId: 5 })
  assert.match(JSON.stringify(breaking), /RADITI_PREVIEW_ORIGIN/)
  assert.equal(breaking.rounds.at(-1)[0].name, 'raditi_browser_navigate')
  // S3: open the page, edit the footer, check it at once.
  assert.deepEqual(
    MODEL_TURNS.clarification().rounds.map((round) => round[0].name),
    ['raditi_browser_navigate', 'bash', 'raditi_browser_run_checks'],
  )
  // S6a: the call before the preview is ready, the same call again, the write.
  assert.deepEqual(
    MODEL_TURNS.conflicting({ contactsId: 4 }).rounds.map((round) => round[0].arguments.method),
    ['GET', 'GET', 'POST'],
  )
  assert.match(MODEL_TURNS.stale().rounds[0][0].arguments.command, new RegExp(STYLE_PATH))
  // S8a: a table, a new page, a setting and a text, in the tools of the platform alone.
  assert.deepEqual(
    MODEL_TURNS.allKinds({ postId: 5 }).rounds.map((round) => [
      round[0].name,
      round[0].arguments.route ?? round[0].arguments.table,
    ]),
    [
      ['raditi_db_schema', 'bookings'],
      ['raditi_wp_rest', '/wp/v2/pages'],
      ['raditi_wp_rest', '/wp/v2/settings'],
      ['raditi_wp_rest', '/wp/v2/posts/5'],
      ['raditi_wp_rest', '/wp/v2/posts/5'],
    ],
  )
  // S8c breaks production only, as S5 does.
  assert.match(JSON.stringify(MODEL_TURNS.breakingDb()), /RADITI_PREVIEW_ORIGIN/)
  // S10: the retry changes the mark the first pass of dialog J left, in the style of the theme.
  assert.match(MODEL_TURNS.retryBase().rounds[0][0].arguments.command, new RegExp(STYLE_PATH))
  assert.match(
    MODEL_TURNS.retryDone().rounds[0][0].arguments.command,
    new RegExp(`${TEXT.retryMark(1)}/${TEXT.retryMark(2)}`),
  )
  // The large usage of the first turn stays far from the compaction of the CLI.
  assert.deepEqual(MODEL_TURNS.first({ contactsId: 4 }).usage, LARGE_USAGE)
  assert.ok(LARGE_USAGE.prompt + LARGE_USAGE.completion <= 500_000)
})

test('the round of a request is the tool steps since the last words of the user', () => {
  const step = { role: 'assistant', tool_calls: [{ id: 'a' }] }
  const answer = { role: 'tool', content: 'CONTENT_PREVIEW_NOT_READY' }
  assert.equal(roundOf({ messages: [{ role: 'user', content: 'x' }] }), 0)
  assert.equal(roundOf({ messages: [{ role: 'user' }, step, answer] }), 1)
  assert.equal(roundOf({ messages: [step, answer, { role: 'user' }, step, answer, step] }), 2)
  assert.equal(roundOf(null), 0)
})

test('a probe counts a target isolated only when the packet found no way to it', () => {
  for (const seen of [
    'closed:101:Network is unreachable',
    'closed:113:No route to host',
    'closed:110:Connection timed out',
    'closed:0:Connection timed out',
    'closed:ENETUNREACH',
    'closed:EHOSTUNREACH',
    'closed:ETIMEDOUT',
  ])
    assert.equal(isolatedAnswer(seen), true, seen)
  // A refusal reached a host; a name that did not resolve says nothing of an address.
  for (const seen of [
    'open',
    'closed:111:Connection refused',
    'closed:ECONNREFUSED',
    'dns',
    'error: x',
  ])
    assert.equal(isolatedAnswer(seen), false, seen)
  assert.equal(isolatedAnswer('dns', { name: true }), true)
  assert.equal(isolatedAnswer('closed:ETIMEDOUT', { name: true }), false)
  // Both probes print the errno of a failed connection.
  assert.match(PHP_ERRNO_PROBE, /"closed:" \. \$code/)
  assert.match(NODE_ERRNO_PROBE, /'closed:' \+ error\.code/)
})

test('the charge the stand expects is the usage at its rates, rounded once, between 5 and the reserve', () => {
  const call = (input, cached, output) => ({
    inputUncachedTokens: input,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: output,
  })
  // 393 216 input, 6 784 cached, 100 000 output: 3.93216 + 0.006784 + 3 = 6.938944 ₽ a call.
  const large = call(393_216, 6_784, 100_000)
  const six = expectedCharge(
    Array.from({ length: 6 }, () => large),
    45,
  )
  assert.equal(six.credits, 7)
  assert.ok(Math.abs(six.costRub - 41.633664) < 1e-9)
  assert.equal(expectedCharge([call(100, 0, 10)], 45).credits, 5)
  assert.equal(
    expectedCharge(
      Array.from({ length: 60 }, () => large),
      45,
    ).credits,
    45,
  )
  assert.equal(STAND_RATES.cacheWritePer1m, null)
})

test('billing:rates gets the rate of the profile and the provisional credit rate in one file', () => {
  const file = standRatesFile()
  assert.equal(file.rubPerCredit, '6.00')
  assert.deepEqual(
    file.prices.map((price) => [price.provider, price.model, price.inputPer1m, price.vatRate]),
    [
      ['zai-coding', 'glm-5.3-standard', '10.000000', '0.2200'],
      // «Попробовать ещё» runs in the heavy class (S10).
      ['zai-coding', 'glm-5.3-heavy', '10.000000', '0.2200'],
    ],
  )
})

test('a version is above another by its numbers, not by its text', () => {
  assert.equal(versionAbove('v0.10.0', 'v0.9.9'), true)
  assert.equal(versionAbove('v0.1.1', 'v0.1.1'), false)
  assert.equal(versionAbove('v0.1.0', 'v0.1.1'), false)
})

test('the final table has a row per scenario, with its NOTE lines apart from its checks', () => {
  assert.equal(
    summaryTable([{ id: 'S1', title: 'chat', checks: 3, ok: true }]),
    '| Сценарий | Проверок | Итог |\n| --- | --- | --- |\n| S1 chat | 3 | PASS |',
  )
  assert.match(
    summaryTable([{ id: 'S2', title: 'preview', checks: 30, notes: 2, ok: true }]),
    /\| S2 preview \| 30 \(NOTE: 2\) \| PASS \|$/,
  )
})

test('the trap of the undo scenarios breaks the pages of the theme, never the routes of the plugin', () => {
  const trap = undoTrap('Цветы у дома — «Ромашка»')
  assert.match(undoTrapPath('a'), /^wp-content\/mu-plugins\/[a-z-]+\.php$/)
  assert.notEqual(undoTrapPath('a'), undoTrapPath('b'))
  assert.ok(trap.startsWith("<?php\nadd_action( 'wp_footer', function () {"))
  assert.ok(trap.includes(`=== "Цветы у дома — «Ромашка»"`))
  assert.ok(trap.includes('raditi_release_verify_missing();'))
})
