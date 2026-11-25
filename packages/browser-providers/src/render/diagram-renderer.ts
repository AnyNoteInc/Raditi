import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { artifactRenderLimits, type DiagramEngine } from '@repo/domain/artifacts'
import type { Browser, BrowserContext, Page } from 'playwright-core'

// Mermaid in a Chromium of the render pool (docs/plan/88-artifacts.md, §7.13, slice 88.24а; spike
// 7): a page a workspace — if parsing ever runs a script, it draws no other client's diagram —, no
// network, the engine's settings locked, 10 s a diagram enforced from Node (a busy loop in the page
// cannot be stopped from inside), and the page closed after a timeout or any failure.

const require = createRequire(import.meta.url)
let engine: string | null = null
/** Mermaid's own bundle, read once: no CDN, nothing from the network (§7.13). */
function mermaidBundle(): string {
  engine ??= readFileSync(require.resolve('mermaid/dist/mermaid.min.js'), 'utf8')
  return engine
}

let plantumlEngine: { viz: string; engine: string } | null = null
/**
 * PlantUML of `@plantuml/core` (docs/plan/91-chat-diagrams.md, Д2): the engine compiled by TeaVM
 * and Graphviz of Viz.js with its WebAssembly inside, read once — no CDN, nothing from the network.
 */
function plantumlBundle(): { viz: string; engine: string } {
  plantumlEngine ??= {
    viz: readFileSync(require.resolve('@plantuml/core/viz-global.js'), 'utf8'),
    engine: readFileSync(require.resolve('@plantuml/core/plantuml.js'), 'utf8'),
  }
  return plantumlEngine
}

/** Keys a text may not change: the label mode, the fonts, the CSS, the limits (spike 7). */
const LOCKED = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'htmlLabels',
  'themeCSS',
  'themeVariables',
  'fontFamily',
  'altFontFamily',
  'darkMode',
  'look',
  'layout',
  'arrowMarkerAbsolute',
]
/** The server measures Liberation Sans; a client draws Arial of the same metrics (spike 7). */
const FONT = 'Arial, "Liberation Sans", sans-serif'

const HELPER = String.raw`
window.__render = async (src, seed, cfg) => {
  window.mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    deterministicIds: true, deterministicIDSeed: seed, htmlLabels: false,
    flowchart: { htmlLabels: false }, maxEdges: cfg.maxEdges, maxTextSize: cfg.maxText,
    fontFamily: cfg.font, themeVariables: { fontFamily: cfg.font }, secure: cfg.secure,
  })
  try {
    const r = await window.mermaid.render('d' + seed, src)
    return { svg: r.svg, type: String(r.diagramType || '') }
  } catch (e) {
    const message = String((e && (e.message || e.str)) || e).split('\n').slice(0, 4).join('\n').slice(0, 300)
    let stage = 'render'
    try { await window.mermaid.parse(src) } catch { stage = 'parse' }
    return { error: message, stage }
  }
}
`

/**
 * PlantUML draws an error as a picture: «PlantUML version …», «[From … (line N) ]» and the words.
 * It goes back as an error of the text with its line; a picture of a text is the SVG as it is.
 */
const PLANTUML_HELPER = String.raw`
window.__loadPlantuml = async (text) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
  try { window.__plantuml = await import(url) } finally { URL.revokeObjectURL(url) }
}
window.__render = (src, seed, cfg) => new Promise((resolve) => {
  window.__plantuml.renderToString(src.split('\n'), (svg) => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const texts = [...doc.querySelectorAll('text')].map((t) => (t.textContent || '').trim())
    const at = texts.map((t) => /^\[From .* \(line (\d+)\) \]$/.exec(t)).find(Boolean)
    if (at && (texts[0] || '').startsWith('PlantUML version')) {
      const words = texts.filter(Boolean).at(-1) || 'Syntax error'
      resolve({ error: ('Error on line ' + at[1] + ': ' + words).slice(0, 300), stage: 'parse' })
    } else resolve({ svg, type: 'plantuml' })
  }, (e) => resolve({ error: String(e).slice(0, 300), stage: 'render' }), { maxSvgSize: cfg.maxSize })
})
`

/** The largest side of a PlantUML picture, in pixels: the engine refuses a larger one. */
const PLANTUML_MAX_SIDE = 8192

/** How a page of an engine is made and kept (docs/plan/91-chat-diagrams.md, Д2). */
interface Engine {
  /** Loads the engine and `window.__render` into a blank page with no network. */
  setup(page: Page): Promise<void>
  /** The settings `__render` gets beside the text. */
  config: Readonly<Record<string, unknown>>
  /** Whether the page stays after this failure; otherwise a new one is made for the next text. */
  keepsPageOn(reason: DiagramRawFailure): boolean
}

type DiagramRawFailure = 'parse' | 'render' | 'timeout'

