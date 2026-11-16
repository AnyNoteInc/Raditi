import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'

import { githubHost, gitHostRefused, gitlabComHost } from '@repo/domain'
import {
  ipLiteral,
  isLoopbackAddress,
  publicAddressCheck,
  type RefusedSubnet,
} from '@repo/ip-address'

// The address of a git host for one operation (docs/plan/84-projects.md, §4.6): the name is
// resolved once, every address it has must be public and outside the platform's subnets, and the
// first is the one both the API transport and git connect to (`http.curloptResolve`). A literal
// address is never a host here: the platform builds every address from a name.

export interface PublicHostOptions {
  refusedSubnets: readonly RefusedSubnet[]
  /** GIT_ALLOW_LOOPBACK, outside production: `localhost` fakes of a stand. */
  allowLoopback: boolean
  resolve?: (host: string) => Promise<readonly LookupAddress[]>
}

export type ResolvePublicHost = (host: string) => Promise<string>

export function publicHostResolver(options: PublicHostOptions): ResolvePublicHost {
  const isPublic = publicAddressCheck(options.refusedSubnets)
  const resolve = options.resolve ?? ((host: string) => lookup(host, { all: true, verbatim: true }))
  return async (host) => {
    if (ipLiteral(host.replace(/^\[(.*)\]$/, '$1')) !== undefined) throw gitHostRefused()
    let addresses: readonly LookupAddress[]
    try {
      addresses = await resolve(host)
    } catch {
      throw gitHostRefused()
    }
    const allowed = (address: string) =>
      isPublic(address) || (options.allowLoopback && isLoopbackAddress(address))
    if (addresses.length === 0 || !addresses.every((entry) => allowed(entry.address)))
      throw gitHostRefused()
    return addresses[0]!.address
  }
}

/**
 * A stand's fake of gitlab.com (RADITI_FAKE_GITLAB_COM_URL, never in production) answers its API
 * at `https://localhost:<port>`; git reaches a repository at `https://gitlab.com/<path>.git` on
 * 443, pinned to the address of the operation. With the fake that address is the one of
 * `localhost`, where the stand forwards 443 to its fake: otherwise the API of an operation would go
 * to the fake and its git to the real gitlab.com.
 */
export function fakedGitlabCom(
  resolve: ResolvePublicHost,
  gitlabComUrl: string | undefined,
): ResolvePublicHost {
  if (!gitlabComUrl) return resolve
  const fake = new URL(gitlabComUrl).hostname
  return (host) => resolve(host === gitlabComHost ? fake : host)
}

/**
 * The same for a stand's fake of GitHub (RADITI_FAKE_GITHUB_API_URL, never in production): git
 * reaches `https://github.com/<path>.git` at the address of `localhost`, where the stand forwards 443
 * to its fake.
 */
export function fakedGithubCom(
  resolve: ResolvePublicHost,
  githubApiUrl: string | undefined,
): ResolvePublicHost {
  if (!githubApiUrl) return resolve
  const fake = new URL(githubApiUrl).hostname
  return (host) => resolve(host === githubHost ? fake : host)
}
