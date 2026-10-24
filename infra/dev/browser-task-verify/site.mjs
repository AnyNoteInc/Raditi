// The synthetic WordPress of the browser-task stand: MariaDB and WordPress 7.x (the block editor)
// on a network of their own, the web server on a published loopback port, installed under the
// exact name `wp.raditi.test` that only the egress proxy of a browser session maps to it
// (BROWSER_LOCAL_SITES). An editor and a contributor with passwords of the run, and three must-use
// plugins of the stand (fixture/mu-plugins): the tap of the sign-in cookies, the upload limit of
// scenario I and the slow publish of scenario J, each behind a switch file. Every container,
// network and volume carries the label of the run; the caller removes them.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { callerEnv, exchange } from '../release-verify/runtime.mjs'
import {
  COOKIE_TAP,
  SITE_ACCOUNTS,
  SITE_HOST,
  SITE_ORIGIN,
  STAND_STATE_DIR,
  siteDbArgs,
  siteDbEnvFile,
  siteWebArgs,
  siteWebEnvFile,
  wpCliArgs,
} from './stand.mjs'

const fixture = fileURLToPath(new URL('./fixture/mu-plugins/', import.meta.url))

/**
 * A Docker command whose output is read as it is: the runtime of the stand blacks out every
 * secret it knows in what its commands print, and the stand must see the very values it looks
 * for (the cookies of the site, the logs of a session's containers). Never printed.
 */
export function rawDocker(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      'docker',
      args,
      { env: callerEnv, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code ?? 1) : 0, output: `${stdout}${stderr}` }),
    )
  })
}

/** A row of WordPress's posts table as the scenarios read it. */
const POST_COLUMNS = 'ID, post_type, post_status, post_title, post_parent, post_mime_type'

export async function startSite(rt, names, { directory, port }) {
  const dbPassword = rt.secret(randomBytes(18).toString('base64url'))
  const dbEnv = join(directory, 'site-db.env')
  const webEnv = join(directory, 'site-web.env')
  await writeFile(dbEnv, siteDbEnvFile(dbPassword), { mode: 0o600 })
  await writeFile(webEnv, siteWebEnvFile(dbPassword), { mode: 0o600 })
  await rt.docker(['network', 'create', '--label', names.label, names.network])
  await rt.docker(['volume', 'create', '--label', names.label, names.volumes.docroot])
  await rt.docker(siteDbArgs({ names, envFile: dbEnv }))
  const db = names.containers['site-db']
  await rt.until(
    'MariaDB of the site accepts its user',
    async () =>
      (
        await rt.docker(
          [
            'exec',
            db,
            'sh',
            '-c',
            'mariadb -uwordpress -p"$MARIADB_PASSWORD" -e "SELECT 1" wordpress',
          ],
          { allowFailure: true },
        )
      ).code === 0,
    { timeoutMs: 120_000 },
  )
  await rt.docker(siteWebArgs({ names, port, envFile: webEnv }))
  const web = names.containers['site-web']
  // The egress proxy of a browser session sits on Docker's default bridge as well: there it
  // reaches the web server of the site straight, not through the published port of the Mac
  // (Docker Desktop's forwarding drops connections when a page opens many at once).
  await rt.docker(['network', 'connect', 'bridge', web])
  const bridgeIp = (
    await rt.docker(['inspect', '--format', '{{.NetworkSettings.Networks.bridge.IPAddress}}', web])
  ).output.trim()
  assert.match(bridgeIp, /^\d+\.\d+\.\d+\.\d+$/, 'The site has no address on the default bridge')
  await rt.until(
    'WordPress is in the document root',
    async () =>
      (
        await rt.docker(['exec', web, 'test', '-f', '/var/www/html/wp-config.php'], {
          allowFailure: true,
        })
      ).code === 0,
    { timeoutMs: 120_000 },
  )
  await rt.until(
    'the web server of the site answers',
    async () => {
      const answer = await exchange(`http://127.0.0.1:${port}/`, {
        headers: { host: SITE_HOST },
        signal: rt.signal,
      })
      return answer.status >= 200 && answer.status < 500
    },
    { timeoutMs: 120_000 },
  )

  const wp = (args, { allowFailure = false, input } = {}) =>
    rt.docker(wpCliArgs({ names, envFile: webEnv, args, input: input !== undefined }), {
      allowFailure,
      input,
      timeoutMs: 180_000,
    })
  /** A query of the site's database as its own user: tab-separated rows without a header. */
  const sql = async (query) =>
    (
      await rt.docker([
        'exec',
        db,
        'sh',
        '-c',
        'mariadb -uwordpress -p"$MARIADB_PASSWORD" -N -B wordpress -e "$1"',
        'sh',
        query,
      ])
    ).output.trim()
  const rows = (text) =>
    text === ''
      ? []
      : text.split('\n').map((line) => {
          const [id, type, status, title, parent, mime] = line.split('\t')
          return { id: Number(id), type, status, title, parent: Number(parent), mime }
        })
  const switches = {
    on: (path) => rt.docker(['exec', '-u', '33:33', web, 'touch', path]),
    off: (path) => rt.docker(['exec', '-u', '33:33', web, 'rm', '-f', path]),
    isOn: async (path) =>
      (await rt.docker(['exec', web, 'test', '-e', path], { allowFailure: true })).code === 0,
  }

  const site = {
    port,
    /** Where the egress proxy of a session reaches the site (BROWSER_LOCAL_SITES). */
    target: `${bridgeIp}:80`,
    origin: SITE_ORIGIN,
    web,
    db,
    wp,
    sql,
    switches,
    accounts: {},
    /** Posts and pages and attachments above `after` (the ids before a scenario began). */
    async objects({ after = 0 } = {}) {
      return rows(
        await sql(
          `SELECT ${POST_COLUMNS} FROM wp_posts WHERE ID > ${Number(after)} AND post_type IN ('post', 'page', 'attachment') AND post_status <> 'auto-draft' ORDER BY ID`,
        ),
      )
    },
    /** The highest id of wp_posts now: what a scenario counts its new objects after. */
    async lastId() {
      return Number((await sql('SELECT COALESCE(MAX(ID), 0) FROM wp_posts')) || 0)
    },
    async meta(postId, key) {
      return sql(
        `SELECT meta_value FROM wp_postmeta WHERE post_id = ${Number(postId)} AND meta_key = '${key.replace(/[^a-z_]/g, '')}'`,
      )
    },
    async content(postId) {
      return sql(`SELECT post_content FROM wp_posts WHERE ID = ${Number(postId)}`)
    },
    /** The values of the sign-in cookies the site set so far (the tap of the stand). */
    async cookies() {
      const read = await rawDocker(['exec', web, 'cat', COOKIE_TAP])
      const values =
        read.code === 0 ? read.output.split('\n').filter((line) => line.length > 20) : []
      for (const value of values) {
        rt.secret(value)
        // The parts of a cookie: the token and the HMAC are as secret as the whole.
        for (const part of value.split('|')) if (part.length >= 16) rt.secret(part)
      }
      return values
    },
    /** A page of the site through its published port, with the site's own Host. */
    page: (path) =>
      exchange(`http://127.0.0.1:${port}${path}`, {
        headers: { host: SITE_HOST },
        signal: rt.signal,
      }),
  }
  return site
}

