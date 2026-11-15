// The cookie notice is fixed over the bottom of every page until the visitor chooses. The runs
// start with the choice made, so it covers nothing they click or measure; a test of the notice
// itself opens a context without it.
const choice = (domain: string) => ({
  name: 'raditi_cookie_consent',
  // `v<version>.<necessary|all>.<unix seconds>`, apps/web/src/lib/cookie-consent.ts.
  value: 'v1.necessary.1794000000',
  domain,
  path: '/',
  expires: -1,
  httpOnly: false,
  secure: false,
  sameSite: 'Lax' as const,
})

// Cookies are not bound to a port; the runs open the web on localhost or on 127.0.0.1.
export const cookieChoiceMade = {
  cookies: [choice('localhost'), choice('127.0.0.1')],
  origins: [],
}
