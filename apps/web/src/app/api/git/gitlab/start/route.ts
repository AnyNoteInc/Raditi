import { withBodyLimit } from '@/server/body-limit'
import { MAX_GIT_SIGN_IN_BODY_BYTES, startGitlabSignIn } from '@/server/git-sign-in'
import { gitSignInDependencies } from '@/server/git-sign-in-runtime'

export const runtime = 'nodejs'

/** The start of a sign-in on gitlab.com (docs/plan/84-projects.md, ПР10, slice 84.17). */
export const POST = withBodyLimit(MAX_GIT_SIGN_IN_BODY_BYTES, (request) =>
  startGitlabSignIn(request, gitSignInDependencies),
)
