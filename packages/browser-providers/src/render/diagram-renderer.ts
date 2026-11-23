import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { artifactRenderLimits } from '@repo/domain/artifacts'
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

export type DiagramRawResult =
  | { ok: true; svg: string; type: string }
  | { ok: false; reason: 'parse' | 'render' | 'timeout'; message: string }

interface Slot {
  context: BrowserContext
  page: Promise<Page>
  queue: Promise<unknown>
  usedAt: number
}

/** Pages kept at once on one Chromium: the least recently used one goes first. */
const MAX_PAGES = 8

export interface DiagramRenderer {
  render(job: { workspaceId: string; source: string }): Promise<DiagramRawResult>
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

  const open = async (key: string): Promise<Slot> => {
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
      await created.setContent(
        '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
      )
      await created.addScriptTag({ content: mermaidBundle() })
      await created.addScriptTag({ content: HELPER })
      return created
    })()
    const slot: Slot = { context, page, queue: Promise.resolve(), usedAt: Date.now() }
    slots.set(key, slot)
    return slot
  }

  const once = async (slot: Slot, source: string): Promise<DiagramRawResult> => {
    const page = await slot.page
    seed += 1
    const config = {
      maxEdges: artifactRenderLimits.diagramEdges,
      maxText: artifactRenderLimits.diagramChars,
      font: FONT,
      secure: LOCKED,
    }
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
    async render({ workspaceId, source }) {
      const slot = await open(workspaceId)
      slot.usedAt = Date.now()
      // One diagram at a time on a page: `initialize` is global to it.
      const result = slot.queue.then(() => once(slot, source))
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
      // A page that failed or timed out is not used again: a new one is made for the next diagram.
      if (!outcome.ok) await drop(workspaceId, slot)
      return outcome
    },
    async close() {
      await Promise.all([...slots.entries()].map(([key, slot]) => drop(key, slot)))
    },
  }
}
