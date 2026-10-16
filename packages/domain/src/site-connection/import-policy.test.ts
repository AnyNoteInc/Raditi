import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import { isPublicationPath } from '../git/publication.ts'
import { forbiddenCiPaths } from '../policies/diff-paths.ts'
import { createImportPathPolicy, isImportSegment, isNestedSiteRoot } from './import-policy.ts'

const REPLACEMENT = String.fromCharCode(0xfffd)
const LONE_SURROGATE = String.fromCharCode(0xd800)

// The kinds of lines the site adapters use (packages/site-adapters): anchored files and folders,
// names at any depth, `*` inside a segment.
const excludeLines = [
  '/wp-config.php',
  '/wp-*.php',
  '/index.php',
  '/wp-admin/',
  '/wp-includes/',
  '/wp-content/uploads/',
  '/wp-content/cache/',
  '/wp-content/backup*/',
  '/wp-content/advanced-cache.php',
  '/.htaccess',
  'node_modules/',
  '.ssh/',
  '.vscode/',
  '*.log',
  '*.sql',
  '*.sql.gz',
  '*.csv',
  '.env',
  '.env.*',
  'id_rsa*',
  'wp-config*',
  'error_log',
]
const policy = createImportPathPolicy(excludeLines)
const nothingExcluded = createImportPathPolicy([])

