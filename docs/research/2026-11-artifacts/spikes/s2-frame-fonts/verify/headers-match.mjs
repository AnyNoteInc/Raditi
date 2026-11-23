// Is headers.mjs of the spike the repository's code byte for byte? Imports the product sources
// themselves (type-stripped by Node) and compares every value the stand sends.
import * as product from './product/headers.ts'
import { pageFileHeaders as productFileHeaders } from './product/files.ts'
import { pageSetCookie as productSetCookie } from './product/page-cookie.ts'
import * as replica from '../headers.mjs'

const same = (name, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  console.log(`${ok ? 'SAME ' : 'DIFF '} ${name}`)
  if (!ok) console.log('  product:', JSON.stringify(a), '\n  replica:', JSON.stringify(b))
  return ok
}
let bad = 0
const app = 'https://cabinet.example.test'
for (const kind of ['html', 'reading']) {
  bad += !same(`pagePolicy('${kind}')`, product.pagePolicy(kind), replica.pagePolicy(kind))
  bad += !same(`pagePolicy('${kind}', app)`, product.pagePolicy(kind, app), replica.pagePolicy(kind, app))
}
for (const kind of ['html', 'reading', 'platform']) {
  bad += !same(`pageResponseHeaders('${kind}')`, product.pageResponseHeaders(kind), replica.pageResponseHeaders(kind))
  bad += !same(`pageResponseHeaders('${kind}', framed)`, product.pageResponseHeaders(kind, { framedBy: app }), replica.pageResponseHeaders(kind, { framedBy: app }))
}
bad += !same('PAGE_SANDBOX', product.PAGE_SANDBOX, replica.PAGE_SANDBOX)
bad += !same('PAGE_CSP_SANDBOX', product.PAGE_CSP_SANDBOX, replica.PAGE_CSP_SANDBOX)
bad += !same('PAGE_PLATFORM_CSP', product.PAGE_PLATFORM_CSP, replica.PAGE_PLATFORM_CSP)
bad += !same('PAGE_COMMON_HEADERS', { ...product.PAGE_COMMON_HEADERS }, { ...replica.PAGE_COMMON_HEADERS })
bad += !same('PAGE_ROBOTS_TXT', product.PAGE_ROBOTS_TXT, replica.PAGE_ROBOTS_TXT)
for (const type of ['font/woff2', 'text/css; charset=utf-8', 'text/javascript; charset=utf-8', 'image/png', 'image/svg+xml', 'application/pdf'])
  bad += !same(`pageFileHeaders(${type})`, productFileHeaders(type), replica.pageFileHeaders(type))
// The cookie: the product signs a value, the stand puts a random one; compare the attributes.
const attrs = (s) => s.replace(/^raditi_page=[^;]*; Max-Age=\d+; /, '')
bad += !same('cookie attributes', attrs(productSetCookie('s', { id: 'x', passwordEpoch: 1 }, 0, 60)), attrs(replica.pageSetCookie('v', 60)))
console.log(bad === 0 ? 'all equal' : `${bad} differ`)
