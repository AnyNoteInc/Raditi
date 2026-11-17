// Pure parts of the projects stand (verify-projects.mjs, docs/plan/84-projects.md §6): its
// options, the names of what a run owns, the images it builds, the environments of the processes
// it starts and the arguments of the forwarder of 443. Nothing here touches Docker, the network or
// a file. The services and the build come from the browser-task stand (../browser-task-verify),
// whose environments this one starts from: the same apps, without the browser of a chat and with
// the git of projects.
import { isAbsolute } from 'node:path'

import {
  BUILT_IMAGES as BROWSER_TASK_IMAGES,
  HOST_NAME,
  RUNTIMES,
  appEnvironment,
  hostIn,
  hostRelays,
  webEnvironment,
} from '../browser-task-verify/stand.mjs'
import { GITHUB_HOST } from './fake-github.mjs'
import { COM_HOST, OWN_HOST } from './fake-gitlab.mjs'

export const STAND = 'projects-verify'
export const STAND_LABEL = 'io.raditi.projects-verify'
const RUN = /^[0-9a-f]{8}$/

/** Every resource of one run by name; nothing outside these names is created or removed by name. */
export function standNames(run) {
  if (typeof run !== 'string' || !RUN.test(run)) throw new Error('Invalid run id of the stand')
  const stand = `raditi-${STAND}-${run}`
  return {
    run,
    stand,
    label: `${STAND_LABEL}=${run}`,
    containers: Object.fromEntries(
      ['postgres', 'redis', 's3', 'openbao', 'forwarder'].map((name) => [name, `${stand}-${name}`]),
    ),
  }
}

/** The images of a turn: the sandbox, its gateway and its guard (no browser in this stand). */
export const BUILT_IMAGES = Object.freeze(
  Object.fromEntries(
    ['sandbox', 'gateway', 'guard'].map((name) => [
      name,
      {
        ...BROWSER_TASK_IMAGES[name],
        tag: BROWSER_TASK_IMAGES[name].tag.replace('browser-task-verify', STAND),
      },
    ]),
  ),
)

/** How build.mjs of the browser-task stand builds this one: its folder, stamps and images. */
export const PROJECTS_BUILD = Object.freeze({
  name: STAND,
  envPrefix: 'PROJECTS_VERIFY',
  own: 'infra/dev/projects-verify/',
  images: BUILT_IMAGES,
})

// ─── Options and scenarios ────────────────────────────────────────────────────

/**
 * The scenarios in their order (README, «Сценарии») and what each needs first. S signs the owner
 * up and switches the model on; A makes the project the others use; D and K connect GitLab; E
 * attaches the repository the rest works on; F opens the second chat whose request I merges when
 * its build passes; W takes the hook of that repository, reruns its builds and reverts the merge of
 * I; P is the GitHub App on its own project; M puts projects into the trash and purges them.
 */
export const SCENARIO_IDS = Object.freeze([
  'S',
  'A',
  'B',
  'C',
  'K',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'W',
  'P',
  'L',
  'N',
  'M',
])
const NEEDS = Object.freeze({
  S: [],
  A: ['S'],
  B: ['S', 'A'],
  C: ['S', 'A'],
  K: ['S', 'A'],
  D: ['S', 'A'],
  E: ['S', 'A', 'K'],
  F: ['S', 'A', 'K', 'E'],
  G: ['S', 'A', 'K', 'E', 'F'],
  H: ['S', 'A', 'K', 'E', 'F'],
  I: ['S', 'A', 'K', 'E', 'F', 'H'],
  J: ['S', 'A', 'K', 'E', 'F', 'H', 'I'],
  W: ['S', 'A', 'K', 'E', 'F', 'H', 'I'],
  P: ['S', 'A'],
  L: ['S', 'A', 'K', 'E'],
  N: ['S'],
  M: ['S', 'A'],
})

export function scenariosToRun(only) {
  if (only === null) return [...SCENARIO_IDS]
  const wanted = new Set()
  const add = (id) => {
    for (const need of NEEDS[id]) add(need)
    wanted.add(id)
  }
  for (const id of only) add(id)
  return SCENARIO_IDS.filter((id) => wanted.has(id))
}

/**
 * `--no-build`, `--keep`, `--only a,b`, `--runtime=runc|runsc` (the sandbox of a turn; runsc on
 * Linux only); nothing names a database, a host or a key.
 */
