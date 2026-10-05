import { auth } from '@repo/auth'
import { toNextJsHandler } from 'better-auth/next-js'

import { MAX_AUTH_BODY_BYTES, withBodyLimit } from '@/server/body-limit'

export const runtime = 'nodejs'

// `auth` is a lazy handle: the instance (and its configuration) is built on the first request.
// better-auth reads a body whole before it checks the captcha, the origin or the session, so
// the body is limited here; toNextJsHandler serves every method with the same function.
const handler = withBodyLimit(MAX_AUTH_BODY_BYTES, toNextJsHandler(auth).POST)

export { handler as GET, handler as POST, handler as PATCH, handler as PUT, handler as DELETE }
