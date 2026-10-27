import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// The `site` image of a preview in one container (docs/plan/58-preview-single-container.md, §10):
// what its Dockerfile pins and what init.sh and run-as.sh promise, read from the files. The
// services under their uids, the database, the forwarders and the stop are proven on Docker under
// runc and runsc (plan 58, «Результат» of 58.1); these checks need no daemon.

const here = new URL('./', import.meta.url)
const read = (name) => readFileSync(new URL(name, here), 'utf8')
const dockerfile = read('Dockerfile')
const ignore = read('.dockerignore')
const init = read('init.sh')
const runAs = read('run-as.sh')
const site = dockerfile.slice(dockerfile.indexOf('FROM ${BASE} AS site'))

/** The v4 fingerprint of the first public key of an armored OpenPGP key (RFC 4880, 12.2). */
function fingerprint(armored) {
  const body = armored
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('-----') && !line.startsWith('='))
    .join('')
  const bytes = Buffer.from(body, 'base64')
  const tag = bytes[0]
  assert.equal(tag & 0x80, 0x80, 'a packet')
  let kind
  let length
  let header
  if (tag & 0x40) {
    // New format: the tag in the low six bits, then a length of one, two or five octets.
    kind = tag & 0x3f
    const first = bytes[1]
    if (first < 192) [length, header] = [first, 2]
    else if (first < 224) [length, header] = [((first - 192) << 8) + bytes[2] + 192, 3]
    else [length, header] = [bytes.readUInt32BE(2), 6]
  } else {
    kind = (tag >> 2) & 0x0f
    const lengthType = tag & 0x03
    ;[length, header] =
      lengthType === 0
        ? [bytes[1], 2]
        : lengthType === 1
          ? [bytes.readUInt16BE(1), 3]
          : [bytes.readUInt32BE(1), 5]
  }
  assert.equal(kind, 6, 'a public-key packet first')
  const packet = bytes.subarray(header, header + length)
  const prefix = Buffer.from([0x99, (length >> 8) & 0xff, length & 0xff])
  return createHash('sha1').update(prefix).update(packet).digest('hex').toUpperCase()
}

const sh = (script, env = {}, args = []) =>
  spawnSync('/bin/sh', [new URL(script, here).pathname, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
    timeout: 10_000,
  })

