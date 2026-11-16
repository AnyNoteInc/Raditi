import { z } from 'zod'

import { repoProviderKinds, type RepoProviderKind, type RepoRef } from '../ports/git-provider.ts'
import { repoLinkInvalid } from './errors.ts'

// A repository reference and the parsing of a link to it (docs/plan/84-projects.md, ПР9, ПР11,
// §4.6). A link names a host and a path; github.com is GitHub, any other host is read as GitLab —
// gitlab.com or the client's own server.

export const repoPathMaxLength = 300

/** The host of github.com repositories; the API is api.github.com (§4.5). */
export const githubHost = 'github.com'
export const gitlabComHost = 'gitlab.com'

// A DNS name of at least two labels, lowercase; never an address literal (the transport checks
// the address the name resolves to, §4.6).
const hostLabel = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const hostPattern = new RegExp(`^(?:${hostLabel}\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$`)

export const gitHostSchema = z
  .string()
  .min(4)
  .max(253)
  .refine((host) => hostPattern.test(host), 'Not a host name')

// GitLab: a segment starts with a letter, a digit or `_`, holds letters, digits, `_`, `.`, `-`,
// and does not end with `.git` or `.atom` (https://docs.gitlab.com/user/reserved_names/).
const gitlabSegment = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
// GitHub: an owner is 1–39 letters, digits or inner hyphens; a name 1–100 of letters, digits,
// `.`, `_`, `-`, never `.` or `..`.
const githubOwner = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const githubName = /^[A-Za-z0-9._-]{1,100}$/

const isGitlabSegment = (segment: string): boolean =>
  gitlabSegment.test(segment) && !segment.endsWith('.') && !/\.(git|atom)$/i.test(segment)

/**
 * The shape of a path on each provider, as data (rule 8: the kind is a key, never compared):
 * how many segments, which segment is what, and how a link keeps only the repository part.
 */
const pathRules: Record<
  RepoProviderKind,
  { valid(segments: string[]): boolean; fromLink(segments: string[]): string[] }
> = {
  github: {
    valid: ([owner, name, ...rest]) =>
      rest.length === 0 &&
      owner !== undefined &&
      name !== undefined &&
      githubOwner.test(owner) &&
      githubName.test(name) &&
      name !== '.' &&
      name !== '..' &&
      !name.toLowerCase().endsWith('.git'),
    // `/owner/name/tree/main/src` — the repository is the first two segments.
    fromLink: (segments) => segments.slice(0, 2),
  },
  gitlab: {
    valid: (segments) => segments.length >= 2 && segments.every(isGitlabSegment),
    // `/group/sub/project/-/tree/main` — everything after `-` is a page of the project.
    fromLink: (segments) => {
      const dash = segments.indexOf('-')
      return dash === -1 ? segments : segments.slice(0, dash)
    },
  },
}

/** Hosts whose provider is known by name; any other host is a GitLab server (ПР9). */
const providerOfHost: Readonly<Record<string, RepoProviderKind>> = Object.freeze({
  [githubHost]: 'github',
  [`www.${githubHost}`]: 'github',
})
const canonicalHost: Readonly<Record<string, string>> = Object.freeze({
  [`www.${githubHost}`]: githubHost,
})

/** The provider a host serves: github.com is GitHub, the rest is GitLab. */
export function providerOf(host: string): RepoProviderKind {
  return providerOfHost[host] ?? 'gitlab'
}

/** True when `path` is a repository path of `provider` (ПР11). */
export function isRepoPath(provider: RepoProviderKind, path: string): boolean {
  if (path.length === 0 || path.length > repoPathMaxLength) return false
  return pathRules[provider].valid(path.split('/'))
}

export const repoRefSchema = z
  .strictObject({
    provider: z.enum(repoProviderKinds),
    host: gitHostSchema,
    path: z.string().min(3).max(repoPathMaxLength),
    providerRepoId: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .optional(),
  })
  .refine((ref) => isRepoPath(ref.provider, ref.path), 'Not a repository path of the provider')
  .refine(
    (ref) => providerOf(ref.host) === ref.provider,
    'GitHub repositories live on github.com only',
  )

/**
 * The repository a link names (ПР9): `https://github.com/o/r`, `https://gitlab.com/g/s/p`, an own
 * GitLab server, with `.git`, a trailing `/`, `/tree/…`, `/-/…` or `/blob/…` tolerated. Only
 * `https` on 443, no credentials. Refuses with REPO_LINK_INVALID.
 */
export function parseRepositoryLink(link: string): RepoRef {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    throw repoLinkInvalid()
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    throw repoLinkInvalid()
  if (url.port !== '' && url.port !== '443') throw repoLinkInvalid()
  const name = url.hostname.toLowerCase()
  const host = canonicalHost[name] ?? name
  if (!gitHostSchema.safeParse(host).success) throw repoLinkInvalid()
  const provider = providerOf(host)
  let segments: string[]
  try {
    segments = url.pathname
      .split('/')
      .filter((s) => s !== '')
      .map(decodeURIComponent)
  } catch {
    throw repoLinkInvalid()
  }
  segments = pathRules[provider].fromLink(segments)
  const last = segments.length - 1
  if (last >= 0 && segments[last]!.toLowerCase().endsWith('.git'))
    segments[last] = segments[last]!.slice(0, -4)
  const path = segments.join('/')
  if (!isRepoPath(provider, path)) throw repoLinkInvalid()
  return { provider, host, path }
}

/** `https://<host>/<path>` — the address a repository shows the client, built, never received. */
export function repoWebUrl(ref: Pick<RepoRef, 'host' | 'path'>): string {
  return `https://${ref.host}/${ref.path}`
}

/** The git address of a repository, built from the host and the path (§4.6). */
export function repoCloneUrl(ref: Pick<RepoRef, 'host' | 'path'>): string {
  return `https://${ref.host}/${ref.path}.git`
}

/**
 * An address the API gave, kept only when it is `https://<host>/…` of the same host; otherwise
 * `fallback`, built by the platform (§4.6: an own server may answer with any address).
 */
export function sameHostUrl(host: string, given: unknown, fallback: string): string {
  if (typeof given === 'string' && given.length <= 500) {
    try {
      const url = new URL(given)
      if (
        url.protocol === 'https:' &&
        url.hostname.toLowerCase() === host &&
        (url.port === '' || url.port === '443') &&
        url.username === '' &&
        url.password === ''
      )
        return url.toString()
    } catch {
      // the fallback below
    }
  }
  return fallback
}
