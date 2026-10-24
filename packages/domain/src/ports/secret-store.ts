/**
 * Secret store port — Vault-compatible (OpenBao), spec §15. The database keeps only
 * credential_refs (path, type, key_version); secret values never reach the database,
 * logs, S3 or git. What a service may do is enforced by its Vault policy (AppRole):
 * web can only write kv/sites/*, it cannot read them back.
 */
export interface SecretStoreHealth {
  initialized: boolean
  sealed: boolean
  standby: boolean
  version: string
}

export interface IssuedToken {
  token: string
  accessor: string
  expiresAt: Date
}

/** The version is returned with the data, so a refresh needs no metadata permission. */
export interface KvSecret {
  data: Record<string, string>
  version: number
}

export interface KvMetadata {
  currentVersion: number
  custom: Record<string, string>
  createdTime: Date
  /** A scheduled deletion in the future is still readable. */
  deleted: boolean
  destroyed: boolean
}

export interface KvWriteOptions {
  /** 0 creates a new key; a positive value must match the current version. */
  cas?: number
  /**
   * The most versions Vault keeps of this key (1–100), set on its metadata before the data: the
   * versions beyond it — a replaced or removed value — are gone for everybody after this write.
   * The writer's policy must allow it on the metadata path (`sites-writer`: 1 on `env/*`).
   */
  maxVersions?: number
}

export interface KvListPage {
  after?: string
  limit: number
}

/**
 * Data behind a single-use response-wrapping token (sys/wrapping/wrap, spec §15; plan 53, Р29).
 * The token is the secret: whoever holds it unwraps once, and then nobody can. The accessor
 * names it without opening it, so it may be kept in the database for a revocation.
 */
export interface WrappedSecret {
  token: string
  accessor: string
  /** Counted from before the request: the wrapping lives at least this long. */
  expiresAt: Date
}

/** What a live wrapping token says about itself; its data stays wrapped. */
export interface WrappingInfo {
  /** The endpoint that wrapped it: `sys/wrapping/wrap` for data of SecretStore.wrap. */
  creationPath: string
  createdAt: Date
  expiresAt: Date
}

export interface SecretStore {
  health(): Promise<SecretStoreHealth>

  /**
   * Logical KV v2 paths include the mount, e.g. turns/t_<id> or subs/<backend>/<id>. `version`
   * reads that version instead of the current one (null when it is deleted, destroyed or never
   * existed): a reader that follows a reference reads what the reference names, so a newer
   * version written by a request that then failed does not stand in for it.
   */
  kvRead(path: string, options?: { version?: number }): Promise<KvSecret | null>
  kvWrite(
    path: string,
    data: Record<string, string>,
    options?: KvWriteOptions,
  ): Promise<{ version: number }>
  /** Data with CAS=0 first, custom metadata second; a retry cannot revive a deleted key. */
  kvCreateOnce(
    path: string,
    data: Record<string, string>,
    metadata: Record<string, string>,
  ): Promise<'created' | 'exists'>
  /** Soft-delete the latest version. */
  kvDelete(path: string): Promise<void>
  /** DELETE metadata removes all versions and metadata; this is not POST destroy. */
  kvDestroyAll(path: string): Promise<void>
  /** KV LIST is one snapshot; sorting and cursor filtering happen in the adapter. */
  kvList(prefix: string, page?: KvListPage): Promise<string[]>
  kvMetadata(path: string): Promise<KvMetadata | null>

  /** Transit: per-workspace keys transit/keys/ws-<workspaceId> for sessions, logs and backups. */
  transitDataKey(key: string): Promise<{ plaintext: Uint8Array; ciphertext: string }>
  transitDecryptDataKey(key: string, ciphertext: string): Promise<Uint8Array>
  /**
   * Creates the Transit key of a workspace (`workspaceTransitKey`, aes256-gcm96) when it is
   * missing; one that exists stays as it is — Transit takes a creation as an upsert, so a repeat
   * neither rotates nor reconfigures it. Only `ws-<uuid>` names. The policy
   * `workspace-provisioner` allows this and nothing else about the key: web calls it before it
   * creates a task (docs/plan/57-browser-tasks.md, Б32).
   */
  transitEnsureKey(key: string): Promise<void>

  /** SSH CA: short-lived certificates for client servers (ssh/sign/deploy). */
  sshSign(role: string, publicKey: string, ttlSeconds: number): Promise<string>

  /** A token with the given policies; the release flow of plan 53 creates none (Р29). */
  createToken(policies: string[], ttlSeconds: number): Promise<IssuedToken>
  /** Wraps `data` for one unwrap within `ttlSeconds`; nothing of it is stored in KV. */
  wrap(data: Record<string, string>, ttlSeconds: number): Promise<WrappedSecret>
  /**
   * Opens a wrapping with the wrapping token itself, needing no credential of its own. Null
   * when the token is spent, revoked or expired: the data is gone for everybody.
   */
  unwrap(token: string): Promise<Record<string, string> | null>
  /** Whether a wrapping is still unopened, without opening it; null when it is not. */
  lookupWrapping(token: string): Promise<WrappingInfo | null>
  /** Revokes the token this accessor names; one that is already gone counts as revoked. */
  revokeAccessor(accessor: string): Promise<void>
}
