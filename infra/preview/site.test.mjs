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

// The base every stack stands on (docs/plan/62, Т19, Т21): the official image of one PHP version,
// the stage `php-base` that `site` takes with --build-arg BASE=php-base, and site-bases.json.
const stage = (from, to) => {
  const start = dockerfile.indexOf(from)
  assert.ok(start >= 0, from)
  const end = dockerfile.indexOf(to, start)
  return dockerfile.slice(start, end < 0 ? undefined : end)
}
const globalArg = (name) => {
  const head = dockerfile.slice(0, dockerfile.indexOf('FROM '))
  const line = head.match(new RegExp(`^ARG ${name}=(.*)$`, 'm'))
  assert.ok(line, `ARG ${name} before the first FROM`)
  return line[1].replace(/^"(.*)"$/, '$1')
}
const stageArg = (text, name) => {
  const line = text.match(new RegExp(`^ARG ${name}=(.*)$`, 'm'))
  assert.ok(line, `ARG ${name}`)
  return line[1].replace(/^"(.*)"$/, '$1')
}
/** Т19: the versions of PHP a preview runs on, in this order. */
const PHP_VERSIONS = ['7.3', '7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5']
/** Т21: the 26 names of the installer; with ionCube, 27. */
const EXTENSIONS = [
  'apcu',
  'bcmath',
  'bz2',
  'calendar',
  'exif',
  'gd',
  'gettext',
  'gmp',
  'imagick',
  'intl',
  'ldap',
  'mcrypt',
  'memcached',
  'mysqli',
  'opcache',
  'pdo_mysql',
  'redis',
  'shmop',
  'soap',
  'sockets',
  'sysvmsg',
  'sysvsem',
  'sysvshm',
  'xmlrpc',
  'xsl',
  'zip',
]
/** Nine names no version goes without (Т21). */
const REQUIRED = [
  'bcmath',
  'exif',
  'gd',
  'imagick',
  'intl',
  'mysqli',
  'zip',
  'pdo_mysql',
  'opcache',
]
/** The extensions of PECL among the 26; xmlrpc is in the core of PHP until 8.0. */
const peclNames = (php) => [
  'apcu',
  'imagick',
  'mcrypt',
  'memcached',
  'redis',
  ...(php === '7.3' || php === '7.4' ? [] : ['xmlrpc']),
]
/** The codenames the MariaDB step of `site` knows, read from its `case`, `*)` left out. */
const debianCodenames = () => {
  const step = site.match(/case "\$VERSION_CODENAME" in([\s\S]*?)esac/)
  assert.ok(step, 'the MariaDB step of site reads VERSION_CODENAME')
  const names = [...step[1].matchAll(/([a-z]+)\) debian=\d+/g)].map((match) => match[1])
  assert.ok(names.length > 0, 'the MariaDB step names its codenames')
  return names
}
const phpBase = () => stage('FROM ${PHP_BASE} AS php-base', 'FROM ${BASE} AS site')
const parseIni = (text) =>
  Object.fromEntries(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith(';'))
      .map((line) => {
        const at = line.indexOf('=')
        assert.ok(at > 0, line)
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
      }),
  )

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
  for (const name of [
    'init.sh',
    'run-as.sh',
    'dns.mjs',
    'mariadb-release-signing-key.asc',
    'preview-php.ini',
    'no-sendmail',
  ])
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

