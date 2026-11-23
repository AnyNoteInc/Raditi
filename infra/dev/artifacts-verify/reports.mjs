// «Отчёт» as a PDF on a Chromium of this machine (docs/plan/88-artifacts.md, §7.13, slice 88.32),
// part of `pnpm verify:artifacts`. The report of the template «Отчёт о продажах» through core's
// export and the printer of apps/browser (PrintService on the render pool): a real A4 PDF with the
// fonts of the platform, its charts inline; the page itself carries no script and loads nothing.

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
  }
}

export async function reportsOnChromium({ root, databaseUrl, check }) {
  const dbModule = await import(resolve(root, 'packages/db/src/index.ts'))
  const { createPlaywrightFrameRenderer } = await import(
    resolve(root, 'packages/browser-providers/src/render/index.ts')
  )
  const { RenderPool } = await import(resolve(root, 'apps/browser/src/render/render-pool.ts'))
  const { PrintService } = await import(resolve(root, 'apps/browser/src/render/print-service.ts'))
  const { ArtifactExports } = await import(
    resolve(root, 'apps/core/src/artifact-exports/artifact-exports.ts')
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
    const printer = new PrintService(pool)
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic reports', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
    const made = await createGalleryArtifact(db, {
      userId: user.id,
      appEnv: 'development',
      kind: 'report',
      title: 'Отчёт о продажах',
      projectId: null,
      templateId: 'sales-report',
    })

    let page = ''
    const exports = new ArtifactExports({
      db,
      storage: bucket,
      print: (request) => {
        page = request.html
        return printer.print(request)
      },
    })
    const row = await db.artifactExport.create({
      data: { artifactId: made.id, userId: user.id, format: 'pdf' },
    })
    const started = Date.now()
    const built = await exports.build(row.id)
    const ms = Date.now() - started
    const done = await db.artifactExport.findUniqueOrThrow({ where: { id: row.id } })
    const bytes = done.objectKey ? bucket.objects.get(done.objectKey) : undefined
    const text = bytes?.toString('latin1') ?? ''
    const pages = text.match(/\/Type\s*\/Page[^s]/g)?.length ?? 0
    const box = /\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/.exec(text)
    check(
      'core prints the report into a real A4 PDF',
      built === 'ready' &&
        text.startsWith('%PDF-') &&
        pages >= 1 &&
        Math.abs(Number(box?.[1]) - 595) < 2 &&
        Math.abs(Number(box?.[2]) - 842) < 2,
      `${built}, ${pages} pages, ${bytes?.byteLength ?? 0} bytes, ${ms} ms`,
    )
    check(
      'the PDF carries Golos Text, the font of the platform the printer serves',
      /GolosText/.test(text),
      /\/BaseFont\s*\/[^\s/]+/.exec(text)?.[0] ?? 'no font',
    )
    check(
      'the printed page has its charts inline, no script and nothing to load',
      /<img src="data:image\/svg\+xml;base64,/.test(page) &&
        !/<script/i.test(page) &&
        !/(?:src|href)="(?:https?:)?\/\//i.test(page),
      `${page.length} characters`,
    )
  } finally {
    await pool.close()
    await db.$disconnect()
  }
}
