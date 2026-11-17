import { finishGithubSignIn } from '@/server/github-sign-in'
import { githubSignInDependencies } from '@/server/git-sign-in-runtime'

export const runtime = 'nodejs'

/**
 * The return from github.com: of the installation (the Setup URL), then of the sign-in of the
 * app's user (docs/plan/84-projects.md, ПР10, slice 84.25).
 */
export function GET(request: Request) {
  return finishGithubSignIn(request, githubSignInDependencies)
}
