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
}

export interface KvListPage {
  after?: string
  limit: number
}

export interface SecretStore {
  health(): Promise<SecretStoreHealth>

  /** Logical KV v2 paths include the mount, e.g. turns/t_<id> or subs/<backend>/<id>. */
  kvRead(path: string): Promise<KvSecret | null>
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

  /** SSH CA: short-lived certificates for client servers (ssh/sign/deploy). */
  sshSign(role: string, publicKey: string, ttlSeconds: number): Promise<string>

  /** Deploy secret flow: token with a site-<id>-deploy policy, wrapped once, revoked after deploy. */
  createToken(policies: string[], ttlSeconds: number): Promise<IssuedToken>
  wrap(
    data: Record<string, string>,
    ttlSeconds: number,
  ): Promise<{ wrappingToken: string; expiresAt: Date }>
  revokeAccessor(accessor: string): Promise<void>
}
