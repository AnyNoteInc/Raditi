import type { PreviewWebServer } from '@repo/domain'
import { PREVIEW_SETTINGS_PATH } from '@repo/domain'
import { prologuePhp, siteApacheConf } from './preview-files.ts'

// The web server of a preview of a PHP stack (docs/plan/62-site-stacks.md, Т11, Т21): Apache of
// the official PHP images (php:*-apache) as www-data on 127.0.0.1:8081, behind the gateway of the
// preview's own container (docs/plan/58). The configuration is infra/preview/site-apache.conf with
// the rewrite rules of the stack at its mark; the generated configuration of the stack requires
// prologue.php, which reads the settings file. Both lie next to the settings file, outside the tree,
// and never reach git. WordPress keeps its own server block (Т11).

/** Where the runtime writes the configuration files of the server: next to the settings file. */
const settingsFolder = PREVIEW_SETTINGS_PATH.slice(0, PREVIEW_SETTINGS_PATH.lastIndexOf('/'))

/** The line of site-apache.conf the rules of a stack take the place of. */
const RULES_MARK = '    # RADITI_SITE_RULES'

/** `conf` with `siteRules` in place of its one mark line; a configuration without it throws. */
export function withSiteRules(conf: string, siteRules: string): string {
  const lines = conf.split('\n')
  const at = lines.indexOf(RULES_MARK)
  if (at === -1 || lines.indexOf(RULES_MARK, at + 1) !== -1)
    throw new Error('The configuration of Apache has no single line for the rules of a stack')
  // The rules are lines of their own: their last line break is the one the mark had.
  lines.splice(at, 1, siteRules.replace(/\n$/, ''))
  return lines.join('\n')
}

/** The block `web` of the recipe of a PHP stack whose rewrite rules are `siteRules`. */
export function phpPreviewWeb(siteRules: string): PreviewWebServer {
  return {
    command: ['apache2-foreground', '-f', `${settingsFolder}/apache2.conf`],
    env: {
      APACHE_RUN_DIR: '/tmp/apache2/run',
      APACHE_LOCK_DIR: '/tmp/apache2/lock',
      APACHE_PID_FILE: '/tmp/apache2/run/apache2.pid',
      // An ini of the stack would lie next to the settings file (Т21); none is needed so far.
      PHP_INI_SCAN_DIR: `:${settingsFolder}`,
    },
    port: 8081,
    user: '33:33',
    docroot: '/var/www/html',
    tmpfs: ['/tmp'],
    configFiles: [
      { name: 'apache2.conf', content: withSiteRules(siteApacheConf, siteRules) },
      { name: 'prologue.php', content: prologuePhp },
    ],
  }
}
