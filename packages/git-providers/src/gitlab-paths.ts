import { gitPathRefused } from '@repo/domain'

// The path whitelist of the GitLab transport (docs/plan/84-projects.md, ПР10, §4.6). A token with
// the `api` scope opens all of the client's GitLab: variables, members, tokens, settings, other
// projects. The adapter therefore sends only what this list names, for the attached project only;
// everything else is refused before the network.

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

const N = '[1-9][0-9]{0,19}'

// Paths below `projects/<the attached project>/`.
const projectRules: readonly [Method, RegExp][] = [
  ['GET', /^$/],
  ['GET', /^\/repository\/branches$/],
  ['POST', /^\/merge_requests$/],
  // The merge requests of one source branch: one opened at the provider is adopted (84.26).
  ['GET', /^\/merge_requests$/],
  ['GET', new RegExp(`^/merge_requests/${N}$`)],
  // Closing only: the adapter sends `state_event: close` and nothing else (gitlabBodyAllowed).
  ['PUT', new RegExp(`^/merge_requests/${N}$`)],
  ['PUT', new RegExp(`^/merge_requests/${N}/merge$`)],
  [
    'POST',
    new RegExp(`^/merge_requests/${N}/(cancel_auto_merge|cancel_merge_when_pipeline_succeeds)$`),
  ],
  ['GET', /^\/pipelines$/],
  ['GET', new RegExp(`^/pipelines/${N}$`)],
  ['GET', new RegExp(`^/pipelines/${N}/jobs$`)],
  ['POST', new RegExp(`^/pipelines/${N}/(retry|cancel)$`)],
  ['GET', new RegExp(`^/jobs/${N}/trace$`)],
  ['POST', new RegExp(`^/jobs/${N}/play$`)],
  ['POST', /^\/ci\/lint$/],
  ['POST', /^\/hooks$/],
  ['DELETE', new RegExp(`^/hooks/${N}$`)],
]

/**
 * True when `method` `apiPath` (below `/api/v4`, without the query) may go out for the project
 * whose key — its numeric id or its URL-encoded path — is `projectKey`. `/user` and the list of
 * the user's projects need no project.
 */
export function gitlabPathAllowed(
  method: Method,
  apiPath: string,
  query: URLSearchParams,
  projectKey: string | null,
): boolean {
  if (method === 'GET' && apiPath === '/user') return true
  if (method === 'GET' && apiPath === '/projects') return query.get('membership') === 'true'
  if (projectKey === null) return false
  const prefix = `/projects/${projectKey}`
  if (!apiPath.startsWith(prefix)) return false
  const rest = apiPath.slice(prefix.length)
  return projectRules.some(([m, pattern]) => m === method && pattern.test(rest))
}

/** The one body a PUT of a merge request may carry: closing it. */
export function gitlabBodyAllowed(method: Method, apiPath: string, body: unknown): boolean {
  if (method !== 'PUT' || apiPath.endsWith('/merge')) return true
  return (
    typeof body === 'object' &&
    body !== null &&
    Object.keys(body).length === 1 &&
    (body as Record<string, unknown>).state_event === 'close'
  )
}

export function assertGitlabPath(
  method: Method,
  apiPath: string,
  query: URLSearchParams,
  projectKey: string | null,
  body?: unknown,
): void {
  if (
    !gitlabPathAllowed(method, apiPath, query, projectKey) ||
    !gitlabBodyAllowed(method, apiPath, body)
  )
    throw gitPathRefused(method, apiPath)
}