/**
 * WordPress installed at the site's own origin, its default posts and pages deleted (the counts of
 * the scenarios start at nothing), the editor and the contributor with passwords of the run, the
 * folders of the stand outside the document root, the must-use plugins of the fixture.
 */
export async function installSite(rt, site) {
  // Passwords go on stdin (`--prompt`), never in the arguments of a process.
  const adminPassword = rt.secret(randomBytes(18).toString('base64url'))
  await site.wp(
    [
      'core',
      'install',
      `--url=${SITE_ORIGIN}`,
      '--title=Цветочная лавка «Ромашка»',
      '--admin_user=stand-admin',
      '--admin_email=admin@example.test',
      '--skip-email',
      '--prompt=admin_password',
    ],
    { input: `${adminPassword}\n` },
  )
  const version = (await site.wp(['core', 'version'])).output.trim().split('\n').at(-1)
  assert.match(version, /^7\./, `The synthetic site runs WordPress ${version}, not 7.x`)
  await site.wp(['post', 'delete', '1', '2', '3', '--force'], { allowFailure: true })
  for (const [key, account] of Object.entries(SITE_ACCOUNTS)) {
    const password = rt.secret(`Synth-${randomBytes(12).toString('base64url')}`)
    await site.wp([
      'user',
      'create',
      account.login,
      account.email,
      `--role=${account.role}`,
      '--porcelain',
    ])
    await site.wp(['user', 'update', account.login, '--skip-email', '--prompt=user_pass'], {
      input: `${password}\n`,
    })
    site.accounts[key] = { ...account, password }
  }
  await rt.docker([
    'exec',
    site.web,
    'sh',
    '-c',
    `mkdir -p ${STAND_STATE_DIR}/cookies ${STAND_STATE_DIR}/switches /var/www/html/wp-content/mu-plugins && chown -R 33:33 ${STAND_STATE_DIR} /var/www/html/wp-content/mu-plugins && chmod 700 ${STAND_STATE_DIR}/cookies`,
  ])
  const plugins = (await readdir(fixture)).filter((name) => name.endsWith('.php'))
  for (const name of plugins)
    await rt.docker(
      [
        'exec',
        '-i',
        '-u',
        '33:33',
        site.web,
        'sh',
        '-c',
        'cat > "$1"',
        'sh',
        `/var/www/html/wp-content/mu-plugins/${name}`,
      ],
      { input: await readFile(join(fixture, name)) },
    )
  const answer = await site.page('/wp-login.php')
  assert.equal(answer.status, 200, `The sign-in page of the site answered ${answer.status}`)
  return { version, plugins }
}
