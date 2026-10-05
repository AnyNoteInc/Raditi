import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// The fixture module of the webhook tests (Node strips the types).
import { giteaWebhooksRecorded } from '../../../packages/git-providers/src/testing/gitea-webhooks-recorded.ts'
import { GITEA_IMAGE as TURN_GIT_STAND_GITEA } from '../gitea-verify/stand.mjs'
import {
  GITEA_IMAGE,
  JOB_IMAGE,
  OPENBAO_IMAGE,
  RUNNER_IMAGE,
  REPOSITORY_WORKFLOWS_OFF,
  SAMPLE_NAMES,
  VAULT_INSIDE,
  certificateConfigs,
  giteaContainerArgs,
  helperContainerArgs,
  openbaoContainerArgs,
  parseProbe,
  runnerConfig,
  runnerContainerArgs,
  samplesModule,
  sanitizeWebhookBody,
  scopedRequiredForm,
  standNames,
  standOptions,
} from './stand.mjs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const names = standNames('0123abcd')
const values = (args, flag) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []))
const environment = (args) =>
  Object.fromEntries(values(args, '-e').map((pair) => pair.split(/=(.*)/s).slice(0, 2)))

test('every image is pinned by digest and never pulled', () => {
  assert.equal(GITEA_IMAGE, TURN_GIT_STAND_GITEA)
  assert.match(RUNNER_IMAGE, /^gitea\/runner:4\.0\.0@sha256:[a-f0-9]{64}$/)
  assert.match(OPENBAO_IMAGE, /^ghcr\.io\/openbao\/openbao:2\.7\.0@sha256:[a-f0-9]{64}$/)
  assert.match(JOB_IMAGE, /^alpine:3\.22@sha256:[a-f0-9]{64}$/)
  // The runner of the dev infrastructure is the same release.
  assert.match(read('../docker-compose.yml'), /image: gitea\/runner:4\.0\.0\n/)
  for (const args of [
    giteaContainerArgs({ names, port: 43210 }),
    giteaContainerArgs({ names, port: 43211, repositoryWorkflows: false }),
    openbaoContainerArgs({ names }),
    runnerContainerArgs({ names, kind: 'check' }),
    runnerContainerArgs({ names, kind: 'deploy' }),
    helperContainerArgs({ names }),
  ]) {
    assert.deepEqual(args.slice(0, 3), ['create', '--pull', 'never'])
    assert.deepEqual(values(args, '--label'), ['raditi.stand=raditi-pipeline-verify-0123abcd'])
  }
})

test('names belong to one run and nothing of the dev infrastructure can be named', () => {
  assert.equal(names.label, 'raditi.stand=raditi-pipeline-verify-0123abcd')
  for (const name of Object.values(names.containers))
    assert.match(name, /^raditi-pipeline-verify-0123abcd-[a-z-]+$/)
  for (const name of [...Object.values(names.networks), names.siteVolume])
    assert.match(name, /^raditi-pipeline-verify-0123abcd-[a-z]+$/)
  assert.equal(new Set(Object.values(names.containers)).size, 6)
  for (const id of ['', 'dev', '0123ABCD', '0123abcd0', '../x', 'raditi-dev'])
    assert.throws(() => standNames(id), /run id/)
})

test('Gitea: HTTPS with the stand certificate, loopback only, Actions on, no host mounts', () => {
  const args = giteaContainerArgs({ names, port: 43210 })
  assert.deepEqual(values(args, '--name'), [names.containers.gitea])
  assert.deepEqual(values(args, '-p'), ['127.0.0.1:43210:3000'])
  assert.deepEqual(values(args, '--network'), [names.networks.check])
  assert.deepEqual(values(args, '--network-alias'), ['gitea'])
  assert.deepEqual(values(args, '-v'), [])
  assert.deepEqual(values(args, '--volume'), [])
  assert.equal(args.at(-1), GITEA_IMAGE)
  const env = environment(args)
  assert.equal(env.GITEA__server__PROTOCOL, 'https')
  // Runners and job containers reach it by the network alias; the host by the loopback port.
  assert.equal(env.GITEA__server__ROOT_URL, 'https://gitea:3000/')
  assert.equal(env.GITEA__actions__ENABLED, 'true')
  assert.equal(env.GITEA__actions__DEFAULT_ACTIONS_URL, 'self')
  assert.equal(env.GITEA__service__DISABLE_REGISTRATION, 'true')
  assert.equal(env.GITEA__server__START_SSH_SERVER, 'false')
  // The webhook receiver is the stand process on the host: a private address, nothing else.
  assert.equal(env.GITEA__webhook__ALLOWED_HOST_LIST, 'private')
  // The default instance keeps the default workflow directories: that is what is measured.
  assert.ok(!('GITEA__actions__WORKFLOW_DIRS' in env))
})

