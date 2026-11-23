import { createHash } from 'node:crypto'

import {
  artifactFilesByIds,
  artifactRole,
  projectBrandOf,
  publishClientPage,
  readArtifactVersion,
  saveArtifactVersion,
  type PrismaClient,
  artifactDiagramOf,
} from '@repo/db'
import { diagramPage, readingPage, reportPage } from '@repo/doc-render'
import { reportPartsOf } from '@repo/doc-render/report'
import {
  checkPageContent,
  DomainError,
  pageAddressUrl,
  pageContentRefused,
  type ObjectStorage,
  type PagesAddress,
} from '@repo/domain'
import {
  artifactFileRefsOf,
  artifactForbidden,
  artifactFrameBlocksOf,
  artifactFrameDocument,
  brandCss,
  brandTokensOf,
  canvasLegacyHome,
  canvasPublishedScreens,
  canvasSegmentOf,
  artifactKindSpecOf,
  artifactNotFound,
  tableMarkdown,
  tableOfBlocks,
  withArtifactFileAddresses,
  artifactSlidesOf,
} from '@repo/domain/artifacts'

// The bridge from an artifact to pages (docs/plan/88-artifacts.md, Ар2, Ар23, §7.10; slice 88.11б):
// «Опубликовать как страницу» of a document — only its owner, in the owner's workspace. What goes
// out is a version: the one chosen, or the current one (made now when there is none yet), drawn as
// a page for reading. The document has its one page (as the documents of plan 69): publishing again
// is «Обновить страницу» — the next version of that page. `artifact_publications` says which
// version of the artifact the page shows.

const encode = (text: string) => new TextEncoder().encode(text)

/**
 * A version of a table drawn as Markdown for a page to read (slice 88.14): its columns and rows as
 * a table of Markdown; null — the version holds no table.
 */
function markdownOfTable(
  blocks: readonly { key: string; kind: string | null; rev: number; content: string | null }[],
): string | null {
  const table = tableOfBlocks(
    blocks.flatMap((block) => (block.kind === null ? [] : [{ ...block, kind: block.kind }])),
  )
  return table.columnsKey === null ? null : `${tableMarkdown(table.columns, table.rows)}\n`
}

async function projectOf(db: PrismaClient, artifactId: string): Promise<string | null> {
  return (
    (await db.artifact.findUnique({ where: { id: artifactId }, select: { projectId: true } }))
      ?.projectId ?? null
  )
}

async function ownedDocument(db: PrismaClient, artifactId: string, userId: string) {
  const role = await artifactRole(db, { artifactId, userId })
  if (role === null) throw artifactNotFound()
  if (role !== 'owner') throw artifactForbidden()
  const artifact = await db.artifact.findUniqueOrThrow({
    where: { id: artifactId },
    select: {
      id: true,
      workspaceId: true,
      kind: true,
      title: true,
      currentVersion: true,
      seq: true,
    },
  })
  const spec = artifactKindSpecOf(artifact.kind)
  const publish = spec?.publish
  if (publish !== 'reading-page' && publish !== 'html' && publish !== 'site')
    throw new DomainError('ARTIFACT_KIND_REFUSED', 'This kind is not published as a page yet', 409)
  return {
    ...artifact,
    publish,
    framed: spec?.framed === true,
    projectId: await projectOf(db, artifactId),
  }
}

const extensionOf = (type: string) =>
  (
    ({
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/avif': 'avif',
      'image/svg+xml': 'svg',
      'font/woff2': 'woff2',
      'font/woff': 'woff',
    }) as Record<string, string>
  )[type] ?? 'bin'

/**
 * A version of a mockup as the HTML of a published page (§7.10): its parts assembled as the frame
 * does — without the bridge — and the files it names copied into the shared files of the site
 * (`/_files/a/<id>.<ext>`, Дер34), the references rewritten to them: the preview and the page load
 * the same bytes.
 */
interface VersionBlock {
  key: string
  kind: string | null
  parent: string | null
  rank: string | null
  content: string | null
}

