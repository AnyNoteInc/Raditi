import {
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
  type PagesAddress,
} from '@repo/domain'
import { artifactForbidden, artifactKindSpecOf, artifactNotFound } from '@repo/domain/artifacts'

// The bridge from an artifact to pages (docs/plan/88-artifacts.md, Ар2, Ар23, §7.10; slice 88.11б):
// «Опубликовать как страницу» of a document — only its owner, in the owner's workspace. What goes
// out is a version: the one chosen, or the current one (made now when there is none yet), drawn as
// a page for reading. The document has its one page (as the documents of plan 69): publishing again
// is «Обновить страницу» — the next version of that page. `artifact_publications` says which
// version of the artifact the page shows.

const encode = (text: string) => new TextEncoder().encode(text)

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
  if (artifactKindSpecOf(artifact.kind)?.publish !== 'reading-page')
    throw new DomainError('ARTIFACT_KIND_REFUSED', 'This kind is not published as a page yet', 409)
  return artifact
}

export async function publishArtifactPage(
  db: PrismaClient,
  address: PagesAddress,
  input: { artifactId: string; userId: string; versionNo: number | null },
): Promise<{ pageId: string; url: string; version: number; versionNo: number }> {
  const artifact = await ownedDocument(db, input.artifactId, input.userId)
  const actor = { kind: 'user' as const, userId: input.userId }
  const versionNo =
    input.versionNo ??
    (artifact.currentVersion > 0
      ? artifact.currentVersion
      : (await saveArtifactVersion(db, { artifactId: artifact.id, actor })).no)
  const version = await readArtifactVersion(db, { artifactId: artifact.id, no: versionNo, actor })
  if (version.markdown === null)
    throw new DomainError('DOC_NOT_READY', 'The version has no text to publish', 409)
  const bytes = encode(await readingPage({ title: artifact.title, markdown: version.markdown }))
  const verdict = checkPageContent(bytes)
  if (!verdict.ok) throw pageContentRefused(verdict.reason)
  const page = await publishClientPage(db, {
    workspaceId: artifact.workspaceId,
    taskId: null,
    title: artifact.title,
    target: { documentId: artifact.id },
    bytes,
    markdown: encode(version.markdown),
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
