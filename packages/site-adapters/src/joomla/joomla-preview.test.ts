import type { SiteFacts } from '@repo/domain'
import { previewRecipeSchema } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { siteApacheConf } from '../php/preview-files.ts'
import { joomlaPreviewRecipe } from './joomla-preview.ts'
import { previewConfigurationPhp, previewRewriteConf } from './preview-files.ts'

const site: SiteFacts = {
  stack: 'joomla',
  url: 'https://shop.example.ru',
  docroot: '/var/www/html',
  generation: 'j6',
  database: { tablePrefix: 'jx7_', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' },
  extras: { dbtype: 'mysqli' },
}

/** Every setting of production the recipe passes on. */
const allExtras = {
  sitename: 'Мастерская «Пример»',
  sitenamePagetitles: '2',
  metaDesc: 'Ремонт обуви',
  offset: 'Europe/Moscow',
  sef: '1',
  sefRewrite: '0',
  sefSuffix: '1',
  unicodeslugs: '0',
  listLimit: '25',
  feedLimit: '15',
}

describe('joomlaPreviewRecipe', () => {
  const recipe = joomlaPreviewRecipe(site)

  it('passes the schema of a recipe', () => {
    expect(previewRecipeSchema.safeParse(recipe).error).toBeUndefined()
  })

  it('runs Joomla on PHP and MySQL with the core it needs', () => {
    expect(recipe.runtime).toBe('php')
    expect(recipe.database).toBe('mysql')
    expect(recipe.requiredPaths).toEqual([
      'index.php',
      'includes/framework.php',
      'includes/defines.php',
      'libraries/loader.php',
      'libraries/src/Version.php',
      'administrator/index.php',
      'administrator/manifests/files/joomla.xml',
    ])
    expect(recipe.writableFolders).toEqual([
      'cache',
      'tmp',
      'administrator/cache',
      'administrator/logs',
    ])
    expect(recipe.healthPath).toBe('/')
    expect(recipe.content).toBeNull()
  })

  it('writes configuration.php and no other file a site could have', () => {
    expect(recipe.generatedFiles).toEqual([
      { path: 'configuration.php', content: previewConfigurationPhp },
    ])
    expect(previewConfigurationPhp.startsWith('<?php\n')).toBe(true)
    // The first statement requires the prologue, which marks the page and reads the settings.
    const code = previewConfigurationPhp
      .split('\n')
      .filter((line) => line !== '<?php' && !line.startsWith('//'))
    expect(code[0]).toBe("require '/run/raditi/preview/prologue.php';")
  })

  it('reads in configuration.php every setting the recipe passes', () => {
    const full = joomlaPreviewRecipe({ ...site, extras: { ...allExtras, dbtype: 'mysqli' } })
    expect(Object.keys(full.settings)).toHaveLength(11)
    for (const key of Object.keys(full.settings))
      expect(previewConfigurationPhp, key).toContain(`'${key}'`)
  })

  it('keeps the settings file out of the Registry and marks the page a preview', () => {
    // Static, so get_object_vars(new JConfig) — what Joomla's Registry reads — never sees it.
    expect(previewConfigurationPhp).toContain('public static $raditi = array();')
    expect(previewConfigurationPhp).not.toMatch(/public \$raditi\b/)
    expect(previewConfigurationPhp).toContain('JConfig::$raditi = $raditi_preview;')
    expect(previewConfigurationPhp).toContain(
      "define('RADITI_PREVIEW_ORIGIN', $raditi_preview['origin']);",
    )
    expect(previewConfigurationPhp).toContain('unset($raditi_preview);')
    // No database in the settings: a dead page, which the recipe's ready check reads.
    expect(previewConfigurationPhp).toContain('http_response_code(503);')
    expect(previewConfigurationPhp).toContain('echo "Предпросмотр ещё не готов.\\n";')
  })

  it('writes configuration.php in the syntax of PHP 7.3, which j3 and j4 run', () => {
    // No arrow function, no match, no typed property; `public static $x` is fine.
    expect(previewConfigurationPhp).not.toMatch(
      /\bfn\s*\(|\bmatch\s*\(|\b(?:public|private|protected)\s+(?!static\b)\??[a-z]+\s+\$/,
    )
  })

  it('tells a live Joomla by the mark of the configuration and the texts of a dead one', () => {
    expect(recipe.ready).toEqual({
      header: 'x-raditi-preview',
      absent: [
        'No configuration file found and no installation code available',
        'Environment Setup Incomplete',
        'Sorry, your PHP version is not supported',
        'Database Error: ',
        'Предпросмотр ещё не готов',
      ],
    })
  })

  it('serves the tree with the rules of htaccess.txt in the configuration of Apache', () => {
    const apache = recipe.web.configFiles.find((file) => file.name === 'apache2.conf')
    expect(apache?.content).not.toContain('RADITI_SITE_RULES')
    expect(apache?.content).toContain(previewRewriteConf)
    expect(apache?.content.startsWith(siteApacheConf.split('    # RADITI_SITE_RULES')[0]!)).toBe(
      true,
    )
    expect(recipe.web.configFiles.map((file) => file.name)).toEqual([
      'apache2.conf',
      'prologue.php',
    ])
    expect(recipe.web.env.PHP_INI_SCAN_DIR).toBe(':/run/raditi/preview')
  })

  it('passes the prefix and only the settings production gave', () => {
    expect(recipe.settings).toEqual({ TABLE_PREFIX: 'jx7_' })
    const full = joomlaPreviewRecipe({ ...site, extras: { ...allExtras, dbtype: 'mysqli' } })
    expect(full.settings).toEqual({
      TABLE_PREFIX: 'jx7_',
      SITENAME: 'Мастерская «Пример»',
      SITENAME_PAGETITLES: '2',
      META_DESC: 'Ремонт обуви',
      OFFSET: 'Europe/Moscow',
      SEF: '1',
      SEF_REWRITE: '0',
      SEF_SUFFIX: '1',
      UNICODESLUGS: '0',
      LIST_LIMIT: '25',
      FEED_LIMIT: '15',
    })
    expect(
      joomlaPreviewRecipe({ ...site, extras: { dbtype: 'mysqli', sef: '0' } }).settings,
    ).toEqual({ TABLE_PREFIX: 'jx7_', SEF: '0' })
  })

  it('gives the same recipe for extras with a key it does not know', () => {
    expect(joomlaPreviewRecipe({ ...site, extras: { probe: 'value' } })).toEqual(
      joomlaPreviewRecipe({ ...site, extras: {} }),
    )
  })

  it('tries the PHP of the branch, the one of the site first', () => {
    const j3 = { ...site, generation: 'j3' }
    expect(joomlaPreviewRecipe(j3).runtimeVersions).toEqual(['7.4', '7.3', '8.0'])
    expect(joomlaPreviewRecipe({ ...j3, runtimeVersion: '5.6' }).runtimeVersions[0]).toBe('7.3')
    expect(joomlaPreviewRecipe(site).runtimeVersions[0]).toBe('8.3')
    expect(joomlaPreviewRecipe({ ...site, generation: 'j4' }).runtimeVersions[0]).toBe('8.1')
    expect(joomlaPreviewRecipe({ ...site, runtimeVersion: '8.5.2' }).runtimeVersions[0]).toBe('8.5')
  })

  const { database: _database, ...withoutDatabase } = site
  const { generation: _generation, ...withoutGeneration } = site
  it.each([
    ['without the database settings', withoutDatabase],
    ['without a generation', withoutGeneration],
    ['with a generation of no row', { ...site, generation: 'j9' }],
  ])('throws %s', (_, facts: SiteFacts) => {
    expect(() => joomlaPreviewRecipe(facts)).toThrow()
  })
})
