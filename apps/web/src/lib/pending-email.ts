// The address a sign-up or an unverified sign-in used, so the «check your inbox» page can
// offer to send the letter again. Kept in this tab only; storage may be unavailable.
const KEY = 'raditi:pending-email'

export function rememberPendingEmail(email: string): void {
  try {
    sessionStorage.setItem(KEY, email)
  } catch {
    // Private mode or storage disabled: the visitor types the address instead.
  }
}

export function readPendingEmail(): string | null {
  try {
    return sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}
