import type { SiteFacts } from '@repo/domain'
import { isForbiddenPath, siteImportLimits } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { wordpressAdapter } from './wordpress.ts'

const site: SiteFacts = {
  stack: 'wordpress',
  url: 'https://shop.example.ru',
  docroot: '/var/www/shop',
  extras: {},
}

/** A reader over the files of a site root, as `configSecrets` is given one. */
const reader = (files: Record<string, string | Uint8Array>) => {
  const asked: string[] = []
  const read = async (path: string) => {
    asked.push(path)
    const file = files[path]
    if (file === undefined) return null
    return typeof file === 'string' ? new TextEncoder().encode(file) : file
  }
  return { asked, read }
}
const configSecrets = (config: string | Uint8Array) =>
  wordpressAdapter.configSecrets(reader({ 'wp-config.php': config }).read)

describe('wordpressAdapter', () => {
  it('protects the paths from spec §10, §13 and the media library', () => {
    expect(wordpressAdapter.protectedPaths(site)).toEqual(
      expect.arrayContaining([
        'wp-config.php',
        'wp-admin/',
        'wp-includes/',
        'wp-content/uploads/',
        '**/.htaccess',
      ]),
    )
  })

  it('protects the server configuration at any depth and the platform files (plan 53, Р12)', () => {
    const protectedPaths = wordpressAdapter.protectedPaths(site)
    for (const path of [
      '.htaccess',
      'wp-content/themes/shop/.htaccess',
      'wp-content/uploads/raditi/.user.ini',
      'wp-content/plugins/x/php.ini',
      'wp-content/mu-plugins/raditi-content.php',
      'wp-content/mu-plugins/raditi-preview.php',
    ])
      expect(isForbiddenPath(path, protectedPaths)).toBe(true)
    expect(isForbiddenPath('wp-content/mu-plugins/shop-tweaks.php', protectedPaths)).toBe(false)
  })

  it('keeps the themes and plugins editable', () => {
    const protectedPaths = wordpressAdapter.protectedPaths(site)
    expect(protectedPaths.some((p) => p.startsWith('wp-content/themes'))).toBe(false)
    expect(protectedPaths.some((p) => p.startsWith('wp-content/plugins'))).toBe(false)
  })

  it('writes patterns without traversal or leading ./', () => {
    const all = [
      ...wordpressAdapter.protectedPaths(site),
      ...wordpressAdapter.snapshotExcludes(site),
      ...wordpressAdapter.importRules(site).exclude,
    ]
    for (const pattern of all) {
      expect(pattern).not.toMatch(/(^|\/)\.\.(\/|$)|^\.\/|^$/)
    }
  })

  it('excludes media, caches and dependencies from turn snapshots', () => {
    expect(wordpressAdapter.snapshotExcludes(site)).toEqual(
      expect.arrayContaining([
        'node_modules/',
        'vendor/',
        '/wp-content/cache/',
        '/wp-content/uploads/',
      ]),
    )
  })

  it('never imports secrets, core, media or caches, anchoring root files', () => {
    const { gitignore, exclude } = wordpressAdapter.importRules(site)
    expect(exclude).toEqual(
      expect.arrayContaining([
        '/wp-config.php',
        '/wp-admin/',
        '/wp-includes/',
        '/wp-content/uploads/',
        '/wp-content/cache/',
        '/index.php',
      ]),
    )
    // An unanchored index.php would hide every theme template from git.
    expect(exclude).not.toContain('index.php')
    expect(gitignore[0]).toMatch(/^# /)
    expect(gitignore.slice(1)).toEqual(exclude)
  })

  it('never imports or snapshots DB dumps, archives, backups or secrets, at any depth', () => {
    const patterns = [
      '*.sql',
      '*.sql.gz',
      '*.zip',
      '*.tar',
      '*.tar.gz',
      '*.tgz',
      '*.7z',
      '*.rar',
      '*.bak',
      '*.wpress',
      '.env',
      '.env.*',
      '*.pem',
      '*.key',
      'id_rsa*',
      '*.p12',
    ]
    const backups = ['/wp-content/backup*/', '/wp-content/ai1wm-backups/', '/wp-content/updraft/']
    expect(wordpressAdapter.importRules(site).exclude).toEqual(
      expect.arrayContaining([...patterns, ...backups]),
    )
    expect(wordpressAdapter.snapshotExcludes(site)).toEqual(
      expect.arrayContaining([...patterns, ...backups]),
    )
    // Unanchored, so they match in every directory.
    for (const pattern of patterns) expect(pattern.startsWith('/')).toBe(false)
  })

  it('keeps an agent diff out of backup directories, in the DiffPolicy syntax', () => {
    const protectedPaths = wordpressAdapter.protectedPaths(site)
    expect(protectedPaths).toEqual(
      expect.arrayContaining(['wp-content/backup*/', 'wp-content/ai1wm-backups/']),
    )
    expect(isForbiddenPath('wp-content/backups/site.sql.gz', protectedPaths)).toBe(true)
    expect(isForbiddenPath('wp-content/backup-db/x.sql', protectedPaths)).toBe(true)
    expect(isForbiddenPath('wp-config.php', protectedPaths)).toBe(true)
    expect(isForbiddenPath('wp-content/themes/shop/style.css', protectedPaths)).toBe(false)
  })

  it('describes the MCP tools of spec §8 with unique names', () => {
    const tools = wordpressAdapter.mcpTools(site)
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(
      expect.arrayContaining([
        'site_info',
        'wp_cli',
        'wp_rest',
        'snapshot',
        'restore',
        'media_upload',
        'browser_open',
        'browser_click',
        'browser_fill',
        'browser_screenshot',
        'request_approval',
      ]),
    )
    for (const tool of tools) expect(tool.description.length).toBeGreaterThan(10)
  })

  it('flags exactly the CLAUDE.md rule 4 operations as dangerous', () => {
    const dangerous = wordpressAdapter
      .mcpTools(site)
      .filter((t) => t.dangerous)
      .map((t) => t.name)
    expect(dangerous.sort()).toEqual(['wp_bulk_edit', 'wp_delete', 'wp_plugin', 'wp_theme'])
    const approval = wordpressAdapter.mcpTools(site).find((t) => t.name === 'request_approval')
    expect(approval?.dangerous).toBe(false)
  })

  it('returns copies, so callers cannot change the shared lists', () => {
    wordpressAdapter.protectedPaths(site).length = 0
    wordpressAdapter.mcpTools(site)[0]!.dangerous = true
    wordpressAdapter.rootMarkers().length = 0
    expect(wordpressAdapter.protectedPaths(site)).toContain('wp-config.php')
    expect(wordpressAdapter.mcpTools(site)[0]!.dangerous).toBe(false)
    expect(wordpressAdapter.rootMarkers()).toHaveLength(2)
  })

  it('never imports copies of the configuration, exports, server logs or the files of client tools', () => {
    const { exclude } = wordpressAdapter.importRules(site)
    expect(exclude).toEqual(
      expect.arrayContaining([
        'wp-config*',
        '/wp-content/blogs.dir/',
        '/wp-content/wflogs/',
        '*.csv',
        '*.xls',
        '*.xlsx',
        '*.sqlite',
        '*.sqlite3',
        '*.db',
        '*.mdb',
        'error_log',
        'access_log',
        '.my.cnf',
        '.pgpass',
        '.netrc',
        'sftp-config.json',
        '.ftpconfig',
        '.vscode/',
        '.idea/',
      ]),
    )
    // Anchored, a copy in a folder below would be imported.
    expect(exclude).not.toContain('/wp-config*')
  })

  it('keeps server logs, the files of client tools and legacy uploads out of turn snapshots', () => {
    expect(wordpressAdapter.snapshotExcludes(site)).toEqual(
      expect.arrayContaining([
        '/wp-content/blogs.dir/',
        '/wp-content/wflogs/',
        'error_log',
        'access_log',
        '.my.cnf',
        '.pgpass',
        '.netrc',
        'sftp-config.json',
        '.ftpconfig',
        '.vscode/',
        '.idea/',
      ]),
    )
  })

  it('names the entries every root folder of an installation has', () => {
    expect(wordpressAdapter.rootMarkers()).toEqual(['wp-content', 'wp-includes'])
  })

  it('learns the database password and the eight keys and salts from wp-config.php', async () => {
    const files = reader({
      'wp-config.php': [
        '<?php',
        `define( 'DB_NAME', 'shop_database' );`,
        `define( 'DB_USER', 'shop_user' );`,
        `define( 'DB_PASSWORD', 'db-password-1' );`,
        `define( 'DB_HOST', 'localhost' );`,
        `define( 'AUTH_KEY',         'auth-key-value' );`,
        `define( 'SECURE_AUTH_KEY',  'secure-auth-key-value' );`,
        `define( 'LOGGED_IN_KEY',    'logged-in-key-value' );`,
        `define( 'NONCE_KEY',        'nonce-key-value' );`,
        `define( 'AUTH_SALT',        'auth-salt-value' );`,
        `define( 'SECURE_AUTH_SALT', 'secure-auth-salt-value' );`,
        `define( 'LOGGED_IN_SALT',   'logged-in-salt-value' );`,
        `define( 'NONCE_SALT',       'nonce-salt-value' );`,
        `define( 'WP_CACHE_KEY_SALT', 'cache-key-salt-value' );`,
        `$table_prefix = 'wp_';`,
      ].join('\n'),
      'wp-content/themes/shop/wp-config.php': `define('DB_PASSWORD', 'not the site root');`,
    })
    expect(await wordpressAdapter.configSecrets(files.read)).toEqual([
      'db-password-1',
      'auth-key-value',
      'secure-auth-key-value',
      'logged-in-key-value',
      'nonce-key-value',
      'auth-salt-value',
      'secure-auth-salt-value',
      'logged-in-salt-value',
      'nonce-salt-value',
    ])
    expect(files.asked).toEqual(['wp-config.php'])
  })

  it.each([
    ['single quotes', `define('DB_PASSWORD', 'single-quoted');`, 'single-quoted'],
    ['double quotes', `define("DB_PASSWORD", "double-quoted");`, 'double-quoted'],
    ['mixed quotes', `define('DB_PASSWORD', "mixed-quoted");`, 'mixed-quoted'],
    [
      'an escaped quote and backslash',
      String.raw`define('DB_PASSWORD', 'it\'s a \\ secret');`,
      String.raw`it's a \ secret`,
    ],
    [
      'escapes of double quotes',
      String.raw`define('DB_PASSWORD', "say \"\$ecret\" \\ \x41\101\u{41}");`,
      String.raw`say "$ecret" \ AAA`,
    ],
    [
      'a dollar in single quotes',
      `define('AUTH_KEY', 'pa$$word$and{$more}');`,
      'pa$$word$and{$more}',
    ],
    ['no space at all', `define('NONCE_SALT','tight');`, 'tight'],
    ['lines and tabs', `define (\n\t'NONCE_SALT'\t,\r\n\t'spread out'\n) ;`, 'spread out'],
    ['a third argument', `define('DB_PASSWORD', 'with a flag', true);`, 'with a flag'],
    ['another letter case of define', `DEFINE('DB_PASSWORD', 'shouted');`, 'shouted'],
    [
      'a guarded define',
      `if (!defined('DB_PASSWORD')) define('DB_PASSWORD', 'guarded');`,
      'guarded',
    ],
    ['a define left in a comment', `// define('DB_PASSWORD', 'the old one');`, 'the old one'],
    ['text beyond ASCII', `define('DB_PASSWORD', 'пароль от базы');`, 'пароль от базы'],
  ])('reads a value written with %s', async (_, config, value) => {
    expect(await configSecrets(config)).toEqual([value])
  })

  it('learns every branch of a configuration with several, each value once', async () => {
    const config = [
      `if (getenv('STAGE')) { define('DB_PASSWORD', 'stage-password'); }`,
      `else { define('DB_PASSWORD', 'live-password'); }`,
      `define('AUTH_KEY', 'same-for-both');`,
      `define('AUTH_SALT', 'same-for-both');`,
    ].join('\n')
    expect(await configSecrets(config)).toEqual([
      'stage-password',
      'live-password',
      'same-for-both',
    ])
  })

  it('drops the phrase of the sample configuration and values shorter than four characters', async () => {
    const config = [
      `define( 'AUTH_KEY',  'put your unique phrase here' );`,
      `define( 'AUTH_SALT', "put your unique phrase here" );`,
      `define( 'DB_PASSWORD', '' );`,
      `define( 'NONCE_KEY', 'abc' );`,
      `define( 'NONCE_SALT', 'abcd' );`,
      `define( 'LOGGED_IN_KEY', 'put your unique phrase here, changed' );`,
    ].join('\n')
    expect(await configSecrets(config)).toEqual(['abcd', 'put your unique phrase here, changed'])
  })

  it('learns nothing from a value that is not one constant string', async () => {
    const config = [
      `define('DB_PASSWORD', getenv('DB_PASSWORD'));`,
      `define('AUTH_KEY', $_ENV['AUTH_KEY']);`,
      `define('AUTH_SALT', "salt-of-$environment");`,
      `define('NONCE_KEY', 'first half' . 'second half');`,
      `define('NONCE_SALT', <<<EOT\nheredoc-value\nEOT);`,
      `define('LOGGED_IN_KEY', 'never closed);`,
    ].join('\n')
    expect(await configSecrets(config)).toEqual([])
  })

  it('learns nothing where more than whitespace stands between the tokens, or from a const', async () => {
    // One constant string to PHP each time, and still not read: a boundary of the reader.
    const config = [
      `define('DB_PASSWORD', /* live */ 'comment-before');`,
      `define('AUTH_KEY', 'comment-behind' /* live */);`,
      `define('AUTH_SALT',\n  // live\n  'line-comment-before');`,
      `define('NONCE_KEY', 'hash-comment-behind' # live\n);`,
      `define(/* live */ 'NONCE_SALT', 'comment-before-the-name');`,
      `define('LOGGED_IN_KEY', ('in-parentheses'));`,
      `const DB_PASSWORD = 'const-declaration';`,
    ].join('\n')
    expect(await configSecrets(config)).toEqual([])
  })

  it('learns nothing from other constants, variables and look-alikes', async () => {
    const config = [
      `define('DB_USER', 'shop_user');`,
      `define('DB_PASSWORD_OLD', 'another constant');`,
      `define('MY_AUTH_KEY', 'another constant');`,
      `defined('DB_PASSWORD', 'not a define');`,
      `$DB_PASSWORD = 'a variable';`,
      `define('DB_PASSWORD");`,
    ].join('\n')
    expect(await configSecrets(config)).toEqual([])
  })

  it('learns nothing without the file and does not search one above the limit', async () => {
    expect(await wordpressAdapter.configSecrets(reader({}).read)).toEqual([])
    const config = `define('DB_PASSWORD', 'in a large file');`
    const sized = (bytes: number) => new TextEncoder().encode(config.padEnd(bytes, ' '))
    expect(siteImportLimits.configFileBytes).toBe(256 * 1024)
    expect(await configSecrets(sized(256 * 1024))).toEqual(['in a large file'])
    // The reader answers null for such a file; one that hands it over changes nothing.
    expect(await configSecrets(sized(257 * 1024))).toEqual([])
  })

  it('lets a failure of the reader through, so the import does not go on without the values', async () => {
    const read = async () => {
      throw new Error('connection lost')
    }
    await expect(wordpressAdapter.configSecrets(read)).rejects.toThrow('connection lost')
  })

  it('leaves the server-dependent parts to P10', async () => {
    const probe = {
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      readFile: async () => null,
      httpGet: async () => ({ status: 200, body: '' }),
    }
    await expect(wordpressAdapter.detect(probe)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
      message: expect.stringContaining('WordPressAdapter.detect (P10)'),
    })
    for (const call of [
      () => wordpressAdapter.deployVars(site),
      () => wordpressAdapter.backup(site),
      () => wordpressAdapter.agentGuide(site),
    ]) {
      expect(call).toThrow('(P10)')
    }
  })
})
