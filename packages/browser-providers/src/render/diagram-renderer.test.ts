import { existsSync } from 'node:fs'

import { chromium, type Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDiagramRenderer, type DiagramRenderer } from './diagram-renderer.ts'
import { renderChromiumArgs } from './frame-renderer.ts'
import { cleanDiagramSvg } from './diagram-svg.ts'

// Mermaid on the page of a workspace (docs/plan/88-artifacts.md, §7.13, 88.24а; spike 7). Needs a
// Chromium of this machine: Playwright's, or a system Chrome; without one the suite is skipped (the
// stand `verify:artifacts` draws in the image of apps/browser).

const executable = [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
].find((path): path is string => typeof path === 'string' && existsSync(path))

const workspace = '0193f8a2-6c1e-7000-8000-000000000001'

describe.skipIf(!executable)('diagrams drawn by Mermaid in a Chromium', () => {
  let browser: Browser
  let renderer: DiagramRenderer

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: renderChromiumArgs(),
      proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
      executablePath: executable!,
    })
    renderer = createDiagramRenderer(browser)
  }, 60_000)
  afterAll(async () => {
    await renderer?.close()
    await browser?.close()
  })

  it('draws a flowchart with Cyrillic labels into a clean SVG for <img>', async () => {
    const out = await renderer.render({
      workspaceId: workspace,
      source:
        'flowchart LR\n  A[Заявка с сайта] --> B{Есть товар?}\n  B -->|да| C[Счёт]\n  B -->|нет| D[Под заказ]',
    })
    expect(out).toMatchObject({ ok: true, type: 'flowchart-v2' })
    if (!out.ok) return
    const clean = cleanDiagramSvg(out.svg)
    expect(clean!.width).toBeGreaterThan(100)
    // Without HTML labels Mermaid puts each word of a label into a tspan of its own.
    for (const word of ['Заявка', 'сайта', 'товар?', 'Счёт']) expect(clean!.svg).toContain(word)
    expect(clean!.svg).not.toMatch(/<script|foreignObject/i)
  }, 30_000)

  it('answers a broken text with the line Mermaid named, and draws again after it', async () => {
    const out = await renderer.render({
      workspaceId: workspace,
      source: 'flowchart LR\n  A --> B\n  B --> ((',
    })
    expect(out).toMatchObject({ ok: false, reason: 'parse' })
    if (out.ok) return
    expect(out.message).toMatch(/line 3/i)
    // The failed page was closed: a new one draws the next diagram.
    expect(
      await renderer.render({ workspaceId: workspace, source: 'flowchart LR\n  A --> B' }),
    ).toMatchObject({
      ok: true,
    })
  }, 30_000)

  it('refuses more edges than the limit, without a line', async () => {
    const edges = Array.from({ length: 201 }, (_, at) => `  n${at} --> n${at + 1}`).join('\n')
    const out = await renderer.render({ workspaceId: workspace, source: `flowchart LR\n${edges}` })
    expect(out.ok).toBe(false)
  }, 30_000)
})
