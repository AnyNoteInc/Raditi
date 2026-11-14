import { pagesBaseDomainSchema, pageUrlOf } from './slug.ts'

/**
 * Where pages answer (docs/plan/69-pages.md, Ст3, Ст10): the base domain, `https` in production
 * and `http` elsewhere (the listener of the preview app, no Traefik in front), and the port the
 * address carries outside production. The apps that name a page — mcp, core, web — read it the
 * same way, so a link is the same wherever it is made.
 */
export interface PagesAddress {
  baseDomain: string
  scheme: 'https' | 'http'
  port?: number
}

/** The address from PAGES_BASE_DOMAIN and PAGES_PUBLIC_PORT; null — no pages. Problems are pushed. */
export function pagesAddressFromEnv(
  env: { PAGES_BASE_DOMAIN?: string; PAGES_PUBLIC_PORT?: number },
  production: boolean,
  problems: string[],
): PagesAddress | null {
  if (env.PAGES_BASE_DOMAIN === undefined) {
    if (env.PAGES_PUBLIC_PORT !== undefined)
      problems.push('PAGES_PUBLIC_PORT: needs PAGES_BASE_DOMAIN')
    return null
  }
  const base = pagesBaseDomainSchema.safeParse(env.PAGES_BASE_DOMAIN)
  if (!base.success) {
    problems.push('PAGES_BASE_DOMAIN: must be a lower-case domain name')
    return null
  }
  if (production && env.PAGES_PUBLIC_PORT !== undefined)
    problems.push('PAGES_PUBLIC_PORT: not in production (a page host carries no port there)')
  return {
    baseDomain: base.data,
    scheme: production ? 'https' : 'http',
    ...(env.PAGES_PUBLIC_PORT === undefined ? {} : { port: env.PAGES_PUBLIC_PORT }),
  }
}

/** The one address of a page. */
export const pageAddressUrl = (slug: string, address: PagesAddress): string =>
  pageUrlOf(slug, address)
