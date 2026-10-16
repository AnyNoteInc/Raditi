/** A failed call of the billing router, as the tRPC client reports it. */
export interface BillingCallError {
  message: string
  /** Absent when no answer of the server arrived: the network failed, not the request. */
  data?: { domainCode?: string | null } | null
}

/** The server's text for a refusal is Russian already, without a full stop. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/**
 * What to tell the customer about a failed call. The server's message is written for them; a
 * call that never reached the server has only the browser's own words, so it gets `offline`.
 */
export function billingErrorText(error: BillingCallError, offline: string): string {
  return error.data ? sentence(error.message) : offline
}

/** The DomainError code of a refusal; null for any other failure. */
export function domainCodeOf(error: BillingCallError | null): string | null {
  return error?.data?.domainCode ?? null
}
