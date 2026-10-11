import type { KvSecret, LlmBackend, SecretStore, SubscriptionCredential } from '@repo/domain'

import { subscriptionCredentialPath } from '../llm/turn-key.ts'

export interface CredentialContext {
  accountId: string
  credentialRef: string
  credentialVersion: number
}

export interface CredentialSource {
  get(context: CredentialContext, backend: LlmBackend): Promise<SubscriptionCredential>
}

const MAX_CREDENTIAL_BYTES = 32_768
const unavailable = () => new Error('Subscription credential unavailable')

/** One provider-neutral KV string preserves nulls and future adapter-owned fields. */
export function encodeSubscriptionCredential(
  credential: SubscriptionCredential,
): Record<string, string> {
  const json = JSON.stringify(credential)
  if (Buffer.byteLength(json) > MAX_CREDENTIAL_BYTES) throw unavailable()
  return { credential: json }
}

export function decodeSubscriptionCredential(
  stored: KvSecret | null,
  backend: LlmBackend,
): SubscriptionCredential {
  try {
    if (
      !stored ||
      !Number.isSafeInteger(stored.version) ||
      stored.version < 1 ||
      Object.keys(stored.data).length !== 1 ||
      typeof stored.data.credential !== 'string' ||
      Buffer.byteLength(stored.data.credential) > MAX_CREDENTIAL_BYTES
    )
      throw unavailable()
    const parsed = backend.credentialSchema.safeParse(JSON.parse(stored.data.credential) as unknown)
    if (!parsed.success) throw unavailable()
    return Object.freeze(parsed.data)
  } catch {
    throw unavailable()
  }
}

function validateContext(context: CredentialContext, backend: LlmBackend): void {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(context.accountId) ||
    context.credentialRef !== subscriptionCredentialPath(backend.id, context.accountId) ||
    !Number.isSafeInteger(context.credentialVersion) ||
    context.credentialVersion < 1
  )
    throw unavailable()
}

/**
 * The caller supplies fresh account metadata; a version change never uses an old credential.
 * Entries are re-read from Vault after `ttlMs`. If that read fails, the entry for the very
 * version the database still names keeps serving for `staleIfErrorMs` since it was last read
 * (p3-design §3.2 step 10: a short refusal only when Vault is down and nothing is cached).
 */
export function createCredentialSource(
  vault: Pick<SecretStore, 'kvRead'>,
  { ttlMs = 30_000, staleIfErrorMs = 3_600_000, maxEntries = 1000, now = Date.now } = {},
): CredentialSource {
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 0 ||
    !Number.isSafeInteger(staleIfErrorMs) ||
    staleIfErrorMs < 0 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1
  )
    throw unavailable()
  type Entry = {
    ref: string
    version: number
    credential: SubscriptionCredential
    expires: number
    verified: number
  }
  const cache = new Map<string, Entry>()
  const pending = new Map<string, Promise<SubscriptionCredential>>()
  const matching = (context: CredentialContext): Entry | undefined => {
    const entry = cache.get(context.accountId)
    return entry?.ref === context.credentialRef && entry.version === context.credentialVersion
      ? entry
      : undefined
  }
  const current = (context: CredentialContext): Entry | undefined => {
    const entry = matching(context)
    return entry && entry.expires > now() ? entry : undefined
  }
  // Only for an unreadable Vault: a readable Vault with another version always wins.
  const stale = (context: CredentialContext): Entry | undefined => {
    const entry = matching(context)
    return entry && now() - entry.verified < staleIfErrorMs ? entry : undefined
  }
  const trim = () => {
    for (const accountId of cache.keys()) {
      if (cache.size < maxEntries) break
      cache.delete(accountId)
    }
  }
  return {
    async get(context, backend) {
      validateContext(context, backend)
      const cached = current(context)
      if (cached) return cached.credential
      const key = `${context.credentialRef}:${context.credentialVersion}`
      const underway = pending.get(key)
      if (underway) return underway
      const read = (async () => {
        let stored: Awaited<ReturnType<typeof vault.kvRead>>
        try {
          stored = await vault.kvRead(context.credentialRef)
        } catch {
          const kept = stale(context)
          if (kept) return kept.credential
          throw unavailable()
        }
        if (stored?.version !== context.credentialVersion) throw unavailable()
        const credential = decodeSubscriptionCredential(stored, backend)
        trim()
        cache.set(context.accountId, {
          ref: context.credentialRef,
          version: context.credentialVersion,
          credential,
          expires: now() + ttlMs,
          verified: now(),
        })
        return credential
      })()
      pending.set(key, read)
      try {
        return await read
      } finally {
        if (pending.get(key) === read) pending.delete(key)
      }
    },
  }
}