async function mockupPage(
  db: PrismaClient,
  storage: () => Pick<ObjectStorage, 'get'>,
  input: {
    artifactId: string
    title: string
    blocks: readonly VersionBlock[]
    /** A framed kind (a canvas): the screen it publishes; null — a mockup. */
    framed: boolean
    frame: string | null
    /** The CSS variables of the project's brand (slice 88.15а). */
    brandCss: string
  },
) {
  const sorted = input.blocks
    .flatMap((block) => (block.kind === null ? [] : [{ ...block, kind: block.kind }]))
    .toSorted((a, b) =>
      (a.rank ?? '') < (b.rank ?? '') ? -1 : (a.rank ?? '') > (b.rank ?? '') ? 1 : 0,
    )
  // The one assembly of a frame, as `/v/` and the renderer have it (§7.2).
  const parts = artifactFrameBlocksOf({ framed: input.framed, blocks: sorted, frame: input.frame })
  if (parts === null) throw artifactNotFound()
  const used = [
    ...parts.html,
    ...parts.style,
    ...parts.script,
    ...(parts.settings ? [parts.settings] : []),
  ]
  const of = (list: readonly { content: string | null }[]) => list.map((block) => block.content!)
  const ids = new Set(used.flatMap((block) => artifactFileRefsOf(block.content!)))
  const files = await artifactFilesByIds(db, { artifactId: input.artifactId, ids: [...ids] })
  const paths = new Map<string, string>()
  const copied: { path: string; bytes: Uint8Array }[] = []
  for (const file of files) {
    const object = await storage().get('artifacts', file.objectKey)
    if (object === null) continue
    const chunks: Uint8Array[] = []
    for await (const chunk of object) chunks.push(chunk)
    const path = `/_files/a/${file.id}.${extensionOf(file.contentType)}`
    paths.set(file.id, path)
    copied.push({ path, bytes: Buffer.concat(chunks) })
  }
  const addressed = (text: string) => withArtifactFileAddresses(text, (id) => paths.get(id) ?? null)
  const html = artifactFrameDocument({
    title: input.title,
    platformCss: input.brandCss,
    bridge: false,
    parts: {
      html: of(parts.html).map(addressed),
      style: of(parts.style).map(addressed),
      script: of(parts.script),
      settings: parts.settings?.content ?? null,
    },
  })
  return { bytes: encode(html), files: copied }
}

/**
 * A version of «Схема» as a page (§7.10, 88.24в): each diagram block by the picture kept of its text
 * — the SVG the server drew and cleaned — copied into the files of the site. A text without a drawn
 * picture is not published: the client sees why.
 */
async function diagramPublication(
  db: PrismaClient,
  input: { artifactId: string; title: string; blocks: readonly VersionBlock[] },
) {
  const diagrams = input.blocks
    .filter((block) => block.kind === 'diagram' && block.content && block.content.trim() !== '')
    .toSorted((a, b) =>
      (a.rank ?? '') < (b.rank ?? '') ? -1 : (a.rank ?? '') > (b.rank ?? '') ? 1 : 0,
    )
  if (diagrams.length === 0)
    throw new DomainError('DOC_NOT_READY', 'The version has no diagram to publish', 409)
  const files: { path: string; bytes: Uint8Array }[] = []
  const pictures: { src: string; width: number; height: number }[] = []
  for (const block of diagrams) {
    const kept = await artifactDiagramOf(db, {
      artifactId: input.artifactId,
      source: block.content!,
    })
    if (!kept?.ok || !kept.svg || !kept.width || !kept.height)
      throw new DomainError(
        'ARTIFACT_DIAGRAM_NOT_DRAWN',
        'A diagram of the version is not drawn',
        409,
      )
    const path = `/_files/a/d-${kept.sourceSha256.slice(0, 32)}.svg`
    if (!files.some((file) => file.path === path)) files.push({ path, bytes: encode(kept.svg) })
    pictures.push({ src: path, width: kept.width, height: kept.height })
  }
  return { bytes: encode(await diagramPage({ title: input.title, pictures })), files }
}

/**
 * A version of «Отчёт» as a page (§7.10, 88.28): its sections, its charts drawn on the server — files
 * of the site —, its table, in the order of the blocks. A chart whose spec does not parse is left
 * out of the page rather than shown broken.
 */
