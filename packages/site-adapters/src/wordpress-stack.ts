import type {
  SiteDriftProbe,
  SiteRead,
  SiteVersionReading,
  StackConnection,
  StackRecognition,
  StackSupport,
} from '@repo/domain'
import { parseSiteVersion } from '@repo/domain'
import { coreVersion } from './wordpress-public-code.ts'

// What WordPress declares of its stack (docs/plan/62-site-stacks.md, §2.3, Т14, Т15, Т17, Т26–Т29,
// Т32): its support, how it is recognised, what the wizard says of it and where its version is.
// Nothing here is read by the product before Э9 and Э6а; the values keep WordPress as it works.

/** Every version of WordPress is open: the version is not judged, and an unknown one narrows nothing. */
export const wordpressSupport: StackSupport = {
  files: 'on',
  browser: 'on',
  generations: [],
  refuseBelow: null,
  releaseNeedsChecks: false,
  unknownVersion: 'open',
}

/** The paths of a theme or the core, the sign-in page and a route of the REST API (escaped in JSON). */
const SIGNS = /\/wp-content\/|\/wp-includes\/|wp-login\.php|wp\\?\/v2/

export const wordpressRecognition: StackRecognition = {
  publicPaths: ['/wp-login.php', '/wp-json/'],
  // Never `no`: a site may hide its signs, and the absence of them says nothing (question В4 of Э2).
  fingerprint: (pages) => (pages.some((page) => SIGNS.test(page.html)) ? 'yes' : 'unknown'),
  publicGeneration: () => null,
  needsOwnYes: true,
  rootHint: () => null,
  coreFolder: null,
}

export const wordpressConnection: StackConnection = {
  // The step of the database as before: three choices (Т26, the board O-db-wordpress).
  databaseEngines: ['postgres', 'mysql'],
  fullName: 'WordPress',
  // The field of the tab «Без доступа» (Т29, the board O-noaccess-foreign).
  adminPathDefault: '/wp-admin/',
  shops: [{ folder: 'wp-content/plugins/woocommerce', products: 'open' }],
  alwaysShop: null,
  // Э8.23 sets it once the guard of prices stands.
  pricesGuarded: false,
  configFile: 'wp-config.php',
  terms: {
    copy: 'Код и стили агент меняет в копии: вы смотрите предпросмотр и сами выпускаете правку, её можно отменить в течение 7 дней.',
    copyDetail: 'Файлы тем и плагинов, оформление.',
    live: 'Тексты и новости агент меняет сразу на сайте, и отменить это мы не сможем.',
    liveDetail: 'Записи, страницы, картинки.',
    closed: [
      'Пользователи, плагины и темы в панели управления, настройки, формы, комментарии и заказы. Удаление записей и страниц.',
    ],
  },
}

/** What tells that the site on the hosting moved away from `main` (Т17). */
export const wordpressDriftProbe: SiteDriftProbe = {
  versionFile: 'wp-includes/version.php',
  extensionRoots: ['wp-content/plugins', 'wp-content/themes'],
}

const decoder = new TextDecoder('utf-8', { fatal: false })

/** `$wp_version` of `wp-includes/version.php`: one read, a file of the release without a secret. */
export async function wordpressReadVersion(read: SiteRead): Promise<SiteVersionReading> {
  const bytes = await read('wp-includes/version.php')
  if (bytes === null) return { kind: 'unknown' }
  const raw = coreVersion(decoder.decode(bytes))
  const version = raw === null ? null : parseSiteVersion(raw)
  return version === null ? { kind: 'unknown' } : { kind: 'read', version }
}

/** How a WordPress site is built, for the instructions of a turn (question В8 of Э2). */
export function wordpressStackGuide(): string {
  return [
    '- Code of the site: themes in `wp-content/themes/`, plugins in `wp-content/plugins/`, must-use plugins in `wp-content/mu-plugins/`.',
    '- Posts, pages, menus, widgets and options live in the database, not in files.',
    '- The core (`wp-admin/`, `wp-includes/`, the files of the root) and `wp-config.php` are not yours to change.',
  ].join('\n')
}
