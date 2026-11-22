// «Изображение» on a Chromium of this machine (docs/plan/88-artifacts.md, §7.13, slice 88.26в), part
// of `pnpm verify:artifacts`. The pictures of the template through the renderer of apps/browser:
// each drawn once in the size of its place, a picture taller than that named by `artifact_layout`,
// a thumbnail each, and the PNG core builds in the very size of the picture.

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

export async function imagesOnChromium({ root, databaseUrl, check }) {
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
  const { chromium } = (
    await import(
      resolve(
        root,
        'node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/index.js',
      )
    )
  ).default

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
      data: { name: 'Synthetic pictures', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
    const made = await createGalleryArtifact(db, {
      userId: user.id,
      appEnv: 'development',
      kind: 'image',
      title: 'Пост для соцсетей',
      projectId: null,
      templateId: 'social-post',
    })
    const person = { kind: 'user', userId: user.id }

    // 88.26а — each picture once, in the size of its place, and the template fits.
    for (const [frame, width, height] of [
      ['post', 1080, 1080],
      ['story', 1080, 1920],
    ]) {
      const layout = await renderer.render({
        artifactId: made.id,
        frame,
        viewer: person,
        output: 'layout',
        widths: [1440, 390],
      })
      check(
        `the picture ${frame} is drawn once at ${width}×${height}, and it fits`,
        layout.heights.length === 1 &&
          layout.heights[0].width === width &&
          layout.heights[0].height <= height &&
          !/over its/.test(layout.report),
        JSON.stringify(layout.heights),
      )
    }

    // The agent writes a picture too tall for a banner: `artifact_layout` names it first.
    const taskId = (
      await db.task.create({
        data: { id: uuidv7(), workspaceId: workspace.id, createdById: user.id, status: 'running' },
        select: { id: true },
      })
    ).id
    await dbModule.attachMentionedArtifacts(db, { taskId, artifactIds: [made.id] })
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
    const long = Array.from({ length: 12 }, (_, at) => `<p>Строка ${at + 1}</p>`).join('')
    const wrote = await tools.edit(scope, {
      artifactId: made.id,
      opId: `picture-${randomUUID()}`,
      ops: [
        {
          op: 'insert',
          block: 'tall',
          after: 'story',
          kind: 'frame',
          props: { name: 'Баннер', size: 'banner' },
        },
        {
          op: 'insert',
          block: 'tall-html',
          after: null,
          parent: 'tall',
          kind: 'html',
          content: `<section class="picture" style="height:auto"><h1>Всё сразу</h1>${long}</section>`,
        },
      ],
    })
    check('the agent writes a picture of its own', wrote.ok, JSON.stringify(wrote))
    const told = await tools.layout(scope, { artifactId: made.id, frame: 'tall' })
    check(
      'artifact_layout names a picture taller than its size first',
      told.ok && /^The picture is \d+ px tall, over its 630/.test(told.value.report),
      JSON.stringify(told).slice(0, 300),
    )

    // A thumbnail each, in the width of its size.
    const thumbs = new ArtifactThumbs({
      db,
      storage: bucket,
      render: (request) => renderer.render(request),
    })
    const drawn = await thumbs.draw(made.id)
    check('core draws a thumbnail a picture', drawn >= 2, String(drawn))

    // 88.26б — the PNG of the story in its very size.
    const exports = new ArtifactExports({
      db,
      storage: bucket,
      render: (request) => renderer.render(request),
    })
    const row = await db.artifactExport.create({
      data: { artifactId: made.id, userId: user.id, format: 'png', blockKey: 'story' },
    })
    const built = await exports.build(row.id)
    const done = await db.artifactExport.findUniqueOrThrow({ where: { id: row.id } })
    const bytes = done.objectKey ? bucket.objects.get(done.objectKey) : undefined
    // The size of a PNG is in its IHDR: width and height, big-endian, at bytes 16 and 20.
    check(
      'the PNG of the story is 1080×1920, a real PNG',
      built === 'ready' &&
        bytes?.subarray(1, 4).toString('latin1') === 'PNG' &&
        bytes.readUInt32BE(16) === 1080 &&
        bytes.readUInt32BE(20) === 1920,
      bytes ? `${bytes.readUInt32BE(16)}×${bytes.readUInt32BE(20)}` : built,
    )
  } finally {
    await pool.close()
    await db.$disconnect()
  }
}
