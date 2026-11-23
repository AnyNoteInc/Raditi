// «Презентация» on a Chromium of this machine (docs/plan/88-artifacts.md, §7.13, slice 88.25г), part
// of `pnpm verify:artifacts`. The deck of the template through the renderer of apps/browser: each
// slide drawn once at 1280×720, a slide taller than that named by `artifact_layout`, the PDF and the
// PPTX built by core from the pictures the renderer drew, and the site of the slides published with
// its links from one slide to the next.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

function memoryBucket() {
  const objects = new Map()
  return {
    objects,
    async put(_bucket, key, body) {
      objects.set(key, Buffer.from(body))
    },
    async delete(_bucket, key) {
      objects.delete(key)
    },
    async exists(_bucket, key) {
      return objects.has(key)
    },
    async get(_bucket, key) {
      const bytes = objects.get(key)
      return bytes === undefined
        ? null
        : (async function* () {
            yield bytes
          })()
    },
  }
}

export async function slidesOnChromium({ root, databaseUrl, check }) {
  const dbModule = await import(resolve(root, 'packages/db/src/index.ts'))
  const { uuidv7 } = await import(resolve(root, 'packages/db/src/uuidv7.ts'))
  const { createPlaywrightFrameRenderer } = await import(
    resolve(root, 'packages/browser-providers/src/render/index.ts')
  )
  const { RenderPool } = await import(resolve(root, 'apps/browser/src/render/render-pool.ts'))
  const { RenderService } = await import(resolve(root, 'apps/browser/src/render/render-service.ts'))
  const { McpArtifactsService } = await import(
    resolve(root, 'apps/mcp/src/artifacts/artifacts-service.ts')
  )
  const { postgresArtifactsStore } = await import(
    resolve(root, 'apps/mcp/src/artifacts/artifacts-store.ts')
  )
  const { ArtifactExports } = await import(
    resolve(root, 'apps/core/src/artifact-exports/artifact-exports.ts')
  )
  const { ArtifactThumbs } = await import(
    resolve(root, 'apps/core/src/artifact-exports/artifact-thumbs.ts')
  )
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
  const { PDFDocument } = await import(
    resolve(root, 'node_modules/.pnpm/pdf-lib@1.17.1/node_modules/pdf-lib/cjs/index.js')
  )

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
  try {
    const bucket = memoryBucket()
    const renderer = new RenderService({ db, files: bucket, pool })
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic slides', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
    const deck = await createGalleryArtifact(db, {
      userId: user.id,
      appEnv: 'development',
      kind: 'slides',
      title: 'Презентация компании',
      projectId: null,
      templateId: 'company-deck',
    })
    const person = { kind: 'user', userId: user.id }
    const read = await dbModule.readArtifact(db, { artifactId: deck.id, actor: person })
    const frames = read.blocks.filter((block) => block.kind === 'frame')
    check('the deck of the template is five slides with their notes', frames.length === 5)

    // 88.25а — a slide is drawn once, at 1280×720, whatever widths were asked.
    const layout = await renderer.render({
      artifactId: deck.id,
      frame: frames[0].key,
      viewer: person,
      output: 'layout',
      widths: [1440, 390],
    })
    check(
      'a slide is drawn once at 1280×720, and the slide of the template fits',
      layout.heights.length === 1 &&
        layout.heights[0].width === 1280 &&
        layout.heights[0].height <= 720 &&
        !/not fit|over its 720/.test(layout.report),
      JSON.stringify(layout.heights),
    )

    // The agent writes a slide too tall: `artifact_layout` names it first.
    const taskId = (
      await db.task.create({
        data: { id: uuidv7(), workspaceId: workspace.id, createdById: user.id, status: 'running' },
        select: { id: true },
      })
    ).id
    await dbModule.attachMentionedArtifacts(db, { taskId, artifactIds: [deck.id] })
    const tools = new McpArtifactsService({
      store: postgresArtifactsStore(db),
      render: (request) => renderer.render(request),
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
    const long = Array.from({ length: 30 }, (_, at) => `<li>Пункт ${at + 1}</li>`).join('')
    const wrote = await tools.edit(scope, {
      artifactId: deck.id,
      opId: `slide-${randomUUID()}`,
      ops: [
        {
          op: 'insert',
          block: 'tall',
          after: frames[4].key,
          kind: 'frame',
          props: { name: 'Длинный' },
        },
        {
          op: 'insert',
          block: 'tall-html',
          after: null,
          parent: 'tall',
          kind: 'html',
          content: `<section class="slide" style="height:auto"><h2>Всё сразу</h2><ul>${long}</ul></section>`,
        },
      ],
    })
    check('the agent writes a slide of its own', wrote.ok, JSON.stringify(wrote))
    const told = await tools.layout(scope, { artifactId: deck.id, frame: 'tall' })
    check(
      'artifact_layout names a slide taller than 720 px first',
      told.ok && /^The slide is \d+ px tall, over its 720/.test(told.value.report),
      JSON.stringify(told).slice(0, 300),
    )

    // What the person reads now: the slides of the template and the agent's frame (its text waits
    // for the check of core) — the thumbnails, the files and the site follow it.
    const { artifactSlidesOf } = await import(
      resolve(root, 'packages/domain/src/artifacts/index.ts')
    )
    const now = (await dbModule.readArtifact(db, { artifactId: deck.id, actor: person })).blocks
    const seen = artifactSlidesOf(now).length
    // The files and the site take only the slides whose text was checked.
    const ready = artifactSlidesOf(now).filter((slide) =>
      now.some((block) => block.parent === slide.key && block.kind === 'html' && block.content),
    ).length
    check(
      'the agent’s slide waits for the check, and the person sees it coming',
      seen === ready + 1,
    )
    // 88.25а — one thumbnail a slide, the slide and nothing below it.
    const thumbs = new ArtifactThumbs({
      db,
      storage: bucket,
      render: (request) => renderer.render(request),
    })
    const drawn = await thumbs.draw(deck.id)
    check('core draws one thumbnail a slide, at 1280', drawn === seen, `${drawn} of ${seen}`)

    // 88.25в — the PDF and the PPTX of the slides as the person reads them.
    const exports = new ArtifactExports({
      db,
      storage: bucket,
      render: (request) => renderer.render(request),
    })
    for (const format of ['pdf', 'pptx']) {
      const row = await db.artifactExport.create({
        data: { artifactId: deck.id, userId: user.id, format },
      })
      const built = await exports.build(row.id)
      const done = await db.artifactExport.findUniqueOrThrow({ where: { id: row.id } })
      const bytes = done.objectKey ? bucket.objects.get(done.objectKey) : undefined
      check(
        `the ${format.toUpperCase()} of the deck is built`,
        built === 'ready' && bytes?.length > 10_000,
        built,
      )
      if (format === 'pdf') {
        const pdf = await PDFDocument.load(bytes)
        check(
          'the PDF has a 16:9 page a checked slide',
          pdf.getPageCount() === ready && pdf.getPage(0).getWidth() === 960,
        )
      } else {
        const text = bytes.toString('latin1')
        check(
          'the PPTX has a slide a checked slide and the speaker notes',
          text.includes(`ppt/slides/slide${ready}.xml`) &&
            !text.includes(`ppt/slides/slide${ready + 1}.xml`) &&
            text.includes('ppt/notesSlides/'),
        )
      }
    }

    // 88.25в — the site of the slides, each linked to the next.
    const published = await publishArtifactPage(
      db,
      { baseDomain: 'pages.localhost', scheme: 'http', port: 3110 },
      { artifactId: deck.id, userId: user.id, versionNo: null },
      () => bucket,
    )
    const pages = await db.artifactPublication.findMany({
      where: { artifactId: deck.id },
      select: { pageId: true, page: { select: { path: true } } },
    })
    const cover = Buffer.from(
      (await db.pageContent.findUniqueOrThrow({ where: { pageId: published.pageId } })).bytes,
    ).toString('utf8')
    check(
      'the deck is published as a page a slide, the cover linked to the next',
      pages.length === ready &&
        cover.includes('<a href="/2" rel="next"') &&
        cover.includes(`1 из ${ready}`),
      pages.map((row) => row.page.path).join(),
    )
  } finally {
    await pool.close()
    await db.$disconnect()
  }
}