async function reportPublication(input: { title: string; blocks: readonly VersionBlock[] }) {
  const ordered = input.blocks
    .filter((block) => block.parent === null && block.kind !== null)
    .toSorted((a, b) =>
      (a.rank ?? '') < (b.rank ?? '') ? -1 : (a.rank ?? '') > (b.rank ?? '') ? 1 : 0,
    )
  if (ordered.length === 0)
    throw new DomainError('DOC_NOT_READY', 'The version has no text to publish', 409)
  const files: { path: string; bytes: Uint8Array }[] = []
  const parts = reportPartsOf(
    ordered.map((block) => ({
      key: block.key,
      kind: block.kind!,
      content: block.content,
      props: (block as { props?: Record<string, unknown> }).props ?? null,
    })),
    (picture) => {
      const path = `/_files/a/c-${createHash('sha256').update(picture.svg).digest('hex').slice(0, 32)}.svg`
      if (!files.some((file) => file.path === path))
        files.push({ path, bytes: encode(picture.svg) })
      return path
    },
  )
  return { bytes: encode(await reportPage({ title: input.title, parts })), files }
}

/** The CSS variables of the brand of the artifact's project; '' — none (slice 88.15а). */
async function brandCssOf(db: PrismaClient, projectId: string | null): Promise<string> {
  const brand = await projectBrandOf(db, projectId)
  return brand ? brandCss(brandTokensOf(brand.settings)) : ''
}

export async function publishArtifactPage(
  db: PrismaClient,
  address: PagesAddress,
  input: { artifactId: string; userId: string; versionNo: number | null },
  /** The artifacts bucket, made only when a mockup names files: a document needs none. */
  storage?: () => Pick<ObjectStorage, 'get'>,
): Promise<{ pageId: string; url: string; version: number; versionNo: number }> {
  const artifact = await ownedDocument(db, input.artifactId, input.userId)
  const actor = { kind: 'user' as const, userId: input.userId }
  const versionNo =
    input.versionNo ??
    (artifact.currentVersion > 0
      ? artifact.currentVersion
      : (await saveArtifactVersion(db, { artifactId: artifact.id, actor })).no)
  const version = await readArtifactVersion(db, { artifactId: artifact.id, no: versionNo, actor })
  if (artifact.publish === 'site') {
    if (storage === undefined) throw new DomainError('PAGES_UNAVAILABLE', 'No storage here', 503)
    if (artifact.kind === 'slides')
      return publishSlidesSite(db, address, storage, {
        artifact,
        versionNo,
        blocks: version.blocks,
      })
    return publishCanvasSite(db, address, storage, {
      artifact,
      actor,
      versionNo,
      blocks: version.blocks,
    })
  }
  let bytes: Uint8Array
  let markdown: string | null = null
  let files: { path: string; bytes: Uint8Array }[] = []
  if (artifact.publish === 'html') {
    if (storage === undefined) throw new DomainError('PAGES_UNAVAILABLE', 'No storage here', 503)
    ;({ bytes, files } = await mockupPage(db, storage, {
      artifactId: artifact.id,
      title: artifact.title,
      blocks: version.blocks,
      framed: false,
      frame: null,
      brandCss: await brandCssOf(db, artifact.projectId),
    }))
  } else if (artifact.kind === 'report') {
    ;({ bytes, files } = await reportPublication({ title: artifact.title, blocks: version.blocks }))
  } else if (artifact.kind === 'diagram') {
    ;({ bytes, files } = await diagramPublication(db, {
      artifactId: artifact.id,
      title: artifact.title,
      blocks: version.blocks,
    }))
  } else {
    markdown = version.markdown ?? markdownOfTable(version.blocks)
    if (markdown === null)
      throw new DomainError('DOC_NOT_READY', 'The version has no text to publish', 409)
    bytes = encode(await readingPage({ title: artifact.title, markdown }))
  }
  const verdict = checkPageContent(bytes)
  if (!verdict.ok) throw pageContentRefused(verdict.reason)
  const page = await publishClientPage(db, {
    workspaceId: artifact.workspaceId,
    taskId: null,
    title: artifact.title,
    target: { documentId: artifact.id },
    bytes,
    markdown: markdown === null ? null : encode(markdown),
    html: artifact.publish === 'html',
    files,
  })
  await db.artifactPublication.upsert({
    where: { pageId: page.pageId },
    create: { artifactId: artifact.id, pageId: page.pageId, seq: artifact.seq, versionNo },
    update: { seq: artifact.seq, versionNo, publishedAt: new Date() },
  })
  return {
    pageId: page.pageId,
    url: pageAddressUrl(page.slug, address, page.path),
    version: page.version,
    versionNo,
  }
}

