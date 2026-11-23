import { auth } from '@repo/auth'
import { toNextJsHandler } from 'better-auth/next-js'

import { MAX_AUTH_BODY_BYTES, withBodyLimit } from '@/server/body-limit'
import { withOriFactHeader } from '@/server/ori-fact-header'

export const runtime = 'nodejs'

// `auth` is a lazy handle: the instance (and its configuration) is built on the first request.
// better-auth reads a body whole before it checks the captcha, the origin or the session, so
// the body is limited here; toNextJsHandler serves every method with the same function.
// A sign-up or a sign-in is a fact of the ORI: its answer names it to the edge (88.16а-2).
const handler = withBodyLimit(MAX_AUTH_BODY_BYTES, withOriFactHeader(toNextJsHandler(auth).POST))

export { handler as GET, handler as POST, handler as PATCH, handler as PUT, handler as DELETE }