test('the second Gitea differs by one setting: repository workflow files are not read', () => {
  const args = giteaContainerArgs({ names, port: 43211, repositoryWorkflows: false })
  assert.deepEqual(values(args, '--name'), [names.containers.giteaHardened])
  assert.deepEqual(values(args, '--network-alias'), ['gitea-hardened'])
  const env = environment(args)
  // A path below .git cannot be committed, so no repository can supply a workflow file.
  assert.equal(REPOSITORY_WORKFLOWS_OFF, '.git/raditi-no-repository-workflows')
  assert.equal(env.GITEA__actions__WORKFLOW_DIRS, REPOSITORY_WORKFLOWS_OFF)
  const plain = environment(giteaContainerArgs({ names, port: 43211 }))
  delete env.GITEA__actions__WORKFLOW_DIRS
  delete env.GITEA__server__ROOT_URL
  delete plain.GITEA__server__ROOT_URL
  assert.deepEqual(env, plain)
})

test('a port outside the unprivileged range is refused', () => {
  for (const port of [0, 80, 65536, '43210', 1.5])
    assert.throws(() => giteaContainerArgs({ names, port }), /port/)
})

test('OpenBao is on the deploy network only and its root values never reach arguments', () => {
  const args = openbaoContainerArgs({ names })
  assert.deepEqual(values(args, '--network'), [names.networks.deploy])
  assert.deepEqual(values(args, '--network-alias'), ['openbao'])
  assert.deepEqual(values(args, '-p'), ['127.0.0.1::8200'])
  assert.deepEqual(values(args, '-e'), [])
  assert.ok(!args.join(' ').includes('-dev'))
  assert.match(args.at(-1), /exec bao server -config=/)
})

test('a runner keeps the hardening of infra/dev/runner.yaml and adds only the stand’s own', () => {
  const dev = read('../runner.yaml')
  for (const kind of ['check', 'deploy']) {
    const config = runnerConfig({ names, kind })
    // The three lines that keep a job away from the Docker socket and from host paths.
    for (const line of ["  docker_host: '-'", '  privileged: false']) {
      assert.ok(dev.includes(`${line}\n`), `infra/dev/runner.yaml lost: ${line}`)
      assert.ok(config.includes(`${line}\n`), `the stand lost: ${line}`)
    }
    assert.match(config, /\n {2}force_pull: false\n/)
    assert.match(config, new RegExp(`\\n {2}network: ${names.networks[kind]}\\n`))
    // Every job container carries the label of the run, so the cleanup finds it.
    assert.match(config, /options: .*--label raditi\.stand=raditi-pipeline-verify-0123abcd/)
  }
  // A check job gets no volume at all; a deploy job gets the site volume and nothing else.
  assert.match(runnerConfig({ names, kind: 'check' }), /\n {2}valid_volumes: \[\]\n/)
  assert.ok(!runnerConfig({ names, kind: 'check' }).includes(names.siteVolume))
  const deploy = runnerConfig({ names, kind: 'deploy' })
  assert.match(deploy, new RegExp(`--volume ${names.siteVolume}:/site`))
  assert.match(deploy, new RegExp(`valid_volumes:\\n {4}- ${names.siteVolume}\\n`))
  assert.throws(() => runnerConfig({ names, kind: 'host' }), /runner kind/)
})

