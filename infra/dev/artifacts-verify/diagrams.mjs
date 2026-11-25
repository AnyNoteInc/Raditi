// The renderer of diagrams on a Chromium of this machine (docs/plan/88-artifacts.md, §7.13, slice
// 88.24г; spike 7), part of `pnpm verify:artifacts`. The artifact «Схема» is gone (plan 93, АТ3), but
// its Mermaid renderer stays for the diagrams in chat answers (plan 91): the corpus of spike 7 goes
// through the renderer of apps/browser (DiagramService on the render pool): every diagram valid by
// the documentation — Cyrillic ids included — is drawn with its labels, every classic mistake is
// refused with its error; each picture is clean XML for `<img>` that loads nothing and runs nothing;
// the hostile probes leave no trace.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { corpus, hostile } from './diagram-corpus.mjs'

/** In the page: what an SVG is as an image, and what in it could run or load. */
const INSPECT = `async (svg) => {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const broken = doc.getElementsByTagName('parsererror').length > 0 || doc.documentElement.localName !== 'svg'
  const found = { script: 0, handler: 0, foreign: 0, external: 0 }
  for (const element of doc.querySelectorAll('*')) {
    const name = element.localName.toLowerCase()
    if (name === 'script') found.script += 1
    if (name === 'foreignobject' || name === 'iframe' || name === 'object' || name === 'embed') found.foreign += 1
    if (name === 'style' && /@import|url\\(\\s*['"]?\\s*(?:https?:)?\\/\\//i.test(element.textContent)) found.external += 1
    for (const attribute of element.attributes) {
      const key = attribute.name.toLowerCase()
      if (key.startsWith('on')) found.handler += 1
      if ((key === 'href' || key.endsWith(':href')) && !attribute.value.trim().startsWith('#')) found.external += 1
      if (/url\\(\\s*['"]?\\s*(?:https?:)?\\/\\//i.test(attribute.value)) found.external += 1
    }
  }
  const text = [...doc.querySelectorAll('text')].map((node) => node.textContent).join(' ')
  const image = new Image()
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  let drawn = false
  try { await image.decode(); drawn = image.naturalWidth > 0 && image.naturalHeight > 0 } catch {}
  return { broken, found, text, drawn }
}`

const squash = (text) => text.normalize('NFC').replace(/[\s ]+/g, '')

export async function diagramsOnChromium({ root, check }) {
  const { createPlaywrightFrameRenderer } = await import(
    resolve(root, 'packages/browser-providers/src/render/index.ts')
  )
  const { RenderPool } = await import(resolve(root, 'apps/browser/src/render/render-pool.ts'))
  const { DiagramService } = await import(
    resolve(root, 'apps/browser/src/render/diagram-service.ts')
  )
  const { chromium } = (
    await import(
      resolve(
        root,
        'node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/index.js',
      )
    )
  ).default

  // Playwright's Chromium, or a system Chrome where it is not installed (a machine of a developer).
  const executablePath = [
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((path) => existsSync(path))
  const pool = new RenderPool({
    runtime: null,
    local: true,
    containers: 1,
    create: (target) =>
      createPlaywrightFrameRenderer(
        'launch' in target && executablePath ? { ...target, executablePath } : target,
      ),
  })
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  })
  try {
    const diagrams = new DiagramService(pool)
    const viewer = await browser.newContext()
    // The page that looks at the pictures reaches nothing: any request it makes is counted.
    let requests = 0
    await viewer.route('**/*', (route) => {
      requests += 1
      return route.abort()
    })
    const page = await viewer.newPage()
    await page.setContent('<!doctype html><meta charset="utf-8"><body></body>')
    const inspect = (svg) => page.evaluate(`(${INSPECT})(${JSON.stringify(svg)})`)
    const workspaceId = randomUUID()

    // The corpus of spike 7 through the renderer of apps/browser.
    const drawn = []
    const refused = []
    let labels = 0
    let found = 0
    const missing = []
    for (const diagram of corpus) {
      const out = await diagrams.render({ workspaceId, source: diagram.source })
      // Spike 7: Mermaid refuses the categories of an xychart without quotes (X01) — the rule the
      // agent is given — and draws one of the eight mistakes; every other diagram is drawn. The
      // fence of F12 is a mistake Mermaid refuses, and the normalisation takes it off (§7.13).
      if ((diagram.valid === false && diagram.id !== 'F12') || diagram.id === 'X01') {
        refused.push({ id: diagram.id, valid: diagram.valid, out })
        if (out.ok) drawn.push(diagram.id)
        continue
      }
      check(
        `the diagram ${diagram.id} (${diagram.type}) valid by the documentation is drawn`,
        out.ok,
        out.ok ? '' : out.message,
      )
      const seen = await inspect(out.svg)
      check(
        `the picture of ${diagram.id} is clean XML an <img> draws, with nothing to run or load`,
        !seen.broken &&
          seen.drawn &&
          seen.found.script + seen.found.handler + seen.found.foreign + seen.found.external === 0 &&
          Buffer.byteLength(out.svg) <= 512 * 1024,
        JSON.stringify(seen.found),
      )
      const text = squash(seen.text)
      for (const label of diagram.labels ?? []) {
        labels += 1
        // Without HTML labels Mermaid puts each word into a tspan, and wraps long labels.
        if (
          squash(label)
            .split(/<br\/?>/)
            .every((part) => text.includes(squash(part)))
        )
          found += 1
        else missing.push(`${diagram.id}: ${label}`)
      }
      drawn.push(diagram.id)
    }
    check(
      '23 diagrams of the corpus are drawn: the 22 of spike 7 and the fenced one, normalised',
      drawn.length === 23 && drawn.includes('F12'),
      drawn.join(),
    )
    const x01 = refused.find(({ id }) => id === 'X01')?.out
    check(
      'the categories of an xychart without quotes are refused with their line (the rule of the agent)',
      x01 && !x01.ok && x01.line === 3,
      JSON.stringify(x01),
    )
    check(
      'the labels the client wrote are in the pictures (spike 7: 1 of 205 out of its frame)',
      found / labels >= 0.97,
      `${found}/${labels}; missing: ${missing.slice(0, 5).join('; ')}`,
    )
    const mistakes = refused.filter(({ valid }) => valid === false)
    const turnedAway = mistakes.filter(({ out }) => !out.ok)
    check(
      'six of the seven other mistakes of a model are refused with the engine’s words (spike 7)',
      turnedAway.length >= 6 && turnedAway.every(({ out }) => out.message.length > 0),
      mistakes.map(({ id, out }) => `${id}:${out.ok ? 'drawn' : out.reason}`).join(),
    )
    check(
      'the refusals name their line, but for a date in words (spike 7)',
      turnedAway.filter(({ out }) => out.line !== null).length >= 5,
      turnedAway.map(({ id, out }) => `${id}:${out.line}`).join(),
    )
    for (const probe of hostile) {
      const out = await diagrams.render({ workspaceId, source: probe.source })
      if (!out.ok) continue
      const seen = await inspect(out.svg)
      check(
        `the hostile probe ${probe.id} leaves nothing to run or load`,
        !seen.broken &&
          seen.found.script + seen.found.handler + seen.found.foreign + seen.found.external === 0,
        JSON.stringify(seen.found),
      )
    }
    check('looking at every picture made no request', requests === 0, String(requests))
  } finally {
    await browser.close()
    await pool.close()
  }
}
