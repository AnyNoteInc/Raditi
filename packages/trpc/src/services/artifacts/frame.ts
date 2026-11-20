import { createHash } from 'node:crypto'

import {
  artifactFileFor,
  artifactFilesByIds,
  artifactRole,
  createArtifact,
  listArtifactFiles,
  readArtifact,
  startArtifactFileUpload,
  type ArtifactFileRow,
  type PrismaClient,
} from '@repo/db'
import {
  artifactEditCopy,
  artifactImportOf,
  patchArtifactText,
  stampArtifactHtml,
  type ArtifactTextPatchRefusal,
} from '@repo/doc-bridge'
import { checkPageContent, DomainError, type ObjectStorage } from '@repo/domain'
import {
  artifactFileRef,
  artifactFileRefsOf,
  artifactFrameDocument,
  artifactImportKindOf,
  artifactKindCreatable,
  artifactKindRefused,
  artifactKindSpecOf,
  artifactLimits,
  artifactNotFound,
  artifactOpInvalid,
  withArtifactFileAddresses,
  type ArtifactFrameSources,
  type ArtifactOp,
} from '@repo/domain/artifacts'

import type { ChatContext } from '../chat/context.ts'
import { pagesUnavailable } from '../chat/documents.ts'
import { readChatFile } from '../chat/files.ts'
import {
  PAGE_VIEW_TTL_MS,
  readArtifactToken,
  signArtifactToken,
  type ArtifactTokenLabel,
} from '../chat/page-tokens.ts'
import { accessibleTask } from '../chat/access.ts'
import { applyCabinetOps } from './editor.ts'

// The frame of an artifact (docs/plan/88-artifacts.md, Ар9, Ар12, Ар28, §7.7; slices 88.12 and
// 88.13). The cabinet gets an address of five minutes for this viewer: `/v/<token>` on the root of
// the domain of pages for the frame that runs the mockup, `/api/artifact-frame/<token>` on its own
// origin for the edit frame that runs nothing. Each GET reads the role again and assembles the
// document of the frame from the checked blocks; each file it names gets a signed address of its
// own, bound to the viewer, and the policy of the frame names exactly those addresses.

type Pages = NonNullable<ChatContext['pageViews']>

/** The fonts of the platform a frame loads (Ар30): their CSS with absolute addresses, and these. */
export interface ArtifactPlatformFonts {
  css: string
  urls: readonly string[]
}

function pagesOf(chat: ChatContext | null): Pages {
  if (!chat?.pageViews) throw pagesUnavailable()
  return chat.pageViews
}

async function frameRole(db: PrismaClient, input: { userId: string; artifactId: string }) {
  const role = await artifactRole(db, input)
  if (role === null) throw artifactNotFound()
  return role
}

