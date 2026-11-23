// «Схема» on a Chromium of this machine (docs/plan/88-artifacts.md, §7.13, slice 88.24г; spike 7),
// part of `pnpm verify:artifacts`. The corpus of spike 7 goes through the renderer of apps/browser
// (DiagramService on the render pool): every diagram valid by the documentation — Cyrillic ids
// included — is drawn with its labels, every classic mistake is refused with its error; each picture
// is clean XML for `<img>` that loads nothing and runs nothing; the hostile probes leave no trace.
// Then the whole road: the agent's write answered with the line of its error, the cabinet's picture
// asked of core and drawn, the page published with the picture as a file of the site.

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

export async function diagramsOnChromium({ root, databaseUrl, check }) {
  const dbModule = await import(resolve(root, 'packages/db/src/index.ts'))
  const { uuidv7 } = await import(resolve(root, 'packages/db/src/uuidv7.ts'))
  const { createPlaywrightFrameRenderer } = await import(
    resolve(root, 'packages/browser-providers/src/render/index.ts')
  )
  const { RenderPool } = await import(resolve(root, 'apps/browser/src/render/render-pool.ts'))
  const { DiagramService } = await import(
    resolve(root, 'apps/browser/src/render/diagram-service.ts')
  )
  const { McpArtifactsService } = await import(
    resolve(root, 'apps/mcp/src/artifacts/artifacts-service.ts')
  )
  const { postgresArtifactsStore } = await import(
    resolve(root, 'apps/mcp/src/artifacts/artifacts-store.ts')
  )
  const { ArtifactDiagram } = await import(resolve(root, 'apps/core/src/tasks/artifact-diagram.ts'))
  const { createGalleryArtifact } = await import(
    resolve(root, 'packages/trpc/src/services/artifacts/gallery.ts')
  )
  const { publishArtifactPage } = await import(
    resolve(root, 'packages/trpc/src/services/artifacts/publish.ts')
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
  const db = dbModule.createPrismaClient({ databaseUrl, log: [] })
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

    // 88.24г — the corpus of spike 7 through the renderer of apps/browser.
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

    // 88.24б–в — the agent's write, the cabinet's picture by core, the published page.
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic diagrams', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
    const created = await createGalleryArtifact(db, {
      userId: user.id,
      appEnv: 'development',
      kind: 'diagram',
      title: 'Путь клиента',
      projectId: null,
      templateId: 'customer-journey',
    })
    const view = (block) =>
      dbModule.readArtifactDiagram(db, { artifactId: created.id, block, userId: user.id })
    const [block] = (
      await dbModule.readArtifact(db, {
        artifactId: created.id,
        actor: { kind: 'user', userId: user.id },
      })
    ).blocks
    check(
      'the cabinet asks core for a picture it has not got',
      (await view(block.key)).state === 'drawing',
    )
    const job = await db.outboxEvent.findFirst({
      where: { type: 'artifact.diagram', payload: { path: ['artifactId'], equals: created.id } },
    })
    await new ArtifactDiagram({ db, draw: (request) => diagrams.render(request) }).run(job.payload)
    const shown = await view(block.key)
    check(
      'core draws it, and the cabinet shows the picture',
      shown.state === 'drawn' && shown.width > 0,
    )

    const taskId = (
      await db.task.create({
        data: { id: uuidv7(), workspaceId: workspace.id, createdById: user.id, status: 'running' },
        select: { id: true },
      })
    ).id
    await dbModule.attachMentionedArtifacts(db, { taskId, artifactIds: [created.id] })
    const tools = new McpArtifactsService({
      store: postgresArtifactsStore(db),
      diagram: (request) => diagrams.render(request),
    })
    const scope = {
      keyId: randomUUID(),
      taskId,
      workspaceId: workspace.id,
      sessionId: 'synthetic',
      turn: 1,
      firstEpoch: 1,
      epoch: 1,
      requirements: { repository: false, browser: false },
    }
    const wrote = await tools.edit(scope, {
      artifactId: created.id,
      opId: `diagram-${randomUUID()}`,
      // A new block: the person who made the artifact still holds the block of the template.
      ops: [
        {
          op: 'insert',
          block: 'd2',
          after: block.key,
          kind: 'diagram',
          content: 'flowchart LR\n  A[Заявка] --> B[Счёт]\n  B --> (((',
        },
      ],
    })
    const told = wrote.ok ? wrote.value.diagrams?.find((each) => each.block === 'd2') : null
    check(
      'the agent reads in the answer that its diagram did not parse, and the line',
      told?.drawn === false && told.line === 3,
      JSON.stringify(wrote),
    )
    const published = await publishArtifactPage(
      db,
      { baseDomain: 'pages.localhost', scheme: 'http', port: 3110 },
      { artifactId: created.id, userId: user.id, versionNo: null },
    )
    const html = Buffer.from(
      (await db.pageContent.findUniqueOrThrow({ where: { pageId: published.pageId } })).bytes,
    ).toString('utf8')
    check(
      'the published page shows the checked picture as a file of the site, without Mermaid',
      /<img src="\/_files\/a\/d-[0-9a-f]{32}\.svg"/.test(html) && !/<script|mermaid/i.test(html),
    )
  } finally {
    await browser.close()
    await pool.close()
    await db.$disconnect()
  }
}
