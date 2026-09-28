import { auth } from '@repo/auth'
import { toNextJsHandler } from 'better-auth/next-js'

export const runtime = 'nodejs'

// `auth` is a lazy handle: the instance (and its configuration) is built on the first request.
export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(auth)
