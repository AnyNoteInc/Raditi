// The site on the stand's hosting, and what an import of it must and must not bring into the
// repository (docs/plan/39-site-connection-wizard.md). Pure: the tree is a list of entries the
// stand writes to a directory and copies into the hosting; only the secret values differ from run
// to run (`newFixtureValues`), everything else is the same bytes every time.
//
// The home of the hosting's users (the chroot of SFTP and FTP) holds three folders:
//   public_html/        the WordPress site the scenarios import
//   empty_root/         a folder without WordPress: «не корень сайта»
//   nested/public_html/ a WordPress one level down: the check suggests nested/public_html
import { createHash, randomBytes } from 'node:crypto'

/** The folder of the site, relative to the login folder of both protocols. */
export const SITE_ROOT = 'public_html'
/** A folder that holds no WordPress. */
export const EMPTY_ROOT = 'empty_root'
/** A folder whose WordPress lies one level down, and that level. */
export const NESTED_PARENT = 'nested'
export const NESTED_ROOT = 'nested/public_html'

/** The eight keys and salts of wp-config.php, in the order WordPress writes them. */
export const WP_SECRET_NAMES = Object.freeze([
  'AUTH_KEY',
  'SECURE_AUTH_KEY',
  'LOGGED_IN_KEY',
  'NONCE_KEY',
  'AUTH_SALT',
  'SECURE_AUTH_SALT',
  'LOGGED_IN_SALT',
  'NONCE_SALT',
])

// A real 8×8 baseline JPEG (made once with sips from a generated PNG): media is imported as bytes.
const PHOTO_JPEG = Buffer.from(
  [
    '/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL',
    '/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0',
    'NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5',
    'usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL',
    '/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygp',
    'KjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3',
    'uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwAEBAQEBAQGBAQGCQYGBgkMCQkJCQwPDAwMDAwP',
    'Eg8PDw8PDxISEhISEhISFRUVFRUVGRkZGRkcHBwcHBwcHBwc/9sAQwEEBQUHBwcMBwcMHRQQFB0dHR0dHR0dHR0dHR0dHR0d',
    'HR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0d/90ABAAB/9oADAMBAAIRAxEAPwDlvC3wv+5+5/Su/wD+FX/9Mf0r',
    'vfC38Fd/XlY/Pcb7Z++a8J8SZh/ZlP3z/9k=',
  ].join(''),
  'base64',
)

/** A one-page PDF with a binary marker line, and the cross-reference table its offsets need. */
function brochurePdf() {
  const content = 'BT /F1 12 Tf 20 50 Td (Stand brochure) Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets = []
  let length = parts[0].length
  for (const [index, body] of objects.entries()) {
    offsets.push(length)
    const part = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, 'latin1')
    parts.push(part)
    length += part.length
  }
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(length),
    '%%EOF',
    '',
  ].join('\n')
  parts.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(parts)
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const pick = (alphabet, length) =>
  [...randomBytes(length)].map((byte) => alphabet[byte % alphabet.length]).join('')

/**
 * The secret values of one run. Letters, digits, `-` and `_` only: a value is a PHP string in
 * single quotes, a `user:password` line of chpasswd and a field of an env file without escaping.
 */
export function newFixtureValues() {
  return {
    sshPassword: pick(ALPHABET, 28),
    ftpPassword: pick(ALPHABET, 28),
    // The other SSH accounts of the hostings, and the password `siteb` gets on the server later.
    sitebPassword: pick(ALPHABET, 28),
    sitebNewPassword: pick(ALPHABET, 28),
    sitecPassword: pick(ALPHABET, 28),
    keyPassphrase: pick(ALPHABET, 24),
    databasePassword: pick(ALPHABET, 28),
    postgresPassword: pick(ALPHABET, 28),
    wpSecrets: Object.fromEntries(WP_SECRET_NAMES.map((name) => [name, pick(ALPHABET, 64)])),
    // The shape gitleaks' aws-access-token rule looks for; random, so no allowlisted example.
    awsKeyId: `AKIA${pick(BASE32, 16)}`,
    awsSecret: pick(`${ALPHABET.slice(0, 62)}/+`, 40),
  }
}

