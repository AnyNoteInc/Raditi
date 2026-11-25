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

  // PlantUML of `@plantuml/core` on a page of its own (docs/plan/91-chat-diagrams.md, Д2).
  it('draws a PlantUML sequence and a class diagram with Cyrillic into a clean SVG', async () => {
    const sequence = await renderer.render({
      workspaceId: workspace,
      engine: 'plantuml',
      source: '@startuml\nКлиент -> Магазин : Заказ\nМагазин --> Клиент : Счёт\n@enduml',
    })
    expect(sequence).toMatchObject({ ok: true, type: 'plantuml' })
    if (!sequence.ok) return
    const clean = cleanDiagramSvg(sequence.svg)
    expect(clean!.width).toBeGreaterThan(50)
    for (const word of ['Клиент', 'Магазин', 'Счёт']) expect(clean!.svg).toContain(word)
    const classes = await renderer.render({
      workspaceId: workspace,
      engine: 'plantuml',
      source: '@startuml\nclass Заказ {\n +сумма\n}\nЗаказ --> Клиент\n@enduml',
    })
    expect(classes).toMatchObject({ ok: true })
  }, 60_000)

  it('answers a broken PlantUML text and an include with the line, and loads nothing', async () => {
    const broken = await renderer.render({
      workspaceId: workspace,
      engine: 'plantuml',
      source: '@startuml\nAlice -> : \n foo bar baz (\n@enduml',
    })
    expect(broken).toMatchObject({ ok: false, reason: 'parse' })
    if (!broken.ok) expect(broken.message).toMatch(/line 3/)
    const include = await renderer.render({
      workspaceId: workspace,
      engine: 'plantuml',
      source: '@startuml\n!include https://example.com/x.puml\nA -> B\n@enduml',
    })
    expect(include).toMatchObject({ ok: false, reason: 'parse' })
    if (!include.ok) expect(include.message).toMatch(/line 2.*cannot include/)
    // The page stays whole after an error of the text.
    const again = await renderer.render({
      workspaceId: workspace,
      engine: 'plantuml',
      source: '@startmindmap\n* Корень\n** Ветка\n@endmindmap',
    })
    expect(again).toMatchObject({ ok: true })
  }, 60_000)
})