test('the table of bases: eight versions by the digest of an index', () => {
  const { versions } = JSON.parse(read('site-bases.json'))
  assert.deepEqual(
    versions.map((row) => row.php),
    PHP_VERSIONS,
  )
  const debian = debianCodenames()
  for (const row of versions) {
    assert.match(row.image, /^php@sha256:[0-9a-f]{64}$/, row.php)
    assert.ok(debian.includes(row.debian), `${row.php}: ${row.debian}`)
    assert.ok(row.tag.startsWith(`${row.php}-`), `${row.php}: ${row.tag}`)
    for (const name of row.without) {
      assert.ok(EXTENSIONS.includes(name), `${row.php}: ${name} is not among the 26`)
      assert.ok(!REQUIRED.includes(name), `${row.php} cannot go without ${name}`)
    }
    for (const pin of row.pecl) assert.match(pin, /^[a-z]+-\d[\w.]*$/, `${row.php}: ${pin}`)
    assert.deepEqual(
      row.pecl.map((pin) => pin.slice(0, pin.indexOf('-'))).sort(),
      peclNames(row.php)
        .filter((name) => !row.without.includes(name))
        .sort(),
      `${row.php}: a version for every extension of PECL it has`,
    )
  }
  assert.equal(new Set(versions.map((row) => row.image)).size, versions.length, 'no image twice')
  const php83 = versions.find((row) => row.php === '8.3')
  assert.deepEqual(php83.without, [], '8.3 is the version of WordPress: nothing goes')
  assert.ok(php83.pecl.includes('imagick-3.8.1'), 'the imagick of the WordPress image')
  assert.equal(globalArg('PHP_BASE'), php83.image)
  assert.equal(stageArg(phpBase(), 'PHP_PECL_PINS'), php83.pecl.join(' '))
})

test('php-base: the installer and ionCube are pinned and stay out of the image', () => {
  const installer = stage('FROM scratch AS php-extension-installer', '\nFROM ')
  const ioncube = stage('FROM scratch AS ioncube-archive-amd64', 'FROM ${PHP_BASE} AS php-base')
  const base = phpBase()
  assert.equal(installer.match(/--checksum=sha256:[0-9a-f]{64}\b/g)?.length, 1, 'the installer')
  assert.match(
    installer,
    /https:\/\/github\.com\/mlocati\/docker-php-extension-installer\/releases\/download\/\d+\.\d+\.\d+\/install-php-extensions/,
  )
  assert.doesNotMatch(installer, /latest/)
  assert.equal(
    ioncube.match(/--checksum=sha256:[0-9a-f]{64}\b/g)?.length,
    2,
    'ionCube, amd64 and arm64',
  )
  assert.match(ioncube, /^FROM ioncube-archive-\$\{TARGETARCH\} AS ioncube-archive$/m)
  // Each stage of an architecture takes the Loader of that architecture.
  for (const [arch, file] of [
    ['amd64', 'x86-64'],
    ['arm64', 'aarch64'],
  ])
    assert.match(
      ioncube,
      new RegExp(
        `^FROM scratch AS ioncube-archive-${arch}\\nADD --checksum=sha256:[0-9a-f]{64} \\\\\\n\\s+https://downloads\\.ioncube\\.com/loader_downloads/ioncube_loaders_lin_${file}\\.tar\\.gz /ioncube\\.tar\\.gz$`,
        'm',
      ),
      arch,
    )
  assert.match(
    base,
    /--mount=type=bind,from=php-extension-installer,source=\/install-php-extensions,target=\/usr\/local\/bin\/install-php-extensions/,
  )
  assert.match(
    base,
    /--mount=type=bind,from=ioncube-archive,source=\/ioncube\.tar\.gz,target=\/tmp\/ioncube\.tar\.gz/,
  )
  // Nothing copies the installer or the archive into an image.
  assert.doesNotMatch(dockerfile, /COPY --from=(php-extension-installer|ioncube-archive)/)
  const list = base.match(/for name in ([^;]+); do/)
  assert.ok(list, 'the list of the installer')
  const names = list[1].replace(/\\\n/g, ' ').trim().split(/\s+/)
  assert.deepEqual(names, EXTENSIONS)
  assert.ok(!names.includes('ioncube_loader') && names.includes('pdo_mysql'))
  assert.ok(!names.includes('amqp') && !names.includes('memcache'))
  assert.match(base, /^\s+install-php-extensions \$names; \\$/m)
  assert.doesNotMatch(dockerfile, /sury/i)
  assert.ok(base.includes('if [ "$php_version" != 8.0 ]; then'), 'no ionCube on PHP 8.0')
  assert.match(base, /ioncube\/LICENSE\.txt/)
  const first = dockerfile.indexOf('FROM ')
  for (const name of ['BASE', 'PHP_BASE', 'TARGETARCH'])
    assert.ok(new RegExp(`^ARG ${name}\\b`, 'm').test(dockerfile.slice(0, first)), name)
  // php-base stands before site, and site is the same: BASE alone moves it over.
  assert.ok(dockerfile.indexOf('AS php-base') < dockerfile.indexOf('AS site'))
  assert.doesNotMatch(site, /install-php-extensions|ioncube|RUN a2dismod/)
})

