import 'server-only'

import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'

import { gitHostRefused } from '@repo/domain'
import {
  ipLiteral,
  isLoopbackAddress,
  publicAddressCheck,
  type RefusedSubnet,
} from '@repo/ip-address'
import type { GitServices } from '@repo/trpc'
import { createVaultSecretStore } from '@repo/vault'

import { env } from '@/env'

let services: { value: GitServices | null } | undefined

/**
 * The check of the host of an own GitLab server or of a link (docs/plan/84-projects.md, §4.6):
 * the name resolves, and every address it has is public and outside the platform's subnets. Web
 * sends no request there — core does, to the address it checks again (`git.connection.sync`).
 */
export function gitHostResolver(options: {
  refusedSubnets: readonly RefusedSubnet[]
  allowLoopback: boolean
  resolve?: (host: string) => Promise<readonly LookupAddress[]>
}): (host: string) => Promise<string> {
  const isPublic = publicAddressCheck(options.refusedSubnets)
  const resolve = options.resolve ?? ((host: string) => lookup(host, { all: true, verbatim: true }))
  return async (host) => {
    if (ipLiteral(host) !== undefined) throw gitHostRefused()
    const addresses = await resolve(host).catch(() => {
      throw gitHostRefused()
    })
    if (
      addresses.length === 0 ||
      !addresses.every(
        (entry) =>
          isPublic(entry.address) || (options.allowLoopback && isLoopbackAddress(entry.address)),
      )
    )
      throw gitHostRefused()
    return addresses[0]!.address
  }
}

/** The settings web resolves the hosts of git by: those of the check of MCP servers (§4.6). */
export function gitHostOptions() {
  return {
    refusedSubnets: env.web().mcpServerProbe.refusedSubnets,
    allowLoopback: env.git().allowLoopback,
  }
}

/**
 * What git connections are written and checked through (docs/plan/84-projects.md, 84.17): a Vault
 * store of which only `kvWrite` and `kvMetadata` are reachable — `sites-writer` reads nothing
 * back — and the check of a host. Built on first use and kept for the process; null — the vault,
 * web or git settings do not parse: repositories cannot be connected, everything else works.
 */
export function gitServices(): GitServices | null {
  if (services === undefined) {
    let config
    try {
      config = { vault: env.vault(), web: env.web(), git: env.git() }
    } catch {
      console.error('[web] git connections are off: the vault, web or git settings do not parse')
      services = { value: null }
      return null
    }
    const store = createVaultSecretStore(config.vault)
    services = {
      value: {
        appEnv: config.web.appEnv,
        secrets: {
          kvWrite: (path, data, options) => store.kvWrite(path, data, options),
          kvMetadata: (path) => store.kvMetadata(path),
        },
        checkHost: (() => {
          const resolve = gitHostResolver({
            refusedSubnets: config.web.mcpServerProbe.refusedSubnets,
            allowLoopback: config.git.allowLoopback,
          })
          return async (host: string) => {
            await resolve(host)
          }
        })(),
        gitlabComConfigured: config.git.gitlabOauth !== null,
      },
    }
  }
  return services.value
}
