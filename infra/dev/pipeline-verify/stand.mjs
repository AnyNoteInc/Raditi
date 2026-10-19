// Pure parts of the pipeline stand: names, container arguments, runner configuration, the form
// of Gitea's scoped-workflow settings, the reader of probe lines and the sanitiser of recorded
// webhook bodies. Nothing here touches Docker, the network or the file system.
import { createHash } from 'node:crypto'
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
 * The hosting of the site of a release (plan 53, Р30): OpenSSH with internal-sftp, by digest,
 * already pulled. A release job writes the site's files there over SFTP.
 */
export const HOSTING_IMAGE =
  'linuxserver/openssh-server@sha256:96b9a4d3b5106746d08d43a6911650d4d21f7d5c7f2ac9660e792bdb5e63157c'

/** Where the hosting keeps the site, and the SFTP account a release job logs in with. */
export const HOSTING_ROOT = '/srv/site'
export const HOSTING_USER = 'site'
/** The site's address as a release job checks it: the site server on the deploy network. */
export const SITE_ORIGIN = 'http://site:8080'

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

/**
 * The image of the runner label `deploy` on the second Gitea: the orchestrator image built from
 * this tree (`docker build -f apps/orchestrator/Dockerfile --target runtime -t <this> .`). Its
 * command `deploy-step` is what the product workflow runs; the stand never builds or pulls it.
 */
export const DEPLOY_IMAGE = 'raditi-pipeline-verify/orchestrator:local'
const IMAGE_REFERENCE =
  /^[a-z0-9][a-z0-9._/-]{0,199}(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/

/**
 * `--record=<absolute directory>` writes sanitised webhook bodies there; `--only=tags` asks only
 * the questions of the release tag (the second Gitea); `--deploy-image=<reference>` names another
 * local image for the runner label `deploy` of the second Gitea. Nothing else is taken.
 */
export function standOptions(argv) {
  const args = argv.filter((arg) => arg !== '--')
  const usage = new Error(
    'Usage: verify-pipeline.mjs [--record=<absolute directory>] [--only=tags] [--deploy-image=<image>]',
  )
  const options = { record: null, only: null, deployImage: DEPLOY_IMAGE }
  const seen = new Set()
  for (const arg of args) {
    const [, name, value] = /^--(record|only|deploy-image)=(.+)$/.exec(arg) ?? []
    if (!name || seen.has(name)) throw usage
    seen.add(name)
    if (name === 'record') {
      if (!isAbsolute(value)) throw usage
      options.record = value
    } else if (name === 'only') {
      if (value !== 'tags') throw usage
      options.only = value
    } else {
      if (!IMAGE_REFERENCE.test(value)) throw usage
      options.deployImage = value
    }
  }
  // The samples are bodies of the first Gitea's runs: a run without it has none to record.
  if (options.record && options.only) throw usage
  return options
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
      // The deploy runner of the second Gitea: the product workflow on a release tag.
      runnerRelease: `${stand}-runner-release`,
      site: `${stand}-site-reader`,
      // The site a release job deploys to: its SFTP hosting and the server of its pages.
      hosting: `${stand}-hosting`,
      siteServer: `${stand}-site-server`,
    },
    // Two networks, as two kinds of runner machines: only the deploy side reaches OpenBao.
    networks: { check: `${stand}-check`, deploy: `${stand}-deploy` },
    siteVolume: `${stand}-site`,
    // The stand's CA for the release jobs: they check the certificate of the second Gitea.
    caVolume: `${stand}-ca`,
    // The files of the site of a release: written over SFTP, served by the site server.
    hostingVolume: `${stand}-hosting-files`,
  }
}

/**
 * The release API as a job of the second Gitea sees it: the stand process on the host. Like the
 * address of Vault, it is a part of the runner's configuration, never of a site repository.
 */
export const releaseApiInside = (port) => {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error('Invalid port')
  return `http://host.docker.internal:${port}`
}

