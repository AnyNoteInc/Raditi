import { startGithubSignIn } from '@/server/github-sign-in'
import { githubSignInDependencies } from '@/server/git-sign-in-runtime'

export const runtime = 'nodejs'

/** The start of the connection of the GitHub App (docs/plan/84-projects.md, ПР10, slice 84.25). */
export function GET(request: Request) {
  return startGithubSignIn(request, githubSignInDependencies)
}