test('a runner container: its own network, one label, the socket for the runner only', () => {
  for (const kind of ['check', 'deploy']) {
    const args = runnerContainerArgs({ names, kind })
    assert.deepEqual(values(args, '--network'), [names.networks[kind]])
    assert.deepEqual(values(args, '-v'), ['/var/run/docker.sock:/var/run/docker.sock'])
    assert.deepEqual(values(args, '-p'), [])
    const env = environment(args)
    assert.equal(env.GITEA_INSTANCE_URL, 'https://gitea:3000')
    assert.equal(env.GITEA_RUNNER_LABELS, `${kind}:docker://${JOB_IMAGE}`)
    assert.equal(env.CONFIG_FILE, '/config/runner.yaml')
    // The registration token is a file copied into the container, not an argument.
    assert.equal(env.GITEA_RUNNER_REGISTRATION_TOKEN_FILE, '/config/registration-token')
    assert.ok(!('GITEA_RUNNER_REGISTRATION_TOKEN' in env))
    // The runner trusts the stand's CA; certificate verification is never switched off.
    assert.equal(env.SSL_CERT_FILE, '/config/ca.pem')
    assert.equal(args.at(-1), RUNNER_IMAGE)
    assert.ok(!args.includes('--privileged'))
  }
})

test('the server certificate covers the loopback address and the network alias', () => {
  const { authority, server } = certificateConfigs()
  assert.match(authority, /basicConstraints = critical, CA:true/)
  assert.match(server, /extendedKeyUsage = serverAuth/)
  assert.match(
    server,
    /subjectAltName = IP:127\.0\.0\.1, DNS:localhost, DNS:gitea, DNS:gitea-hardened/,
  )
})

test('the form that marks scoped workflows as required', () => {
  const form = scopedRequiredForm({
    repositoryId: 7,
    files: ['check.yml', 'deploy.yml', 'probe.yml'],
    required: { 'check.yml': 'platform/ci: check / *', 'deploy.yml': 'platform/ci: check / *' },
  })
  const params = new URLSearchParams(form)
  assert.equal(params.get('repo_id'), '7')
  assert.deepEqual(params.getAll('workflow_ids'), ['check.yml', 'deploy.yml', 'probe.yml'])
  assert.deepEqual(params.getAll('required_workflow_ids'), ['check.yml', 'deploy.yml'])
  assert.equal(params.get('required_patterns[check.yml]'), 'platform/ci: check / *')
  assert.equal(params.get('required_patterns[probe.yml]'), null)
  assert.throws(
    () => scopedRequiredForm({ repositoryId: 7, files: ['a.yml'], required: { 'b.yml': 'x' } }),
    /not a file of the source/,
  )
})

test('probe lines are read from a job log, timestamps and other lines are dropped', () => {
  const log = [
    '2026-10-04T09:50:01.1234567Z probe.check.uid=0',
    '2026-10-04T09:50:01.1234567Z ::group::Run p() { echo "probe.$KIND.$1=$2"; }',
    '2026-10-04T09:50:01.1234567Z probe.check.token_own_repo=200',
    'probe.deploy.site_volume=mounted',
    '2026-10-04T09:50:01.1234567Z probe.deploy.cap_eff=00000000a80425fb',
    '2026-10-04T09:50:01.1234567Z probe.deploy.empty=',
    '',
  ].join('\n')
  assert.deepEqual(parseProbe(log), {
    check: { uid: '0', token_own_repo: '200' },
    deploy: { site_volume: 'mounted', cap_eff: '00000000a80425fb', empty: '' },
  })
})

test('a recorded webhook body loses the addresses of the stand and keeps everything else', () => {
  const raw = [
    '{',
    '  "html_url": "https://gitea:3000/sites/demo/actions/runs/3",',
    '  "avatar_url": "https://127.0.0.1:43210/avatars/abc",',
    '  "clone_url": "https://gitea-hardened:3000/sites/demo.git",',
    '  "email": "2+raditi-bot@noreply.gitea",',
    '  "head_sha": "3f786850e387550fdab836ed7e6dc881de23001b"',
    '}',
  ].join('\n')
  const clean = sanitizeWebhookBody(raw, { port: 43210, forbidden: ['wrap-token-value'] })
  assert.equal(
    clean,
    [
      '{',
      '  "html_url": "https://gitea.example.test/sites/demo/actions/runs/3",',
      '  "avatar_url": "https://gitea.example.test/avatars/abc",',
      '  "clone_url": "https://gitea.example.test/sites/demo.git",',
      '  "email": "2+raditi-bot@noreply.gitea.example.test",',
      '  "head_sha": "3f786850e387550fdab836ed7e6dc881de23001b"',
      '}',
    ].join('\n'),
  )
})