/** Where a release job finds the stand's CA (the volume `caVolume`, read-only). */
export const CA_INSIDE = '/run/raditi/ca/ca.pem'

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

/**
 * `check` and `deploy` serve the first Gitea (spike N18); `release` is the deploy runner of the
 * second Gitea, the one the product workflow of a release tag runs on.
 */
const runnerKinds = ['check', 'deploy', 'release']

function runnerKind(kind) {
  if (!runnerKinds.includes(kind)) throw new Error('Unknown runner kind')
  return kind
}

const runnerNetwork = (names, kind) => names.networks[kind === 'check' ? 'check' : 'deploy']

/**
 * The configuration of infra/dev/runner.yaml (no Docker socket, no privileges and no host volumes
 * for a job) plus what a disposable stand needs: its own network instead of a network per job,
 * the label of the run on every job container and no pull. A deploy job of the first Gitea gets a
 * volume — the substitute "site" — and the address of OpenBao in its environment. A release job
 * of the second Gitea gets the addresses of OpenBao and of the release API, the stand's CA (a
 * read-only volume and NODE_EXTRA_CA_CERTS, as a deploy machine of the platform would hold the CA
 * of its Gitea and Vault) and APP_ENV: all of it from the runner, nothing from the repository.
 */
export function runnerConfig({ names, kind, releaseApiPort }) {
  const deploy = runnerKind(kind) === 'deploy'
  const release = kind === 'release'
  const options = [
    `--label ${names.label}`,
    '--add-host host.docker.internal:host-gateway',
    ...(deploy ? [`--volume ${names.siteVolume}:/site`] : []),
    ...(release ? [`--volume ${names.caVolume}:${CA_INSIDE.replace(/\/[^/]+$/, '')}:ro`] : []),
  ].join(' ')
  const envs = deploy
    ? ['  envs:', `    RADITI_VAULT_ADDR: ${VAULT_INSIDE}`]
    : release
      ? [
          '  envs:',
          `    RADITI_VAULT_ADDR: ${VAULT_INSIDE}`,
          `    RADITI_RELEASE_API_URL: ${releaseApiInside(releaseApiPort)}`,
          `    NODE_EXTRA_CA_CERTS: ${CA_INSIDE}`,
          '    APP_ENV: development',
        ]
      : []
  const volumes = deploy ? [names.siteVolume] : release ? [names.caVolume] : []
  return [
    'log:',
    '  level: info',
    'runner:',
    // Two sites deploy at the same time; one site never does (concurrency of deploy.yml).
    '  capacity: 2',
    '  fetch_interval: 1s',
    '  fetch_interval_max: 2s',
    '  shutdown_timeout: 0s',
    ...envs,
    'container:',
    `  network: ${runnerNetwork(names, kind)}`,
    "  docker_host: '-'",
    '  privileged: false',
    '  force_pull: false',
    `  options: ${options}`,
    ...(volumes.length > 0
      ? ['  valid_volumes:', ...volumes.map((volume) => `    - ${volume}`)]
      : ['  valid_volumes: []']),
    '',
  ].join('\n')
}

/**
 * `docker create` of one runner. /config (runner.yaml, the stand's CA and the registration token
 * file) is copied in before the start. The Docker socket is the runner's own: job containers do
 * not get it (`docker_host: '-'`). The label `deploy` of the release runner names the image of a
 * release job: the orchestrator image, chosen by the runner and never by the repository.
 */