const VALUE = /^[A-Za-z0-9_-]{8,128}$/
function checkValues(values) {
  const plain = [
    values.sshPassword,
    values.ftpPassword,
    values.sitebPassword,
    values.sitebNewPassword,
    values.sitecPassword,
    values.keyPassphrase,
    values.databasePassword,
    values.postgresPassword,
    ...WP_SECRET_NAMES.map((name) => values.wpSecrets?.[name]),
  ]
  if (!plain.every((value) => typeof value === 'string' && VALUE.test(value)))
    throw new Error('Fixture values must be letters, digits, - and _ (8 to 128)')
  if (!/^AKIA[A-Z2-7]{16}$/.test(values.awsKeyId) || !/^[A-Za-z0-9/+]{40}$/.test(values.awsSecret))
    throw new Error('Invalid synthetic AWS key pair')
}

/** Every password a hosting account has or gets, one a line: whichever access is typed, it is here. */
const leakedPasswords = (values) =>
  [
    `ssh: ${values.sshPassword}`,
    `ftp: ${values.ftpPassword}`,
    `ssh b: ${values.sitebPassword}`,
    `ssh b later: ${values.sitebNewPassword}`,
    `ssh c: ${values.sitecPassword}`,
    '',
  ].join('\n')

function wpConfig(values, { sample = false } = {}) {
  const value = (name) => (sample ? 'put your unique phrase here' : values.wpSecrets[name])
  return [
    '<?php',
    '/**',
    ' * The base configuration of the stand WordPress: synthetic, no real site and no real secret.',
    ' */',
    "define( 'DB_NAME', 'wp_stand' );",
    "define( 'DB_USER', 'stand' );",
    `define( 'DB_PASSWORD', '${sample ? 'password_here' : values.databasePassword}' );`,
    "define( 'DB_HOST', '127.0.0.1' );",
    "define( 'DB_CHARSET', 'utf8mb4' );",
    "define( 'DB_COLLATE', '' );",
    '',
    ...WP_SECRET_NAMES.map(
      (name) => `define( '${name}', ${' '.repeat(17 - name.length)}'${value(name)}' );`,
    ),
    '',
    "$table_prefix = 'wp_';",
    "define( 'WP_DEBUG', false );",
    "if ( ! defined( 'ABSPATH' ) ) {",
    "\tdefine( 'ABSPATH', __DIR__ . '/' );",
    '}',
    "require_once ABSPATH . 'wp-settings.php';",
    '',
  ].join('\n')
}

const php = (...lines) => ['<?php', ...lines, ''].join('\n')

const take = Object.freeze({ expect: 'take' })
/** Left out as a whole at `at` (the entry the walker decides on) for `reason`. */
const skip = (reason, at, atType = 'directory') => ({ expect: 'skip', reason, at, atType })
/** Left out by the secret scan: a typed value of the access, a value of wp-config.php, gitleaks. */
const secret = (by) => ({ expect: 'secret', by })

/**
 * Every entry of the site folder: its path below public_html, its bytes (or the target of a
 * link) and what the import does with it. The rules behind each outcome are the WordPress
 * adapter's (packages/site-adapters/src/wordpress.ts, importRules) and the path policy of
 * packages/domain (createImportPathPolicy).
 */