export function standOptions(argv) {
  const options = { build: true, keep: false, webDev: false, only: null, runtime: 'runc' }
  const args = argv.filter((value) => value !== '--')
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--no-build') options.build = false
    else if (arg === '--keep') options.keep = true
    else if (arg.startsWith('--runtime=')) {
      const runtime = arg.slice('--runtime='.length)
      if (!RUNTIMES.includes(runtime)) throw new Error('--runtime is runc or runsc')
      options.runtime = runtime
    } else if (arg === '--only' || arg.startsWith('--only=')) {
      const value = arg === '--only' ? args[++index] : arg.slice('--only='.length)
      const ids = String(value ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
      for (const id of ids)
        if (!SCENARIO_IDS.includes(id)) throw new Error(`Unknown scenario ${id}`)
      if (ids.length === 0) throw new Error('--only names at least one scenario')
      options.only = ids
    } else
      throw new Error(
        'This stand accepts --no-build, --keep, --only and --runtime only; it takes no database, host or key',
      )
  }
  return options
}

// ─── Processes ────────────────────────────────────────────────────────────────

/** The host names of the fakes' certificate: the own server, gitlab.com and github.com. */
export const FAKE_HOSTS = Object.freeze([OWN_HOST, COM_HOST, GITHUB_HOST])

/**
 * core's APP_URL: a hook of a GitLab project is made only for an `https` address (84.26). Core puts
 * it into letters and hooks only; the fake GitLab delivers to web's own address in its place.
 */
export const CORE_APP_URL = 'https://raditi.localhost'

/** What the stand never gives core or mcp: there is no browser of a chat here. */
const NO_BROWSER = ['BROWSER_WORKER_URL', 'BROWSER_WORKER_TOKEN', 'BROWSER_SESSION_MAX_HOURS']
/**
 * The browser-task stand names the ports of the browser and its stream in every environment; this
 * stand runs neither and takes out what names them, so they stand at a port nothing listens on.
 */
const noBrowserPorts = (context) => ({
  ...context,
  ports: { browser: 65_535, stream: 65_535, ...context.ports },
})
const without = (env, names) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)))

/** The git of projects, as core, its git worker and web read it (outside production only). */
function gitOf(context) {
  const { git } = context
  return {
    RADITI_FAKE_GITHUB_API_URL: git.github.origin,
    GIT_CA_FILE: context.caFile,
    GIT_ALLOW_LOOPBACK: '1',
    RADITI_FAKE_GITLAB_COM_URL: `https://localhost:${git.fakePort}`,
    GITLAB_OAUTH_CLIENT_ID: git.oauth.clientId,
    GITLAB_OAUTH_CLIENT_SECRET: git.oauth.secret,
    REPO_CONFIRM_SECRET: git.confirmSecret,
  }
}

/** The environment of an app of the platform: the browser-task stand's, the browser out, git in. */
export function projectAppEnvironment(app, context) {
  const env = without(appEnvironment(app, noBrowserPorts(context)), NO_BROWSER)
  if (app === 'core') {
    const { GIT_CA_FILE, GIT_ALLOW_LOOPBACK, ...apps } = gitOf(context)
    const { git } = context
    if (!isAbsolute(git.mirrorDir)) throw new Error('GIT_MIRROR_DIR is an absolute path')
    if (!isAbsolute(git.github.keyFile)) throw new Error('The key of the GitHub App is a file')
    return {
      ...env,
      APP_URL: CORE_APP_URL,
      GITHUB_APP_ID: git.github.appId,
      GITHUB_APP_PRIVATE_KEY_FILE: git.github.keyFile,
      SANDBOX_DEPLOYMENT: `${STAND}-${context.run}`,
      GIT_MIRROR_DIR: context.git.mirrorDir,
      GIT_CA_FILE,
      GIT_ALLOW_LOOPBACK,
      ...apps,
    }
  }
  return env
}

/** The git worker: the volume of the mirrors, the CA of the stand, loopback for its fakes. */
export function gitWorkerEnvironment(context) {
  return {
    PATH: context.path,
    HOME: `${context.directory}/home`,
    TMPDIR: `${context.directory}/tmp`,
    NODE_ENV: 'production',
    NO_COLOR: '1',
    APP_ENV: 'test',
    GIT_MIRROR_DIR: context.git.mirrorDir,
    GIT_CA_FILE: context.caFile,
    GIT_ALLOW_LOOPBACK: '1',
  }
}

/** web: no stream of a browser; the sign-in on gitlab.com through the fake, its CA trusted. */
export function projectWebEnvironment(context, options) {
  const env = without(webEnvironment(noBrowserPorts(context), options), [
    'BROWSER_STREAM_PUBLIC_URL',
  ])
  const { GIT_CA_FILE: _ca, ...git } = gitOf(context)
  const { github } = context.git
  return {
    ...env,
    ...git,
    RADITI_FAKE_GITHUB_WEB_URL: github.origin,
    GITHUB_APP_SLUG: github.slug,
    GITHUB_APP_CLIENT_ID: github.clientId,
    GITHUB_APP_CLIENT_SECRET: github.clientSecret,
    GITHUB_APP_WEBHOOK_SECRET: github.webhookSecret,
    NODE_EXTRA_CA_CERTS: context.caFile,
  }
}

