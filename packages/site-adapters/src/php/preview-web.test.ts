import { PREVIEW_SETTINGS_PATH, previewRecipeSchema } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { prologuePhp, siteApacheConf } from './preview-files.ts'
import { phpPreviewWeb, withSiteRules } from './preview-web.ts'

const RULES = '    RewriteEngine On\n    RewriteRule ^a$ index.php?q=$1 [L,QSA]\n'

describe('phpPreviewWeb', () => {
  const web = phpPreviewWeb(RULES)

  it('passes the schema of a recipe', () => {
    const recipe = previewRecipeSchema.safeParse({
      runtime: 'php',
      runtimeVersions: ['8.3'],
      database: 'mysql',
      requiredPaths: [],
      generatedFiles: [],
      settings: {},
      healthPath: '/',
      web,
    })
    expect(recipe.error).toBeUndefined()
  })

  it('runs Apache as www-data on the configuration it writes next to the settings file', () => {
    const folder = PREVIEW_SETTINGS_PATH.slice(0, PREVIEW_SETTINGS_PATH.lastIndexOf('/'))
    expect(folder).toBe('/run/raditi/preview')
    expect(web.command).toEqual(['apache2-foreground', '-f', `${folder}/apache2.conf`])
    expect(web.user).toBe('33:33')
    expect(web.port).toBe(8081)
    expect(web.docroot).toBe('/var/www/html')
    expect(web.tmpfs).toEqual(['/tmp'])
    expect(web.env).toEqual({
      APACHE_RUN_DIR: '/tmp/apache2/run',
      APACHE_LOCK_DIR: '/tmp/apache2/lock',
      APACHE_PID_FILE: '/tmp/apache2/run/apache2.pid',
      PHP_INI_SCAN_DIR: ':/run/raditi/preview',
    })
  })

  it('hands over the configuration of Apache with the rules and the prologue', () => {
    expect(web.configFiles.map((file) => file.name)).toEqual(['apache2.conf', 'prologue.php'])
    const [apache, prologue] = web.configFiles
    expect(prologue?.content).toBe(prologuePhp)
    expect(apache?.content).not.toContain('RADITI_SITE_RULES')
    // In the folder of the docroot, word for word: `$1` is not a pattern of a replacement.
    expect(apache?.content).toContain(
      `    DirectoryIndex index.php index.html\n${RULES}</Directory>`,
    )
    expect(apache?.content.split('\n')).toHaveLength(siteApacheConf.split('\n').length + 1)
  })
})

describe('withSiteRules', () => {
  it('puts the rules in place of the mark line', () => {
    expect(withSiteRules('a\n    # RADITI_SITE_RULES\nb\n', '    x\n    y\n')).toBe(
      'a\n    x\n    y\nb\n',
    )
    expect(withSiteRules('a\n    # RADITI_SITE_RULES\nb', "    $& $' $`")).toBe(
      "a\n    $& $' $`\nb",
    )
  })

  it.each([
    ['no mark', 'a\nb\n'],
    ['a mark in another indent', 'a\n  # RADITI_SITE_RULES\nb\n'],
    ['a mark inside a line', 'a # RADITI_SITE_RULES\n'],
    ['two marks', '    # RADITI_SITE_RULES\n    # RADITI_SITE_RULES\n'],
  ])('throws on a configuration with %s', (_, conf) => {
    expect(() => withSiteRules(conf, RULES)).toThrow(/no single line for the rules/)
  })
})
