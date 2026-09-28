import { CONSENT_REQUIRED as SERVER_CONSENT_REQUIRED, type AppRouter } from '@repo/trpc'
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { describe, expect, it, vi } from 'vitest'

import {
  CONSENT_REQUIRED,
  CONSENTS_PATH,
  consentRedirectLink,
  isConsentRequired,
  redirectToConsents,
} from './consent-redirect'
import { shouldRetryQuery } from './query-client'

const trpcError = (code: string, domainCode: string | null) =>
  TRPCClientError.from({
    error: {
      code: -32_000,
      message: 'Примите обновлённые документы, чтобы продолжить',
      data: { code, httpStatus: 428, domainCode },
    },
  })

const consentRequired = trpcError('PRECONDITION_REQUIRED', CONSENT_REQUIRED)
const notFound = trpcError('NOT_FOUND', 'NOT_FOUND')

/** A client whose every call ends with `error`, behind the consent link. */
function clientFailingWith(error: unknown) {
  const onConsentRequired = vi.fn()
  const failing: TRPCLink<AppRouter> = () => () =>
    observable((observer) => {
      observer.error(error as TRPCClientError<AppRouter>)
    })
  const client = createTRPCClient<AppRouter>({
    links: [consentRedirectLink(onConsentRequired), failing],
  })
  return { client, onConsentRequired }
}

describe('isConsentRequired', () => {
  it('uses the code consentedProcedure sends', () => {
    expect(CONSENT_REQUIRED).toBe(SERVER_CONSENT_REQUIRED)
  })

  it('branches on data.domainCode only', () => {
    expect(isConsentRequired(consentRequired)).toBe(true)
    expect(isConsentRequired(notFound)).toBe(false)
    expect(isConsentRequired(trpcError('PRECONDITION_REQUIRED', null))).toBe(false)
    expect(isConsentRequired(new Error(CONSENT_REQUIRED))).toBe(false)
    expect(isConsentRequired(undefined)).toBe(false)
  })
})

describe('consentRedirectLink', () => {
  it('redirects on CONSENT_REQUIRED and still hands the error to the caller', async () => {
    const { client, onConsentRequired } = clientFailingWith(consentRequired)

    await expect(client.consent.list.query()).rejects.toBe(consentRequired)
    expect(onConsentRequired).toHaveBeenCalledOnce()
  })

  it('leaves other errors alone', async () => {
    const { client, onConsentRequired } = clientFailingWith(notFound)

    await expect(client.consent.list.query()).rejects.toBe(notFound)
    expect(onConsentRequired).not.toHaveBeenCalled()
  })
})

describe('redirectToConsents', () => {
  it('replaces the current page with the consents page', () => {
    const location = { pathname: '/app', replace: vi.fn() }

    redirectToConsents(location)

    expect(location.replace).toHaveBeenCalledWith(CONSENTS_PATH)
  })

  it('does nothing on the consents page itself and outside the browser', () => {
    const location = { pathname: CONSENTS_PATH, replace: vi.fn() }

    redirectToConsents(location)
    expect(() => redirectToConsents()).not.toThrow()

    expect(location.replace).not.toHaveBeenCalled()
  })
})

describe('shouldRetryQuery', () => {
  it('retries once as before, but never a call that needs the documents accepted', () => {
    expect(shouldRetryQuery(0, notFound)).toBe(true)
    expect(shouldRetryQuery(1, notFound)).toBe(false)
    expect(shouldRetryQuery(0, consentRequired)).toBe(false)
  })
})