export function runnerContainerArgs({ names, kind, deployImage = DEPLOY_IMAGE }) {
  runnerKind(kind)
  if (!IMAGE_REFERENCE.test(deployImage)) throw new Error('Invalid deploy image')
  const name = {
    check: names.containers.runnerCheck,
    deploy: names.containers.runnerDeploy,
    release: names.containers.runnerRelease,
  }[kind]
  return [
    ...created(names, name),
    ...['--network', runnerNetwork(names, kind)],
    ...['-v', '/var/run/docker.sock:/var/run/docker.sock'],
    ...variables({
      GITEA_INSTANCE_URL: kind === 'release' ? 'https://gitea-hardened:3000' : 'https://gitea:3000',
      GITEA_RUNNER_REGISTRATION_TOKEN_FILE: '/config/registration-token',
      GITEA_RUNNER_NAME: name,
      GITEA_RUNNER_LABELS:
        kind === 'release' ? `deploy:docker://${deployImage}` : `${kind}:docker://${JOB_IMAGE}`,
      CONFIG_FILE: '/config/runner.yaml',
      SSL_CERT_FILE: '/config/ca.pem',
    }),
    RUNNER_IMAGE,
  ]
}

/** Writes the stand's CA into the CA volume: a container without network, the PEM on stdin. */
export function caWriterArgs({ names }) {
  return [
    'run',
    '--rm',
    '-i',
    '--pull',
    'never',
    ...['--label', names.label],
    ...['--network', 'none'],
    ...['--mount', `type=volume,src=${names.caVolume},dst=/ca`],
    JOB_IMAGE,
    'sh',
    '-c',
    'umask 022; cat > /ca/ca.pem',
  ]
}

/**
 * `docker create` of the hosting: on the deploy network as `hosting`, no published port, the
 * site's files on their own volume. The password of the SFTP account is a file copied in before
 * the start (`USER_PASSWORD_FILE`), never an argument.
 */
export function hostingContainerArgs({ names }) {
  return [
    ...created(names, names.containers.hosting),
    ...['--network', names.networks.deploy, '--network-alias', 'hosting'],
    ...['--mount', `type=volume,src=${names.hostingVolume},dst=${HOSTING_ROOT}`],
    ...variables({
      PUID: '1000',
      PGID: '1000',
      USER_NAME: HOSTING_USER,
      PASSWORD_ACCESS: 'true',
      USER_PASSWORD_FILE: '/stand/password',
    }),
    HOSTING_IMAGE,
  ]
}

/**
 * The server of the site's pages: the front page is the file `index.php` of the hosting as it is,
 * read-only; a release job checks it at SITE_ORIGIN. The deploy image, so nothing is pulled.
 */
export const SITE_SERVER_SCRIPT = [
  "const { createServer } = require('node:http')",
  "const { readFile } = require('node:fs/promises')",
  'createServer(async (request, response) => {',
  "  if (request.url !== '/') return response.writeHead(404).end()",
  '  try {',
  `    const page = await readFile('${HOSTING_ROOT}/index.php')`,
  "    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page)",
  '  } catch {',
  '    response.writeHead(500).end()',
  '  }',
  '}).listen(8080)',
].join('\n')

export function siteServerArgs({ names, deployImage = DEPLOY_IMAGE }) {
  if (!IMAGE_REFERENCE.test(deployImage)) throw new Error('Invalid deploy image')
  return [
    ...created(names, names.containers.siteServer),
    ...['--network', names.networks.deploy, '--network-alias', 'site'],
    ...['--mount', `type=volume,src=${names.hostingVolume},dst=${HOSTING_ROOT},readonly`],
    '--read-only',
    ...['--cap-drop', 'ALL'],
    ...['--security-opt', 'no-new-privileges'],
    ...['--entrypoint', 'node'],
    deployImage,
    '-e',
    SITE_SERVER_SCRIPT,
  ]
}

/**
 * The host key of an OpenSSH `.pub` line as an access names it (`hostKeySchema`): the key type and
 * `SHA256:` with the unpadded base64 of the SHA-256 of the key blob — what `ssh-keygen -l` prints.
 */
export function hostKeyFingerprint(publicKeyLine) {
  const [type, blob] = publicKeyLine.trim().split(/\s+/)
  if (!/^ssh-[a-z0-9-]+$/.test(type ?? '') || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob ?? ''))
    throw new Error('Not an OpenSSH public key line')
  const digest = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64')
  return `${type} SHA256:${digest.replace(/=+$/, '')}`
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
