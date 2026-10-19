import { readFileSync } from 'node:fs'

import type { SiteFacts } from '@repo/domain'
import { dbOperationKinds, isForbiddenPath, PREVIEW_SETTINGS_PATH } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { wordpressAdapter } from './wordpress.ts'
import {
  wordpressDbOperationKinds,
  wordpressPhpVersions,
  wordpressPreviewFiles,
  wordpressPreviewRecipe,
} from './wordpress-preview.ts'
import * as embedded from './wordpress-preview-files.ts'

const site: SiteFacts = {
  stack: 'wordpress',
  url: 'https://shop.example.ru',
  docroot: '/var/www/html',
  extras: {},
  database: { tablePrefix: 'wp_', charset: 'utf8mb4', collation: null },
}

// The files are embedded because the orchestrator image has no infra/; these are their sources.
const sources = {
  raditiContentPhp: readFileSync(
    new URL('../../../infra/wordpress/raditi-content.php', import.meta.url),
    'utf8',
  ),
  raditiPreviewPhp: readFileSync(
    new URL('../../../infra/wordpress/raditi-preview.php', import.meta.url),
    'utf8',
  ),
  previewWpConfigPhp: readFileSync(
    new URL('../../../infra/wordpress/preview-wp-config.php', import.meta.url),
    'utf8',
  ),
  previewApacheConf: readFileSync(
    new URL('../../../infra/wordpress/preview-apache.conf', import.meta.url),
    'utf8',
  ),
}

describe('the preview recipe of WordPress', () => {
  it('embeds the files of infra/wordpress as they are', () => {
    const run = 'run `node packages/site-adapters/scripts/embed-wordpress-files.mjs`'
    for (const [name, source] of Object.entries(sources))
      expect(embedded[name as keyof typeof sources], `${name} differs: ${run}`).toBe(source)
  })

  it('writes the configuration, the mu-plugin and the content plugin over the tree', () => {
    const recipe = wordpressPreviewRecipe(site)
    expect(recipe.generatedFiles).toEqual([
      { path: 'wp-config.php', content: sources.previewWpConfigPhp },
      { path: 'wp-content/mu-plugins/raditi-content.php', content: sources.raditiContentPhp },
      { path: 'wp-content/mu-plugins/raditi-preview.php', content: sources.raditiPreviewPhp },
    ])
    // The agent never writes a file the platform writes (Р11): each is a protected path.
    const protectedPaths = wordpressAdapter.protectedPaths(site)
    for (const file of wordpressPreviewFiles)
      expect(isForbiddenPath(file.path, protectedPaths), file.path).toBe(true)
    // Nothing per preview and no secret is in them: wp-config.php reads the settings file.
    expect(sources.previewWpConfigPhp).toContain(`'${PREVIEW_SETTINGS_PATH}'`)
    expect(sources.previewWpConfigPhp).not.toMatch(/define\(\s*'DB_PASSWORD'\s*,\s*['"]/)
    expect(sources.previewWpConfigPhp).toMatch(/^require_once ABSPATH \. 'wp-settings\.php';$/m)
  })

  it('needs the core of WordPress in the repository and answers on its front page', () => {
    const recipe = wordpressPreviewRecipe(site)
    expect(recipe.requiredPaths).toContain('wp-includes/version.php')
    expect(recipe.requiredPaths).toContain('wp-settings.php')
    expect(recipe.database).toBe('mysql')
    expect(recipe.healthPath).toBe('/')
  })

  it('passes the prefix and the encoding of production to wp-config.php', () => {
    expect(
      wordpressPreviewRecipe({
        ...site,
        database: { tablePrefix: 'shop_', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' },
      }).settings,
    ).toEqual({ TABLE_PREFIX: 'shop_', DB_CHARSET: 'utf8mb4', DB_COLLATE: 'utf8mb4_unicode_ci' })
    expect(wordpressPreviewRecipe(site).settings).toEqual({
      TABLE_PREFIX: 'wp_',
      DB_CHARSET: 'utf8mb4',
      DB_COLLATE: '',
    })
  })

  it('never guesses the prefix: without the settings of production there is no recipe', () => {
    const { database: _database, ...unread } = site
    expect(() => wordpressPreviewRecipe(unread)).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
  })

  it('runs Apache unprivileged on 8080 with its configuration next to the settings file', () => {
    const { web } = wordpressPreviewRecipe(site)
    expect(web.port).toBe(8080)
    expect(web.user).toBe('33:33')
    const [file] = web.configFiles
    const folder = PREVIEW_SETTINGS_PATH.slice(0, PREVIEW_SETTINGS_PATH.lastIndexOf('/'))
    expect(web.command).toEqual(['apache2-foreground', '-f', `${folder}/${file?.name}`])
    const conf = file?.content ?? ''
    expect(conf).toBe(sources.previewApacheConf)
    expect(conf).toMatch(new RegExp(`^Listen ${web.port}$`, 'm'))
    expect(conf).toMatch(new RegExp(`^DocumentRoot ${web.docroot}$`, 'm'))
    // No .htaccess of the site is read; nothing but /tmp is written.
    expect(conf).not.toMatch(/AllowOverride (?!None)/)
    // What a sync wrote runs at the next request: opcache looks at file times every time (R12).
    for (const module of ['php_module', 'php7_module'])
      expect(conf).toContain(
        `<IfModule ${module}>\n    php_admin_flag opcache.validate_timestamps on\n    php_admin_value opcache.revalidate_freq 0\n</IfModule>`,
      )
    for (const path of [...Object.values(web.env), ...conf.matchAll(/\/tmp\/\S+/g)].map(String))
      expect(
        web.tmpfs.some((dir) => path.startsWith(`${dir}/`)),
        path,
      ).toBe(true)
  })

  it('runs the PHP of the hosting, else the nearest one', () => {
    expect(wordpressPhpVersions(undefined)[0]).toBe('8.3')
    expect(wordpressPhpVersions('8.1.31')).toEqual([
      '8.1',
      '8.0',
      '8.2',
      '8.3',
      '8.4',
      '8.5',
      '7.4',
    ])
    expect(wordpressPhpVersions('7.2')[0]).toBe('7.4')
    expect(wordpressPhpVersions('9.1')[0]).toBe('8.5')
    expect(wordpressPhpVersions('php')[0]).toBe('8.3')
    expect(wordpressPreviewRecipe({ ...site, runtimeVersion: '8.2' }).runtimeVersions[0]).toBe(
      '8.2',
    )
  })

  it('replays every kind of a database plan', () => {
    expect(wordpressDbOperationKinds()).toEqual([...dbOperationKinds])
    for (const kind of wordpressDbOperationKinds()) expect(dbOperationKinds).toContain(kind)
  })
})