describe('createImportPathPolicy', () => {
  describe('version control folders come first', () => {
    it.each([
      ['.git', 'directory'],
      ['.git/config', 'file'],
      ['.git/objects/ab/cdef', 'file'],
      ['.GIT/HEAD', 'file'],
      ['git~1/config', 'file'],
      ['GIT~1', 'directory'],
      ['.git./config', 'file'],
      ['.git /config', 'file'],
      ['.git::$INDEX_ALLOCATION/config', 'file'],
      ['wp-content/plugins/shop/.git/config', 'file'],
      // A worktree or a submodule leaves a file of this name.
      ['wp-content/themes/shop/.git', 'file'],
      ['.svn', 'directory'],
      ['.svn/pristine/ab/abcdef0123.svn-base', 'file'],
      ['wp-content/.SVN/wc.db', 'file'],
      ['.hg/store/data/wp-config.php.i', 'file'],
      ['sub/.hg', 'directory'],
      ['.bzr/checkout/dirstate', 'file'],
      ['CVS/Entries', 'file'],
      ['wp-content/themes/shop/CVS/Root', 'file'],
      // A bare repository left next to the code.
      ['site.git', 'directory'],
      ['backup/site.git/HEAD', 'file'],
      ['backup/site.GIT/objects/pack/pack-1.pack', 'file'],
    ] as const)('leaves %s out as vcs', (path, type) => {
      expect(policy.decide(path, type)).toBe('vcs')
      expect(nothingExcluded.decide(path, type)).toBe('vcs')
    })

    it('reports the paths git itself refuses as vcs, not as unsupported', () => {
      for (const segment of ['.git', '.GIT', 'git~1', '.git.', '.git ', '.git:stream']) {
        expect(isPublicationPath(`${segment}/config`)).toBe(false)
        expect(nothingExcluded.decide(`${segment}/config`, 'file')).toBe('vcs')
        expect(nothingExcluded.decide(`themes/${segment}`, 'directory')).toBe('vcs')
      }
    })

    it('wins over a CI path and an exclude line', () => {
      expect(policy.decide('.github/.git/config', 'file')).toBe('vcs')
      expect(policy.decide('wp-admin/.svn/entries', 'file')).toBe('vcs')
      expect(policy.decide('.svn/debug.log', 'file')).toBe('vcs')
    })

    it.each([
      ['.gitignore', 'file'],
      ['.gitattributes', 'file'],
      ['.gitkeep', 'file'],
      ['wp-content/themes/shop/.gitignore', 'file'],
      // A file may end in `.git`; only a folder is a bare repository.
      ['docs/notes.git', 'file'],
      ['git', 'directory'],
      ['.gitx/file', 'file'],
      ['svn/readme.txt', 'file'],
      // Lower case is an ordinary folder name («CVs»); the tool writes `CVS`.
      ['cvs/ivanov.pdf', 'file'],
      ['hg/readme.txt', 'file'],
    ] as const)('does not take %s for a version control folder', (path, type) => {
      expect(nothingExcluded.decide(path, type)).toBe('take')
    })
  })

  describe('paths a repository cannot hold', () => {
    it.each([
      '',
      '/wp-content/a.php',
      '-rf',
      'a//b',
      'a/./b',
      'a/../b',
      '..',
      'a/',
      'C:/site/index.php',
      'a\\b.php',
      'a\u0007b.php',
      'dir/a\nb',
      'a\u007f',
      `ф${REPLACEMENT}.jpg`,
      Array.from({ length: 33 }, () => 'd').join('/'),
      `${'a'.repeat(1020)}/b.php`,
    ])('leaves %j out as unsupported_path', (path) => {
      expect(nothingExcluded.decide(path, 'file')).toBe('unsupported_path')
      expect(policy.decide(path, 'file')).toBe('unsupported_path')
    })

    it('comes before the exclude lines', () => {
      expect(policy.decide('/wp-config.php', 'file')).toBe('unsupported_path')
      expect(policy.decide('a//debug.log', 'file')).toBe('unsupported_path')
    })
  })

  describe('CI paths (CLAUDE.md rule 6)', () => {
    it.each([
      ['.github', 'directory'],
      ['.github/workflows/deploy.yml', 'file'],
      ['.GitHub/Workflows/deploy.yml', 'file'],
      ['.gitea', 'directory'],
      ['.gitea/workflows/deploy.yml', 'file'],
      ['.forgejo/workflows/x.yml', 'file'],
      ['.gitlab-ci.yml', 'file'],
      ['.GITLAB-CI.YML', 'file'],
      ['.gitlab/ci/build.yml', 'file'],
      ['.woodpecker.yml', 'file'],
      ['.woodpecker/pipeline.yml', 'file'],
      ['.drone.yml', 'file'],
      ['Jenkinsfile', 'file'],
      ['JENKINSFILE', 'file'],
      ['bitbucket-pipelines.yml', 'file'],
      ['.circleci/config.yml', 'file'],
      ['.gitmodules', 'file'],
      ['.GitModules', 'file'],
    ] as const)('leaves %s out as ci', (path, type) => {
      expect(nothingExcluded.decide(path, type)).toBe('ci')
      expect(policy.decide(path, type)).toBe('ci')
    })

    it('covers every entry of forbiddenCiPaths, as a file and as a folder', () => {
      for (const pattern of forbiddenCiPaths) {
        const path = pattern.replace('*', '.yml').replace(/\/$/, '')
        const type = pattern.endsWith('/') ? 'directory' : 'file'
        expect(nothingExcluded.decide(path, type), pattern).toBe('ci')
        expect(nothingExcluded.decide(path.toUpperCase(), type), pattern).toBe('ci')
      }
    })

    it('comes before the exclude lines and only at the root of the repository', () => {
      expect(createImportPathPolicy(['.github/']).decide('.github/workflows/x.yml', 'file')).toBe(
        'ci',
      )
      expect(nothingExcluded.decide('docs/.github/readme.md', 'file')).toBe('take')
      expect(nothingExcluded.decide('wp-content/themes/shop/.gitlab-ci.yml', 'file')).toBe('take')
    })
  })

  describe('exclude lines', () => {
    it.each([
      // Anchored files.
      ['wp-config.php', 'file'],
      ['wp-login.php', 'file'],
      ['wp-settings.php', 'file'],
      ['index.php', 'file'],
      ['.htaccess', 'file'],
      ['wp-content/advanced-cache.php', 'file'],
      // Anchored folders and everything below them.
      ['wp-admin', 'directory'],
      ['wp-admin/index.php', 'file'],
      ['wp-includes/js/jquery/jquery.js', 'file'],
      ['wp-content/uploads', 'directory'],
      ['wp-content/uploads/2026/10/photo.jpg', 'file'],
      ['wp-content/cache/page/index.html', 'file'],
      ['wp-content/backups', 'directory'],
      ['wp-content/backup-2026/site.tar', 'file'],
      ['wp-content/backup/readme.txt', 'file'],
      // Names at any depth.
      ['node_modules', 'directory'],
      ['wp-content/themes/shop/node_modules/a/index.js', 'file'],
      ['.ssh/authorized_keys', 'file'],
      ['wp-content/.vscode/sftp.json', 'file'],
      ['debug.log', 'file'],
      ['.log', 'file'],
      ['wp-content/debug.log', 'file'],
      ['dump.sql', 'file'],
      ['wp-content/dump.sql.gz', 'file'],
      ['orders.csv', 'file'],
      ['.env', 'file'],
      ['app/.env', 'file'],
      ['.env.production', 'file'],
      ['id_rsa', 'file'],
      ['keys/id_rsa.pub', 'file'],
      ['error_log', 'file'],
      ['wp-admin-old/error_log', 'file'],
      // `wp-config*` has no slash: any depth, any ending.
      ['old/wp-config.php', 'file'],
      ['wp-config.php.save', 'file'],
      ['backup/wp-config.txt', 'file'],
      ['wp-config-sample.php', 'file'],
      // A folder with the name of an excluded file is excluded with everything below it.
      ['logs.sql/readme.txt', 'file'],
      ['.env/secrets.txt', 'file'],
    ] as const)('leaves %s out as excluded', (path, type) => {
      expect(policy.decide(path, type)).toBe('excluded')
      expect(nothingExcluded.decide(path, type)).toBe('take')
    })

    it.each([
      ['wp-content/themes/shop/functions.php', 'file'],
      ['wp-content/themes/shop', 'directory'],
      ['wp-content', 'directory'],
      ['wp-content/plugins/shop/index.php', 'file'],
      ['readme.md', 'file'],
      // Anchored to the root: the same name deeper is the site's own code.
      ['wp-content/themes/shop/wp-login.php', 'file'],
      ['wp-content/themes/shop/.htaccess', 'file'],
      ['other/wp-admin/index.php', 'file'],
      ['other/wp-content/uploads/a.jpg', 'file'],
      // A trailing slash means a folder: a file of that name is taken.
      ['wp-admin', 'file'],
      ['node_modules', 'file'],
      ['wp-content/.ssh', 'file'],
      ['wp-content/backup.txt', 'file'],
      // `*` stays inside one segment and a name matches whole.
      ['wp-content/x.php', 'file'],
      ['wp-content/uploadsx/a.jpg', 'file'],
      ['wp-adminx/index.php', 'file'],
      ['logo.png', 'file'],
      ['debug.log.txt', 'file'],
      ['catalog', 'directory'],
      ['.envrc', 'file'],
      ['env', 'file'],
      ['my_id_rsa', 'file'],
      ['error_log.php', 'file'],
    ] as const)('takes %s', (path, type) => {
      expect(policy.decide(path, type)).toBe('take')
    })

    it('ignores letter case: it only excludes more', () => {
      expect(policy.decide('WP-CONFIG.PHP', 'file')).toBe('excluded')
      expect(policy.decide('Wp-Admin/Index.php', 'file')).toBe('excluded')
      expect(policy.decide('WP-Content/Uploads/a.JPG', 'file')).toBe('excluded')
      expect(policy.decide('Debug.LOG', 'file')).toBe('excluded')
      expect(policy.decide('Node_Modules', 'directory')).toBe('excluded')
      expect(createImportPathPolicy(['/Local/Secret.PHP']).decide('local/secret.php', 'file')).toBe(
        'excluded',
      )
    })

    it('anchors a line with a slash in the middle, as .gitignore does', () => {
      const anchored = createImportPathPolicy(['docs/private', 'bitrix/cache/'])
      expect(anchored.decide('docs/private', 'file')).toBe('excluded')
      expect(anchored.decide('docs/private/plan.md', 'file')).toBe('excluded')
      expect(anchored.decide('site/docs/private/plan.md', 'file')).toBe('take')
      expect(anchored.decide('bitrix/cache/a.php', 'file')).toBe('excluded')
      expect(anchored.decide('bitrix/cache', 'file')).toBe('take')
      expect(anchored.decide('local/bitrix/cache/a.php', 'file')).toBe('take')
    })

    it('reads a regular expression character of a line as itself', () => {
      const literal = createImportPathPolicy(['a.b', 'x+y', '(old)/', '/price$.txt', 'a|b', 'q{1}'])
      expect(literal.decide('a.b', 'file')).toBe('excluded')
      expect(literal.decide('axb', 'file')).toBe('take')
      expect(literal.decide('x+y', 'file')).toBe('excluded')
      expect(literal.decide('xxy', 'file')).toBe('take')
      expect(literal.decide('(old)/index.php', 'file')).toBe('excluded')
      expect(literal.decide('old/index.php', 'file')).toBe('take')
      expect(literal.decide('price$.txt', 'file')).toBe('excluded')
      expect(literal.decide('a|b', 'file')).toBe('excluded')
      expect(literal.decide('a', 'file')).toBe('take')
      expect(literal.decide('q{1}', 'file')).toBe('excluded')
      expect(literal.decide('q', 'file')).toBe('take')
    })

    it('keeps a name that only begins or ends like a dot segment', () => {
      const dotted = createImportPathPolicy(['...', '..a', 'a..', '/.b', 'c/.../'])
      expect(dotted.decide('...', 'file')).toBe('excluded')
      expect(dotted.decide('x/..a', 'file')).toBe('excluded')
      expect(dotted.decide('a../x.php', 'file')).toBe('excluded')
      expect(dotted.decide('.b', 'file')).toBe('excluded')
      expect(dotted.decide('c/.../x.php', 'file')).toBe('excluded')
      expect(dotted.decide('c/x.php', 'file')).toBe('take')
    })

    it('takes everything else when there is no line', () => {
      expect(nothingExcluded.decide('wp-config.php', 'file')).toBe('take')
      expect(nothingExcluded.decide('wp-content/uploads', 'directory')).toBe('take')
    })
  })

  describe('lines outside the supported subset', () => {
    it.each([
      '**/cache',
      'cache/**',
      'a/**/b',
      '!wp-config.php',
      'important!.txt',
      '[Bb]ackup',
      'file?.php',
      'a\\ b',
      '',
      ' ',
      '# comment',
      '#',
      'trailing ',
      ' leading',
      '*.log\n',
      '/',
      '//',
      '//wp-admin/',
      'a//b',
      'wp-admin//',
      // A line no path of a repository can match: it would exclude nothing, silently.
      '.',
      '..',
      './wp-admin/',
      '../secret',
      '/./wp-admin',
      'a/./b',
      'a/../b',
      'wp-content/..',
      'a\u0000b',
      'a\tb',
      'wp-content/de\nbug.log',
      'a\u007fb',
    ])('refuses the line %j at construction', (line) => {
      let thrown: unknown
      try {
        createImportPathPolicy(['*.log', line, '/wp-admin/'])
      } catch (error) {
        thrown = error
      }
      expect(isDomainError(thrown)).toBe(true)
      expect(thrown).toMatchObject({
        code: 'BAD_REQUEST',
        message: `Unsupported import exclude line: "${line}"`,
      })
    })
  })
})

