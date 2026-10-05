// Pure parts of the pipeline stand: names, container arguments, runner configuration, the form
// of Gitea's scoped-workflow settings, the reader of probe lines and the sanitiser of recorded
// webhook bodies. Nothing here touches Docker, the network or the file system.
import { isAbsolute } from 'node:path'

import { GITEA_IMAGE } from '../gitea-verify/stand.mjs'

export { GITEA_IMAGE }

/** The runner of infra/dev/docker-compose.yml, by digest. The stand never pulls it. */
export const RUNNER_IMAGE =
  'gitea/runner:4.0.0@sha256:7b5aa1137a262c2ca452a420c645629c95c5277920d2bdeb90757cb5ea24689f'

export const OPENBAO_IMAGE =
  'ghcr.io/openbao/openbao:2.7.0@sha256:71156a1c6623a5fa3f5e61b0c6a8ead0faf0df29a778339188443551995d1315'

/** The image of every job container and of the stand's reader of the site volume. */
export const JOB_IMAGE =
  'alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce'

/**
 * `[actions] WORKFLOW_DIRS` of the second Gitea. Git refuses to track a path below `.git`, so no
 * commit can put a workflow file there: repository workflows are off, scoped ones are not.
 */
export const REPOSITORY_WORKFLOWS_OFF = '.git/raditi-no-repository-workflows'

/**
 * OpenBao as a deploy job sees it: the network alias on the deploy network. The address is a part
 * of the deploy runner's configuration (`runner.envs`), not a variable of a site repository: what
 * a repository holds must not decide where the wrapped deploy token is sent.
 */
export const VAULT_INSIDE = 'http://openbao:8200'

const RUN_ID = /^[0-9a-f]{8}$/

/** `--record=<absolute directory>` writes sanitised webhook bodies there; nothing else is taken. */
export function standOptions(argv) {
  const args = argv.filter((arg) => arg !== '--')
  const usage = new Error('Usage: verify-pipeline.mjs [--record=<absolute directory>]')
  if (args.length > 1) throw usage
  if (args.length === 0) return { record: null }
  const [, record] = /^--record=(.+)$/.exec(args[0]) ?? []
  if (!record || !isAbsolute(record)) throw usage
  return { record }
}

/** Every resource of one run. Nothing outside these names is ever created or removed by name. */
export function standNames(id) {
  if (typeof id !== 'string' || !RUN_ID.test(id)) throw new Error('Invalid run id of the stand')
  const stand = `raditi-pipeline-verify-${id}`
  return {
    stand,
    label: `raditi.stand=${stand}`,
    containers: {
      gitea: `${stand}-gitea`,
      giteaHardened: `${stand}-gitea-hardened`,
      openbao: `${stand}-openbao`,
      runnerCheck: `${stand}-runner-check`,
      runnerDeploy: `${stand}-runner-deploy`,
      site: `${stand}-site-reader`,
    },
    // Two networks, as two kinds of runner machines: only the deploy side reaches OpenBao.
    networks: { check: `${stand}-check`, deploy: `${stand}-deploy` },
    siteVolume: `${stand}-site`,
  }
}

const created = (names, name) => [
  'create',
  '--pull',
  'never',
  '--name',
  name,
  '--label',
  names.label,
]
const variables = (env) => Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`])

/**
 * `docker create` of a Gitea of the stand: built-in HTTPS with the stand's certificate (copied in
 * before the start, no host path is mounted), published on loopback only, SQLite inside, Actions
 * on. With `repositoryWorkflows: false` it is the second instance, which reads no workflow file
 * from a repository.
 */
export function giteaContainerArgs({ names, port, repositoryWorkflows = true }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new Error('Invalid loopback port')
  const alias = repositoryWorkflows ? 'gitea' : 'gitea-hardened'
  const env = {
    GITEA__security__INSTALL_LOCK: 'true',
    GITEA__database__DB_TYPE: 'sqlite3',
    GITEA__server__PROTOCOL: 'https',
    GITEA__server__HTTP_PORT: '3000',
    GITEA__server__ROOT_URL: `https://${alias}:3000/`,
    GITEA__server__CERT_FILE: '/tls/server.pem',
    GITEA__server__KEY_FILE: '/tls/server-key.pem',
    GITEA__server__DISABLE_SSH: 'true',
    GITEA__server__START_SSH_SERVER: 'false',
    GITEA__service__DISABLE_REGISTRATION: 'true',
    GITEA__actions__ENABLED: 'true',
    GITEA__actions__DEFAULT_ACTIONS_URL: 'self',
    GITEA__webhook__ALLOWED_HOST_LIST: 'private',
    GITEA__log__LEVEL: 'Warn',
    ...(repositoryWorkflows ? {} : { GITEA__actions__WORKFLOW_DIRS: REPOSITORY_WORKFLOWS_OFF }),
  }
  return [
    ...created(
      names,
      repositoryWorkflows ? names.containers.gitea : names.containers.giteaHardened,
    ),
    ...['--network', names.networks.check, '--network-alias', alias],
    // The webhook receiver is the stand process; Docker Desktop resolves the name by itself.
    ...['--add-host', 'host.docker.internal:host-gateway'],
    ...['-p', `127.0.0.1:${port}:3000`],
    ...variables(env),
    GITEA_IMAGE,
  ]
}

