// Pure parts of the projects stand (verify-projects.mjs, docs/plan/84-projects.md §6): its
// options, the names of what a run owns, the images it builds, the environments of the processes
// it starts and the arguments of the forwarder of 443. Nothing here touches Docker, the network or
// a file. The services and the build come from the browser-task stand (../browser-task-verify),
// whose environments this one starts from: the same apps, without the browser of a chat and with
// the git of projects.
import { isAbsolute } from 'node:path'

import {
  BUILT_IMAGES as BROWSER_TASK_IMAGES,
  appEnvironment,
  webEnvironment,
} from '../browser-task-verify/stand.mjs'
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
 * attaches the repository the rest works on.
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
  N: ['S'],
  M: ['S'],
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

/** `--no-build`, `--keep`, `--only a,b`; nothing names a database, a host or a key. */
export function standOptions(argv) {
  const options = { build: true, keep: false, webDev: false, only: null }
  const args = argv.filter((value) => value !== '--')
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--no-build') options.build = false
    else if (arg === '--keep') options.keep = true
    else if (arg === '--only' || arg.startsWith('--only=')) {
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
        'This stand accepts --no-build, --keep and --only only; it takes no database, host or key',
      )
  }
  return options
}

// ─── Processes ────────────────────────────────────────────────────────────────

/** The host names of the fake's certificate: the own server and gitlab.com. */
export const FAKE_HOSTS = Object.freeze([OWN_HOST, COM_HOST])

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
    if (!isAbsolute(context.git.mirrorDir)) throw new Error('GIT_MIRROR_DIR is an absolute path')
    return {
      ...env,
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
  return { ...env, ...git, NODE_EXTRA_CA_CERTS: context.caFile }
}

/**
 * The forwarder of 443: macOS lets no user bind 443 on loopback, Docker Desktop does. Git reaches
 * a repository at `https://<host>/<path>.git` on 443 only (and the API of an own server too), so
 * 127.0.0.1:443 and [::1]:443 go to the fake on the stand's own port. A node of the gateway image
 * of this tree — nothing is pulled.
 */
export function forwarderArgs({ names, image, fakePort }) {
  if (!Number.isInteger(fakePort) || fakePort < 1024 || fakePort > 65_535)
    throw new Error('Invalid port')
  const program = [
    "const net = require('node:net');",
    `net.createServer((c) => { const u = net.connect(${fakePort}, 'host.docker.internal');`,
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