describe('isNestedSiteRoot', () => {
  const markers = ['wp-content', 'wp-includes']

  it('knows another installation by every marker of the stack', () => {
    expect(isNestedSiteRoot(['index.php', 'wp-admin', 'wp-content', 'wp-includes'], markers)).toBe(
      true,
    )
    expect(isNestedSiteRoot(['wp-includes', 'wp-content'], markers)).toBe(true)
    // Without letter case on either side, as the check of the root folder compares them.
    expect(isNestedSiteRoot(['WP-Content', 'WP-INCLUDES'], markers)).toBe(true)
    expect(isNestedSiteRoot(['wp-content', 'wp-includes'], ['WP-Content', 'WP-Includes'])).toBe(
      true,
    )
    expect(isNestedSiteRoot(['bitrix', 'upload', 'local'], ['bitrix'])).toBe(true)
  })

  it('enters a folder that misses a marker', () => {
    expect(isNestedSiteRoot(['wp-content', 'index.php'], markers)).toBe(false)
    expect(isNestedSiteRoot(['wp-contents', 'wp-includes-old'], markers)).toBe(false)
    expect(isNestedSiteRoot([], markers)).toBe(false)
  })

  it('is never true for a stack without markers: every folder would be a nested site', () => {
    expect(isNestedSiteRoot(['index.html', 'css'], [])).toBe(false)
    expect(isNestedSiteRoot([], [])).toBe(false)
  })
})