const openbaoConfig = `disable_mlock = true
storage "inmem" {}
listener "tcp" {
  address = "0.0.0.0:8200"
  tls_disable = true
}
`

/**
 * A regular in-memory server, initialised through its API: the root token and the unseal key
 * exist only in the memory of the stand process, never in arguments, environment or logs.
 */
export function openbaoContainerArgs({ names }) {
  return [
    ...created(names, names.containers.openbao),
    ...['--network', names.networks.deploy, '--network-alias', 'openbao'],
    ...['-p', '127.0.0.1::8200'],
    ...['--entrypoint', 'sh'],
    OPENBAO_IMAGE,
    '-c',
    `umask 077; cat > /tmp/raditi-bao.hcl <<'RADITI_CONFIG'\n${openbaoConfig}RADITI_CONFIG\nexec bao server -config=/tmp/raditi-bao.hcl`,
  ]
}

function runnerKind(kind) {
  if (kind !== 'check' && kind !== 'deploy') throw new Error('Unknown runner kind')
  return kind
}

/**
 * The configuration of infra/dev/runner.yaml (no Docker socket, no privileges and no host volumes
 * for a job) plus what a disposable stand needs: its own network instead of a network per job,
 * the label of the run on every job container and no pull. Only a deploy job gets a volume — the
 * substitute "site" — and the address of OpenBao in its environment.
 */
export function runnerConfig({ names, kind }) {
  const deploy = runnerKind(kind) === 'deploy'
  const options = [
    `--label ${names.label}`,
    '--add-host host.docker.internal:host-gateway',
    ...(deploy ? [`--volume ${names.siteVolume}:/site`] : []),
  ].join(' ')
  return [
    'log:',
    '  level: info',
    'runner:',
    // Two sites deploy at the same time; one site never does (concurrency of deploy.yml).
    '  capacity: 2',
    '  fetch_interval: 1s',
    '  fetch_interval_max: 2s',
    '  shutdown_timeout: 0s',
    ...(deploy ? ['  envs:', `    RADITI_VAULT_ADDR: ${VAULT_INSIDE}`] : []),
    'container:',
    `  network: ${names.networks[kind]}`,
    "  docker_host: '-'",
    '  privileged: false',
    '  force_pull: false',
    `  options: ${options}`,
    ...(deploy ? ['  valid_volumes:', `    - ${names.siteVolume}`] : ['  valid_volumes: []']),
    '',
  ].join('\n')
}

/**
 * `docker create` of one runner. /config (runner.yaml, the stand's CA and the registration token
 * file) is copied in before the start. The Docker socket is the runner's own: job containers do
 * not get it (`docker_host: '-'`).
 */
export function runnerContainerArgs({ names, kind }) {
  const name =
    runnerKind(kind) === 'deploy' ? names.containers.runnerDeploy : names.containers.runnerCheck
  return [
    ...created(names, name),
    ...['--network', names.networks[kind]],
    ...['-v', '/var/run/docker.sock:/var/run/docker.sock'],
    ...variables({
      GITEA_INSTANCE_URL: 'https://gitea:3000',
      GITEA_RUNNER_REGISTRATION_TOKEN_FILE: '/config/registration-token',
      GITEA_RUNNER_NAME: name,
      GITEA_RUNNER_LABELS: `${kind}:docker://${JOB_IMAGE}`,
      CONFIG_FILE: '/config/runner.yaml',
      SSL_CERT_FILE: '/config/ca.pem',
    }),
    RUNNER_IMAGE,
  ]
}

/** The stand's reader of the site volume: read-only, no network, lives for the run. */
export function helperContainerArgs({ names }) {
  return [
    ...created(names, names.containers.site),
    ...['--network', 'none'],
    ...['--mount', `type=volume,src=${names.siteVolume},dst=/site,readonly`],
    JOB_IMAGE,
    'sleep',
    '3600',
  ]
}

/** OpenSSL extension files of the stand's two-day CA and its server certificate. */
export function certificateConfigs() {
  return {
    authority: [
      'basicConstraints = critical, CA:true, pathlen:0',
      'keyUsage = critical, keyCertSign',
      'subjectKeyIdentifier = hash',
      '',
    ].join('\n'),
    server: [
      'basicConstraints = critical, CA:false',
      'keyUsage = critical, digitalSignature',
      'extendedKeyUsage = serverAuth',
      'subjectAltName = IP:127.0.0.1, DNS:localhost, DNS:gitea, DNS:gitea-hardened',
      '',
    ].join('\n'),
  }
}

