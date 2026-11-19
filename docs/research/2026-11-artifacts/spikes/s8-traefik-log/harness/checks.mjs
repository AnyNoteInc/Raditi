// The browser checks of spike s8, shared by browsers.mjs (macOS) and in-docker.mjs (Linux).
import { randomBytes } from 'node:crypto'

export const requestLineOf = (body) => /^(?:GET|POST|HEAD) \S+ HTTP\/\d\.\d$/m.exec(body ?? '')?.[0] ?? null
export const refererOf = (body) => /^Referer: (.*)$/m.exec(body ?? '')?.[1] ?? null

/** Markers handed out during a run; every one must stay out of every log. */
export function marks() {
  const all = []
  const mark = (kind, id) => {
    const m = `S8${kind}${id}x${randomBytes(6).toString('hex')}`
    all.push(m)
    return m
  }
  return { all, mark }
}

/**
 * Through the edge (Traefik → whoami, which echoes the request it got): /a#<token>, the Referer of
 * requests made from it, the edge's redirects, fetch() and links with a fragment; /a?k=<token>
 * for comparison.
 */
export async function browserChecks({ type, name, proxyPort, apex, mark }) {
  const browser = await type.launch({ headless: true, proxy: { server: `http://127.0.0.1:${proxyPort}` } })
  // A self-signed certificate of a synthetic host: this throwaway context accepts it.
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const out = { browser: name, version: browser.version() }
  const id = name.slice(0, 2)

  const f1 = mark('F', `${id}1`)
  await page.goto(`https://${apex}/a#${f1}`)
  let body = await page.textContent('body')
  out.navigation = {
    backendRequestLine: requestLineOf(body),
    backendSawToken: body.includes(f1),
    pageUrlKeepsToken: page.url().includes(f1),
    locationHash: (await page.evaluate(() => location.hash)).replace(f1, '<token>'),
  }
  await page.evaluate(() => history.replaceState(null, '', location.pathname + location.search))
  out.afterReplaceState = { url: page.url(), locationHash: await page.evaluate(() => location.hash) }

  const f2 = mark('F', `${id}2`)
  await page.goto(`https://${apex}/a#${f2}`)
  const fetched = await page.evaluate(async () => (await fetch('/b-ref')).text())
  const unsafe = await page.evaluate(async () => (await fetch('/b-ref2', { referrerPolicy: 'unsafe-url' })).text())
  await page.evaluate(() => {
    location.href = '/c-ref'
  })
  await page.waitForURL('**/c-ref')
  body = await page.textContent('body')
  out.referer = {
    fetch: refererOf(fetched),
    fetchUnsafeUrl: refererOf(unsafe),
    navigation: refererOf(body),
    tokenInAny: [fetched, unsafe, body].some((t) => t.includes(f2)),
  }

  const q = mark('Q', `${id}4`)
  await page.goto(`https://${apex}/a?k=${q}`)
  const fq = await page.evaluate(async () => (await fetch('/b-ref3')).text())
  const fqNo = await page.evaluate(async () => (await fetch('/b-ref4', { referrerPolicy: 'no-referrer' })).text())
  out.queryVariant = {
    refererOfFetch: refererOf(fq)?.replace(q, '<token>') ?? null,
    tokenInReferer: fq.includes(q),
    tokenWithNoReferrer: fqNo.includes(q),
  }

  const f3 = mark('F', `${id}5`)
  await page.goto(`https://www.${apex}/a#${f3}`)
  body = await page.textContent('body')
  out.wwwRedirect = {
    finalUrl: page.url().replace(f3, '<token>'),
    keptToken: page.url().endsWith(`#${f3}`),
    backendRequestLine: requestLineOf(body),
    backendSawToken: body.includes(f3),
  }
  const f4 = mark('F', `${id}6`)
  await page.goto(`http://${apex}/a#${f4}`)
  body = await page.textContent('body')
  out.httpRedirect = {
    finalUrl: page.url().replace(f4, '<token>'),
    keptToken: page.url().endsWith(`#${f4}`),
    backendRequestLine: requestLineOf(body),
    backendSawToken: body.includes(f4),
  }

  const f5 = mark('F', `${id}7`)
  const ff = await page.evaluate(async (f) => (await fetch(`/d-frag#${f}`)).text(), f5)
  out.fetchWithFragment = { backendRequestLine: requestLineOf(ff), backendSawToken: ff.includes(f5) }
  const f6 = mark('F', `${id}8`)
  await page.setContent(`<a id="go" href="https://${apex}/e-link#${f6}">go</a>`)
  await Promise.all([page.waitForURL(`**/e-link#${f6}`), page.click('#go')])
  body = await page.textContent('body')
  out.linkWithFragment = { backendRequestLine: requestLineOf(body), backendSawToken: body.includes(f6) }

  await browser.close()
  return out
}

/**
 * Plain http:// with a fragment, straight to an origin and through an HTTP proxy: the recorder
 * keeps the request line exactly as the browser sent it.
 */
export async function plainHttpChecks({ type, name, recorder, mark }) {
  const id = name.slice(0, 2)
  const out = { browser: name }
  const direct = await type.launch({ headless: true })
  const page = await (await direct.newContext()).newPage()
  const f1 = mark('F', `${id}d`)
  const before = recorder.seen.length
  await page.goto(`http://127.0.0.1:${recorder.port}/a#${f1}`)
  out.directOrigin = recorder.seen.slice(before).map((l) => l.replace(f1, '<token>'))
  await direct.close()

  const proxied = await type.launch({ headless: true, proxy: { server: `http://127.0.0.1:${recorder.port}` } })
  const page2 = await (await proxied.newContext()).newPage()
  const f2 = mark('F', `${id}p`)
  const before2 = recorder.seen.length
  await page2.goto(`http://recorded.example.test/a#${f2}`)
  out.viaHttpProxy = recorder.seen.slice(before2).map((l) => l.replace(f2, '<token>'))
  out.tokenReachedProxy = recorder.seen.slice(before2).some((l) => l.includes(f2))
  await proxied.close()
  return out
}
