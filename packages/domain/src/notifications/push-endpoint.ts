// The push services of the browsers a Web Push subscription may name (docs/plan/75-chat-input-
// output.md, ВВ8). core sends to the endpoint a browser gave: anything else — an address of the
// platform, a private one, another site — would make core a client of it. Checked when the
// subscription is kept and again before every send.

/** Hosts, and the parents of hosts, of the push services of Chrome, Firefox, Edge and Safari. */
export const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
] as const

/** The endpoint is `https://` on the default port, with no user, on a push service of a browser. */
export function isPushEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  return PUSH_SERVICE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}