type CanvasVersionBlock = VersionBlock & { rev: number; props: Readonly<Record<string, unknown>> }

function orderedLiveBlocks(blocks: readonly CanvasVersionBlock[]) {
  return blocks
    .flatMap((block) => (block.kind === null ? [] : [{ ...block, kind: block.kind }]))
    .toSorted((a, b) =>
      (a.rank ?? '') < (b.rank ?? '') ? -1 : (a.rank ?? '') > (b.rank ?? '') ? 1 : 0,
    )
}

/**
 * «Опубликовать как сайт» (Ар8, §7.10): one page per screen, showing its selected variant. The
 * first publication picks a home; updates keep its screen and the other pages by their frames.
 */
async function publishCanvasSite(
  db: PrismaClient,
  address: PagesAddress,
  storage: () => Pick<ObjectStorage, 'get'>,
  input: {
    artifact: Awaited<ReturnType<typeof ownedDocument>>
    actor: { kind: 'user'; userId: string }
    versionNo: number
    blocks: readonly CanvasVersionBlock[]
  },
): Promise<{ pageId: string; url: string; version: number; versionNo: number }> {
  const { artifact, actor, versionNo } = input
  const screens = canvasPublishedScreens(orderedLiveBlocks(input.blocks)).toSorted(
    (a, b) => Number(b.path === '/') - Number(a.path === '/'),
  )
  if (screens.length === 0)
    throw new DomainError('DOC_NOT_READY', 'The canvas has no screen to publish', 409)
  const css = await brandCssOf(db, artifact.projectId)
  const previous = await db.artifactPublication.findMany({
    where: { artifactId: artifact.id, page: { deletedAt: null } },
    select: {
      pageId: true,
      blockKey: true,
      versionNo: true,
      page: { select: { currentVersion: true, treeId: true, path: true, documentId: true } },
    },
    orderBy: [{ page: { createdAt: 'asc' } }, { pageId: 'asc' }],
  })
  const previousHome = previous.find((row) => row.page.documentId === artifact.id)
  const children = previous.filter(
    (row) => row.page.treeId === previousHome?.page.treeId && row.page.documentId === null,
  )
  type Screen = (typeof screens)[number]
  const byFrame = new Map(
    screens.flatMap((screen) => screen.frameKeys.map((key) => [key, screen] as const)),
  )
  const snapshots = new Map<number, ReturnType<typeof orderedLiveBlocks>>()
  const snapshot = async (no: number) => {
    const cached = snapshots.get(no)
    if (cached) return cached
    // Unnamed versions may have aged out.
    const exists = await db.artifactVersion.findUnique({
      where: { documentId_no: { documentId: artifact.id, no } },
      select: { id: true },
    })
    const saved = exists
      ? orderedLiveBlocks(
          (await readArtifactVersion(db, { artifactId: artifact.id, no, actor })).blocks,
        )
      : []
    snapshots.set(no, saved)
    return saved
  }
  const screenOf = async (row: (typeof previous)[number]) => {
    const key = row.blockKey
    const direct = key === null ? undefined : byFrame.get(key)
    if (direct) return direct
    const saved = await snapshot(row.versionNo)
    // Older home publications had no frame key. Replay the old selection on the saved version.
    const priorKeys =
      key === null
        ? canvasLegacyHome(saved)
        : canvasPublishedScreens(saved).find((screen) => screen.frameKeys.includes(key))?.frameKeys
    return priorKeys?.map((frame) => byFrame.get(frame)).find((screen) => screen !== undefined)
  }
  const knownChildren = new Map<Screen, (typeof children)[number]>()
  for (const child of children) {
    const screen = await screenOf(child)
    if (screen && !knownChildren.has(screen)) knownChildren.set(screen, child)
  }
  const home =
    (previousHome && (await screenOf(previousHome))) ??
    screens.find((screen) => !knownChildren.has(screen)) ??
    screens[0]!
  const usedPaths = new Set(['/', ...children.map((child) => child.page.path)])
  let first: Awaited<ReturnType<typeof publishClientPage>> | null = null
  for (const screen of [home, ...screens.filter((screen) => screen !== home)]) {
    const page = await mockupPage(db, storage, {
      artifactId: artifact.id,
      title: `${artifact.title} — ${screen.name}`,
      blocks: input.blocks,
      framed: true,
      frame: screen.key,
      brandCss: css,
    })
    const verdict = checkPageContent(page.bytes)
    if (!verdict.ok) throw pageContentRefused(verdict.reason)
    const isHome = screen === home
    const known = isHome ? undefined : knownChildren.get(screen)
    const basePath = screen.path === '/' ? `/${canvasSegmentOf(screen.name)}` : screen.path
    let path = known?.page.path ?? basePath
    if (!isHome && !known) {
      for (let n = 2; usedPaths.has(path); n += 1) path = `${basePath}-${n}`
      usedPaths.add(path)
    }
    const published = await publishClientPage(db, {
      workspaceId: artifact.workspaceId,
      taskId: null,
      title: isHome ? artifact.title : screen.name,
      target: isHome ? { documentId: artifact.id } : { fileName: `${path.slice(1)}.html` },
      ...(isHome
        ? {}
        : known
          ? { into: { pageId: known.pageId, expectedVersion: known.page.currentVersion } }
          : { place: { treeId: first!.treeId, path } }),
      bytes: page.bytes,
      html: true,
      files: page.files,
    })
    if (isHome) first = published
    await db.artifactPublication.upsert({
      where: { pageId: published.pageId },
      create: {
        artifactId: artifact.id,
        pageId: published.pageId,
        blockKey: screen.key,
        seq: artifact.seq,
        versionNo,
      },
      update: { blockKey: screen.key, seq: artifact.seq, versionNo, publishedAt: new Date() },
    })
  }
  return {
    pageId: first!.pageId,
    url: pageAddressUrl(first!.slug, address, first!.path),
    version: first!.version,
    versionNo,
  }
}

