/** Vault/OpenBao failure. Messages never contain tokens or secret values. */
export class VaultError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VaultError'
    this.status = status
  }
}
