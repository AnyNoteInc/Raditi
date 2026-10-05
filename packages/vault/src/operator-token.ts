import { appEnvSchema, type AppEnv } from '@repo/domain'
import { z } from 'zod'

import { VaultError } from './errors.ts'
import { createVaultSession } from './session.ts'

const policyNames = { writer: 'subscriptions-writer', admin: 'subscriptions-admin' } as const
const secret = z.string().regex(/^[\x21-\x7e]{1,4096}$/)

export interface DevSubscriptionTokenOptions {
  appEnv: AppEnv
  addr: string
  rootToken: string
  policy: 'writer' | 'admin'
  fetch?: typeof fetch
}

/** Explicit local operator action; this does not extend the runtime service token port. */
export async function createDevSubscriptionToken(
  options: DevSubscriptionTokenOptions,
): Promise<string> {
  const bad = () => new VaultError('Dev subscription token issuance failed')
  try {
    const env = appEnvSchema.safeParse(options.appEnv)
    const url = URL.parse(options.addr)
    const policy = policyNames[options.policy]
    if (
      !env.success ||
      env.data === 'production' ||
      !Object.hasOwn(policyNames, options.policy) ||
      !policy ||
      !url ||
      !['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !secret.safeParse(options.rootToken).success
    )
      throw bad()
    const session = createVaultSession({
      addr: url.origin,
      token: options.rootToken,
      fetch: options.fetch,
      timeoutMs: 5000,
    })
    const reply = await session.request('/v1/auth/token/create', {
      method: 'POST',
      body: {
        policies: [policy],
        no_default_policy: true,
        ttl: '15m',
        explicit_max_ttl: '15m',
        renewable: false,
      },
    })
    const parsed = z
      .object({
        auth: z.object({
          client_token: secret,
          policies: z.array(z.string()).length(1),
          lease_duration: z.number().int().positive().max(900),
          renewable: z.literal(false),
        }),
      })
      .safeParse(reply.json)
    if (!parsed.success || parsed.data.auth.policies[0] !== policy) throw bad()
    return parsed.data.auth.client_token
  } catch {
    throw bad()
  }
}