const ENGINES: Record<DiagramEngine, Engine> = {
  mermaid: {
    async setup(page) {
      await page.setContent(
        '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
      )
      await page.addScriptTag({ content: mermaidBundle() })
      await page.addScriptTag({ content: HELPER })
    },
    config: {
      maxEdges: artifactRenderLimits.diagramEdges,
      maxText: artifactRenderLimits.diagramChars,
      font: FONT,
      secure: LOCKED,
    },
    // `initialize` is global to the page, and a failed render may leave it in any state.
    keepsPageOn: () => false,
  },
  plantuml: {
    async setup(page) {
      // Viz.js finds itself by the address of the page: `about:blank` has none, so the page gets
      // one that leads nowhere — every request is aborted anyway.
      await page.setContent(
        '<!doctype html><html><head><meta charset="utf-8"><base href="https://render.invalid/"></head><body></body></html>',
      )
      const bundle = plantumlBundle()
      await page.addScriptTag({ content: bundle.viz })
      // The engine is an ES module: imported from a blob of its own text, never from an address.
      await page.addScriptTag({ content: PLANTUML_HELPER })
      await page.evaluate(
        (text) =>
          (window as unknown as { __loadPlantuml: (t: string) => Promise<void> }).__loadPlantuml(
            text,
          ),
        bundle.engine,
      )
    },
    config: { maxSize: PLANTUML_MAX_SIDE },
    // PlantUML answers an error of the text with a picture, its page whole.
    keepsPageOn: (reason) => reason === 'parse',
  },
}

export type DiagramRawResult =
  | { ok: true; svg: string; type: string }
  | { ok: false; reason: DiagramRawFailure; message: string }

interface Slot {
  context: BrowserContext
  page: Promise<Page>
  queue: Promise<unknown>
  usedAt: number
}

/** Pages kept at once on one Chromium: the least recently used one goes first. */
const MAX_PAGES = 8

export interface DiagramJob {
  workspaceId: string
  source: string
  /** None — Mermaid. */
  engine?: DiagramEngine
}

export interface DiagramRenderer {
  render(job: DiagramJob): Promise<DiagramRawResult>
  close(): Promise<void>
}

export function createDiagramRenderer(browser: Browser): DiagramRenderer {
  const slots = new Map<string, Slot>()
  let seed = 0

  const drop = async (key: string, slot: Slot) => {
    if (slots.get(key) === slot) slots.delete(key)
    // Closing the context closes its renderer even in a busy loop.
    await Promise.race([
      slot.context.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ])
  }

  /** The page of an engine for a workspace: Mermaid and PlantUML never share one. */
  const open = async (key: string, engine: DiagramEngine): Promise<Slot> => {
    const existing = slots.get(key)
    if (existing) return existing
    if (slots.size >= MAX_PAGES) {
      const [oldKey, old] = [...slots.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0]!
      void drop(oldKey, old)
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.route('**/*', (route) => route.abort().catch(() => undefined))
    const page = (async () => {
      const created = await context.newPage()
      await ENGINES[engine].setup(created)
      return created
    })()
    const slot: Slot = { context, page, queue: Promise.resolve(), usedAt: Date.now() }
    slots.set(key, slot)
    return slot
  }

  const once = async (
    slot: Slot,
    source: string,
    config: Engine['config'],
  ): Promise<DiagramRawResult> => {
    const page = await slot.page
    seed += 1
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), artifactRenderLimits.diagramRenderMs)
    })
    const work = page
      .evaluate(
        ({ src, at, cfg }) =>
          (
            window as unknown as {
              __render: (s: string, n: number, c: unknown) => Promise<unknown>
            }
          ).__render(src, at, cfg),
        { src: source, at: seed, cfg: config },
      )
      .catch((error: unknown) => ({
        error: String((error as Error)?.message ?? error),
        stage: 'render',
      }))
    const out = await Promise.race([work, timeout])
    clearTimeout(timer)
    if (out === 'timeout')
      return { ok: false, reason: 'timeout', message: 'The diagram took longer than 10 s' }
    const value = out as { svg?: string; type?: string; error?: string; stage?: string }
    if (typeof value.svg === 'string')
      return { ok: true, svg: value.svg, type: (value.type ?? '').slice(0, 40) }
    return {
      ok: false,
      reason: value.stage === 'parse' ? 'parse' : 'render',
      message: (value.error ?? 'The diagram was not drawn').slice(0, 300),
    }
  }

  return {
    async render({ workspaceId, source, engine = 'mermaid' }) {
      const key = `${engine}:${workspaceId}`
      const slot = await open(key, engine)
      slot.usedAt = Date.now()
      // One diagram at a time on a page: `initialize` is global to it.
      const result = slot.queue.then(() => once(slot, source, ENGINES[engine].config))
      slot.queue = result.catch(() => undefined)
      let outcome: DiagramRawResult
      try {
        outcome = await result
      } catch (error) {
        outcome = {
          ok: false,
          reason: 'render',
          message: String((error as Error)?.message ?? error).slice(0, 300),
        }
      }
      // A page that failed is not used again, unless its engine keeps it whole after that failure.
      if (!outcome.ok && !ENGINES[engine].keepsPageOn(outcome.reason)) await drop(key, slot)
      return outcome
    },
    async close() {
      await Promise.all([...slots.entries()].map(([key, slot]) => drop(key, slot)))
    },
  }
}