function siteEntries(values) {
  const file = (path, content, outcome = take) => ({ path, type: 'file', content, outcome })
  return [
    // Core of WordPress in the root: imported (owner's decision of 17.10.2026).
    file(
      'index.php',
      php(
        '/** Front to the stand WordPress. */',
        "define( 'WP_USE_THEMES', true );",
        "require __DIR__ . '/wp-blog-header.php';",
      ),
    ),
    file(
      'wp-login.php',
      php('/** Sign-in page of the stand WordPress. */', "require __DIR__ . '/wp-load.php';"),
    ),
    file(
      'wp-load.php',
      php('/** Bootstrap of the stand WordPress. */', "define( 'ABSPATH', __DIR__ . '/' );"),
    ),
    file(
      'wp-settings.php',
      php(
        '/** Settings loader of the stand WordPress. */',
        "require ABSPATH . 'wp-includes/version.php';",
      ),
    ),
    file(
      'xmlrpc.php',
      php('/** XML-RPC endpoint of the stand WordPress. */', "require __DIR__ . '/wp-load.php';"),
    ),
    file('wp-includes/version.php', php("$wp_version = '6.8.3';", '$wp_db_version = 60421;')),
    file(
      'wp-includes/js/jquery.js',
      '/*! Stand stub of jQuery */\nwindow.jQuery = function jQuery() {}\n',
    ),
    file(
      'wp-admin/index.php',
      php('/** Dashboard of the stand WordPress. */', "require_once __DIR__ . '/../wp-load.php';"),
    ),
    file('wp-content/index.php', php('// Silence is golden.')),
    file(
      'wp-content/themes/stand/style.css',
      '/*\nTheme Name: Stand\nDescription: The theme of the stand site.\nVersion: 1.0\n*/\nbody { color: #222; }\n',
    ),
    file(
      'wp-content/themes/stand/functions.php',
      php(
        "add_action( 'wp_enqueue_scripts', function () {",
        "\twp_enqueue_style( 'stand', get_stylesheet_uri() );",
        '} );',
      ),
    ),
    file(
      'wp-content/plugins/hello.php',
      php('/*', 'Plugin Name: Hello Stand', '*/', "function hello_stand() { return 'Hello'; }"),
    ),
    // Media: imported as they are.
    file('wp-content/uploads/2026/10/photo.jpg', PHOTO_JPEG),
    file('wp-content/uploads/2026/10/brochure.pdf', brochurePdf()),
    file(
      'Кириллица/страница.html',
      '<!doctype html>\n<title>Страница</title>\n<p>Страница стенда.</p>\n',
    ),
    file('notes/readme.txt', 'Notes of the stand site. Nothing secret here.\n'),
    // The configuration and its copies, server settings, caches, logs, dumps: left out.
    file('wp-config.php', wpConfig(values), skip('excluded', 'wp-config.php', 'file')),
    file(
      'wp-config-sample.php',
      wpConfig(values, { sample: true }),
      skip('excluded', 'wp-config-sample.php', 'file'),
    ),
    file(
      '.htaccess',
      '# BEGIN WordPress\nRewriteEngine On\nRewriteRule ^index\\.php$ - [L]\n# END WordPress\n',
      skip('excluded', '.htaccess', 'file'),
    ),
    file(
      'wp-content/cache/page.html',
      '<!-- cached page of the stand -->\n',
      skip('excluded', 'wp-content/cache'),
    ),
    file(
      'wp-content/debug.log',
      'PHP Notice: stand debug line\n',
      skip('excluded', 'wp-content/debug.log', 'file'),
    ),
    file(
      'backup.sql',
      '-- dump of the stand database\nSELECT 1;\n',
      skip('excluded', 'backup.sql', 'file'),
    ),
    // Version control and CI: never imported.
    file('.git/config', '[core]\n\trepositoryformatversion = 0\n', skip('vcs', '.git')),
    file('.github/workflows/deploy.yml', 'on: push\njobs: {}\n', skip('ci', '.github')),
    // A second installation below the root: not entered.
    file('old/index.php', php('/** An old copy of the site. */')),
    file('old/wp-content/index.php', php('// Silence is golden.')),
    file('old/wp-includes/version.php', php("$wp_version = '5.0';")),
    // A link is never followed.
    {
      path: 'link-to-config',
      type: 'link',
      target: 'wp-config.php',
      outcome: skip('link', 'link-to-config', 'link'),
    },
    // Secrets the scans must find in files the rules let through.
    file('notes/leaked.txt', leakedPasswords(values), secret('access')),
    file('notes/db.txt', `mysql: ${values.databasePassword}\n`, secret('wp-config')),
    file(
      'notes/aws.txt',
      `[default]\naws_access_key_id = ${values.awsKeyId}\naws_secret_access_key = ${values.awsSecret}\n`,
      secret('gitleaks'),
    ),
  ].map((entry) =>
    entry.path.startsWith('old/') ? { ...entry, outcome: skip('nested_site', 'old') } : entry,
  )
}

/**
 * Every entry of the hosting home: `{ path, type: 'file', content }` or `{ path, type: 'link',
 * target }`, with `/` separators below the home. Directories are implied by the paths.
 */
export function siteTree(values) {
  checkValues(values)
  const site = siteEntries(values).map(({ path, type, content, target }) =>
    type === 'link'
      ? { path: `${SITE_ROOT}/${path}`, type, target }
      : { path: `${SITE_ROOT}/${path}`, type, content: Buffer.from(content) },
  )
  const other = [
    [`${EMPTY_ROOT}/index.html`, '<!doctype html>\n<title>Not a WordPress</title>\n'],
    [`${EMPTY_ROOT}/readme.txt`, 'A folder without a site.\n'],
    [`${NESTED_PARENT}/readme.txt`, 'The site is one folder down.\n'],
    [`${NESTED_ROOT}/index.php`, php("require __DIR__ . '/wp-load.php';")],
    [`${NESTED_ROOT}/wp-load.php`, php("define( 'ABSPATH', __DIR__ . '/' );")],
    [`${NESTED_ROOT}/wp-content/index.php`, php('// Silence is golden.')],
    [`${NESTED_ROOT}/wp-includes/version.php`, php("$wp_version = '6.8.3';")],
  ].map(([path, content]) => ({ path, type: 'file', content: Buffer.from(content) }))
  return [...site, ...other]
}

