import {
  artifactFilesByIds,
  artifactRole,
  projectBrandOf,
  publishClientPage,
  readArtifactVersion,
  saveArtifactVersion,
  type PrismaClient,
} from '@repo/db'
import { readingPage } from '@repo/doc-render'
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
