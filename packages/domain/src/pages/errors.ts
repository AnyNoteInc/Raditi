import { DomainError } from '../errors.ts'
import type { PageRefusalReason } from './content-check.ts'
import { pageLimits } from './limits.ts'

/** The errors of pages and documents (docs/plan/69-pages.md, §5): the agent reads their codes. */

/** Not there, or another workspace's: the two are never told apart. */
export const pageNotFound = (): DomainError =>
  new DomainError('PAGE_NOT_FOUND', 'No such page in this workspace', 404)

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
