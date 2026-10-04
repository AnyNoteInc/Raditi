import type { KvSecret, LlmBackend, SecretStore, SubscriptionCredential } from '@repo/domain'

import { subscriptionCredentialPath } from '../llm/turn-key.ts'

export interface CredentialContext {
  accountId: string
  credentialRef: string
  credentialVersion: number
}

export interface CredentialSource {
  get(context: CredentialContext, backend: LlmBackend): Promise<SubscriptionCredential>
  /** Authentication retry uses the version actually sent, including a pending rotation. */
  versionOf?(credential: SubscriptionCredential): number | null
}

export interface MutableCredentialSource extends CredentialSource {
  versionOf(credential: SubscriptionCredential): number | null
  /** A rotation stays pinned until Vault and the account version are both committed. */
  install(
    context: CredentialContext,
    backend: LlmBackend,
    credential: SubscriptionCredential,
    previousVersion?: number,
  ): void
  commit(context: CredentialContext): void
  invalidate(accountId: string): void
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
 * The caller supplies fresh account metadata; a version change never uses an old token.
 * Entries are re-read from Vault after `ttlMs`. If that read fails, the entry for the very
 * version the database still names keeps serving for `staleIfErrorMs` since it was last read
 * (p3-design §3.2 step 10: a short refusal only when Vault is down and nothing is cached).
 */
export function createCredentialSource(
  vault: Pick<SecretStore, 'kvRead'>,
  { ttlMs = 30_000, staleIfErrorMs = 3_600_000, maxEntries = 1000, now = Date.now } = {},
): MutableCredentialSource {
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
    minimumVersion: number
    credential: SubscriptionCredential
    expires: number
    verified: number
    pinned: boolean
  }
  const cache = new Map<string, Entry>()
  const versions = new WeakMap<SubscriptionCredential, number>()
  const pending = new Map<string, Promise<SubscriptionCredential>>()
  const epochs = new Map<string, number>()
  const advance = (accountId: string) => epochs.set(accountId, (epochs.get(accountId) ?? 0) + 1)
  const matching = (context: CredentialContext): Entry | undefined => {
    const entry = cache.get(context.accountId)
    if (
      entry &&
      entry.ref === context.credentialRef &&
      entry.minimumVersion <= context.credentialVersion &&
      entry.version >= context.credentialVersion
    )
      return entry
    return undefined
  }
  const current = (context: CredentialContext): Entry | undefined => {
    const entry = matching(context)
    return entry && (entry.pinned || entry.expires > now()) ? entry : undefined
  }
  // Only for an unreadable Vault: a readable Vault with another version always wins.
  const stale = (context: CredentialContext): Entry | undefined => {
    const entry = matching(context)
    return entry && now() - entry.verified < staleIfErrorMs ? entry : undefined
  }
  const trim = () => {
    for (const [accountId, entry] of cache) {
      if (cache.size < maxEntries) break
      // Losing an uncommitted rotation would resurrect the old refresh token from Vault.
      if (!entry.pinned) cache.delete(accountId)
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
      const epoch = epochs.get(context.accountId) ?? 0
      const read = (async () => {
        let stored: Awaited<ReturnType<typeof vault.kvRead>>
        try {
          stored = await vault.kvRead(context.credentialRef)
        } catch {
          const kept =
            (epochs.get(context.accountId) ?? 0) === epoch ? stale(context) : current(context)
          if (kept) return kept.credential
          throw unavailable()
        }
        try {
          // A refresh can finish while this old-version Vault read is in flight.
          const rotated = current(context)
          if (rotated) return rotated.credential
          if ((epochs.get(context.accountId) ?? 0) !== epoch) throw unavailable()
          if (stored?.version !== context.credentialVersion) throw unavailable()
          const credential = decodeSubscriptionCredential(stored, backend)
          versions.set(credential, context.credentialVersion)
          trim()
          cache.set(context.accountId, {
            ref: context.credentialRef,
            version: context.credentialVersion,
            minimumVersion: context.credentialVersion,
            credential,
            expires: now() + ttlMs,
            verified: now(),
            pinned: false,
          })
          return credential
        } catch {
          const rotated = current(context)
          if (rotated && (epochs.get(context.accountId) ?? 0) !== epoch) return rotated.credential
          throw unavailable()
        }
      })()
      pending.set(key, read)
      try {
        return await read
      } finally {
        if (pending.get(key) === read) pending.delete(key)
      }
    },
    install(context, backend, value, previousVersion = context.credentialVersion) {
      validateContext(context, backend)
      if (
        !Number.isSafeInteger(previousVersion) ||
        previousVersion < 1 ||
        previousVersion > context.credentialVersion
      )
        throw unavailable()
      const credential = decodeSubscriptionCredential(
        { data: encodeSubscriptionCredential(value), version: context.credentialVersion },
        backend,
      )
      const existing = cache.get(context.accountId)
      if (existing && existing.version > context.credentialVersion) throw unavailable()
      advance(context.accountId)
      versions.set(credential, context.credentialVersion)
      trim()
      cache.set(context.accountId, {
        ref: context.credentialRef,
        version: context.credentialVersion,
        minimumVersion: previousVersion,
        credential,
        expires: now() + ttlMs,
        verified: now(),
        pinned: true,
      })
    },
    commit(context) {
      const entry = cache.get(context.accountId)
      if (entry?.ref === context.credentialRef && entry.version === context.credentialVersion) {
        entry.pinned = false
        entry.expires = now() + ttlMs
        // Vault and the account row now both hold this version.
        entry.verified = now()
      }
    },
    versionOf(credential) {
      return versions.get(credential) ?? null
    },
    invalidate(accountId) {
      advance(accountId)
      cache.delete(accountId)
      for (const key of pending.keys())
        if (key.endsWith(`/${accountId}:`) || key.includes(`/${accountId}:`)) pending.delete(key)
    },
  }
}
