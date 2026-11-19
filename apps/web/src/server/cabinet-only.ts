import 'server-only'

import { onPagesHost, pagesNotFound } from '@/lib/pages-origin'

/**
 * A route handler of a route proxy.ts does not run for — one that takes a file, whose body the
 * proxy would cut at 1 MB (see `config.matcher` there). On the domain of pages it answers what the
 * proxy answers there to any route of the cabinet: 404, before the body is read
 * (docs/plan/67-agent-documents.md, Д3).
 */
export function cabinetOnly<Rest extends unknown[]>(
  handler: (request: Request, ...rest: Rest) => Promise<Response>,
): (request: Request, ...rest: Rest) => Promise<Response> {
  return (request, ...rest) =>
    onPagesHost(request.headers) ? Promise.resolve(pagesNotFound()) : handler(request, ...rest)
}