/**
 * Body of `POST …/actions/scoped-workflows/required` — the web form of Gitea 1.27.3; there is no
 * REST API for it. `required` maps a workflow file to its status check patterns (one per line).
 */
export function scopedRequiredForm({ repositoryId, files, required }) {
  const form = new URLSearchParams({ repo_id: String(repositoryId) })
  for (const file of files) form.append('workflow_ids', file)
  for (const [file, patterns] of Object.entries(required)) {
    if (!files.includes(file)) throw new Error(`${file} is not a file of the source`)
    form.append('required_workflow_ids', file)
    form.append(`required_patterns[${file}]`, patterns)
  }
  return form.toString()
}

/** `probe.<kind>.<key>=<value>` lines of a job log → { kind: { key: value } }. */
export function parseProbe(log) {
  const result = {}
  for (const line of log.split('\n')) {
    const [, kind, key, value] = /(?:^|\s)probe\.([a-z_]+)\.([a-z_]+)=(\S*)\s*$/.exec(line) ?? []
    if (kind) (result[kind] ??= {})[key] = value
  }
  return result
}

const EXAMPLE_ORIGIN = 'https://gitea.example.test'

/**
 * A webhook body as Gitea sent it, with the addresses of the stand replaced by example ones.
 * Fails closed: a body that carries a secret of the run, a host name of the machine, a home path
 * or an address the rules do not know is refused rather than cleaned.
 */
export function sanitizeWebhookBody(raw, { port, forbidden }) {
  for (const value of forbidden) {
    if (typeof value !== 'string' || value === '')
      throw new Error('An empty forbidden value would match every body')
    if (raw.includes(value)) throw new Error('The body carries a forbidden value')
  }
  if (/\/(?:Users|home)\/[^/"\s]+/.test(raw)) throw new Error('The body carries a home path')
  const clean = raw
    .replaceAll('https://gitea-hardened:3000', EXAMPLE_ORIGIN)
    .replaceAll('https://gitea:3000', EXAMPLE_ORIGIN)
    .replaceAll(`https://127.0.0.1:${port}`, EXAMPLE_ORIGIN)
    .replaceAll('ssh://git@localhost:2222/', 'ssh://git@gitea.example.test:2222/')
    .replaceAll(/@noreply\.gitea(?:-hardened)?"/g, '@noreply.gitea.example.test"')
  // Whatever is left of the stand's names, and any literal IPv4 address at all: a container, the
  // gateway of a Docker network or the host — no rule above knows them.
  if (
    /localhost|host\.docker\.internal|gitea(?:-hardened)?:3000|noreply\.gitea"/.test(clean) ||
    /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/.test(clean)
  )
    throw new Error('The body carries an address of the stand')
  return clean
}

/** The samples of the fixture module, in its order. A recording must give exactly these. */
export const SAMPLE_NAMES = [
  'pullRequestOpened',
  'pullRequestMerged',
  'pushMain',
  'runRequested',
  'runInProgress',
  'runSuccess',
  'runFailure',
  'runCancelled',
  'runRepositoryWorkflow',
  'jobFailure',
]

const quoted = (text) =>
  `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`

/**
 * The text of packages/git-providers/src/testing/gitea-webhooks-recorded.ts from a `--record`
 * directory: `files` maps `<name>.<event>.json` to its sanitised body, `date` is the day of the
 * recording. A missing or an unknown sample is refused: the tests name every sample.
 */
export function samplesModule({ files, date }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('The recording date is YYYY-MM-DD')
  const names = Object.keys(files)
  const entries = SAMPLE_NAMES.map((name) => {
    const file = names.find((entry) => entry.startsWith(`${name}.`) && entry.endsWith('.json'))
    if (!file) throw new Error(`The recording has no sample ${name}`)
    const event = file.slice(name.length + 1, -'.json'.length)
    if (!/^[a-z_]+$/.test(event)) throw new Error(`The sample ${name} names no event`)
    return `  ${name}: {\n    event: '${event}',\n    body: ${quoted(files[file])},\n  },`
  })
  if (names.length !== SAMPLE_NAMES.length) throw new Error('The recording has an unknown sample')
  return `// Webhook bodies recorded from a disposable gitea/gitea:1.27.3-rootless with gitea/runner 4.0.0 on
// ${date} by \`pnpm verify:pipeline --record=<directory>\` (bodies as sent, Gitea pretty-prints
// them). Only the addresses differ: the origin of the stand is https://gitea.example.test. No
// signature is stored: a test signs the body with its own secret.
export interface RecordedWebhook {
  /** The value of X-Gitea-Event. */
  event: string
  body: string
}

export const giteaWebhooksRecorded = {
${entries.join('\n')}
} satisfies Record<string, RecordedWebhook>
`
}
