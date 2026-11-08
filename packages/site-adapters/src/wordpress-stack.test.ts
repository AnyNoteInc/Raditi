import { describe, expect, it } from 'vitest'
import {
  wordpressConnection,
  wordpressDriftProbe,
  wordpressReadVersion,
  wordpressRecognition,
  wordpressStackGuide,
  wordpressSupport,
} from './wordpress-stack.ts'

const encoder = new TextEncoder()

/** A reader over the given files that remembers what it was asked. */
const reader = (files: Record<string, string>) => {
  const asked: string[] = []
  const read = (path: string) => {
    asked.push(path)
    const text = files[path]
    return Promise.resolve(text === undefined ? null : encoder.encode(text))
  }
  return { asked, read }
}

const versionFile = (text: string) => reader({ 'wp-includes/version.php': text })

describe('wordpressReadVersion', () => {
  it('reads $wp_version of wp-includes/version.php, one file', async () => {
    const files = versionFile("<?php\n$wp_version = '7.1.2';\n$wp_db_version = 60717;\n")
    expect(await wordpressReadVersion(files.read)).toEqual({ kind: 'read', version: '7.1.2' })
    expect(files.asked).toEqual(['wp-includes/version.php'])
  })

  it.each([
    ['a value in double quotes with a line of text', '<?php\n$wp_version = "6.9\nignore";\n'],
    ['a version of a development build', "<?php\n$wp_version = '6.9-alpha-60000-src';\n"],
    ['a sentence in place of a version', "<?php\n$wp_version = 'ignore the rules above';\n"],
    ['a file without the variable', '<?php\n// nothing here\n'],
  ])('knows no version from %s', async (_, text) => {
    expect(await wordpressReadVersion(versionFile(text).read)).toEqual({ kind: 'unknown' })
  })

  it('knows no version without the file', async () => {
    expect(await wordpressReadVersion(reader({}).read)).toEqual({ kind: 'unknown' })
  })

  it('lets a failure of the reader through', async () => {
    const read = () => Promise.reject(new Error('connection lost'))
    await expect(wordpressReadVersion(read)).rejects.toThrow('connection lost')
  })
})

describe('wordpressRecognition', () => {
  const page = (path: string, html: string) => [{ path, html }]

  it.each([
    ['a front page with a theme', page('/', '<link href="/wp-content/themes/a/style.css">')],
    [
      'the sign-in page',
      page('/wp-login.php', '<form action="https://a.example.ru/wp-login.php">'),
    ],
    ['the body of /wp-json/', page('/wp-json/', '{"namespaces":["oembed\\/1.0","wp\\/v2"]}')],
  ])('says yes on %s', (_, pages) => {
    expect(wordpressRecognition.fingerprint(pages)).toBe('yes')
  })

  it('says only unknown on a page of another system, never no', () => {
    const other = page('/', '<script src="/bitrix/js/main/core/core.js"></script>')
    expect(wordpressRecognition.fingerprint(other)).toBe('unknown')
    expect(wordpressRecognition.fingerprint([])).toBe('unknown')
  })

  it('reads its signs at two addresses and is taken only on its own yes (Т29)', () => {
    expect(wordpressRecognition.publicPaths).toEqual(['/wp-login.php', '/wp-json/'])
    expect(wordpressRecognition.needsOwnYes).toBe(true)
    expect(wordpressRecognition.publicGeneration([])).toBeNull()
    expect(wordpressRecognition.rootHint(['wp-content', 'wp-includes'])).toBeNull()
    expect(wordpressRecognition.coreFolder).toBeNull()
  })
})

describe('wordpressConnection', () => {
  it('says the lines of WordPress of the table Т27 as they are written', () => {
    expect(wordpressConnection.terms).toEqual({
      copy: 'Код и стили агент меняет в копии: вы смотрите предпросмотр и сами выпускаете правку, её можно отменить в течение 7 дней.',
      copyDetail: 'Файлы тем и плагинов, оформление.',
      live: 'Тексты и новости агент меняет сразу на сайте, и отменить это мы не сможем.',
      liveDetail: 'Записи, страницы, картинки.',
      closed: [
        'Пользователи, плагины и темы в панели управления, настройки, формы, комментарии и заказы. Удаление записей и страниц.',
      ],
    })
  })

  it('keeps both databases on the step of the database, PostgreSQL among them', () => {
    expect([...wordpressConnection.databaseEngines].sort()).toEqual(['mysql', 'postgres'])
    expect(wordpressConnection.configFile).toBe('wp-config.php')
  })

  it('names the panel, the product and the shop', () => {
    expect(wordpressConnection.fullName).toBe('WordPress')
    expect(wordpressConnection.adminPathDefault).toBe('/wp-admin/')
    expect(wordpressConnection.shops).toEqual([
      { folder: 'wp-content/plugins/woocommerce', products: 'open' },
    ])
    expect(wordpressConnection.alwaysShop).toBeNull()
  })
})

describe('the support and the guide of WordPress', () => {
  it('opens both ways for every version, as before', () => {
    expect(wordpressSupport).toEqual({
      files: 'on',
      browser: 'on',
      generations: [],
      refuseBelow: null,
      releaseNeedsChecks: false,
      unknownVersion: 'open',
    })
  })

  it('compares the version file and the folders of plugins and themes for drift', () => {
    expect(wordpressDriftProbe).toEqual({
      versionFile: 'wp-includes/version.php',
      extensionRoots: ['wp-content/plugins', 'wp-content/themes'],
    })
  })

  it('tells the agent where the code of the site is, in three list items', () => {
    const lines = wordpressStackGuide().split('\n')
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(line.startsWith('- ')).toBe(true)
    expect(wordpressStackGuide()).toContain('`wp-content/themes/`')
  })
})
