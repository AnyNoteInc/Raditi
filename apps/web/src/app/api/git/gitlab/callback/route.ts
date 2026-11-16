import { finishGitlabSignIn } from '@/server/git-sign-in'
import { gitSignInDependencies } from '@/server/git-sign-in-runtime'

export const runtime = 'nodejs'

/** The return of the client from gitlab.com (docs/plan/84-projects.md, ПР10, slice 84.17). */
export function GET(request: Request) {
  return finishGitlabSignIn(request, gitSignInDependencies)
}