/** The address of the frame of a mockup for this viewer (`/v/` on the root of the pages). */
export async function issueArtifactFrame(
  db: PrismaClient,
  chat: ChatContext | null,
  input: { userId: string; artifactId: string; mode: 'view' | 'edit' },
  now = Date.now(),
): Promise<{ url: string; expiresAt: string }> {
  const pages = pagesOf(chat)
  await frameRole(db, input)
  const kind = (
    await db.artifact.findUnique({ where: { id: input.artifactId }, select: { kind: true } })
  )?.kind
  if (artifactKindSpecOf(kind ?? '')?.view !== 'frame') throw artifactNotFound()
  const expiresAt = now + PAGE_VIEW_TTL_MS
  const label: ArtifactTokenLabel = input.mode === 'view' ? 'artifact' : 'aedit'
  const token = signArtifactToken(pages.keys.view, label, {
    artifactId: input.artifactId,
    userId: input.userId,
    expiresAt,
  })
  return {
    url: input.mode === 'view' ? `${pages.origin}/v/${token}` : `/api/artifact-frame/${token}`,
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

export type FrameAnswer =
  | { ok: true; html: string; sources: ArtifactFrameSources; appOrigin: string }
  | { ok: false; status: 404 | 410 }

/**
 * The document of a frame for the token's viewer, the role read now: the checked parts of the
 * mockup, its files by addresses of the root of the pages; in the edit frame — the parts stamped
 * with ids and with links that lead nowhere, without scripts.
 */
export async function serveArtifactFrame(
  db: PrismaClient,
  chat: ChatContext | null,
  input: { token: string; mode: 'view' | 'edit'; fonts: ArtifactPlatformFonts },
  now = Date.now(),
): Promise<FrameAnswer> {
  const pages = pagesOf(chat)
  const read = readArtifactToken(
    pages.keys.view,
    input.mode === 'view' ? 'artifact' : 'aedit',
    input.token,
    now,
  )
  if (read === 'expired') return { ok: false, status: 410 }
  if (read === null) return { ok: false, status: 404 }
  if ((await artifactRole(db, read)) === null) return { ok: false, status: 404 }
  const artifact = await readArtifact(db, {
    artifactId: read.artifactId,
    actor: { kind: 'user', userId: read.userId },
  })
  if (artifactKindSpecOf(artifact.kind)?.view !== 'frame') return { ok: false, status: 404 }
  const top = artifact.blocks.filter((block) => block.parent === null && block.content !== null)
  const text = (kind: string) => top.filter((block) => block.kind === kind)
  const referenced = new Set<string>()
  for (const block of top) for (const id of artifactFileRefsOf(block.content!)) referenced.add(id)
  const files = await artifactFilesByIds(db, { artifactId: artifact.id, ids: [...referenced] })
  const address = new Map<string, string>()
  for (const file of files)
    address.set(
      file.id,
      `${pages.origin}/v/${signArtifactToken(pages.keys.view, 'afile', {
        artifactId: artifact.id,
        fileId: file.id,
        userId: read.userId,
        expiresAt: now + PAGE_VIEW_TTL_MS,
      })}`,
    )
  const addressed = (content: string) =>
    withArtifactFileAddresses(content, (id) => address.get(id) ?? null)
  const html = text('html').map((block) =>
    input.mode === 'edit'
      ? artifactEditCopy(stampArtifactHtml(block.key, addressed(block.content!)))
      : addressed(block.content!),
  )
  const settings = text('settings')[0]?.content ?? null
  const document = artifactFrameDocument({
    title: artifact.title,
    platformCss: input.fonts.css,
    bridge: input.mode === 'view',
    parts: {
      html,
      style: text('style').map((block) => addressed(block.content!)),
      script: input.mode === 'view' ? text('script').map((block) => addressed(block.content!)) : [],
      settings: input.mode === 'view' ? settings : null,
    },
  })
  const fontFiles = files.filter((file) => file.contentType.startsWith('font/'))
  const imageFiles = files.filter((file) => !file.contentType.startsWith('font/'))
  return {
    ok: true,
    html: document,
    appOrigin: new URL(pages.appUrl).origin,
    sources: {
      scripts: [],
      styles: [],
      images: imageFiles.map((file) => address.get(file.id)!),
      fonts: [...input.fonts.urls, ...fontFiles.map((file) => address.get(file.id)!)],
    },
  }
}

/** A file of an artifact by its signed address: the role of its viewer read now (Ар12). */
export async function serveArtifactFile(
  db: PrismaClient,
  chat: ChatContext | null,
  input: { token: string },
  now = Date.now(),
): Promise<{ ok: true; type: string; bytes: Uint8Array } | { ok: false; status: 404 | 410 }> {
  const pages = pagesOf(chat)
  const read = readArtifactToken(pages.keys.view, 'afile', input.token, now)
  if (read === 'expired') return { ok: false, status: 410 }
  if (read === null || read.fileId === undefined) return { ok: false, status: 404 }
  const file = await artifactFileFor(db, { ...read, fileId: read.fileId })
  if (file === null) return { ok: false, status: 404 }
  const object = await chat!.storage().get('artifacts', file.objectKey)
  if (object === null) return { ok: false, status: 404 }
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of object) {
    length += chunk.byteLength
    if (length > file.bytes) return { ok: false, status: 404 }
    chunks.push(chunk)
  }
  return { ok: true, type: file.contentType, bytes: Buffer.concat(chunks, length) }
}

/** Whether a token is one of a file of an artifact (the route of `/v/` tells them apart). */
export function isArtifactFileToken(chat: ChatContext | null, token: string, now = Date.now()) {
  if (!chat?.pageViews) return false
  return readArtifactToken(chat.pageViews.keys.view, 'afile', token, now) !== null
}

/** The viewer a token of the edit frame names; null — none (an expired token too). */
export function readArtifactEditViewer(chat: ChatContext | null, token: string, now = Date.now()) {
  if (!chat?.pageViews) return null
  const read = readArtifactToken(chat.pageViews.keys.view, 'aedit', token, now)
  return read === null || read === 'expired' ? null : read.userId
}

/** Whether a token is one of the frame of an artifact. */
export function isArtifactFrameToken(chat: ChatContext | null, token: string, now = Date.now()) {
  if (!chat?.pageViews) return false
  return readArtifactToken(chat.pageViews.keys.view, 'artifact', token, now) !== null
}

// ---- «Править текст» (Ар9) ----

const patchRefusalTexts: Readonly<Record<ArtifactTextPatchRefusal, string>> = Object.freeze({
  NO_ELEMENT: 'the element is gone: the mockup changed',
  AMBIGUOUS_ID: 'this element is written twice in the HTML: change it in the chat',
  NOT_EDITABLE: 'the text of this element is not edited by hand',
  SHAPE_CHANGED: 'the element changed: the mockup changed',
  NO_SLOT: 'the element changed: the mockup changed',
  TEXT_NOT_IN_PLACE: 'the text of this element stands elsewhere in the HTML: change it in the chat',
  CHECK_FAILED: 'the edit did not fit the HTML: change it in the chat',
})

/**
 * A person's edit of the text of one element in the edit frame: the source of its block patched by
 * the offsets of parse5 and written as a `replace` under the revision the frame showed — plain
 * text, the markup escaped. Refused when the element is not where the frame saw it.
 */
export async function editArtifactText(
  db: PrismaClient,
  input: {
    userId: string
    artifactId: string
    block: string
    ifRev: number
    element: string
    shape: readonly string[]
    edits: readonly { slot: number; text: string }[]
  },
) {
  const artifact = await readArtifact(db, {
    artifactId: input.artifactId,
    actor: { kind: 'user', userId: input.userId },
  })
  const block = artifact.blocks.find((each) => each.key === input.block)
  if (!block || block.kind !== 'html' || block.content === null) throw artifactNotFound()
  if (!input.element.startsWith(`${input.block}.`))
    throw artifactOpInvalid('the element is not of this block')
  const patched = patchArtifactText({
    block: input.block,
    html: block.content,
    id: input.element,
    shape: input.shape,
    edits: input.edits,
  })
  if (!patched.ok)
    throw new DomainError('ARTIFACT_TEXT_REFUSED', patchRefusalTexts[patched.refusal], 409, {
      refusal: patched.refusal,
    })
  return applyCabinetOps(db, {
    userId: input.userId,
    batch: {
      artifactId: input.artifactId,
      opId: `text-${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32)}`,
      ops: [{ op: 'replace', block: input.block, ifRev: input.ifRev, content: patched.html }],
    },
  })
}

// ---- Files (Ар12) ----

const fileView = (file: ArtifactFileRow) => ({
  id: file.id,
  ref: artifactFileRef(file.id),
  name: file.name,
  type: file.contentType,
  bytes: file.bytes,
  createdAt: file.createdAt.toISOString(),
})

export async function cabinetArtifactFiles(
  db: PrismaClient,
  input: { userId: string; artifactId: string },
) {
  return (await listArtifactFiles(db, input)).map(fileView)
}

/** «Загрузить файл»: the row; the bytes come by `PUT /api/artifact-files/<id>`. */
export async function startCabinetArtifactFile(
  db: PrismaClient,
  input: { userId: string; artifactId: string; name: string; sizeBytes: number },
) {
  const row = await startArtifactFileUpload(db, input)
  return {
    fileId: row.id,
    ref: artifactFileRef(row.id),
    uploadUrl: `/api/artifact-files/${row.id}`,
  }
}

// ---- «Открыть как артефакт» (§3, Ар3; slice 88.12) ----

const importBatches = (ops: ArtifactOp[]) => {
  // The cabinet's rows are not counted against 50 operations; other blocks are, and every batch
  // keeps within its JSON.
  const out: ArtifactOp[][] = []
  let batch: ArtifactOp[] = []
  let size = 0
  for (const op of ops) {
    const bytes = Buffer.byteLength(JSON.stringify(op))
    const counted = batch.filter((each) => !(each.op === 'insert' && each.kind === 'row')).length
    if (
      batch.length > 0 &&
      (counted >= artifactLimits.batchOps - 1 ||
        size + bytes > artifactLimits.batchJsonBytes - 4096)
    ) {
      out.push(batch)
      batch = []
      size = 0
    }
    batch.push(op)
    size += bytes
  }
  if (batch.length > 0) out.push(batch)
  return out
}

/**
 * A `.md`, `.html`, `.svg` or `.csv` file of a chat the user may open becomes a new artifact of its
 * kind in the workspace and project of that chat: the person's writes, checked as they are written.
 */
export async function importChatFileAsArtifact(
  db: PrismaClient,
  storage: Pick<ObjectStorage, 'get'>,
  input: { userId: string; taskId: string; fileId: string },
): Promise<{ id: string }> {
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId.toLowerCase()),
    select: {
      id: true,
      workspaceId: true,
      projectId: true,
      project: { select: { createdById: true } },
    },
  })
  if (task === null) throw artifactNotFound()
  const file = await readChatFile(db, storage, { taskId: task.id, fileId: input.fileId })
  if (file === null) throw artifactNotFound()
  const kind = artifactImportKindOf(file.name)
  if (kind === null || !artifactKindCreatable(kind)) throw artifactKindRefused(kind ?? file.name)
  if (file.bytes.byteLength > artifactLimits.importBytes)
    throw artifactOpInvalid('the file is longer than 2 MiB')
  if (!checkPageContent(file.bytes, { maxBytes: artifactLimits.importBytes }).ok)
    throw artifactOpInvalid('the file holds what an artifact may not')
  const imported = artifactImportOf(file.name, new TextDecoder().decode(file.bytes), {
    blockBytes: artifactLimits.blockBytes,
    blocks: artifactLimits.blocks,
    tableRows: artifactLimits.tableRows,
    columns: 50,
  })
  if (!imported.ok)
    throw artifactOpInvalid(`the file cannot be read as an artifact: ${imported.problem}`)
  const actor = { kind: 'user' as const, userId: input.userId }
  const { id } = await createArtifact(db, {
    workspaceId: task.workspaceId,
    kind: imported.kind,
    title: (imported.title ?? file.name.replace(/\.[^.]+$/, '')).slice(0, 200) || file.name,
    projectId:
      task.projectId !== null && task.project?.createdById === input.userId ? task.projectId : null,
    actor,
  })
  let after: string | null = null
  const ops: ArtifactOp[] = imported.blocks.map((block, at) => {
    const key = `${block.kind === 'section' ? 's' : 'b'}${at + 1}`
    const op: ArtifactOp = {
      op: 'insert',
      block: key,
      after,
      kind: block.kind,
      content: block.content,
      ...(block.heading === undefined ? {} : { props: { heading: block.heading } }),
    }
    after = key
    return op
  })
  let at = 0
  try {
    for (const batch of importBatches(ops))
      await applyCabinetOps(db, {
        userId: input.userId,
        batch: { artifactId: id, opId: `import-${id}-${at++}`, ops: batch },
      })
  } catch (error) {
    // Not half an artifact: the import is refused whole.
    await db.artifact.deleteMany({ where: { id } })
    throw error
  }
  return { id }
}
