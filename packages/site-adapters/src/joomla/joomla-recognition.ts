import type { PublicPage, StackConnection, StackRecognition } from '@repo/domain'
import { compareSiteVersions, generationOf } from '@repo/domain'
import { joomlaSupport } from './joomla-support.ts'
import { isJoomlaManifest, JOOMLA_MANIFEST_URL, joomlaManifestVersion } from './joomla-version.ts'

// How a site of Joomla is recognised and what the wizard says of it (docs/plan/62-site-stacks.md,
// Т3, Т15, Т26–Т29, Т32; docs/plan/62-slices/e3.md, Э3.2). Nothing here is read by the product
// before the adapter joins the registry (Э3.7) and the screens of Э9.

/** The markers of the root (Т15): what `rootMarkers()` of the adapter gives in Э3.7. */
export const JOOMLA_ROOT_MARKERS: readonly string[] = ['administrator', 'libraries', 'plugins']

/**
 * The tag a working WordPress or Drupal prints: a site that left it is another system now. Links to
 * `/wp-content/` or `/bitrix/` are not that: they may be what an old site left (Т27). OpenCart needs
 * it too (Э4.1): the second of the two slices moves it to `php/foreign-signs.ts` (Т11).
 */
const FOREIGN_GENERATOR = /<meta\s+name=["']generator["']\s+content=["'](?:WordPress|Drupal)\b/i
const OWN_GENERATOR = /<meta\s+name=["']generator["']\s+content=["']Joomla!/i
/**
 * The assets of the core: `jui` in 3.x, `vendor` with `system` from 4.0. A sign is only the value
 * of a `src` or `href` that starts at the root of this site: the same folder of another host, a
 * sub-path or a word in the text is not this site's asset.
 */
const ownAsset = (folder: string) =>
  new RegExp(`\\s(?:src|href)\\s*=\\s*["']?/media/${folder}/`, 'i')
const MEDIA_3 = ownAsset('jui')
const MEDIA_4 = ownAsset('vendor')
const MEDIA_SYSTEM = ownAsset('system')

/** The branch of a version below `refuseBelow`: it has no row of its own (violation 9 of Э2.3). */
const OLDEST_BRANCH = 'j30'
/** The branch the assets `/media/jui/` tell without a manifest. */
const JUI_BRANCH = 'j3'

const homeOf = (pages: readonly PublicPage[]) => pages.filter((page) => page.path === '/')

const manifestVersionOf = (pages: readonly PublicPage[]): string | null => {
  for (const page of pages) {
    if (page.path !== JOOMLA_MANIFEST_URL) continue
    const version = joomlaManifestVersion(page.html)
    if (version !== null) return version
  }
  return null
}

const isManifest = (page: PublicPage) =>
  page.path === JOOMLA_MANIFEST_URL && isJoomlaManifest(page.html)

function fingerprint(pages: readonly PublicPage[]): 'yes' | 'no' | 'unknown' {
  const home = homeOf(pages)
  const own = home.some(
    ({ html }) =>
      OWN_GENERATOR.test(html) ||
      MEDIA_3.test(html) ||
      (MEDIA_4.test(html) && MEDIA_SYSTEM.test(html)),
  )
  if (own || pages.some(isManifest)) return 'yes'
  // Only a working other system says `no`; a page of a bot check, an error 503, a stub of the
  // hosting and links an old site left say nothing.
  if (home.some(({ html }) => FOREIGN_GENERATOR.test(html))) return 'no'
  return 'unknown'
}

/** Only the id of a branch leaves this function, never a string of the site. */
function publicGeneration(pages: readonly PublicPage[]): string | null {
  const version = manifestVersionOf(pages)
  if (version !== null) {
    const below =
      joomlaSupport.refuseBelow !== null &&
      compareSiteVersions(version, joomlaSupport.refuseBelow) < 0
    // Joomla 2.5 and older: `j30` has `browser: false`, so the panel closes as Т3 and §4 want.
    if (below) return OLDEST_BRANCH
    return generationOf(joomlaSupport, version)?.id ?? null
  }
  return homeOf(pages).some(({ html }) => MEDIA_3.test(html)) ? JUI_BRANCH : null
}

export const joomlaRecognition: StackRecognition = {
  publicPaths: [JOOMLA_MANIFEST_URL],
  fingerprint,
  publicGeneration,
  // A list of what is allowed: what is unknown is closed (Т29).
  needsOwnYes: false,
  /**
   * The public folder of 5.0+: `libraries` and `plugins` lie above it, so the markers do not pass.
   * `renamed_folder` is never the answer: the name `administrator` is set in `includes/defines.php`,
   * not by a setting. A root with `libraries` gets no hint even with `defines.php` beside it: that is
   * the late refusal of `readLayout` (Э3.3, Т16).
   */
  rootHint(names) {
    const has = new Set(names.map((name) => name.toLowerCase()))
    return has.has('defines.php') && has.has('administrator') && !has.has('libraries')
      ? 'outside_root'
      : null
  },
  // Only a stack with `files: 'off'` names the folder of its core.
  coreFolder: null,
}

export const joomlaConnection: StackConnection = {
  databaseEngines: ['mysql'],
  fullName: 'Joomla',
  // The field of the tab «Без доступа» and the check of a closed panel on step 2 (Т2, Т29).
  adminPathDefault: '/administrator/',
  // The shops of Joomla: their products are closed (Т32, the third text without files).
  shops: [
    { folder: 'components/com_jshopping', products: 'closed' },
    { folder: 'components/com_virtuemart', products: 'closed' },
  ],
  alwaysShop: null,
  pricesGuarded: false,
  // The hint of the step of the database (the board O-db-access).
  configFile: 'configuration.php',
  // The row of Joomla of the table Т27, word for word; Э8.17 checks `closed` against the screens.
  terms: {
    copy: 'Код и стили агент меняет в копии: вы смотрите предпросмотр и сами выпускаете правку, её можно отменить в течение 7 дней.',
    copyDetail: 'Оформление, шаблоны, подписи на страницах.',
    live: 'Тексты и новости агент меняет сразу на сайте, и отменить это мы не сможем.',
    liveDetail: 'Статьи, категории, картинки, текстовые блоки.',
    closed: ['Меню, формы, пользователи, настройки и права доступа. Удаление статей и категорий.'],
  },
}
