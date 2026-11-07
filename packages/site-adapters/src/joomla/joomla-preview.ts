import type { PreviewRecipe, SiteFacts } from '@repo/domain'
import { previewRecipeSchema } from '@repo/domain'
import { phpPreviewWeb } from '../php/preview-web.ts'
import { phpVersionsNear } from '../php/versions.ts'
import { type JoomlaFacts, joomlaFactsOf } from './joomla-config.ts'
import { joomlaDatabaseOf, joomlaGenerationOf } from './joomla-db-copy.ts'
import { JOOMLA_MANIFEST } from './joomla-version.ts'
import { previewConfigurationPhp, previewRewriteConf } from './preview-files.ts'

// How a Joomla site runs as a preview (docs/plan/62-site-stacks.md, Т18, Т21, Т33, Т56;
// docs/plan/62-slices/e3.md, Э3.7). The files come from infra/joomla (preview-files.ts): a
// configuration.php with no secret that reads the settings file through the shared prologue, and
// the rules of Joomla's htaccess.txt for the shared configuration of Apache. A preview of Joomla
// reaches no content through a plugin: its database plan is empty and its content is changed in
// the panel (Т8).

/** The settings of the generated configuration, by the key of the facts read from production. */
const settingNames: Record<Exclude<keyof JoomlaFacts, 'dbtype'>, string> = {
  sitename: 'SITENAME',
  sitenamePagetitles: 'SITENAME_PAGETITLES',
  metaDesc: 'META_DESC',
  offset: 'OFFSET',
  sef: 'SEF',
  sefRewrite: 'SEF_REWRITE',
  sefSuffix: 'SEF_SUFFIX',
  unicodeslugs: 'UNICODESLUGS',
  listLimit: 'LIST_LIMIT',
  feedLimit: 'FEED_LIMIT',
}

/** Only the settings production gave: the configuration keeps its own value for the others. */
function settingsOf(facts: JoomlaFacts): Record<string, string> {
  const settings: Record<string, string> = {}
  for (const [key, name] of Object.entries(settingNames)) {
    const value = facts[key as keyof typeof settingNames]
    if (value !== undefined) settings[name] = value
  }
  return settings
}

/**
 * `SiteAdapter.previewRecipe`. The prefix is that of `site.database`, the PHP that of the branch
 * of the record, the site's own first (Т18): a preview never guesses either.
 */
export function joomlaPreviewRecipe(site: SiteFacts): PreviewRecipe {
  const database = joomlaDatabaseOf(site)
  const generation = joomlaGenerationOf(site)
  const facts = joomlaFactsOf(site.extras)
  return previewRecipeSchema.parse({
    runtime: 'php',
    runtimeVersions: phpVersionsNear(generation.php, site.runtimeVersion),
    database: 'mysql',
    // The core is in the repository since the import: without it the preview is unavailable
    // (`no_core`), never a broken page. `libraries/bootstrap.php` is not there on 3.10.
    requiredPaths: [
      'index.php',
      'includes/framework.php',
      'includes/defines.php',
      'libraries/loader.php',
      'libraries/src/Version.php',
      'administrator/index.php',
      JOOMLA_MANIFEST,
    ],
    generatedFiles: [{ path: 'configuration.php', content: previewConfigurationPhp }],
    // What Joomla writes at runtime and the import leaves out.
    writableFolders: ['cache', 'tmp', 'administrator/cache', 'administrator/logs'],
    settings: { TABLE_PREFIX: database.tablePrefix, ...settingsOf(facts) },
    healthPath: '/',
    // The prologue the configuration requires marks a page; the texts are those Joomla prints at
    // 200 when it did not start: no configuration, an old PHP, no database.
    ready: {
      header: 'x-raditi-preview',
      absent: [
        'No configuration file found and no installation code available',
        'Environment Setup Incomplete',
        'Sorry, your PHP version is not supported',
        'Database Error: ',
        'Предпросмотр ещё не готов',
      ],
    },
    web: phpPreviewWeb(previewRewriteConf),
    content: null,
  })
}
