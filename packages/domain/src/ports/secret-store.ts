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

export interface SecretStore {
  health(): Promise<SecretStoreHealth>

  /** KV v2: kv/sites/<siteId>/{ssh,ftp,wp,browser}, kv/llm/<provider>, kv/subscriptions/<id>. */
  kvRead(path: string): Promise<Record<string, string> | null>
  kvWrite(path: string, data: Record<string, string>): Promise<{ version: number }>
  kvDelete(path: string): Promise<void>

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
