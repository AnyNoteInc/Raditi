// What the spike varies on top of the repository's headers (headers.mjs).
import {
  ARTIFACT_SANDBOX,
  PAGE_CSP_SANDBOX,
  PAGE_SANDBOX,
  pageFileHeaders,
  pagePolicy,
} from './headers.mjs'

/** The headers of a resource of the platform: CORP × ACAO. Everything else — Дер34 (files.ts). */
export const HEADER_VARIANTS = {
  h1: { corp: 'cross-origin', acao: '*' },
  h2: { corp: 'cross-origin', acao: null },
  h3: { corp: 'same-origin', acao: '*' },
  h4: { corp: 'same-origin', acao: null },
  h5: { corp: null, acao: '*' },
  h6: { corp: null, acao: null },
  h7: { corp: 'same-site', acao: '*' },
  h8: { corp: 'same-site', acao: null },
}

/** The kinds of a resource in the frame and how it is asked. */
export const RESOURCE_KINDS = {
  font: { type: 'font/woff2', how: '@font-face (CORS, credentials same-origin)' },
  js: { type: 'text/javascript; charset=utf-8', how: '<script src> (no-cors)' },
  jsx: { type: 'text/javascript; charset=utf-8', how: '<script src crossorigin> (CORS)' },
  mjs: { type: 'text/javascript; charset=utf-8', how: '<script type=module src> (CORS)' },
  mji: { type: 'text/javascript; charset=utf-8', how: 'module that imports a sibling module' },
  leaf: { type: 'text/javascript; charset=utf-8', how: 'the imported module' },
  css: { type: 'text/css; charset=utf-8', how: '<link rel=stylesheet> (no-cors)' },
  img: { type: 'image/png', how: '<img src> (no-cors)' },
}

/** The sandbox of the frame: attribute of the iframe and the CSP `sandbox` directive. */
export const SANDBOXES = {
  art: { attribute: ARTIFACT_SANDBOX, directive: `sandbox ${ARTIFACT_SANDBOX}` },
  page: { attribute: PAGE_SANDBOX, directive: PAGE_CSP_SANDBOX },
  none: { attribute: null, directive: null },
}

/** The CSP variants of the frame. c0 is today's frame policy (pagePolicy('html', cabinet)). */
export const CSP_VARIANTS = {
  c0: "today: data: blob: only, script-src 'unsafe-inline'",
  c1: "'self' added",
  c2: 'host-source of the pages root',
  c3: 'host-source with the exact path of each resource',
  c4: "scheme-source https: (as a published page)",
  c5: 'host-source with the path prefix /v/',
}

export const HASH = 'a1b2c3d4'

/** The path of a resource: one segment `/v/<label>.<hash>`, so PAGES_PATHS takes it. */
export const resourcePath = (kind, h, fid) => `/v/${kind}-${h}-${fid}.${HASH}`

/**
 * The policy of the frame for one variant, in the order of pagePolicy (headers.ts:58-75). With
 * sandbox `page` and csp `c0` it is pagePolicy('html', appOrigin) byte for byte (checked).
 */
export function frameCsp({ sandbox, csp, appOrigin, pagesOrigin, fid }) {
  const exact = (kinds) =>
    Object.keys(HEADER_VARIANTS).flatMap((h) =>
      kinds.map((kind) => `${pagesOrigin}${resourcePath(kind, h, fid)}`),
    )
  const sources = (kinds) =>
    ({
      c0: [],
      c1: ["'self'"],
      c2: [pagesOrigin],
      c3: exact(kinds),
      c4: ['https:'],
      c5: [`${pagesOrigin}/v/`],
    })[csp]
  const join = (name, list) => [name, ...list].join(' ')
  const directive = SANDBOXES[sandbox].directive
  const policy = [
    ...(directive ? [directive] : []),
    join('script-src', [...sources(['js', 'jsx', 'mjs', 'mji', 'leaf']), "'unsafe-inline'"]),
    "default-src 'none'",
    join('style-src', [...sources(['css']), "'unsafe-inline'"]),
    join('img-src', [...sources(['img']), 'data:', 'blob:']),
    join('font-src', [...sources(['font']), 'data:', 'blob:']),
    'media-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    `frame-ancestors ${appOrigin}`,
    "object-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
  ].join('; ')
  if (sandbox === 'page' && csp === 'c0' && policy !== pagePolicy('html', appOrigin))
    throw new Error('the c0 frame policy drifted from pagePolicy')
  return policy
}

/** The headers of a resource of the platform: Дер34 with CORP and ACAO of the variant. */
export function resourceHeaders(type, variant, cacheControl) {
  const headers = { ...pageFileHeaders(type) }
  delete headers['Cross-Origin-Resource-Policy']
  const { corp, acao } = HEADER_VARIANTS[variant]
  if (corp) headers['Cross-Origin-Resource-Policy'] = corp
  if (acao) headers['Access-Control-Allow-Origin'] = acao
  headers['Cache-Control'] = cacheControl
  return headers
}
