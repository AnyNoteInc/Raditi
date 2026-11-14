import { DomainError } from '../errors.ts'
import type { PageRefusalReason } from './content-check.ts'
import { pageLimits } from './limits.ts'

/** The errors of pages and documents (docs/plan/69-pages.md, §5): the agent reads their codes. */

/** Not there, or another workspace's: the two are never told apart. */
export const pageNotFound = (): DomainError =>
  new DomainError('PAGE_NOT_FOUND', 'No such page in this workspace', 404)

/**
 * The page is in the trash of «Страницы» (docs/plan/73-pages-sites.md, Дер2): only the client
 * returns it. Neither a new version nor a new password lands on a deleted page.
 */
export const pageDeleted = (of: 'page' | 'document' = 'page'): DomainError =>
  new DomainError(
    'PAGE_DELETED',
    of === 'document'
      ? 'The client deleted the page of this document: it is in the trash of «Страницы», and only they can return it there. Tell the client so; do not publish this document again.'
      : 'The client deleted this page: it is in the trash of «Страницы», and only they can return it. Publish a new page instead, without pageId.',
    409,
  )

/** The client chose a page at a version: another one came since (docs/plan/73-pages-sites.md, Дер25). */
export const pageVersionChanged = (version: number): DomainError =>
  new DomainError(
    'PAGE_VERSION_CHANGED',
    'The page has a newer version now: read it again before changing it',
    409,
    { version },
  )

/** Another page of the site has this path already (Дер15). */
export const pagePathTaken = (path: string): DomainError =>
  new DomainError('PAGE_PATH_TAKEN', 'Another page of this site has this path', 409, { path })

/** A page with pages under it is not deleted or moved alone (Дер2). */
export const pageHasChildren = (): DomainError =>
  new DomainError(
    'PAGE_HAS_CHILDREN',
    'This page has pages under it: delete them with it, or move them first',
    409,
  )

/** The chat's author may not change the pages of the workspace (Дер24). */
export const pageForbidden = (): DomainError =>
  new DomainError(
    'PAGE_FORBIDDEN',
    'Only the owner or an administrator of the workspace changes its pages: tell the client so',
    403,
  )

/** No new site over the limit of the tariff (Дер36): the limit and the number go along. */
export const pageSiteLimitReached = (limit: number): DomainError =>
  new DomainError('PAGE_SITE_LIMIT', `The tariff allows ${limit} sites of pages`, 409, { limit })

/** The support took the page down: nobody deletes it (Дер3, Ст31). */
export const pageTakenDownByOperator = (): DomainError =>
  new DomainError('PAGE_TAKEN_DOWN', 'The support took this page down: it cannot be deleted', 409, {
    by: 'operator',
  })

export const docNotFound = (): DomainError =>
  new DomainError('DOC_NOT_FOUND', 'No such document in this workspace', 404)

export type PageLimitName = keyof typeof pageLimits

/** A bound of `pageLimits` reached: the name and the number go to the agent, the request does not. */
export const pageLimitReached = (limit: PageLimitName): DomainError =>
  new DomainError('PAGE_LIMIT', `The limit ${limit} (${pageLimits[limit]}) is reached`, 409, {
    limit,
    value: pageLimits[limit],
  })

export const docLimitReached = (limit: PageLimitName): DomainError =>
  new DomainError('DOC_LIMIT', `The limit ${limit} (${pageLimits[limit]}) is reached`, 409, {
    limit,
    value: pageLimits[limit],
  })

const REFUSAL_TEXT: Record<PageRefusalReason, string> = {
  not_utf8: 'The content is not UTF-8 text',
  too_large: 'The content is larger than allowed',
  password_form: 'A form with a password field must not send it to another address',
  embedded_token: 'The content carries what looks like a token or a key: remove it',
  turn_key: 'The content carries a key of the platform: remove it',
  client_value: 'The content carries a value of a variable of the client: remove it',
}

/** The content was refused; the reason, never the content, goes to the agent and the log. */
export const pageContentRefused = (reason: PageRefusalReason): DomainError =>
  new DomainError('PAGE_CONTENT_REFUSED', REFUSAL_TEXT[reason], 422, { reason })

export const docSectionUnknown = (key: string): DomainError =>
  new DomainError('DOC_SECTION_UNKNOWN', 'No section with this id in the document', 404, {
    id: key,
  })