/** Runs the loop of php-base that builds the names for the installer, as the build does. */
function installerNames(pins, skip) {
  const text = phpBase()
  const start = text.indexOf('names=;')
  const end = text.indexOf('done; \\\n    install-php-extensions', start)
  assert.ok(start >= 0 && end > start, 'the loop of the names')
  const loop = text.slice(start, end + 'done;'.length).replace(/\\\n/g, ' ')
  const run = spawnSync('/bin/sh', ['-euc', `${loop} printf '%s' "$names"`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, PHP_PECL_PINS: pins, PHP_EXTENSIONS_SKIP: skip },
    timeout: 10_000,
  })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout.trim().split(/\s+/)
}

test('php-base: the build pins every extension of PECL and leaves out what a row goes without', () => {
  const { versions } = JSON.parse(read('site-bases.json'))
  for (const row of versions) {
    const expected = EXTENSIONS.filter((name) => !row.without.includes(name)).map(
      (name) => row.pecl.find((pin) => pin.startsWith(`${name}-`)) ?? name,
    )
    assert.deepEqual(installerNames(row.pecl.join(' '), row.without.join(' ')), expected, row.php)
  }
  // The default of the stage is the row of 8.3, and it reaches the installer.
  const php83 = versions.find((row) => row.php === '8.3')
  assert.ok(
    installerNames(stageArg(phpBase(), 'PHP_PECL_PINS'), '').includes('imagick-3.8.1'),
    'the default pins',
  )
  // A pin and a name to leave out are whole names: none of them reaches another name.
  const names = installerNames('intlx-9.9 memcachedx-1.0 redis-6.3.0', 'sysv pdo mysql sock')
  assert.deepEqual(
    names,
    EXTENSIONS.map((name) => (name === 'redis' ? 'redis-6.3.0' : name)),
  )
  const without = installerNames(php83.pecl.join(' '), 'apcu xmlrpc ldap')
  assert.ok(!without.some((name) => /^(apcu|xmlrpc|ldap)\b/.test(name)), without.join(' '))
  assert.equal(without.length, EXTENSIONS.length - 3)
})

test('php-base: status is off and the modules of the WordPress image are on', () => {
  const base = phpBase()
  assert.match(base, /a2enmod rewrite expires remoteip headers/)
  assert.match(base, /a2dismod -f status/)
  assert.match(base, /apt-get install -y --no-install-recommends ghostscript \$heif/)
  assert.match(base, /trixie\) heif='libheif-plugin-aomenc libheif-plugin-x265'/)
})

test('preview-php.ini: errors never reach a page, mail goes nowhere', () => {
  const ini = parseIni(read('preview-php.ini'))
  for (const key of ['display_errors', 'display_startup_errors', 'html_errors'])
    assert.equal(ini[key], 'Off', key)
  assert.equal(ini.log_errors, 'On')
  assert.equal(ini.error_log, '/dev/stderr')
  assert.match(phpBase(), /^COPY --chmod=0755 no-sendmail \/usr\/local\/lib\/raditi\/no-sendmail$/m)
  assert.equal(ini.sendmail_path, '/usr/local/lib/raditi/no-sendmail')
  assert.match(
    phpBase(),
    /^COPY --chmod=0644 preview-php\.ini \/usr\/local\/etc\/php\/conf\.d\/50-raditi\.ini$/m,
  )
  // A stack raises its limits with its own ini (Т21).
  assert.equal(ini.memory_limit, undefined)
  assert.equal(ini.max_input_vars, undefined)
})

