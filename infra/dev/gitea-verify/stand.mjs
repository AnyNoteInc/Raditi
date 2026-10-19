// Pure parts of the Gitea stand: what the disposable container and the scenario process get.

/** The Gitea of infra/dev/docker-compose.yml, by digest. The stand never pulls it. */
export const GITEA_IMAGE =
  'gitea/gitea:1.27.3-rootless@sha256:1c17ecaead42eb3b5391553d8708103a4beb0e86edf5b9ebc1eb269c318845f2'

const CONTAINER_NAME = /^raditi-gitea-verify-[0-9a-f]{8}$/

/** The stand has no options: it never talks to an existing Gitea or takes a real token. */
export function standOptions(argv) {
  if (argv.filter((arg) => arg !== '--').length > 0)
    throw new Error('This local stand accepts no options, external Gitea address or token')
  return {}
}

/**
 * `docker create` of the stand's own Gitea: built-in HTTPS with the stand's certificate (copied
 * in before the start, so no host path is mounted), published on loopback only, SQLite inside.
 * Actions are on without a runner: runs are created and stay queued. Workflow files of a
 * repository do run here (no `[actions] WORKFLOW_DIRS`): the stand measures tag runs and
 * dispatch on them; the obligatory workflows of platform/ci are the pipeline stand's. Webhooks go
 * to the scenario on the host, a private address.
 */
export function giteaContainerArgs({ name, port }) {
  if (typeof name !== 'string' || !CONTAINER_NAME.test(name))
    throw new Error("Only the stand's own container may be created")
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new Error('Invalid loopback port')
  const env = {
    GITEA__security__INSTALL_LOCK: 'true',
    GITEA__database__DB_TYPE: 'sqlite3',
    GITEA__server__PROTOCOL: 'https',
    GITEA__server__HTTP_PORT: '3000',
    GITEA__server__ROOT_URL: `https://127.0.0.1:${port}/`,
    GITEA__server__CERT_FILE: '/tls/server.pem',
    GITEA__server__KEY_FILE: '/tls/server-key.pem',
    GITEA__server__DISABLE_SSH: 'true',
    GITEA__server__START_SSH_SERVER: 'false',
    GITEA__service__DISABLE_REGISTRATION: 'true',
    GITEA__actions__ENABLED: 'true',
    GITEA__webhook__ALLOWED_HOST_LIST: 'private',
    GITEA__log__LEVEL: 'Warn',
  }
  return [
    'create',
    '--pull',
    'never',
    '--name',
    name,
    '--label',
    `raditi.stand=${name}`,
    '-p',
    `127.0.0.1:${port}:3000`,
    // The webhook receiver is the scenario process; Docker Desktop resolves the name by itself.
    ...['--add-host', 'host.docker.internal:host-gateway'],
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    GITEA_IMAGE,
  ]
}

/**
 * A Gitea container of this stand, of the pipeline stand (infra/dev/pipeline-verify) or of the
 * release stand (infra/dev/release-verify).
 */
const STAND_GITEA =
  /^raditi-(?:gitea-verify-[0-9a-f]{8}|pipeline-verify-[0-9a-f]{8}-[a-z-]+|release-verify-[0-9a-f]{8}-gitea)$/
const ACCOUNT = /^[a-z][a-z0-9-]{0,39}$/
const PASSWORD_LENGTH = 36

/**
 * `docker exec` that creates an account in a stand's Gitea. Gitea generates the password and
 * prints it (`generatedGiteaPassword`): it is never an argument of a process, neither of the
 * Docker CLI on the host nor of `gitea` in the container.
 */
export function giteaAccountArgs({ container, user, admin = false }) {
  if (typeof container !== 'string' || !STAND_GITEA.test(container))
    throw new Error("Only the stand's own container may be used")
  if (typeof user !== 'string' || !ACCOUNT.test(user)) throw new Error('Invalid account name')
  return [
    ...['exec', container, 'gitea', 'admin', 'user', 'create', '--username', user],
    ...['--random-password', '--random-password-length', String(PASSWORD_LENGTH)],
    ...['--email', `${user}@example.test`, '--must-change-password=false'],
    ...(admin ? ['--admin'] : []),
  ]
}

/** The password from the output of `gitea admin user create --random-password` (Gitea 1.27.3). */
export function generatedGiteaPassword(output) {
  const [, password] =
    new RegExp(`^generated random password is '(.{${PASSWORD_LENGTH}})'$`, 'm').exec(output) ?? []
  // The output is never part of the message: it may hold the password in an unexpected form.
  if (!password) throw new Error('Gitea did not print the generated password')
  return password
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
      'subjectAltName = IP:127.0.0.1, DNS:localhost',
      '',
    ].join('\n'),
  }
}

/**
 * The whole environment of the scenario process. HOME is the stand's own empty directory: git,
 * Node and the code under test can find no real credentials of the developer there. The CA
 * reaches git through GIT_CA_FILE and the REST client through NODE_EXTRA_CA_CERTS, as in
 * production. NODE_ENV is not `test`: the local-file git transport of unit tests stays refused.
 */
export function scenarioEnvironment({
  path,
  directory,
  url,
  token,
  gitleaks,
  ownerToken,
  writerToken,
  receiverHost,
}) {
  return {
    PATH: path,
    HOME: `${directory}/home`,
    TMPDIR: `${directory}/tmp`,
    APP_ENV: 'test',
    NODE_EXTRA_CA_CERTS: `${directory}/ca.pem`,
    GIT_CA_FILE: `${directory}/ca.pem`,
    GITEA_URL: url,
    GITEA_TOKEN: token,
    P2_GITLEAKS_BINARY: gitleaks,
    // Tokens of two more accounts of the stand: an owner of the organization (Actions secrets,
    // tag protection) and a second write member (refused a protected tag).
    STAND_OWNER_TOKEN: ownerToken,
    STAND_WRITER_TOKEN: writerToken,
    STAND_RECEIVER_HOST: receiverHost,
  }
}
