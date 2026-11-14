/**
 * A request the cabinet's API must not take (docs/plan/69-pages.md, Ст3): a page of
 * `*.pages.raditi.ru` is the same site as the cabinet, so the browser would send `SameSite`
 * cookies with it. A procedure is called by the cabinet's own pages alone: a `POST` that comes
 * from another origin — `Origin` says so, or the fetch metadata says another site or a sibling
 * one — is refused. A `POST` without either header (a server-side caller, a test) is not a
 * browser's and goes on.
 */
export function refusedCrossOriginPost(
  request: Pick<Request, 'method' | 'headers'>,
  appUrl: string,
): boolean {
  if (request.method !== 'POST') return false
  const site = request.headers.get('sec-fetch-site')?.toLowerCase()
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return true
  const origin = request.headers.get('origin')
  if (origin === null) return false
  return origin !== new URL(appUrl).origin
}