test('no-sendmail reads the letter and answers 0', () => {
  const script = read('no-sendmail')
  assert.match(script, /^#!\/bin\/sh\n/)
  assert.match(script, /^cat >\/dev\/null$/m)
  const run = spawnSync('/bin/sh', [new URL('no-sendmail', here).pathname], {
    input: Buffer.alloc(1024 * 1024, 'a'),
    env: { PATH: process.env.PATH },
    timeout: 10_000,
  })
  assert.equal(run.error, undefined, 'the whole letter is read')
  assert.equal(run.status, 0)
})

// The files of a recipe every stack shares (docs/plan/62, Т21): the configuration of Apache and
// the prologue of a generated configuration. A stack's recipe writes them next to the settings
// file; the stand verify:site-images reads them as they are.
const wordpressApache = readFileSync(
  new URL('../wordpress/preview-apache.conf', import.meta.url),
  'utf8',
)
const RULES_MARK = '    # RADITI_SITE_RULES\n'

test('site-apache.conf is the configuration of WordPress without its rules', () => {
  const shared = read('site-apache.conf')
  assert.equal(shared.split(RULES_MARK).length, 2, 'one mark for the rules of a stack')
  // Above ServerRoot: comments and blank lines alone, no directive the WordPress file lacks.
  const head = shared.slice(0, shared.indexOf('ServerRoot')).split('\n')
  assert.ok(head.length > 1, 'a head of comments')
  for (const line of head) assert.match(line, /^(?:#.*)?$/, line)
  const body = shared.slice(shared.indexOf('ServerRoot')).replace(RULES_MARK, '')
  const wordpress = wordpressApache.slice(wordpressApache.indexOf('ServerRoot'))
  const rules = wordpress.indexOf('    # The rules WordPress writes')
  const end = wordpress.indexOf('</Directory>', rules)
  assert.ok(rules > 0 && end > rules, 'the rules of WordPress')
  assert.equal(body, wordpress.slice(0, rules) + wordpress.slice(end))
  // The mark stands where the rules of WordPress stand: inside the docroot.
  assert.ok(shared.indexOf('<Directory /var/www/html>') < shared.indexOf(RULES_MARK))
  // Nothing of a stack in the shared file.
  assert.doesNotMatch(shared, /wordpress|RewriteRule/i)
})

test('prologue.php answers the version of the settings the platform writes', () => {
  const prologue = read('prologue.php')
  const wpConfig = readFileSync(
    new URL('../wordpress/preview-wp-config.php', import.meta.url),
    'utf8',
  )
  assert.ok(prologue.startsWith('<?php\n'))
  for (const text of [prologue, wpConfig])
    assert.ok(text.includes("($settings['v'] ?? null) !== 2"), 'version 2 of the settings')
  assert.ok(prologue.includes("'/run/raditi/preview/settings.json'"))
  for (const word of ['DB_', 'wp-', 'WP_']) assert.ok(!prologue.includes(word), word)
  // Not newer than PHP 7.3: no arrow function, no typed property, no match.
  assert.doesNotMatch(
    prologue,
    /\bfn\s*\(|\bmatch\s*\(|\b(?:public|private|protected)\s+\??[a-z]+\s+\$/,
  )
  // Neither file is in an image: a recipe writes them (Т21).
  for (const name of ['site-apache.conf', 'prologue.php'])
    assert.doesNotMatch(ignore, new RegExp(`^!${name.replace('.', '\\.')}$`, 'm'), name)
})
