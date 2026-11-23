// Mermaid inside headless Chromium: network blocked, securityLevel "strict", a timeout per diagram
// enforced from Node (a busy loop in the page cannot be stopped from inside the page).
// Runs on the host and inside mcr.microsoft.com/playwright:v1.63.0-noble (the image of apps/browser).

const DEFAULT_SECURE = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges']
// Keys a diagram directive (%%{init}%%) must not change in our pipeline: label mode, CSS and fonts.
export const LOCKED_SECURE = [...DEFAULT_SECURE, 'htmlLabels', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily', 'darkMode', 'look', 'layout']

const HELPER = String.raw`
window.__pwned = null
window.alert = () => { window.__pwned = window.__pwned || 'alert' }
const msgOf = (e) => String((e && (e.message || e.str)) || e).split('\n').slice(0, 3).join(' | ').slice(0, 300)
const countOf = (v) => v == null ? null : (typeof v.size === 'number' ? v.size : Array.isArray(v) ? v.length : typeof v === 'object' ? Object.keys(v).length : null)
window.__renderOne = async (src, cfg) => {
  window.__pwned = null
  const base = {
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    deterministicIds: true, deterministicIDSeed: cfg.seed,
    htmlLabels: cfg.htmlLabels, flowchart: { htmlLabels: cfg.htmlLabels },
    secure: cfg.secure,
  }
  if (cfg.fontFamily) { base.fontFamily = cfg.fontFamily; base.themeVariables = { fontFamily: cfg.fontFamily } }
  window.mermaid.initialize(base)
  const out = {}
  const t0 = performance.now()
  try {
    const r = await window.mermaid.render('m' + cfg.seed, src)
    out.svg = r.svg
    out.type = r.diagramType
    out.ms = performance.now() - t0
  } catch (e) {
    out.ms = performance.now() - t0
    out.error = msgOf(e)
    try { await window.mermaid.parse(src); out.stage = 'render' } catch (e2) { out.stage = 'parse' }
  }
  if (cfg.structure && out.svg) {
    try {
      const d = await window.mermaid.mermaidAPI.getDiagramFromText(src)
      const db = d.db
      const s = {}
      for (const [k, fn] of [['vertices', 'getVertices'], ['edges', 'getEdges'], ['subgraphs', 'getSubGraphs'], ['actors', 'getActors'], ['messages', 'getMessages'], ['classes', 'getClasses'], ['relations', 'getRelations'], ['entities', 'getEntities'], ['relationships', 'getRelationships'], ['states', 'getStates'], ['tasks', 'getTasks'], ['sections', 'getSections']]) {
        if (typeof db[fn] === 'function') { try { const c = countOf(db[fn]()); if (c != null) s[k] = c } catch {} }
      }
      out.structure = s
    } catch (e) { out.structureError = msgOf(e) }
  }
  out.pwned = window.__pwned
  return out
}
// Insert a (sanitized) SVG inline into this page and report whether anything ran.
window.__inlineCheck = async (svg) => {
  window.__pwned = null
  const host = document.createElement('div')
  host.innerHTML = svg
  document.body.appendChild(host)
  await new Promise((r) => setTimeout(r, 50))
  const pwned = window.__pwned
  host.remove()
  return pwned
}
`

export class MermaidPage {
  /**
   * @param {import('playwright-core').Browser} browser
   * @param {{ mermaidJs: string, fontCss?: string, onRequest?: (url: string) => void }} opts
   */
  constructor(browser, opts) {
    this.browser = browser
    this.opts = opts
    this.context = null
    this.page = null
    this.requests = []
  }

  async open() {
    const t0 = Date.now()
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 900 } })
    // Network blocked: every request is aborted and recorded. setContent and addScriptTag need none.
    await this.context.route('**/*', (route) => {
      const url = route.request().url()
      this.requests.push(url)
      this.opts.onRequest?.(url)
      route.abort().catch(() => {})
    })
    this.page = await this.context.newPage()
    const fontStyle = this.opts.fontCss ? `<style>${this.opts.fontCss}</style>` : ''
    await this.page.setContent(`<!doctype html><html><head><meta charset="utf-8">${fontStyle}</head><body></body></html>`)
    await this.page.addScriptTag({ content: this.opts.mermaidJs })
    await this.page.addScriptTag({ content: HELPER })
    if (this.opts.fontCss) {
      await this.page.evaluate(async () => {
        await Promise.all(['400', '600', '700'].map((w) => document.fonts.load(`${w} 16px "Golos Text"`, 'Жж Aa ₽')))
        await document.fonts.ready
      })
    }
    this.openMs = Date.now() - t0
    return this
  }

  /** Render one diagram. Never throws; on timeout the context is killed and must be reopened. */
  async render(src, cfg, timeoutMs = 10000) {
    if (!this.page) await this.open()
    const before = this.requests.length
    const started = Date.now()
    let timer
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs) })
    const job = this.page.evaluate(({ src, cfg }) => window.__renderOne(src, cfg), { src, cfg }).catch((e) => ({ error: String(e.message || e).slice(0, 300), stage: 'harness' }))
    const out = await Promise.race([job, timeout])
    clearTimeout(timer)
    out.wallMs = Date.now() - started
    out.requests = this.requests.slice(before)
    if (out.timedOut) {
      const killStart = Date.now()
      await this.kill()
      out.killMs = Date.now() - killStart
    }
    return out
  }

  async inlineCheck(svg) {
    if (!this.page) await this.open()
    const before = this.requests.length
    const pwned = await this.page.evaluate((s) => window.__inlineCheck(s), svg)
    await this.page.waitForTimeout(50)
    return { pwned, requests: this.requests.slice(before) }
  }

  async kill() {
    const ctx = this.context
    this.context = null
    this.page = null
    if (!ctx) return
    // Closing the context closes its renderer even if its main thread is in a busy loop.
    await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
  }

  async close() { await this.kill() }
}

/** Memory of this page's renderer, from CDP (bytes). */
export async function pageHeap(page) {
  const session = await page.context().newCDPSession(page)
  await session.send('Performance.enable')
  const { metrics } = await session.send('Performance.getMetrics')
  await session.detach()
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]))
  return { jsHeapUsed: m.JSHeapUsedSize, jsHeapTotal: m.JSHeapTotalSize, nodes: m.Nodes, documents: m.Documents }
}