test('a body with a secret, a host name or a home path is refused, not cleaned', () => {
  const body = (text) => JSON.stringify({ note: text })
  const options = { port: 43210, forbidden: ['wrap-token-value', 'workstation.local'] }
  assert.throws(() => sanitizeWebhookBody(body('x wrap-token-value y'), options), /forbidden/)
  assert.throws(() => sanitizeWebhookBody(body('ssh workstation.local'), options), /forbidden/)
  assert.throws(() => sanitizeWebhookBody(body('/Users/someone/site'), options), /home path/)
  assert.throws(() => sanitizeWebhookBody(body('/home/someone/site'), options), /home path/)
  // An address of the stand that the rules above did not replace.
  assert.throws(() => sanitizeWebhookBody(body('http://127.0.0.1:9/x'), options), /address/)
  assert.throws(() => sanitizeWebhookBody(body('http://host.docker.internal/'), options), /address/)
  // Any other literal address: a container, the gateway of a Docker network, the host.
  assert.throws(() => sanitizeWebhookBody(body('http://192.168.65.254:8080/'), options), /address/)
  assert.throws(() => sanitizeWebhookBody(body('runner at 172.18.0.3'), options), /address/)
  // A version is not an address.
  assert.equal(sanitizeWebhookBody(body('gitea 1.27.3'), options), body('gitea 1.27.3'))
  // An empty forbidden value would match everything: refuse the call itself.
  assert.throws(() => sanitizeWebhookBody(body('x'), { port: 43210, forbidden: [''] }), /empty/)
})

test('the stand takes one option: where to write sanitised samples', () => {
  assert.deepEqual(standOptions([]), { record: null })
  assert.deepEqual(standOptions(['--']), { record: null })
  assert.deepEqual(standOptions(['--record=/tmp/samples']), { record: '/tmp/samples' })
  for (const argv of [
    ['--record=relative/dir'],
    ['--record='],
    ['--url=https://gitea.example.test'],
    ['--token', 'x'],
    ['--keep'],
    ['--record=/a', '--record=/b'],
  ])
    assert.throws(() => standOptions(argv), /Usage/)
})

