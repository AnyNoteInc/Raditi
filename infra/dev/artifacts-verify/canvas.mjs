// The canvas, the brand and the renderer of frames (docs/plan/88-artifacts.md, Ар8, Ар32, §7.7,
// §7.12; slices 88.15, 88.15а, 88.15б, 88.15в), part of `pnpm verify:artifacts`: over the disposable
// PostgreSQL of the stand, a project with its brand and a canvas from the template, the agent of a
// chat of the project — `artifact_layout` through mcp onto the renderer of `apps/browser` on a
// Chromium of this machine without network, the chat's own unchecked block in the report, frames
// that try the network and hold the main thread; `artifact_render` pictures; the thumbnails of core
// and the board's ask for them; «Опубликовать как сайт» of the canvas. Synthetic data only.

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve } from 'node:path'

/** A memory of the artifacts bucket: what the renderer reads and core writes. */
function memoryBucket() {
  const objects = new Map()
  return {
    objects,
    async put(_bucket, key, body) {
      objects.set(key, Buffer.from(body))
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

export async function canvasAndRender({ root, databaseUrl, check }) {
  const dbModule = await import(resolve(root, 'packages/db/src/index.ts'))
  const { uuidv7 } = await import(resolve(root, 'packages/db/src/uuidv7.ts'))
  const domain = await import(resolve(root, 'packages/domain/src/artifacts/index.ts'))
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
  const { ArtifactThumbs } = await import(
    resolve(root, 'apps/core/src/artifact-exports/artifact-thumbs.ts')
  )
  const { canvasThumbs } = await import(
    resolve(root, 'packages/trpc/src/services/artifacts/canvas.ts')
  )
  const { publishArtifactPage } = await import(
    resolve(root, 'packages/trpc/src/services/artifacts/publish.ts')
  )
  const { createGalleryArtifact } = await import(
    resolve(root, 'packages/trpc/src/services/artifacts/gallery.ts')
  )
  // Whatever a frame would send outside: nothing may come here.
  let trapped = 0
  const trap = createServer((_request, response) => {
    trapped += 1
    response.end('trapped')
  })
  await new Promise((done) => trap.listen(0, '127.0.0.1', done))
  const trapUrl = `http://127.0.0.1:${trap.address().port}`

  const db = dbModule.createPrismaClient({ databaseUrl, log: [] })
  const pool = new RenderPool({
    runtime: null,
    local: true,
    containers: 1,
    create: createPlaywrightFrameRenderer,
  })
  try {
    const bucket = memoryBucket()
    const renderer = new RenderService({ db, files: bucket, pool })
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic canvas', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
    const project = await db.project.create({
      data: { id: uuidv7(), workspaceId: workspace.id, createdById: user.id, name: 'Пекарня' },
    })
    const person = { kind: 'user', userId: user.id }

    // 88.15а — the brand of the project from its template, its colours in every frame.
    const brand = await createGalleryArtifact(db, {
      userId: user.id,
      appEnv: 'development',
      kind: 'brand',
      title: 'Фирменный стиль',
      projectId: project.id,
      templateId: 'brand',
    })
    const brandRead = await dbModule.readArtifact(db, { artifactId: brand.id, actor: person })
    check(
      'the brand of the template is its tokens and the tone of its texts',
      brandRead.blocks.map((block) => block.kind).join() === 'settings,section',
    )
    // 88.15 — the canvas of the template: three screens for a computer and a phone.
    const canvas = await createGalleryArtifact(db, {
      userId: user.id,
      appEnv: 'development',
      kind: 'canvas',
      title: 'Сайт пекарни',
      projectId: project.id,
      templateId: 'new-site',
    })
    const canvasRead = await dbModule.readArtifact(db, { artifactId: canvas.id, actor: person })
    const screens = domain.canvasScreensOf(canvasRead.blocks)
    check(
      'the template «Холст для нового сайта» is three screens with their pages',
      screens.map((screen) => screen.path).join() === '/,/uslugi,/kontakty',
    )
    const source = await renderer.source({
      artifactId: canvas.id,
      frame: 'home',
      viewer: { kind: 'user', userId: user.id },
    })
    check(
      'a frame of the canvas stands in the brand of its project, its parts marked by block',
      source.html.includes('--brand-primary:#2f5d50') &&
        source.html.includes('<!--raditi-block:home-html-->') &&
        source.policy.startsWith('sandbox allow-scripts') &&
        source.policy.includes("connect-src 'none'"),
    )

    // 88.15б — the agent of a chat of the project checks its frame by `artifact_layout`.
    const taskId = (
      await db.task.create({
        data: {
          id: uuidv7(),
          workspaceId: workspace.id,
          createdById: user.id,
          projectId: project.id,
          status: 'running',
        },
        select: { id: true },
      })
    ).id
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
    const tools = new McpArtifactsService({
      store: postgresArtifactsStore(db),
      render: (request) => renderer.render(request),
    })
    const bugs = [
      '<style>.row{display:grid;grid-template-columns:300px 300px 300px}.grey{color:#c8c8c8}</style>',
      '<section class="row"><div>Хлеб</div><div>Булки</div><div>Торты</div></section>',
      '<p class="grey">Отзыв покупателя серым по белому</p>',
      `<img src="${trapUrl}/pixel.png" alt="">`,
      `<script>fetch('${trapUrl}/f').catch(()=>{});try{new WebSocket('${trapUrl.replace('http', 'ws')}')}catch(e){};new Image().src='${trapUrl}/i';localStorage.x=1</script>`,
    ].join('')
    const wrote = await tools.edit(scope, {
      artifactId: canvas.id,
      opId: 'agent-bugs',
      ops: [
        {
          op: 'insert',
          block: 'home-bugs',
          after: 'home-html',
          parent: 'home',
          kind: 'html',
          content: bugs,
        },
      ],
    })
    check('the agent writes a part of the home screen', wrote.ok, JSON.stringify(wrote))
    const started = performance.now()
    const layout = await tools.layout(scope, { artifactId: canvas.id, frame: 'home' })
    const ms = Math.round(performance.now() - started)
    const report = layout.ok ? layout.value.report : ''
    process.stdout.write(
      `[artifacts] artifact_layout of a frame: ${ms} ms, ${report.length} chars\n`,
    )
    check(
      'artifact_layout sees the chat’s own unchecked part: sideways on the phone, contrast, outside loads',
      layout.ok &&
        report.includes('390') &&
        report.includes('scrolls sideways') &&
        report.includes('low contrast') &&
        report.includes('blocked') &&
        report.includes('home-bugs.'),
      report,
    )
    check(
      'the report keeps to 1 500 characters and quotes at most 32 of the frame',
      report.length <= domain.artifactRenderLimits.layoutReportChars &&
        [...report.matchAll(/«([^»]*)»/g)].every((quote) => quote[1].length <= 32),
      report,
    )
    const personal = await renderer.render({
      artifactId: canvas.id,
      frame: 'home',
      viewer: { kind: 'user', userId: user.id },
      output: 'layout',
    })
    check(
      'a person sees no text of the agent before the check',
      !personal.report.includes('home-bugs.') && !personal.report.includes('scrolls sideways'),
      personal.report,
    )
    check('nothing of a frame reaches the network', trapped === 0, `${trapped} requests`)

    // Hostile frames: a script that never ends is stopped within the call.
    await tools.edit(scope, {
      artifactId: canvas.id,
      opId: 'agent-loop',
      ops: [
        {
          op: 'insert',
          block: 'loop-js',
          after: null,
          parent: 'kontakty',
          kind: 'script',
          content: 'for(;;){}',
        },
      ],
    })
    const loopStarted = performance.now()
    const hung = await tools.layout(scope, { artifactId: canvas.id, frame: 'kontakty' })
    const loopMs = Math.round(performance.now() - loopStarted)
    check(
      'a frame whose script never ends is stopped and still drawn within 20 s',
      hung.ok &&
        loopMs < domain.artifactRenderLimits.layoutCallMs &&
        hung.value.report.includes('did not finish'),
      `${loopMs} ms ${hung.ok ? hung.value.report : JSON.stringify(hung)}`,
    )
    const refusedMockup = await tools.layout(scope, { artifactId: brand.id })
    check(
      'a brand has no frame: the tool says so',
      !refusedMockup.ok && refusedMockup.code === 'ARTIFACT_OP_INVALID',
      JSON.stringify(refusedMockup),
    )

    // 88.15в — the pictures for the helper look: JPEG strips, at most four, three checks a turn.
    const looked = await tools.render(scope, { artifactId: canvas.id, frame: 'uslugi' })
    check(
      'artifact_render gives JPEG pictures of both views, at most four',
      looked.answer.ok &&
        looked.pictures.length >= 2 &&
        looked.pictures.length <= domain.artifactRenderLimits.picturesPerLook &&
        looked.pictures.every(
          (picture) =>
            Buffer.from(picture.data, 'base64').subarray(0, 2).toString('hex') === 'ffd8',
        ),
      JSON.stringify(looked.answer),
    )
    await tools.render(scope, { artifactId: canvas.id, frame: 'uslugi', view: 'phone' })
    await tools.render(scope, { artifactId: canvas.id, frame: 'uslugi', view: 'desktop' })
    const fourth = await tools.render(scope, { artifactId: canvas.id, frame: 'uslugi' })
    check(
      'a fourth look in a turn is refused',
      !fourth.answer.ok && fourth.answer.code === 'ARTIFACT_LIMIT' && fourth.pictures.length === 0,
      JSON.stringify(fourth.answer),
    )

    // 88.15 — the thumbnails: the board asks, core draws them once.
    const asked = await canvasThumbs(db, bucket, { userId: user.id, artifactId: canvas.id })
    const enqueued = await db.outboxEvent.count({ where: { type: domain.ARTIFACT_THUMBS_JOB } })
    check(
      'the board finds no thumbnail and asks core once',
      asked.pending && asked.thumbs.every((thumb) => thumb.url === null) && enqueued === 1,
    )
    await canvasThumbs(db, bucket, { userId: user.id, artifactId: canvas.id })
    check(
      'asking again for the same revision asks nothing more',
      (await db.outboxEvent.count({ where: { type: domain.ARTIFACT_THUMBS_JOB } })) === 1,
    )
    const thumbs = new ArtifactThumbs({
      db,
      storage: bucket,
      render: (request) => renderer.render(request),
    })
    const drawnStarted = performance.now()
    const drawn = await thumbs.draw(canvas.id)
    process.stdout.write(
      `[artifacts] thumbnails of ${screens.length} screens: ${drawn} in ${Math.round(performance.now() - drawnStarted)} ms\n`,
    )
    check('core draws a thumbnail of each view of each screen', drawn === screens.length * 2)
    check('a second pass draws nothing', (await thumbs.draw(canvas.id)) === 0)
    const ready = await canvasThumbs(db, bucket, { userId: user.id, artifactId: canvas.id })
    check(
      'the board gets an address of each thumbnail',
      !ready.pending &&
        ready.thumbs.every((thumb) => thumb.url?.startsWith(`/api/artifact-thumbs/${canvas.id}/`)),
    )

    // 88.15 — «Опубликовать как сайт»: one page a screen.
    const page = await publishArtifactPage(
      db,
      { baseDomain: 'pages.localhost', scheme: 'http', port: 3000 },
      { artifactId: canvas.id, userId: user.id, versionNo: null },
      () => bucket,
    )
    const pages = await db.artifactPublication.findMany({
      where: { artifactId: canvas.id },
      include: { page: { select: { path: true, kind: true } } },
    })
    check(
      'the canvas becomes a site of three pages at their paths',
      pages
        .map((row) => row.page.path)
        .toSorted()
        .join() === '/,/kontakty,/uslugi' &&
        pages.every((row) => row.page.kind === 'html') &&
        page.url.startsWith('http://'),
      JSON.stringify(pages.map((row) => row.page)),
    )
    const again = await publishArtifactPage(
      db,
      { baseDomain: 'pages.localhost', scheme: 'http', port: 3000 },
      { artifactId: canvas.id, userId: user.id, versionNo: null },
      () => bucket,
    )
    check(
      'publishing again updates the same pages',
      again.pageId === page.pageId &&
        (await db.artifactPublication.count({ where: { artifactId: canvas.id } })) === 3,
    )
  } finally {
    await pool.close()
    trap.close()
    await db.$disconnect()
  }
}