/**
 * The ports of this machine the containers of a run reach (`hostRelays` on Linux and in a VM): llm
 * and mcp for the gateway of a turn, the fake GitLab for the forwarder of 443.
 */
export function relayedPorts(ports) {
  return { llm: ports.llm, mcp: ports.mcp, gitlab: ports.gitlab }
}

/** The relays of a run: none on Docker Desktop (stand.mjs of the browser-task stand, `hostOf`). */
export const projectRelays = (host, ports) => hostRelays(host, relayedPorts(ports))

/**
 * What the sandbox of a turn tries to reach on the host (scenario E): every address the host has
 * for containers — `host-gateway` and the gateway of the default bridge, where the relays listen
 * on Linux — at every port the stand opens there. The host rules of a turn leave the sandbox only
 * its gateway (spec §8): none of them may connect.
 */
export function hostProbes(host, ports) {
  const addresses = [...new Set([host.hostGateway, host.bridgeGateway].filter(Boolean))]
  return addresses.flatMap((address) =>
    Object.values(relayedPorts(ports)).map((port) => `${address}:${port}`),
  )
}

/**
 * The control of the probes: the gateway of the turn, the one address the host rules leave the
 * sandbox. It must connect, or a refusal of the probes would prove nothing.
 */
export const PROBE_CONTROL = 'sandbox-gw:8080'

/**
 * Whether a kernel release is the one gVisor reports to what runs under it (`uname -r` in the
 * sandbox, E): `4.19.0-gvisor` of the runsc in the Colima VM, `4.4.0` of older releases.
 */
export const gvisorKernel = (release) => /-gvisor$/.test(release ?? '') || release === '4.4.0'

/** `probe <host>:<port>=<code>` lines of the sandbox (programs.mjs, changeRepository). */
export function probeAnswers(text) {
  return Object.fromEntries(
    [...String(text).matchAll(/^probe ([\w.-]+:\d+)=(\d+)$/gm)].map(([, target, code]) => [
      target,
      code,
    ]),
  )
}

/**
 * The remote ports of the TCP sockets of a process on Linux (scenario N), from the tables of its
 * network namespace (`/proc/<pid>/net/tcp` and `tcp6`) and the inodes of its descriptors: what
 * `lsof -i` of macOS names. A listening socket has no remote port.
 */
export function procRemotePorts(tables, inodes) {
  const ports = []
  for (const table of tables)
    for (const line of String(table).split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 10 || !inodes.has(fields[9])) continue
      const port = Number.parseInt(fields[2].split(':').at(-1) ?? '', 16)
      if (Number.isInteger(port) && port > 0) ports.push(String(port))
    }
  return ports
}

/**
 * The forwarder of 443: no user of this machine may bind 443 on loopback (macOS; Linux below
 * `ip_unprivileged_port_start`), the daemon may. Git reaches a repository at
 * `https://<host>/<path>.git` on 443 only (and the API of an own server too), so 127.0.0.1:443
 * and [::1]:443 go to the fake on the stand's own port. A node of the gateway image of this tree —
 * nothing is pulled — on the default bridge, read-only, without capabilities, published on
 * loopback only, on every kind of host. It reaches the fake where the host is for containers
 * (`hostOf`): Docker Desktop carries `host.docker.internal` to the loopback of the Mac; on Linux
 * that name is `host-gateway` — the bridge gateway, where the relay of the stand carries it on to
 * the fake on loopback; in a VM the bridge gateway by its address.
 */
export function forwarderArgs({ names, image, fakePort, host: given }) {
  if (!Number.isInteger(fakePort) || fakePort < 1024 || fakePort > 65_535)
    throw new Error('Invalid port')
  const host = hostIn({ host: given })
  const program = [
    "const net = require('node:net');",
    `net.createServer((c) => { const u = net.connect(${fakePort}, '${host.upstream}');`,
    "c.pipe(u); u.pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy()); })",
    ".listen(8443, '0.0.0.0');",
  ].join(' ')
  return [
    ...[
      'run',
      '-d',
      '--pull',
      'never',
      '--name',
      names.containers.forwarder,
      '--label',
      names.label,
    ],
    ...['-p', '127.0.0.1:443:8443', '-p', '[::1]:443:8443', '--read-only', '--cap-drop', 'ALL'],
    // Docker Desktop resolves the name itself; on Linux only `host-gateway` gives it.
    ...(host.kind === 'linux' ? ['--add-host', `${HOST_NAME}:host-gateway`] : []),
    ...['--entrypoint', 'node', image, '-e', program],
  ]
}

// ─── Output ───────────────────────────────────────────────────────────────────

/** Every value of `secrets` (6+ characters) that occurs in `text`, by its name: none is right. */
export function leakedIn(text, secrets) {
  const found = []
  for (const [name, value] of Object.entries(secrets))
    if (typeof value === 'string' && value.length >= 6 && text.includes(value)) found.push(name)
  return found
}