test('a repeated signal cannot end the cleanup', () => {
  const stand = read('./verify-pipeline.mjs')
  assert.match(stand, /process\.on\('SIGINT', interrupt\)\n {2}process\.on\('SIGTERM', interrupt\)/)
  assert.doesNotMatch(stand, /process\.once\('SIG/)
  // Removed only after every resource of the run is gone.
  assert.match(
    stand,
    /passed\('temporary directory of the stand removed'\)[\s\S]*process\.removeListener\('SIGTERM', interrupt\)/,
  )
})

test('the cleanup stops the runners first and sweeps what their jobs created', () => {
  const stand = read('./verify-pipeline.mjs')
  const cleanup = stand.slice(stand.indexOf('async function cleanup('))
  const order = [
    'names.containers.runnerCheck',
    'filters.push(`network=',
    '`label=com.gitea.runner.uuid=',
    "'network', 'rm'",
  ].map((text) => cleanup.indexOf(text))
  assert.ok(
    order.every((at) => at > 0),
    'a cleanup step is missing',
  )
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    'cleanup steps are out of order',
  )
})

test('a signal to pnpm reaches the stand: its script line replaces the shell', () => {
  const { scripts } = JSON.parse(read('../../../package.json'))
  assert.equal(
    scripts['verify:pipeline'],
    'exec node infra/dev/pipeline-verify/verify-pipeline.mjs',
  )
})

test('the product workflows: the guard, the token permissions and no network fetch', () => {
  for (const file of ['check.yml', 'deploy.yml']) {
    const workflow = read(`../../../ci/.gitea/scoped_workflows/${file}`)
    // An instance-level source is triggered in every repository of the Gitea.
    assert.match(workflow, /\n {4}if: gitea\.repository_owner == 'sites'\n/)
    // Without it a job token may write to the repository of the site (the default of Gitea).
    assert.match(workflow, /\npermissions:\n {2}contents: read\n/)
    // Nothing is fetched from the network. Actions of the platform's own Gitea (spec §10:
    // platform/actions/*, DEFAULT_ACTIONS_URL = self) are not verified yet: until they are
    // (N25, P9), no `uses:` at all.
    assert.doesNotMatch(workflow, /\buses:/)
    assert.doesNotMatch(workflow, /pull_request_target/)
    // Text of a commit, a branch or a repository never becomes a part of a script.
    const scripts = [...workflow.matchAll(/run: \|\n((?: {10}.*\n|\n)+)/g)]
    assert.ok(scripts.length > 0, `${file} has no script`)
    for (const [, script] of scripts) assert.doesNotMatch(script, /\$\{\{/)
    // A one-line `run:` would escape the check above.
    assert.doesNotMatch(workflow, /run: (?!\|\n)/)
  }
  const deploy = read('../../../ci/.gitea/scoped_workflows/deploy.yml')
  assert.match(
    deploy,
    /\n {2}group: deploy-\$\{\{ gitea\.repository \}\}\n {2}cancel-in-progress: false\n/,
  )
  // A cancelled deploy must be rolled back too: `failure()` alone is skipped on a cancel.
  assert.match(
    deploy,
    /- name: rollback\n(?: {8}#.*\n)* {8}if: \(failure\(\) \|\| cancelled\(\)\) && steps\.backup\.outcome == 'success'\n/,
  )
  // A re-run keeps the run id: the backup is named after the attempt as well.
  assert.match(deploy, /BACKUP_ID: \$\{\{ gitea\.run_id \}\}-\$\{\{ gitea\.run_attempt \}\}\n/)
})

test('the Vault address reaches a deploy job from its runner, never from the repository', () => {
  assert.equal(VAULT_INSIDE, 'http://openbao:8200')
  // `runner.envs` of the runner configuration: the machine that reaches Vault names it.
  assert.match(
    runnerConfig({ names, kind: 'deploy' }),
    /\nrunner:\n(?: {2}.*\n)*? {2}envs:\n {4}RADITI_VAULT_ADDR: http:\/\/openbao:8200\n/,
  )
  assert.ok(!runnerConfig({ names, kind: 'check' }).includes('VAULT'))
  const deploy = read('../../../ci/.gitea/scoped_workflows/deploy.yml')
  // A variable or a secret of the site repository must not say where the wrapped token is sent,
  // and the workflow itself does not set the address either.
  assert.doesNotMatch(deploy, /VAULT_ADDR: /)
  assert.doesNotMatch(deploy, /\$\{\{[^}]*VAULT_ADDR/)
  const requests = [...deploy.matchAll(/"\$([A-Z_]+)\/v1\/[a-z/$A-Z_-]+"/g)].map(([, name]) => name)
  assert.deepEqual(requests, ['RADITI_VAULT_ADDR', 'RADITI_VAULT_ADDR', 'RADITI_VAULT_ADDR'])
  // A job on a runner without the address stops before the wrapped token is sent anywhere.
  assert.match(
    deploy,
    /test -n "\$\{RADITI_VAULT_ADDR:-\}" \|\| \{ echo "vault-login: [^"$]+"; exit 1; \}\n[\s\S]*sys\/wrapping\/unwrap/,
  )
  // The stand never sets it for a repository; it checks that the repository has none.
  const scenario = read('./scenario.mjs')
  assert.doesNotMatch(scenario, /setVariable\([^)]*VAULT/)
  assert.match(
    scenario,
    /actions\/variables\/RADITI_VAULT_ADDR', \{\n\s+as: botToken,\n\s+\}\)\n\s+assert\.equal\(named\.status, 404/,
  )
})

test('nothing read from Vault is written to the pipeline log or to the job log', () => {
  const deploy = read('../../../ci/.gitea/scoped_workflows/deploy.yml')
  // Every line a step prints or appends to the log of the site volume: fixed text, the run id
  // and the commit only.
  const printed = [...deploy.matchAll(/echo "([^"]*)"/g)].map(([, text]) => text)
  assert.ok(printed.length >= 12, 'deploy.yml prints its steps')
  for (const text of printed)
    for (const [, name] of text.matchAll(/\$\{?([A-Za-z_]+)/g))
      assert.ok(['RUN_ID', 'HEAD_SHA'].includes(name), `a step prints $${name}`)
  // The access of the site is only tested for presence.
  assert.deepEqual(deploy.match(/\$\{?target\b/g), ['$target'])
  assert.match(deploy, /test -n "\$target" \|\| \{ echo "deploy: no deploy access"; exit 1; \}/)
  assert.match(
    deploy,
    /echo "deploy-start run=\$RUN_ID sha=\$HEAD_SHA access=read" >> "\$SITE_DIR\/pipeline\.log"/,
  )
  // A step never traces its commands: `set -x` would print the token arguments.
  assert.doesNotMatch(deploy, /set -[a-z]*x/)
})

test('a substitute that puts a Vault token into process arguments is marked and never synchronised', () => {
  const deploy = read('../../../ci/.gitea/scoped_workflows/deploy.yml')
  // busybox wget takes a header only as an argument, so the substitute steps do it.
  assert.match(deploy, /--header "X-Vault-Token: /)
  for (const file of ['check.yml', 'deploy.yml']) {
    const workflow = read(`../../../ci/.gitea/scoped_workflows/${file}`)
    if (!/X-Vault-Token/.test(workflow)) continue
    // Tolerated in a substitute of the stand only: a file without the mark — a real pipeline —
    // must hand the token over in a file or on stdin.
    assert.match(workflow, /^# SPIKE \(N18\): /m, `${file} is not marked SPIKE`)
    assert.match(workflow, /^# A file with this mark is never synchronised into platform\/ci\b/m)
  }
  // The rule is written where the synchronisation is described.
  assert.match(
    read('../../../ci/README.md'),
    /Файл с пометкой `SPIKE` в `platform\/ci` настоящей Gitea не синхронизируется/,
  )
})

test('an account of a stand Gitea is created without a password in process arguments', () => {
  const stand = read('./verify-pipeline.mjs')
  assert.match(stand, /docker\(giteaAccountArgs\(\{ container: name, user, admin \}\), \{/)
  assert.match(stand, /secret\(generatedGiteaPassword\(/)
  assert.doesNotMatch(stand, /'--password'/)
})

test('the fixture module of the webhook tests is what the builder makes of a recording', () => {
  // The recording of 2026-10-04, read back from the module: `<name>.<event>.json` → body.
  const files = Object.fromEntries(
    Object.entries(giteaWebhooksRecorded).map(([name, { event, body }]) => [
      `${name}.${event}.json`,
      body,
    ]),
  )
  assert.deepEqual(Object.keys(giteaWebhooksRecorded), SAMPLE_NAMES)
  assert.equal(
    samplesModule({ files, date: '2026-10-04' }),
    read('../../../packages/git-providers/src/testing/gitea-webhooks-recorded.ts'),
  )
  // Quotes, backslashes and line ends of a body survive the module.
  const tricky = { ...files, 'pushMain.push.json': '{\n  "note": "it\'s a \\\\ path"\n}' }
  assert.match(
    samplesModule({ files: tricky, date: '2026-10-04' }),
    /body: '\{\\n {2}"note": "it\\'s a \\\\\\\\ path"\\n\}',/,
  )
  const { 'jobFailure.workflow_job.json': dropped, ...incomplete } = files
  assert.ok(dropped)
  assert.throws(() => samplesModule({ files: incomplete, date: '2026-10-04' }), /no sample/)
  assert.throws(
    () => samplesModule({ files: { ...files, 'extra.push.json': '{}' }, date: '2026-10-04' }),
    /unknown sample/,
  )
  assert.throws(() => samplesModule({ files, date: 'today' }), /YYYY-MM-DD/)
  // The command that writes the module from a --record directory uses this builder.
  const command = read('./build-samples.mjs')
  assert.match(command, /samplesModule\(\{ files, date \}\)/)
  assert.match(command, /packages\/git-providers\/src\/testing\/gitea-webhooks-recorded\.ts/)
})
