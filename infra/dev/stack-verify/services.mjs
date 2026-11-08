// The services of the stand of the site stacks that the release stand does not start (verify-stack.mjs;
// docs/plan/62-slices/e3.md, Э3.10): the provisioner of repositories in Gitea, the production of a build
// — the image `site` of its PHP with prod/entry.sh, its database inside, the tree of the archive in the
// volume of its document root — and the SFTP hosting over that volume. Every container, network and
// volume is labelled with the run; the caller removes them. The tree of a CMS is only copied here: it
// runs in the production container.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { join } from 'node:path'

import { generatedGiteaPassword, giteaAccountArgs } from '../gitea-verify/stand.mjs'
import { startHosting } from '../release-verify/services.mjs'
import { PRODUCTION_ROOT, productionArgs } from './stand.mjs'

/** The files of the production container, copied into its /prod (the folder holds these only). */
const PROD_FOLDER = new URL('./prod/', import.meta.url).pathname
const PROD_FILES = ['entry.sh', 'apache.conf']

/**
 * A command whose output is a value of the run itself — a password the container holds, a dump the
 * scenarios search — and therefore never redacted: its stdout as bytes, its stderr kept for a
 * failure only, which says the tail of it redacted.
 */
export function rawCommand(rt, file, args, { input, timeoutMs = 120_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: AbortSignal.any([rt.signal, AbortSignal.timeout(timeoutMs)]),
    })
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      const stdout = Buffer.concat(out)
      if (code === 0) return resolve(stdout)
      const tail = rt.redact(Buffer.concat(err).toString('utf8').slice(-1500))
      reject(new Error(`${file} ${args.slice(0, 3).join(' ')}… exited ${code}: ${tail}`))
    })
    child.stdin.on('error', () => {})
    if (input === undefined) child.stdin.end()
    else if (typeof input === 'string' || Buffer.isBuffer(input)) child.stdin.end(input)
    else input.pipe(child.stdin)
  })
}

/**
 * The provisioner of repositories of the first import (as site-import-verify makes it): an account
 * in a team of `sites` that may create repositories and nothing more — Gitea makes it an
 * administrator of each one it creates — with a token for core (GITEA_PROVISIONER_TOKEN).
 */
export async function addProvisioner(rt, gitea) {
  const created = await rt.docker(
    giteaAccountArgs({ container: gitea.name, user: 'raditi-provisioner' }),
  )
  const provisioner = {
    user: 'raditi-provisioner',
    password: rt.secret(generatedGiteaPassword(created.output)),
  }
  const admin = { token: gitea.tokens.admin }
  const team = await gitea.api('POST', '/orgs/sites/teams', {
    as: admin,
    body: {
      name: 'provisioners',
      permission: 'read',
      includes_all_repositories: false,
      can_create_org_repo: true,
      units: ['repo.code'],
    },
    expect: 201,
  })
  await gitea.api('PUT', `/teams/${team.json.id}/members/${provisioner.user}`, {
    as: admin,
    expect: 204,
  })
  const token = await gitea.api('POST', `/users/${provisioner.user}/tokens`, {
    as: provisioner,
    body: { name: 'raditi-provisioner', scopes: ['write:organization', 'write:repository'] },
    expect: 201,
  })
  return rt.secret(token.json.sha1)
}

/**
 * The production of one build, with its hosting: the network and the volumes of the build, the
 * container `site` of its PHP started with prod/entry.sh, the password of its database written to
 * the container's own file on stdin, the tree of the archive in the document root. `exec` and `sql`
 * act in the container as root; `origin` is where the site answers on this machine.
 */
