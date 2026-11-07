import { badRequest, type SiteFacts, type VerifyPlan } from '@repo/domain'

/**
 * Text Joomla and PHP show instead of the site when it is broken (docs/research/2026-11-site-stacks/
 * joomla.md, §9.2): the start of an install without its configuration, the refusal of the PHP of
 * the host, the page of a lost database, the error pages of 3.x and 4.0 and later, the ru-RU
 * translation of the error page, and PHP's own message printed into a page that has already answered
 * 200 (`display_errors` with `html_errors`). Prefixes, compared byte for byte.
 */
export const joomlaFailureMarkers = [
  'No configuration file found and no installation code available',
  'Sorry, your PHP version is not supported',
  'Environment Setup Incomplete',
  'Database Error: ',
  'Sorry, there was a problem we could not recover from.',
  'An Error Occurred: ',
  'Произошла критическая ошибка',
  '<b>Fatal error</b>:',
  '<b>Parse error</b>:',
] as const

/**
 * What a release checks on the site after it wrote (`SiteAdapter.verify`): the front page of the
 * install — the path of the site's address, so a Joomla in a subfolder is checked there — and the
 * failure markers above. `administrator/logs/error.php` is where Joomla writes its errors. No
 * pages of records: a release of Joomla carries no plan of the database.
 */
export function joomlaVerifyPlan(site: SiteFacts): VerifyPlan {
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
    logFiles: ['administrator/logs/error.php'],
    screenshots: [],
    failureMarkers: [...joomlaFailureMarkers],
  }
}
