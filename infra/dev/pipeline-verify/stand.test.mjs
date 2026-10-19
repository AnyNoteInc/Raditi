import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// The fixture module of the webhook tests (Node strips the types).
import { giteaWebhooksRecorded } from '../../../packages/git-providers/src/testing/gitea-webhooks-recorded.ts'
import { GITEA_IMAGE as TURN_GIT_STAND_GITEA } from '../gitea-verify/stand.mjs'
import {
  CA_INSIDE,
  DEPLOY_IMAGE,
  GITEA_IMAGE,
  HOSTING_IMAGE,
  HOSTING_ROOT,
  JOB_IMAGE,
  OPENBAO_IMAGE,
  RUNNER_IMAGE,
  REPOSITORY_WORKFLOWS_OFF,
  SAMPLE_NAMES,
  SITE_ORIGIN,
  SITE_SERVER_SCRIPT,
  VAULT_INSIDE,
  caWriterArgs,
  certificateConfigs,
  giteaContainerArgs,
  helperContainerArgs,
  hostKeyFingerprint,
  hostingContainerArgs,
  openbaoContainerArgs,
  parseProbe,
  releaseApiInside,
  runnerConfig,
  runnerContainerArgs,
  samplesModule,
  sanitizeWebhookBody,
  scopedRequiredForm,
  siteServerArgs,
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
  assert.match(HOSTING_IMAGE, /^linuxserver\/openssh-server@sha256:[a-f0-9]{64}$/)
  // The runner of the dev infrastructure is the same release.
  assert.match(read('../docker-compose.yml'), /image: gitea\/runner:4\.0\.0\n/)
  for (const args of [
    giteaContainerArgs({ names, port: 43210 }),
    giteaContainerArgs({ names, port: 43211, repositoryWorkflows: false }),
    openbaoContainerArgs({ names }),
    runnerContainerArgs({ names, kind: 'check' }),
    runnerContainerArgs({ names, kind: 'deploy' }),
    runnerContainerArgs({ names, kind: 'release' }),
    helperContainerArgs({ names }),
    hostingContainerArgs({ names }),
    siteServerArgs({ names }),
  ]) {
    assert.deepEqual(args.slice(0, 3), ['create', '--pull', 'never'])
    assert.deepEqual(values(args, '--label'), ['raditi.stand=raditi-pipeline-verify-0123abcd'])
  }
  const writer = caWriterArgs({ names })
  assert.deepEqual(writer.slice(0, 6), ['run', '--rm', '-i', '--pull', 'never', '--label'])
  assert.deepEqual(values(writer, '--network'), ['none'])
  // The deploy image is built from this tree and never pulled: the runner has `force_pull: false`.
  assert.equal(DEPLOY_IMAGE, 'raditi-pipeline-verify/orchestrator:local')
})