test('the site image: its base, MariaDB, WP-CLI and Node are pinned', () => {
  assert.match(dockerfile, /^ARG BASE=wordpress@sha256:[0-9a-f]{64}$/m)
  assert.ok(dockerfile.indexOf('ARG BASE=') < dockerfile.indexOf('FROM '), 'BASE before any FROM')
  assert.match(site, /^ARG MARIADB_VERSION=\d+\.\d+\.\d+$/m)
  assert.match(site, /archive\.mariadb\.org\/mariadb-\$\{MARIADB_VERSION\}\/repo\/debian/)
  assert.match(site, /"mariadb-server-core=1:\$\{MARIADB_VERSION\}\+maria~deb\$\{debian\}"/)
  assert.match(site, /"mariadb-client-core=1:\$\{MARIADB_VERSION\}\+maria~deb\$\{debian\}"/)
  assert.match(site, /signed-by=\/usr\/share\/keyrings\/mariadb-release\.asc/)
  assert.match(site, /^ADD --checksum=sha256:[0-9a-f]{64} \\\n\s+https:\/\/github\.com\/wp-cli\//m)
  assert.match(site, /^COPY --from=tools \/usr\/local\/bin\/node \/usr\/local\/bin\/node$/m)
  assert.match(site, /--uid 999 --gid 999/)
  assert.match(site, /rm -rf \/var\/lib\/apt\/lists\/\*/)
})

test('the MariaDB key is the one of mariadb.org, by its fingerprint', () => {
  const key = read('mariadb-release-signing-key.asc')
  assert.equal(fingerprint(key), '177F4010FE56CA3336300305F1656F24C74CD1D8')
  assert.match(dockerfile, /177F 4010 FE56 CA33 3630 0305 F165 6F24 C74C D1D8/)
})

test('the site image starts init under tini and stops it by SIGTERM', () => {
  assert.match(site, /^STOPSIGNAL SIGTERM$/m)
  assert.match(
    site,
    /^ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/usr\/local\/lib\/raditi\/init\.sh"\]$/m,
  )
  assert.match(site, /^COPY --chmod=0755 init\.sh run-as\.sh \/usr\/local\/lib\/raditi\/$/m)
  assert.match(site, /^COPY --chmod=0644 forward\.mjs dns\.mjs \/usr\/local\/lib\/raditi\/$/m)
  for (const name of ['init.sh', 'run-as.sh', 'dns.mjs', 'mariadb-release-signing-key.asc'])
    assert.match(ignore, new RegExp(`^!${name.replace('.', '\\.')}$`, 'm'), name)
})

test('init and run-as are shell the image runs: they parse, and nothing traces them', () => {
  for (const script of ['init.sh', 'run-as.sh']) {
    const parsed = spawnSync('/bin/sh', ['-n', new URL(script, here).pathname])
    assert.equal(parsed.status, 0, script)
  }
  assert.doesNotMatch(init, /set -[a-z]*x/)
  assert.doesNotMatch(runAs, /set -[a-z]*x/)
})

test('every service and command runs under its uid with no capability to keep', () => {
  const drop = '--clear-groups \\\n      --bounding-set=-all --inh-caps=-all --no-new-privs'
  assert.ok(init.includes(`setpriv --reuid="\${ids%%:*}" --regid="\${ids##*:}" ${drop}`))
  assert.match(
    init,
    /exec setpriv --bounding-set=-all --inh-caps=-all --no-new-privs -- \/bin\/sh "\$0" --watch/,
  )
  assert.match(runAs, /--bounding-set=-all --inh-caps=-all --no-new-privs -- \/bin\/sh -c/)
  for (const [service, ids] of [
    ['dns', 'FORWARDER'],
    ['db', 'DATABASE'],
    ['web', 'WEB'],
    ['forward', 'FORWARDER'],
  ])
    assert.match(init, new RegExp(`start ${service} "\\$${ids}"`), service)
  assert.match(init, /^WEB=33:33$/m)
  assert.match(init, /^DATABASE=999:999$/m)
  assert.match(init, /^FORWARDER=10001:10001$/m)
})

test('the passwords of the database never reach an argument, the environment or the log', () => {
  // They are read by the database's uid into the SQL of its first start, on the tmpfs, and the
  // file goes once the server answers.
  assert.match(init, /user=\$\(cat "\$1\/user"\)/)
  assert.match(init, /--init-file=\$SECRETS\/init\.sql/)
  assert.match(init, /as "\$DATABASE" rm -f "\$SECRETS\/init\.sql"/)
  for (const line of init.split('\n').filter((text) => /\becho\b|printf/.test(text)))
    assert.doesNotMatch(line, /\$(user|root)\b/, line)
})

test('init refuses what is not its input before it starts anything', () => {
  const base = {
    RADITI_DNS_SERVERS: '77.88.8.8,77.88.8.1',
    RADITI_HTTP_HOST: 'site-ab12cd-chat-ef34ab.raditi-preview.ru',
    RADITI_WEB_PORT: '8081',
    RADITI_DATABASE: '1',
  }
  const args = ['apache2-foreground']
  for (const [patch, code] of [
    [{ RADITI_DNS_SERVERS: '' }, 70],
    [{ RADITI_DNS_SERVERS: '77.88.8.8 77.88.8.1' }, 70],
    [{ RADITI_DNS_SERVERS: '256.1.1.1' }, 70],
    [{ RADITI_DNS_SERVERS: '01.2.3.4' }, 70],
    [{ RADITI_DNS_SERVERS: 'dns.example' }, 70],
    [{ RADITI_DNS_SERVERS: '1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4' }, 70],
    [{ RADITI_HTTP_HOST: 'Site.example' }, 64],
    [{ RADITI_HTTP_HOST: 'a;b' }, 64],
    [{ RADITI_WEB_PORT: '80a' }, 64],
    [{ RADITI_DATABASE: 'yes' }, 64],
  ]) {
    const run = sh('init.sh', { ...base, ...patch }, args)
    assert.equal(run.status, code, JSON.stringify(patch))
    assert.match(run.stderr, /^raditi-preview: /)
  }
  assert.equal(sh('init.sh', base, []).status, 64, 'no command of the web server')
})

test('run-as takes uid:gid, whole seconds and a command, and nothing else', () => {
  for (const args of [
    [],
    ['33:33'],
    ['33', '5', '--', 'true'],
    ['33:', '5', '--', 'true'],
    [':33', '5', '--', 'true'],
    ['www-data', '5', '--', 'true'],
    ['33:33', '5s', '--', 'true'],
    ['33:33', '5', '--'],
  ]) {
    const run = sh('run-as.sh', {}, args)
    assert.equal(run.status, 64, JSON.stringify(args))
  }
})