describe('isImportSegment', () => {
  // The names of the FTP decoding table (docs/plan/39-site-connection-wizard.md): a name that
  // could not be decoded carries U+FFFD, and the cp1251 step leaves U+0098 for the byte 0x98.
  it.each([
    ['foto.jpg', true],
    ['фото.jpg', true],
    [`ф${REPLACEMENT}.jpg`, false],
    ['ф\u0098.jpg', false],
    ['a\u0007b', false],
  ])('answers for the name %j: %s', (name, imported) => {
    expect(isImportSegment(name)).toBe(imported)
  })

  it.each([
    'index.php',
    '.htaccess',
    '.env',
    '...',
    '-rf',
    'my file (1).txt',
    'файл с пробелами.txt',
    '😀.png',
    '~backup',
    'a:b',
    'a'.repeat(255),
    'я'.repeat(127),
  ])('accepts %j', (name) => {
    expect(isImportSegment(name)).toBe(true)
  })

  it.each([
    '',
    '.',
    '..',
    'a/b',
    '/',
    'a\\b',
    '\u0000',
    'a\tb',
    'a\nb',
    'a\u001fb',
    'a\u007fb',
    'a\u0080b',
    'a\u009fb',
    REPLACEMENT,
    `a${LONE_SURROGATE}b`,
    'a'.repeat(256),
    // 256 bytes in 128 characters.
    'я'.repeat(128),
  ])('refuses %j', (name) => {
    expect(isImportSegment(name)).toBe(false)
  })
})
