// Independent check of the trap «scroll-behavior: smooth animates scrollTo» (spike s3, plan 88) and
// of whether the session browser's own flag --disable-smooth-scrolling (infra/preview/
// browser-server.mjs, plan 85, ТР8), which the spike's launch left out, already removes it.
//   node v4-smooth-scroll.mjs
import { chromium } from 'playwright-core'

const HTML = `<!doctype html><html><head><style>html { scroll-behavior: smooth } body { margin: 0 } div { height: 12000px; background: linear-gradient(#fff, #000) }</style></head><body><div></div></body></html>`
const out = {}
for (const [name, args] of [['without --disable-smooth-scrolling (the spike)', []], ['with --disable-smooth-scrolling (the session browser)', ['--disable-smooth-scrolling']]]) {
  const browser = await chromium.launch({ headless: true, args })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.setContent(HTML)
  out[name] = await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
    const measure = async (fn) => { window.scrollTo({ top: 0, behavior: 'instant' }); await frame(); fn(); await frame(); await frame(); return Math.round(window.scrollY) }
    return {
      'scrollTo(0, 6400)': await measure(() => window.scrollTo(0, 6400)),
      "scrollTo({ top: 6400, behavior: 'instant' })": await measure(() => window.scrollTo({ top: 6400, left: 0, behavior: 'instant' })),
      'scrollingElement.scrollTop = 6400': await measure(() => { document.scrollingElement.scrollTop = 6400 }),
    }
  })
  await browser.close()
}
console.log(JSON.stringify(out, null, 1))