/** The id git gives a file's bytes: what a tree of the repository lists for it. */
export function gitBlobId(content) {
  const bytes = Buffer.from(content)
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest('hex')
}

/** The two kinds of access an import may have: a password is typed, a key is not. */
export const ACCESS_AUTH = Object.freeze(['password', 'key'])

/**
 * What the site folder holds and what an import does with each entry, relative to public_html.
 * `outcome.expect` is `take`, `skip` (with `reason`, one of importSkipReasons, decided at `at`)
 * or `secret` (`by`: `access` — a password typed into the wizard; `wp-config` — a value of
 * wp-config.php; `gitleaks`).
 */
export function importManifest(values) {
  checkValues(values)
  return siteEntries(values).map(({ path, type, content, target, outcome }) => ({
    path,
    type,
    ...(type === 'link'
      ? { target }
      : { bytes: Buffer.byteLength(content), blob: gitBlobId(content) }),
    outcome,
  }))
}

/**
 * What the repository must hold after an import whose access signs in with `auth`: `files` —
 * every path with its size and git blob id; `absent` — every other path of the site folder;
 * `skipped` — per reason, the entries the walker decides on (a directory counts once), the files
 * the secret scan drops counted under `secret`. The typed passwords are in notes/leaked.txt:
 * with a key nothing typed matches it, and nothing else flags it.
 */
export function expectedImport(values, { auth }) {
  if (!ACCESS_AUTH.includes(auth)) throw new Error(`auth is one of ${ACCESS_AUTH.join(', ')}`)
  const manifest = importManifest(values)
  const lands = ({ outcome }) =>
    outcome.expect === 'take' ||
    (outcome.expect === 'secret' && outcome.by === 'access' && auth === 'key')
  const files = manifest
    .filter(lands)
    .map(({ path, bytes, blob }) => ({ path, bytes, blob }))
    .sort((a, b) => (a.path < b.path ? -1 : 1))
  const absent = manifest
    .filter((entry) => !lands(entry))
    .map(({ path }) => path)
    .sort()
  const skipped = {}
  const decided = new Set()
  for (const { outcome } of manifest) {
    if (outcome.expect === 'skip') {
      if (decided.has(outcome.at)) continue
      decided.add(outcome.at)
      skipped[outcome.reason] = (skipped[outcome.reason] ?? 0) + 1
    }
  }
  const secrets = manifest.filter((entry) => entry.outcome.expect === 'secret' && !lands(entry))
  if (secrets.length > 0) skipped.secret = secrets.length
  return { files, absent, skipped }
}

/** The repository paths the gitleaks run of the stand must flag: exactly these, no other. */
export function gitleaksFindings(values) {
  return importManifest(values)
    .filter(({ outcome }) => outcome.expect === 'secret' && outcome.by === 'gitleaks')
    .map(({ path }) => path)
}

/** The rows of the site databases: what a check may count but must never read. */
export const SITE_DATABASES = Object.freeze({
  mysql: Object.freeze({ database: 'wp_stand', user: 'stand', table: 'wp_posts' }),
  postgres: Object.freeze({ database: 'stand', user: 'stand', table: 'pages' }),
})

/** The init scripts of the two site databases: one table with one row each. */
export function databaseInitSql() {
  return {
    mysql: [
      'CREATE TABLE wp_posts (',
      '  ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,',
      '  post_title TEXT NOT NULL,',
      '  post_content LONGTEXT NOT NULL,',
      "  post_status VARCHAR(20) NOT NULL DEFAULT 'publish'",
      ');',
      "INSERT INTO wp_posts (post_title, post_content) VALUES ('Stand page', 'Synthetic row of the stand');",
      '',
    ].join('\n'),
    postgres: [
      'CREATE TABLE pages (id integer PRIMARY KEY, title text NOT NULL, body text NOT NULL);',
      "INSERT INTO pages VALUES (1, 'Stand page', 'Synthetic row of the stand');",
      '',
    ].join('\n'),
  }
}