export async function startProduction(rt, names, { image, treeFolder, port, directory }) {
  for (const file of PROD_FILES)
    if (!existsSync(join(PROD_FOLDER, file))) throw new Error(`No file of the production: ${file}`)
  const name = names.containers.prod
  await rt.docker(['network', 'create', '--label', names.label, names.network])
  for (const volume of [names.volumes.docroot, names.volumes.db])
    await rt.docker(['volume', 'create', '--label', names.label, volume])
  await rt.docker(productionArgs({ names, image, port }))
  await rt.docker(['cp', `${PROD_FOLDER}.`, `${name}:/prod`])
  await rt.docker(['start', name])
  // Letters and digits only (prod/entry.sh quotes it into one statement); on stdin, never an argument.
  const password = rt.secret(randomBytes(18).toString('base64url').replace(/[-_]/g, 'x'))
  await rawCommand(
    rt,
    'docker',
    [
      'exec',
      '-i',
      name,
      'sh',
      '-c',
      'umask 077 && mkdir -p /prod-secrets && cat > /prod-secrets/db',
    ],
    { input: password },
  )
  await rt.until(
    'the database of the production',
    async () =>
      (await rt.docker(['exec', name, 'test', '-f', '/tmp/prod-ready'], { allowFailure: true }))
        .code === 0,
    { timeoutMs: 120_000 },
  )
  // The tree of the archive into the volume: copied here, run only in the container.
  const packed = spawn('tar', ['-C', treeFolder, '-cf', '-', '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await rawCommand(rt, 'docker', ['exec', '-i', name, 'tar', '-C', PRODUCTION_ROOT, '-xf', '-'], {
    input: packed.stdout,
    timeoutMs: 600_000,
  })
  await rt.docker(['exec', name, 'chown', '-R', '33:33', PRODUCTION_ROOT])
  const dbPort = Number(
    /:(\d+)\s*$/m.exec((await rt.docker(['port', name, '3306/tcp'])).output)?.[1],
  )
  if (!Number.isInteger(dbPort)) throw new Error('The database of the production has no port')

  const exec = async (argv, stdin) =>
    (
      await rawCommand(
        rt,
        'docker',
        ['exec', ...(stdin === undefined ? [] : ['-i']), name, ...argv],
        { input: stdin, timeoutMs: 600_000 },
      )
    ).toString('utf8')
  const sql = (query) =>
    exec(
      [
        'mariadb',
        '--no-defaults',
        '--socket=/run/mysqld/mysqld.sock',
        '--user=root',
        '--default-character-set=utf8mb4',
        '--batch',
        '--skip-column-names',
        'site',
      ],
      query,
    )
  const buildDirectory = join(directory, 'builds', names.containers.prod)
  await mkdir(buildDirectory, { recursive: true, mode: 0o700 })
  return {
    name,
    exec,
    sql,
    port,
    origin: `http://localhost:${port}`,
    dbPort,
    dbPassword: password,
    directory: buildDirectory,
  }
}

/** The SFTP hosting over the document root of a build: the hosting of the release stand, its names. */
export async function startBuildHosting(rt, names, { production, port }) {
  return startHosting(rt, names, { directory: production.directory, port })
}

/**
 * A folder of the hosting outside the document root, written by the stand as root and given to the
 * user of SFTP (uid 33): what a client points the wizard at. `files` — relative path → text.
 */
export async function writeHostingFolder(rt, names, folder, files) {
  if (!/^\/stand-roots\/[a-z0-9-]+$/.test(folder)) throw new Error('Invalid folder of the stand')
  const name = names.containers.hosting
  for (const [path, text] of Object.entries(files)) {
    if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(path)) throw new Error('Invalid path')
    await rt.docker(
      [
        'exec',
        '-i',
        name,
        'sh',
        '-c',
        'mkdir -p "$(dirname "$1")" && cat > "$1"',
        'sh',
        `${folder}/${path}`,
      ],
      { input: text },
    )
  }
  await rt.docker(['exec', name, 'chown', '-R', '33:33', folder])
}

/**
 * The relays of the stand on Linux and in a VM (stand.mjs, `hostRelays`; docs/plan/62-slices/e3.md,
 * Э3.16): a plain TCP forwarder in this process per role, `<listen>:<port>` → `<to>:<port>`. The
 * roles listen on loopback; a container that goes to the host meets the relay on the bridge
 * gateway. Resolves once every relay listens; `close()` stops them and every open connection.
 */
export async function startRelays(relays) {
  const servers = []
  const sockets = new Set()
  // Open connections first: a server closes only when the last of its connections did.
  const close = async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map((server) => new Promise((done) => server.close(() => done()))))
  }
  try {
    for (const relay of relays) {
      const server = createServer((inbound) => {
        const outbound = connect({ host: relay.to, port: relay.port })
        for (const end of [inbound, outbound]) {
          sockets.add(end)
          end.once('close', () => sockets.delete(end))
          end.on('error', () => {
            inbound.destroy()
            outbound.destroy()
          })
        }
        inbound.pipe(outbound).pipe(inbound)
      })
      servers.push(server)
      await new Promise((resolve, reject) => {
        server.once('error', (error) =>
          reject(
            new Error(
              `The relay of ${relay.role} cannot listen on ${relay.listen}:${relay.port}: ${error.message}`,
            ),
          ),
        )
        server.listen(relay.port, relay.listen, () => resolve())
      })
    }
  } catch (error) {
    await close()
    throw error
  }
  return { relays, close }
}
