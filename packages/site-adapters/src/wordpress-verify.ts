import { badRequest, type SiteFacts, type VerifyPlan } from '@repo/domain'

/**
 * Text WordPress and PHP show instead of the site when it is broken (docs/plan/53, Р30): the
 * fatal-error handler of WordPress core (5.2 and later; before 5.3 its wording was «technical
 * difficulties»), the page of a lost database and PHP's own message printed into a page that has
 * already answered 200 (`display_errors` with `html_errors`). English and the ru_RU translation of
 * core. Prefixes, so a sentence that follows (admin mail) does not matter.
 */
export const wordpressFailureMarkers = [
  'There has been a critical error on this website',
  'На сайте возникла критическая ошибка',
  'The site is experiencing technical difficulties',
  'Сайт испытывает технические трудности',
  'Error establishing a database connection',
  'Ошибка установки соединения с базой данных',
  '<b>Fatal error</b>:',
  '<b>Parse error</b>:',
] as const

/**
 * What a release checks on the site after it wrote (`SiteAdapter.verify`): the front page of the
 * install — the path of the site's address, so a WordPress in a subfolder is checked there —
 * and the failure markers above. Only the front page: a page a security plugin hides (the login
 * page, the REST index) would roll back a release that broke nothing. `wp-content/debug.log` is
 * where WordPress writes its errors when the site asked it to.
 *
 * A published page or post the release created is checked too, by its number on production
 * (docs/plan/53, critique S9): the query form answers under any `permalink_structure` — with
 * pretty links WordPress redirects it to the address of the record, within the site.
 */
export function wordpressVerifyPlan(site: SiteFacts): VerifyPlan {
  let front: string
  try {
    const url = new URL(site.url)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme')
    front = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  } catch {
    throw badRequest('The address of the site is not an http(s) URL')
  }
  return {
    pages: [front],
    logFiles: ['wp-content/debug.log'],
    screenshots: [],
    failureMarkers: [...wordpressFailureMarkers],
    recordPages: { page: `${front}?page_id={id}`, post: `${front}?p={id}` },
  }
}
