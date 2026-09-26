import 'server-only'

import { getSessionFromHeaders, type Session } from '@repo/auth'
import { headers } from 'next/headers'
import { cache } from 'react'

/** A mutable copy of the request headers, once per request. */
export const getRequestHeaders = cache(async (): Promise<Headers> => new Headers(await headers()))

/** The signed-in session, once per request; throws when the database cannot be reached. */
export const getSession = cache(async (): Promise<Session | null> =>
  getSessionFromHeaders(await getRequestHeaders()),
)