/**
 * What a published slide adds to its page (88.25в): the slide fitted to the window, a line with its
 * number and the links to its neighbours — they work without the script —, and the arrows, the space
 * and PageUp / PageDown of the keyboard. The paths are the platform's own (`/`, `/2`…).
 */
export function slideDeckChrome(input: {
  at: number
  all: number
  previous: string | null
  next: string | null
}): string {
  const link = (href: string | null, rel: 'prev' | 'next', text: string, label: string) =>
    href === null
      ? `<span aria-hidden="true" style="opacity:.3">${text}</span>`
      : `<a href="${href}" rel="${rel}" aria-label="${label}" style="color:#fff;text-decoration:none">${text}</a>`
  return [
    '<nav aria-label="Слайды" style="position:fixed;right:16px;bottom:12px;z-index:2147483647;display:flex;gap:12px;align-items:center;padding:6px 12px;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;font:14px/1.2 Arial,sans-serif">',
    link(input.previous, 'prev', '←', 'Предыдущий слайд'),
    `<span>${input.at} из ${input.all}</span>`,
    link(input.next, 'next', '→', 'Следующий слайд'),
    '</nav>',
    '<script>(()=>{const fit=()=>{document.documentElement.style.zoom=String(Math.min(innerWidth/1280,innerHeight/720))};fit();addEventListener("resize",fit);addEventListener("keydown",(e)=>{const rel=e.key==="ArrowRight"||e.key===" "||e.key==="PageDown"?"next":e.key==="ArrowLeft"||e.key==="PageUp"?"prev":null;const a=rel&&document.querySelector("a[rel="+rel+"]");if(a){e.preventDefault();location.href=a.getAttribute("href")}})})()</script>',
  ].join('')
}

/**
 * «Презентация» as a site (88.25в): each slide a page of 1280×720 by the one assembly of a frame —
 * the first at the root, the others at `/2`, `/3`… —, with the chrome of the deck; a republication
 * keeps the pages of the slides it published before, by their frames.
 */
