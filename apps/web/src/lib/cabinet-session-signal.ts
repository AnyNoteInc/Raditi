// A browser-local hint to discard an already open cabinet. Never an authentication signal.
export function cabinetSessionChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return null
  return new window.BroadcastChannel('raditi-cabinet-session')
}

// A channel delivers to every other object of the same name, in this tab too: the tab that signs
// out leaves by its own navigation and does not replace its cabinet with the notice first.
let signingOutHere = false

/** Whether the sign-out came from this tab. */
export const cabinetSigningOutHere = (): boolean => signingOutHere

export function announceCabinetSignOut(): void {
  signingOutHere = true
  const channel = cabinetSessionChannel()
  channel?.postMessage(null)
  channel?.close()
}