test('names belong to one run and nothing of the dev infrastructure can be named', () => {
  assert.equal(names.label, 'raditi.stand=raditi-pipeline-verify-0123abcd')
  for (const name of Object.values(names.containers))
    assert.match(name, /^raditi-pipeline-verify-0123abcd-[a-z-]+$/)
  for (const name of [
    ...Object.values(names.networks),
    names.siteVolume,
    names.caVolume,
    names.hostingVolume,
  ])
    assert.match(name, /^raditi-pipeline-verify-0123abcd-[a-z-]+$/)
  assert.equal(new Set(Object.values(names.containers)).size, 9)
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
  for (const kind of ['check', 'deploy', 'release']) {
    const config = runnerConfig({ names, kind, releaseApiPort: 43219 })
    // The three lines that keep a job away from the Docker socket and from host paths.
    for (const line of ["  docker_host: '-'", '  privileged: false']) {
      assert.ok(dev.includes(`${line}\n`), `infra/dev/runner.yaml lost: ${line}`)
      assert.ok(config.includes(`${line}\n`), `the stand lost: ${line}`)
    }
    assert.match(config, /\n {2}force_pull: false\n/)
    const network = kind === 'check' ? names.networks.check : names.networks.deploy
    assert.match(config, new RegExp(`\\n {2}network: ${network}\\n`))
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

test('a release job gets Vault, the release API, the CA and APP_ENV from its runner only', () => {
  const release = runnerConfig({ names, kind: 'release', releaseApiPort: 43219 })
  assert.equal(releaseApiInside(43219), 'http://host.docker.internal:43219')
  assert.throws(() => releaseApiInside(80), /port/)
  assert.match(
    release,
    new RegExp(
      [
        '\\n {2}envs:',
        ` {4}RADITI_VAULT_ADDR: ${VAULT_INSIDE}`,
        ' {4}RADITI_RELEASE_API_URL: http://host\\.docker\\.internal:43219',
        ` {4}NODE_EXTRA_CA_CERTS: ${CA_INSIDE}`,
        ' {4}APP_ENV: development\\n',
      ].join('\\n'),
    ),
  )
  // The CA only, read-only: no site volume, no host path.
  assert.match(release, new RegExp(`--volume ${names.caVolume}:/run/raditi/ca:ro`))
  assert.match(release, new RegExp(`valid_volumes:\\n {4}- ${names.caVolume}\\n`))
  assert.ok(!release.includes(names.siteVolume))
  assert.ok(!release.includes(names.hostingVolume))
})

test('a runner container: its own network, one label, the socket for the runner only', () => {
  for (const kind of ['check', 'deploy', 'release']) {
    const args = runnerContainerArgs({ names, kind })
    const network = kind === 'check' ? names.networks.check : names.networks.deploy
    assert.deepEqual(values(args, '--network'), [network])
    assert.deepEqual(values(args, '-v'), ['/var/run/docker.sock:/var/run/docker.sock'])
    assert.deepEqual(values(args, '-p'), [])
    const env = environment(args)
    assert.equal(
      env.GITEA_INSTANCE_URL,
      kind === 'release' ? 'https://gitea-hardened:3000' : 'https://gitea:3000',
    )
    assert.equal(
      env.GITEA_RUNNER_LABELS,
      kind === 'release' ? `deploy:docker://${DEPLOY_IMAGE}` : `${kind}:docker://${JOB_IMAGE}`,
    )
    assert.equal(env.CONFIG_FILE, '/config/runner.yaml')
    // The registration token is a file copied into the container, not an argument.
    assert.equal(env.GITEA_RUNNER_REGISTRATION_TOKEN_FILE, '/config/registration-token')
    assert.ok(!('GITEA_RUNNER_REGISTRATION_TOKEN' in env))
    // The runner trusts the stand's CA; certificate verification is never switched off.
    assert.equal(env.SSL_CERT_FILE, '/config/ca.pem')
    assert.equal(args.at(-1), RUNNER_IMAGE)
    assert.ok(!args.includes('--privileged'))
  }
  // The label `deploy` of the release runner names the deploy image a run gets.
  const other = runnerContainerArgs({ names, kind: 'release', deployImage: 'raditi/other:1' })
  assert.equal(environment(other).GITEA_RUNNER_LABELS, 'deploy:docker://raditi/other:1')
  assert.throws(
    () => runnerContainerArgs({ names, kind: 'release', deployImage: 'x; rm -rf /' }),
    /deploy image/,
  )
})

test('the hosting of a release: SFTP on the deploy network, no port, no password in arguments', () => {
  const args = hostingContainerArgs({ names })
  assert.deepEqual(values(args, '--network'), [names.networks.deploy])
  assert.deepEqual(values(args, '--network-alias'), ['hosting'])
  assert.deepEqual(values(args, '-p'), [])
  assert.deepEqual(values(args, '--mount'), [
    `type=volume,src=${names.hostingVolume},dst=${HOSTING_ROOT}`,
  ])
  const env = environment(args)
  assert.equal(env.PASSWORD_ACCESS, 'true')
  assert.equal(env.USER_PASSWORD_FILE, '/stand/password')
  assert.ok(!('USER_PASSWORD' in env))
  assert.equal(args.at(-1), HOSTING_IMAGE)
  // ssh-keygen -l of the same key line: the form an access names a host key in.
  assert.equal(
    hostKeyFingerprint(
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl root@host',
    ),
    'ssh-ed25519 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
  )
  assert.throws(() => hostKeyFingerprint('not a key'), /public key/)
})

test('the site of a release: its front page is index.php of the hosting, read-only', () => {
  const args = siteServerArgs({ names })
  assert.deepEqual(values(args, '--network-alias'), ['site'])
  assert.deepEqual(values(args, '--mount'), [
    `type=volume,src=${names.hostingVolume},dst=${HOSTING_ROOT},readonly`,
  ])
  assert.ok(args.includes('--read-only'))
  assert.deepEqual(values(args, '--cap-drop'), ['ALL'])
  assert.equal(args.at(-3), DEPLOY_IMAGE)
  assert.equal(args.at(-1), SITE_SERVER_SCRIPT)
  assert.match(SITE_SERVER_SCRIPT, /listen\(8080\)/)
  assert.equal(SITE_ORIGIN, 'http://site:8080')
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

test('the stand takes its options and nothing else', () => {
  const plain = { record: null, only: null, deployImage: DEPLOY_IMAGE }
  assert.deepEqual(standOptions([]), plain)
  assert.deepEqual(standOptions(['--']), plain)
  assert.deepEqual(standOptions(['--record=/tmp/samples']), { ...plain, record: '/tmp/samples' })
  assert.deepEqual(standOptions(['--only=tags']), { ...plain, only: 'tags' })
  assert.deepEqual(standOptions(['--deploy-image=raditi/orchestrator:abc']), {
    ...plain,
    deployImage: 'raditi/orchestrator:abc',
  })
  for (const argv of [
    ['--record=relative/dir'],
    ['--record='],
    ['--url=https://gitea.example.test'],
    ['--token', 'x'],
    ['--keep'],
    ['--record=/a', '--record=/b'],
    ['--only=spike'],
    ['--deploy-image=Bad Image'],
    // The samples come from the first Gitea, which `--only=tags` does not start.
    ['--record=/a', '--only=tags'],
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

const PRODUCT = '../../../ci/.gitea/scoped_workflows'
const SPIKE = './workflows/deploy-spike.yml'
/** Every script of a workflow: what `run: |` runs. */
const scriptsOf = (workflow) =>
  [...workflow.matchAll(/run: \|\n((?: {10}.*\n|\n)+)/g)].map(([, script]) => script)

test('the workflows: the guard, the token permissions and no network fetch', () => {
  for (const path of [`${PRODUCT}/check.yml`, `${PRODUCT}/deploy.yml`, SPIKE]) {
    const workflow = read(path)
    // An instance-level source is triggered in every repository of the Gitea.
    assert.match(workflow, /\n {4}if: gitea\.repository_owner == 'sites'(?: && .*)?\n/)
    // Without it a job token may write to the repository of the site (the default of Gitea).
    assert.match(workflow, /\npermissions:\n {2}contents: read\n/)
    // Nothing is fetched from the network. Actions of the platform's own Gitea (spec §10:
    // platform/actions/*, DEFAULT_ACTIONS_URL = self) are not verified yet: until they are
    // (N25, P9), no `uses:` at all.
    assert.doesNotMatch(workflow, /\buses:/)
    assert.doesNotMatch(workflow, /pull_request_target/)
    // Text of a commit, a branch or a repository never becomes a part of a script.
    const scripts = scriptsOf(workflow)
    assert.ok(scripts.length > 0, `${path} has no script`)
    for (const script of scripts) assert.doesNotMatch(script, /\$\{\{/)
    // A one-line `run:` would escape the check above.
    assert.doesNotMatch(workflow, /run: (?!\|\n)/)
    // One deploy of a site at a time; a newer run never cancels one in progress.
    if (path !== `${PRODUCT}/check.yml`)
      assert.match(
        workflow,
        /\n {2}group: deploy-\$\{\{ gitea\.repository \}\}\n {2}cancel-in-progress: false\n/,
      )
  }
})

test('the product deploy runs on a release tag only, never on a push to main (Р28)', () => {
  const deploy = read(`${PRODUCT}/deploy.yml`)
  assert.match(deploy, /\non:\n {2}push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:\n/)
  assert.doesNotMatch(deploy, /branches:/)
  // The tag of the import (v0.0.0) is installed already; a dispatch must name a tag ref.
  assert.match(
    deploy,
    /\n {4}if: gitea\.repository_owner == 'sites' && startsWith\(gitea\.ref, 'refs\/tags\/v'\) && gitea\.ref_name != 'v0\.0\.0'\n/,
  )
  assert.match(deploy, /\n {4}runs-on: deploy\n/)
  // Past the command's own bounds only: an hour of writing, the rollback, the end report.
  assert.match(deploy, /\n {4}timeout-minutes: 150\n/)
  // The facts of the run reach deploy-step as variables of the job.
  for (const [name, value] of [
    ['RADITI_RUN_EVENT', 'gitea.event_name'],
    ['RADITI_RUN_REF', 'gitea.ref'],
    ['RADITI_RUN_REF_NAME', 'gitea.ref_name'],
    ['RADITI_RUN_SHA', 'gitea.sha'],
    ['RADITI_RUN_SERVER', 'gitea.server_url'],
    ['RADITI_RUN_REPOSITORY', 'gitea.repository'],
  ])
    assert.match(
      deploy,
      new RegExp(`\\n {6}${name}: \\$\\{\\{ ${value.replace('.', '\\.')} \\}\\}\\n`),
    )
  // Two steps of the orchestrator image: `match` decides, `deploy` runs only when it said yes.
  assert.deepEqual(scriptsOf(deploy), [
    '          exec node /app/apps/orchestrator/dist/deploy-step/cli.js match\n',
    '          exec node /app/apps/orchestrator/dist/deploy-step/cli.js run\n',
  ])
  assert.match(deploy, /- name: match\n {8}id: match\n/)
  assert.match(deploy, /- name: deploy\n {8}if: steps\.match\.outputs\.matched == 'true'\n/)
  // The only secret is the one of the repository; the job token reads the files of the release.
  assert.deepEqual(
    [...deploy.matchAll(/\$\{\{ (secrets\.[A-Z_]+|gitea\.token) \}\}/g)].map(([, name]) => name),
    ['secrets.RADITI_DEPLOY_WRAP', 'secrets.RADITI_DEPLOY_WRAP', 'gitea.token'],
  )
  // The command is built from this source: Nest compiles src/ into dist/ (tsconfig rootDir src).
  assert.ok(read('../../../apps/orchestrator/src/deploy-step/cli.ts').length > 0)
  assert.match(read('../../../apps/orchestrator/tsconfig.json'), /"rootDir": "src"/)
  assert.match(
    read('../../../apps/orchestrator/Dockerfile'),
    /\nWORKDIR \/app\/apps\/orchestrator\n/,
  )
})

test('the Vault address and the release API reach a deploy job from its runner, never from the repository', () => {
  assert.equal(VAULT_INSIDE, 'http://openbao:8200')
  // `runner.envs` of the runner configuration: the machine that reaches Vault names it.
  assert.match(
    runnerConfig({ names, kind: 'deploy' }),
    /\nrunner:\n(?: {2}.*\n)*? {2}envs:\n {4}RADITI_VAULT_ADDR: http:\/\/openbao:8200\n/,
  )
  assert.ok(!runnerConfig({ names, kind: 'check' }).includes('VAULT'))
  for (const path of [`${PRODUCT}/deploy.yml`, SPIKE]) {
    const workflow = read(path)
    // A variable or a secret of the site repository must not say where the wrapped token is
    // sent, and the workflow itself does not set the address either.
    assert.doesNotMatch(workflow, /VAULT_ADDR: /)
    assert.doesNotMatch(workflow, /\$\{\{[^}]*VAULT_ADDR/)
    assert.doesNotMatch(workflow, /\$\{\{[^}]*(?:RELEASE_API|NODE_EXTRA_CA_CERTS|APP_ENV)/)
  }
  const spike = read(SPIKE)
  const requests = [...spike.matchAll(/"\$([A-Z_]+)\/v1\/[a-z/$A-Z_-]+"/g)].map(([, name]) => name)
  assert.deepEqual(requests, ['RADITI_VAULT_ADDR', 'RADITI_VAULT_ADDR', 'RADITI_VAULT_ADDR'])
  // A job on a runner without the address stops before the wrapped token is sent anywhere.
  assert.match(
    spike,
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

test('the spike deploy: a cancelled deploy is rolled back, a backup belongs to one attempt', () => {
  const spike = read(SPIKE)
  assert.match(spike, /\non:\n {2}push:\n {4}branches: \[main\]\n/)
  // A cancelled deploy must be rolled back too: `failure()` alone is skipped on a cancel.
  assert.match(
    spike,
    /- name: rollback\n(?: {8}#.*\n)* {8}if: \(failure\(\) \|\| cancelled\(\)\) && steps\.backup\.outcome == 'success'\n/,
  )
  // A re-run keeps the run id: the backup is named after the attempt as well.
  assert.match(spike, /BACKUP_ID: \$\{\{ gitea\.run_id \}\}-\$\{\{ gitea\.run_attempt \}\}\n/)
})

test('nothing read from Vault is written to the pipeline log or to the job log', () => {
  const spike = read(SPIKE)
  // Every line a step prints or appends to the log of the site volume: fixed text, the run id
  // and the commit only.
  const printed = [...spike.matchAll(/echo "([^"]*)"/g)].map(([, text]) => text)
  assert.ok(printed.length >= 12, 'the spike deploy prints its steps')
  for (const text of printed)
    for (const [, name] of text.matchAll(/\$\{?([A-Za-z_]+)/g))
      assert.ok(['RUN_ID', 'HEAD_SHA'].includes(name), `a step prints $${name}`)
  // The access of the site is only tested for presence.
  assert.deepEqual(spike.match(/\$\{?target\b/g), ['$target'])
  assert.match(spike, /test -n "\$target" \|\| \{ echo "deploy: no deploy access"; exit 1; \}/)
  assert.match(
    spike,
    /echo "deploy-start run=\$RUN_ID sha=\$HEAD_SHA access=read" >> "\$SITE_DIR\/pipeline\.log"/,
  )
  // A step never traces its commands: `set -x` would print the token arguments.
  for (const path of [SPIKE, `${PRODUCT}/deploy.yml`])
    assert.doesNotMatch(read(path), /set -[a-z]*x/)
})

test('a substitute that puts a Vault token into process arguments never reaches platform/ci', () => {
  const spike = read(SPIKE)
  // busybox wget takes a header only as an argument, so the substitute steps do it.
  assert.match(spike, /--header "X-Vault-Token: /)
  assert.match(spike, /^# SPIKE \(N18\): /m)
  assert.match(spike, /^# A file with this mark is never synchronised into platform\/ci\b/m)
  // ci/ — what is synchronised into platform/ci — holds no such step.
  for (const file of ['check.yml', 'deploy.yml'])
    assert.doesNotMatch(read(`${PRODUCT}/${file}`), /X-Vault-Token|wget/)
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