async function publishSlidesSite(
  db: PrismaClient,
  address: PagesAddress,
  storage: () => Pick<ObjectStorage, 'get'>,
  input: {
    artifact: Awaited<ReturnType<typeof ownedDocument>>
    versionNo: number
    blocks: readonly CanvasVersionBlock[]
  },
): Promise<{ pageId: string; url: string; version: number; versionNo: number }> {
  const { artifact, versionNo } = input
  const slides = artifactSlidesOf(orderedLiveBlocks(input.blocks))
  if (slides.length === 0)
    throw new DomainError('DOC_NOT_READY', 'The presentation has no slide to publish', 409)
  const css = await brandCssOf(db, artifact.projectId)
  const previous = await db.artifactPublication.findMany({
    where: { artifactId: artifact.id, page: { deletedAt: null } },
    select: {
      pageId: true,
      blockKey: true,
      page: { select: { currentVersion: true, treeId: true, path: true, documentId: true } },
    },
  })
  const home = previous.find((row) => row.page.documentId === artifact.id)
  const children = new Map(
    previous
      .filter((row) => row.page.treeId === home?.page.treeId && row.page.documentId === null)
      .flatMap((row) => (row.blockKey === null ? [] : [[row.blockKey, row] as const])),
  )
  // The paths first: each page links to its neighbours.
  const used = new Set(['/', ...[...children.values()].map((row) => row.page.path)])
  const plan = slides.map((slide, index) => {
    if (index === 0) return { slide, known: undefined, path: '/' }
    const known = children.get(slide.key)
    let path = known?.page.path ?? `/${index + 1}`
    if (!known) {
      for (let n = 2; used.has(path); n += 1) path = `/${index + 1}-${n}`
      used.add(path)
    }
    return { slide, known, path }
  })
  let first: Awaited<ReturnType<typeof publishClientPage>> | null = null
  for (const [index, { slide, known, path }] of plan.entries()) {
    const page = await mockupPage(db, storage, {
      artifactId: artifact.id,
      title: `${artifact.title} — ${slide.name}`,
      blocks: input.blocks,
      framed: true,
      frame: slide.key,
      brandCss: css,
    })
    const html = new TextDecoder().decode(page.bytes)
    const end = html.lastIndexOf('</body>')
    const chrome = slideDeckChrome({
      at: index + 1,
      all: plan.length,
      previous: plan[index - 1]?.path ?? null,
      next: plan[index + 1]?.path ?? null,
    })
    const bytes = encode(end < 0 ? html + chrome : html.slice(0, end) + chrome + html.slice(end))
    const verdict = checkPageContent(bytes)
    if (!verdict.ok) throw pageContentRefused(verdict.reason)
    const isHome = index === 0
    const published = await publishClientPage(db, {
      workspaceId: artifact.workspaceId,
      taskId: null,
      title: isHome ? artifact.title : slide.name,
      target: isHome ? { documentId: artifact.id } : { fileName: `${path.slice(1)}.html` },
      ...(isHome
        ? {}
        : known
          ? { into: { pageId: known.pageId, expectedVersion: known.page.currentVersion } }
          : { place: { treeId: first!.treeId, path } }),
      bytes,
      html: true,
      files: page.files,
    })
    if (isHome) first = published
    await db.artifactPublication.upsert({
      where: { pageId: published.pageId },
      create: {
        artifactId: artifact.id,
        pageId: published.pageId,
        blockKey: slide.key,
        seq: artifact.seq,
        versionNo,
      },
      update: { blockKey: slide.key, seq: artifact.seq, versionNo, publishedAt: new Date() },
    })
  }
  return {
    pageId: first!.pageId,
    url: pageAddressUrl(first!.slug, address, first!.path),
    version: first!.version,
    versionNo,
  }
}

/** The page an artifact became, for its head (Ар2): its address and the version it shows. */
export async function artifactPublicationOf(
  db: PrismaClient,
  address: PagesAddress | null,
  input: { artifactId: string; userId: string },
): Promise<{ pageId: string; url: string | null; versionNo: number; current: boolean } | null> {
  const role = await artifactRole(db, input)
  if (role === null) throw artifactNotFound()
  const row = await db.artifactPublication.findFirst({
    where: {
      artifactId: input.artifactId,
      page: { deletedAt: null, documentId: input.artifactId },
    },
    orderBy: { publishedAt: 'desc' },
    select: {
      pageId: true,
      versionNo: true,
      artifact: { select: { currentVersion: true } },
      page: { select: { path: true, state: true, tree: { select: { slug: true, name: true } } } },
    },
  })
  if (!row) return null
  return {
    pageId: row.pageId,
    url:
      address !== null && row.page.state === 'live'
        ? pageAddressUrl(row.page.tree.name ?? row.page.tree.slug, address, row.page.path)
        : null,
    versionNo: row.versionNo,
    current: row.versionNo === row.artifact.currentVersion,
  }
}
