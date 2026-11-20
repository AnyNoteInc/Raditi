import {
  artifactFilesByIds,
  artifactRole,
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
  artifactFrameDocument,
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
  const publish = artifactKindSpecOf(artifact.kind)?.publish
  if (publish !== 'reading-page' && publish !== 'html')
    throw new DomainError('ARTIFACT_KIND_REFUSED', 'This kind is not published as a page yet', 409)
  return { ...artifact, publish }
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
async function mockupPage(
  db: PrismaClient,
  storage: () => Pick<ObjectStorage, 'get'>,
  input: {
    artifactId: string
    title: string
    blocks: readonly {
      key: string
      kind: string | null
      parent: string | null
      rank: string | null
      content: string | null
    }[]
  },
) {
  const top = input.blocks
    .filter((block) => block.parent === null && block.content !== null)
    .toSorted((a, b) =>
      (a.rank ?? '') < (b.rank ?? '') ? -1 : (a.rank ?? '') > (b.rank ?? '') ? 1 : 0,
    )
  const of = (kind: string) =>
    top.filter((block) => block.kind === kind).map((block) => block.content!)
  const ids = new Set(top.flatMap((block) => artifactFileRefsOf(block.content!)))
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
    platformCss: '',
    bridge: false,
    parts: {
      html: of('html').map(addressed),
      style: of('style').map(addressed),
      script: of('script'),
      settings: of('settings')[0] ?? null,
    },
  })
  return { bytes: encode(html), files: copied }
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
  let bytes: Uint8Array
  let markdown: string | null = null
  let files: { path: string; bytes: Uint8Array }[] = []
  if (artifact.publish === 'html') {
    if (storage === undefined) throw new DomainError('PAGES_UNAVAILABLE', 'No storage here', 503)
    ;({ bytes, files } = await mockupPage(db, storage, {
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

/** The page an artifact became, for its head (Ар2): its address and the version it shows. */
export async function artifactPublicationOf(
  db: PrismaClient,
  address: PagesAddress | null,
  input: { artifactId: string; userId: string },
): Promise<{ pageId: string; url: string | null; versionNo: number; current: boolean } | null> {
  const role = await artifactRole(db, input)
  if (role === null) throw artifactNotFound()
  const row = await db.artifactPublication.findFirst({
    where: { artifactId: input.artifactId, blockKey: null, page: { deletedAt: null } },
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
