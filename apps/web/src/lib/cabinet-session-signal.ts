// A browser-local hint to discard an already open cabinet. Never an authentication signal.
export function cabinetSessionChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return null
  return new window.BroadcastChannel('raditi-cabinet-session')
}

export function announceCabinetSignOut(): void {
  const channel = cabinetSessionChannel()
  channel?.postMessage(null)
  channel?.close()
}
