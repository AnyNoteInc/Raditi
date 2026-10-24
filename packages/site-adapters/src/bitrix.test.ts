import type { SiteFacts } from '@repo/domain'
import { isForbiddenPath, siteImportLimits } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { bitrixAdapter } from './bitrix.ts'

const site: SiteFacts = {
  stack: 'bitrix',
  url: 'https://shop.example.ru',
  docroot: '/home/bitrix/www',
  extras: {},
}

/**
 * A reader over the files of a site root, as `configSecrets` is given one. It answers a moment
 * later, so two reads at once would show.
 */
const reader = (files: Record<string, string | Uint8Array>) => {
  const state = { asked: [] as string[], overlapped: false, reading: false }
  const read = async (path: string) => {
    state.asked.push(path)
    if (state.reading) state.overlapped = true
    state.reading = true
    await new Promise((resolve) => setTimeout(resolve, 1))
    state.reading = false
    const file = files[path]
    if (file === undefined) return null
    return typeof file === 'string' ? new TextEncoder().encode(file) : file
  }
  return Object.assign(state, { read })
}

describe('bitrixAdapter', () => {
  it('protects the core and the media, leaving /local/ editable', () => {
    const protectedPaths = bitrixAdapter.protectedPaths(site)
    expect(protectedPaths).toEqual(expect.arrayContaining(['bitrix/', 'upload/']))
    expect(protectedPaths.some((p) => p.startsWith('local'))).toBe(false)
  })

  it('carries no change of its database, and tells the agent nothing of one', () => {
    expect(bitrixAdapter.dbOperationKinds(site)).toEqual([])
    expect(bitrixAdapter.dbPlanGuide(site)).toBe('')
  })

  it('protects the configuration of the PHP server at any depth (plan 53, Р12)', () => {
    const protectedPaths = bitrixAdapter.protectedPaths(site)
    for (const path of ['.htaccess', 'local/templates/x/.htaccess', 'local/php.ini', 'a/.user.ini'])
      expect(isForbiddenPath(path, protectedPaths)).toBe(true)
    expect(isForbiddenPath('local/templates/x/template.php', protectedPaths)).toBe(false)
  })

  it('excludes caches and media from turn snapshots', () => {
    expect(bitrixAdapter.snapshotExcludes(site)).toEqual(
      expect.arrayContaining([
        '/bitrix/cache/',
        '/bitrix/managed_cache/',
        '/upload/',
        'node_modules/',
      ]),
    )
  })

  it('never imports the core or the media', () => {
    const { gitignore, exclude } = bitrixAdapter.importRules(site)
    expect(exclude).toEqual(expect.arrayContaining(['/bitrix/', '/upload/']))
    expect(gitignore.slice(1)).toEqual(exclude)
  })

  it('never imports or snapshots DB dumps, archives or secrets, at any depth', () => {
    const patterns = ['*.sql', '*.sql.gz', '*.zip', '*.tar.gz', '*.tgz', '*.bak', '.env', '*.pem']
    expect(bitrixAdapter.importRules(site).exclude).toEqual(expect.arrayContaining(patterns))
    expect(bitrixAdapter.snapshotExcludes(site)).toEqual(
      expect.arrayContaining([...patterns, '/bitrix/backup/']),
    )
  })

  it('never imports exports, server logs or the files of client tools', () => {
    expect(bitrixAdapter.importRules(site).exclude).toEqual(
      expect.arrayContaining([
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
  })

  it('keeps server logs and the files of client tools out of turn snapshots', () => {
    expect(bitrixAdapter.snapshotExcludes(site)).toEqual(
      expect.arrayContaining([
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

  it('names the entry every root folder of an installation has, as a copy', () => {
    expect(bitrixAdapter.rootMarkers()).toEqual(['bitrix'])
    bitrixAdapter.rootMarkers().length = 0
    expect(bitrixAdapter.rootMarkers()).toEqual(['bitrix'])
  })

  it('learns the passwords of dbconn.php and of .settings.php, one file after the other', async () => {
    const files = reader({
      'bitrix/php_interface/dbconn.php': [
        '<?',
        `define("DBPersistent", false);`,
        `$DBType = "mysql";`,
        `$DBHost = "localhost";`,
        `$DBLogin = "bitrix_user";`,
        `$DBPassword = "kernel-password";`,
        `$DBName = "sitemanager";`,
      ].join('\n'),
      'bitrix/.settings.php': [
        '<?php',
        'return array (',
        `  'connections' => array (`,
        `    'value' => array (`,
        `      'default' => array (`,
        String.raw`        'className' => '\\Bitrix\\Main\\DB\\MysqliConnection',`,
        `        'host' => 'localhost',`,
        `        'database' => 'sitemanager',`,
        `        'login' => 'bitrix_user',`,
        `        'password' => 'kernel-password',`,
        `        'options' => 2,`,
        `      ),`,
        `    ),`,
        `    'readonly' => true,`,
        `  ),`,
        `  'smtp' => ['value' => ['login' => 'robot', "password" => "mail-password"]],`,
        `);`,
      ].join('\n'),
      'bitrix/.settings_extra.php': `<?php return ['password' => 'not asked for'];`,
    })
    expect(await bitrixAdapter.configSecrets(files.read)).toEqual([
      'kernel-password',
      'mail-password',
    ])
    expect(files.asked).toEqual(['bitrix/php_interface/dbconn.php', 'bitrix/.settings.php'])
    expect(files.overlapped).toBe(false)
  })

  it.each([
    ['single quotes', `$DBPassword = 'single-quoted';`, 'single-quoted'],
    ['no space', `$DBPassword="tight-value";`, 'tight-value'],
    [
      'an escaped quote and backslash',
      String.raw`$DBPassword = 'it\'s a \\ secret';`,
      String.raw`it's a \ secret`,
    ],
    [
      'escapes of double quotes',
      String.raw`$DBPassword = "say \"\$ecret\" \\ \x41";`,
      String.raw`say "$ecret" \ A`,
    ],
  ])('reads the password of dbconn.php written with %s', async (_, dbconn, value) => {
    const { read } = reader({ 'bitrix/php_interface/dbconn.php': dbconn })
    expect(await bitrixAdapter.configSecrets(read)).toEqual([value])
  })

  it.each([
    ['the array syntax of the kernel', `array ('password' => 'kernel-style', 'options' => 2)`],
    ['the last element of an array', `array ('password' => 'kernel-style')`],
    ['a short array', `['password' => 'kernel-style']`],
    ['double quotes and no space', `["password"=>"kernel-style"]`],
  ])('reads a password of .settings.php written in %s', async (_, settings) => {
    const { read } = reader({ 'bitrix/.settings.php': `<?php return ${settings};` })
    expect(await bitrixAdapter.configSecrets(read)).toEqual(['kernel-style'])
  })

  it('learns nothing from other variables and keys, or from a value that is not one constant string', async () => {
    const { read } = reader({
      'bitrix/php_interface/dbconn.php': [
        `$DBLogin = "bitrix_user";`,
        `$DBPasswordOld = "another variable";`,
        `$dbpassword = "another variable";`,
        `$DBPassword = getenv('DB_PASSWORD');`,
        `$DBPassword = "prefix-$suffix";`,
        `$DBPassword = 'first half' . 'second half';`,
        `if ($DBPassword == "a comparison") {}`,
        `$same = $DBPassword == "a comparison";`,
        `$DBPassword = '';`,
        `$DBPassword = 'abc';`,
      ].join('\n'),
      'bitrix/.settings.php': [
        `'login' => 'bitrix_user',`,
        `'Password' => 'another key',`,
        `'password_hash' => 'another key',`,
        `'password' => getenv('DB_PASSWORD'),`,
        `'password' => 'first half' . $secondHalf,`,
        `'password' => null,`,
        `'password' => 'abc',`,
      ].join('\n'),
    })
    expect(await bitrixAdapter.configSecrets(read)).toEqual([])
  })

  it('learns nothing where more than whitespace stands between the tokens', async () => {
    // One constant string to PHP each time, and still not read: a boundary of the reader.
    const { read } = reader({
      'bitrix/php_interface/dbconn.php': [
        `$DBPassword = /* live */ "comment-before";`,
        `$DBPassword = "comment-behind" /* live */;`,
        `$DBPassword = "line-comment-behind" // live\n;`,
        `$DBPassword = ("in-parentheses");`,
      ].join('\n'),
      'bitrix/.settings.php': [
        `'password' => /* live */ 'comment-before',`,
        `'password' => 'comment-behind' /* live */,`,
        `'password' => # live\n 'hash-comment-before',`,
        `'password' => ('in-parentheses'),`,
      ].join('\n'),
    })
    expect(await bitrixAdapter.configSecrets(read)).toEqual([])
  })

  it('learns nothing without the files and does not search one above the limit', async () => {
    expect(await bitrixAdapter.configSecrets(reader({}).read)).toEqual([])
    const sized = (text: string, bytes: number) => new TextEncoder().encode(text.padEnd(bytes, ' '))
    const dbconn = `$DBPassword = "in a large dbconn";`
    const settings = `['password' => 'in large settings']`
    const files = (bytes: number) =>
      reader({
        'bitrix/php_interface/dbconn.php': sized(dbconn, bytes),
        'bitrix/.settings.php': sized(settings, bytes),
      }).read
    expect(siteImportLimits.configFileBytes).toBe(256 * 1024)
    expect(await bitrixAdapter.configSecrets(files(256 * 1024))).toEqual([
      'in a large dbconn',
      'in large settings',
    ])
    expect(await bitrixAdapter.configSecrets(files(257 * 1024))).toEqual([])
  })

  it('reads one file when the other is missing', async () => {
    const dbconn = reader({ 'bitrix/php_interface/dbconn.php': `$DBPassword = "only dbconn";` })
    expect(await bitrixAdapter.configSecrets(dbconn.read)).toEqual(['only dbconn'])
    const settings = reader({ 'bitrix/.settings.php': `['password' => 'only settings']` })
    expect(await bitrixAdapter.configSecrets(settings.read)).toEqual(['only settings'])
  })

  it('lets a failure of the reader through, so the import does not go on without the values', async () => {
    const read = async () => {
      throw new Error('connection lost')
    }
    await expect(bitrixAdapter.configSecrets(read)).rejects.toThrow('connection lost')
  })

  it('copies no database before stage 3, so its preview is unavailable rather than broken', async () => {
    const read = async () => new TextEncoder().encode(`<?php $DBName = "shop";`)
    expect(await bitrixAdapter.databaseSettings(read)).toBeNull()
  })

  it('has no MCP tools before stage 3', () => {
    expect(bitrixAdapter.mcpTools(site)).toEqual([])
  })

  it('leaves the server-dependent parts to stage 3', () => {
    for (const call of [
      () => bitrixAdapter.deployVars(site),
      () => bitrixAdapter.backup(site),
      () => bitrixAdapter.verify(site),
      () => bitrixAdapter.agentGuide(site),
    ]) {
      expect(call).toThrow('(stage 3)')
    }
  })

  it('leaves tasks in the browser to stage 3', () => {
    const ref = { kind: 'post', objectId: '1', editUrl: 'https://shop.example.ru/' } as const
    for (const call of [
      () => bitrixAdapter.browserTaskPolicy({ url: site.url }),
      () => bitrixAdapter.browserCheckpointOf(`${site.url}/bitrix/admin/`),
      () => bitrixAdapter.browserCommitAction('button', 'Сохранить'),
      () => bitrixAdapter.browserVerification(ref),
      () => bitrixAdapter.browserGuide(),
    ]) {
      expect(call).toThrow(expect.objectContaining({ code: 'NOT_IMPLEMENTED' }))
    }
  })
})
