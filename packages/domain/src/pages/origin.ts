import { pagesBaseDomainSchema } from './slug.ts'

/**
 * The origin of the root of the domain of pages, where web serves the pages of a chat to the frame
 * of the cabinet (docs/plan/67-agent-documents.md, Д3): one variable of the domain for both plans,
 * PAGES_BASE_DOMAIN (docs/plan/69-pages.md, Ст3) — `https://<domain>` in production; elsewhere
 * `http://<domain>` with the port of APP_URL, since the root is web's and web answers it itself
 * (the pages of plan 69 are the preview app's, on PAGES_PUBLIC_PORT). The proxy reads it on every
 * request to split the hosts and the CSP of the cabinet frames it; both must never throw, so
 * anything else is null — no page is framed or served.
 */
export function pagesOriginOf(env: Record<string, string | undefined>): string | null {
  const base = pagesBaseDomainSchema.safeParse(env.PAGES_BASE_DOMAIN?.trim() ?? '')
  if (!base.success) return null
  if (env.APP_ENV?.trim() === 'production') return `https://${base.data}`
  const app = URL.parse(env.APP_URL?.trim() ?? '')
  return `http://${base.data}${app?.port ? `:${app.port}` : ''}`
}
