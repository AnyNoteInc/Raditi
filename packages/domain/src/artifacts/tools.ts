import { z } from 'zod'

import { docViewSchema } from '../pages/doc.ts'
import { outboxFileNameSchema } from '../tasks/chat-files.ts'
import { artifactBlockKeySchema, artifactIntentSchema, artifactTitleSchema } from './blocks.ts'
import { artifactCommentBodySchema } from './comments.ts'
import { artifactKindSchema } from './kinds.ts'
import { artifactLimits } from './limits.ts'
import { artifactBatchSchema } from './ops.ts'

/**
 * The family `artifacts` of the role `mcp` (docs/plan/88-artifacts.md, Ар22, §7.5): the tools of the
 * first slice (88.6). The model sees them as `raditi_<name>`; descriptions are English and short,
 * refusals come back as results with `isError`. The tools `doc_*` of plan 69 are their synonyms
 * (Ар3): accepted for the turns begun before the release, never listed.
 */

export const artifactToolNames = [
  'artifact_list',
  'artifact_read',
  'artifact_create',
  'artifact_edit',
  'artifact_claim',
  'artifact_save_version',
  'artifact_file_put',
  'artifact_import',
  'artifact_layout',
  'artifact_render',
  'artifact_comments',
  'artifact_reply',
  'artifact_trash',
] as const
export type ArtifactToolName = (typeof artifactToolNames)[number]

/** The synonyms of plan 69 (Ар3): mapped onto the operations, absent from `tools/list`. */
export const artifactSynonymToolNames = [
  'doc_create',
  'doc_section_write',
  'doc_section_remove',
  'doc_section_move',
  'doc_read',
  'doc_finish',
] as const
export type ArtifactSynonymToolName = (typeof artifactSynonymToolNames)[number]

/**
 * What a chat may open (Ар23): `chat` — created, attached or edited in this chat; `project` — of
 * the chat's project; `mine` — the client's own without a project; `attached` — attached to this
 * chat (slice 88.17). Absent — all of them.
 */
export const artifactListScopes = ['chat', 'project', 'mine', 'attached'] as const
export type ArtifactListScope = (typeof artifactListScopes)[number]

export const artifactListArgumentsSchema = z.strictObject({
  scope: z.enum(artifactListScopes).optional(),
  kind: artifactKindSchema.optional(),
  /** A search in the titles. */
  query: z.string().min(1).max(200).optional(),
})
export type ArtifactListArguments = z.infer<typeof artifactListArgumentsSchema>

const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

export const artifactReadArgumentsSchema = z.strictObject({
  artifactId: z.uuid(),
  /**
   * `outline` — every block without its text, by pages of 200 (`from` — the page's first block);
   * `blocks` — the text, by parts of 48 KiB (`from` — the part's first block). Default `blocks`.
   */
  part: z.enum(['outline', 'blocks']).optional(),
  from: artifactBlockKeySchema.optional(),
  /** Only these blocks. */
  blocks: z.array(artifactBlockKeySchema).min(1).max(50).optional(),
  /** Only the blocks changed after this `seq` of the artifact. */
  sinceSeq: seq.optional(),
})
export type ArtifactReadArguments = z.infer<typeof artifactReadArgumentsSchema>

export const artifactSkeletonSchema = z
  .array(z.strictObject({ id: artifactBlockKeySchema, intent: artifactIntentSchema }))
  .max(artifactLimits.batchOps - 1)

export const artifactCreateArgumentsSchema = z.strictObject({
  /** Only the kinds whose view has shipped (`artifactReleasedKinds`, Ар7). */
  kind: artifactKindSchema,
  title: artifactTitleSchema,
  /** `this_chat` — in the chat's project; null — the client's own. Absent — as the chat is. */
  project: z.enum(['this_chat']).nullable().optional(),
  /** How a document is shown: a page to read or a text to edit (docs/plan/74, Д1). */
  view: docViewSchema.optional(),
  /** The skeleton: every block by its id with its intent in one line. */
  skeleton: artifactSkeletonSchema.optional(),
})
export type ArtifactCreateArguments = z.infer<typeof artifactCreateArgumentsSchema>

/** A batch of operations (§7.2): the format of the cabinet's `artifact.apply` too. */
export const artifactEditArgumentsSchema = artifactBatchSchema
export type ArtifactEditArguments = z.infer<typeof artifactEditArgumentsSchema>

export const artifactClaimArgumentsSchema = z.strictObject({
  artifactId: z.uuid(),
  block: artifactBlockKeySchema,
  intent: artifactIntentSchema,
})
export type ArtifactClaimArguments = z.infer<typeof artifactClaimArgumentsSchema>

export const artifactSaveVersionArgumentsSchema = z.strictObject({
  artifactId: z.uuid(),
  /** A label of up to 60 characters; the agent's version counts as an automatic one (Ар13). */
  label: artifactTitleSchema.max(artifactLimits.versionLabelChars).optional(),
})
export type ArtifactSaveVersionArguments = z.infer<typeof artifactSaveVersionArgumentsSchema>

/**
 * `artifact_file_put` (§7.5, slice 88.12): a picture or a font the turn wrote to the outbox, for an
 * artifact the chat may write — the content names it `artifact-file:<id>` at once, the bytes come at
 * the end of the turn.
 */
export const artifactFilePutArgumentsSchema = z.strictObject({
  artifactId: z.uuid(),
  file: outboxFileNameSchema,
})
export type ArtifactFilePutArguments = z.infer<typeof artifactFilePutArgumentsSchema>

/**
 * `artifact_import` (§7.5): a `.md`, `.html`, `.svg` or `.csv` of the outbox — a new artifact (its id
 * is in the answer, it exists at the end of the turn) or the whole new content of `artifactId`.
 */
export const artifactImportArgumentsSchema = z.strictObject({
  file: outboxFileNameSchema,
  artifactId: z.uuid().optional(),
  title: artifactTitleSchema.optional(),
  /** As `artifact_create`: `this_chat` — the chat's project; null — the client's own. */
  project: z.enum(['this_chat']).nullable().optional(),
})
export type ArtifactImportArguments = z.infer<typeof artifactImportArgumentsSchema>

/**
 * `artifact_layout` (§7.5, Ар32, slice 88.15б): the text report of the layout of a mockup or of one
 * frame of a canvas as the client sees it, drawn by `apps/browser` at 1440 and 390 — the chat's own
 * blocks that wait for the check included.
 */
export const artifactLayoutArgumentsSchema = z.strictObject({
  artifactId: z.uuid(),
  /** The frame of a canvas; absent — a mockup. */
  frame: artifactBlockKeySchema.optional(),
  /** Every finding, past the 1 500 characters of the report. */
  detail: z.boolean().optional(),
})
export type ArtifactLayoutArguments = z.infer<typeof artifactLayoutArgumentsSchema>

/**
 * `artifact_render` (§7.5, Ар32, slice 88.15в): the picture of a mockup or of a frame — strips of
 * JPEG as image results of the tool — for the helper `look`, which alone sees images.
 */
export const artifactRenderArgumentsSchema = z.strictObject({
  artifactId: z.uuid(),
  frame: artifactBlockKeySchema.optional(),
  /** `desktop` — 1440, `phone` — 390; absent — both. */
  view: z.enum(['desktop', 'phone']).optional(),
})
export type ArtifactRenderArguments = z.infer<typeof artifactRenderArgumentsSchema>

/**
 * `artifact_comments` (§7.5, slice 88.18г): the notes the client sent to this chat, with their state
 * and this chat's replies. Absent `artifactId` — of every artifact.
 */
export const artifactCommentsArgumentsSchema = z.strictObject({
  artifactId: z.uuid().optional(),
})
export type ArtifactCommentsArguments = z.infer<typeof artifactCommentsArgumentsSchema>

/**
 * `artifact_reply` (§7.5, slice 88.18г): a reply in a note sent to this chat; `resolve` closes the
 * note once the reply passes the check. The same `opId` with the same text — the same reply.
 */
export const artifactReplyArgumentsSchema = z.strictObject({
  threadId: z.uuid(),
  opId: z.uuid(),
  body: artifactCommentBodySchema,
  resolve: z.boolean().optional(),
})
export type ArtifactReplyArguments = z.infer<typeof artifactReplyArgumentsSchema>

/**
 * `artifact_trash` (§7.5, Ар23, slice 88.20): an artifact of the client into the trash, only when
 * the client asked in this message — 30 days there, «Вернуть» is theirs. Only the owner's.
 */
export const artifactTrashArgumentsSchema = z.strictObject({
  artifactId: z.uuid(),
  confirmedByClient: z.literal(true),
})
export type ArtifactTrashArguments = z.infer<typeof artifactTrashArgumentsSchema>

export const artifactToolArgumentSchemas = {
  artifact_list: artifactListArgumentsSchema,
  artifact_read: artifactReadArgumentsSchema,
  artifact_create: artifactCreateArgumentsSchema,
  artifact_edit: artifactEditArgumentsSchema,
  artifact_claim: artifactClaimArgumentsSchema,
  artifact_save_version: artifactSaveVersionArgumentsSchema,
  artifact_file_put: artifactFilePutArgumentsSchema,
  artifact_import: artifactImportArgumentsSchema,
  artifact_layout: artifactLayoutArgumentsSchema,
  artifact_render: artifactRenderArgumentsSchema,
  artifact_comments: artifactCommentsArgumentsSchema,
  artifact_reply: artifactReplyArgumentsSchema,
  artifact_trash: artifactTrashArgumentsSchema,
} as const satisfies Record<ArtifactToolName, z.ZodType>

/**
 * What «Ход работы» and the progress message of Telegram say of a call of the family (rule 10); null
 * — not a tool of artifacts. `raditi_` before the name is read as it is.
 */
export function artifactToolLine(tool: string): string | null {
  const name = tool.replace(/^raditi_/, '')
  switch (name) {
    case 'artifact_list':
      return 'Смотрит список артефактов'
    case 'artifact_read':
    case 'doc_read':
      return 'Читает артефакт'
    case 'artifact_create':
    case 'doc_create':
      return 'Создаёт артефакт'
    case 'artifact_edit':
    case 'doc_section_write':
    case 'doc_section_remove':
    case 'doc_section_move':
      return 'Правит артефакт'
    case 'artifact_claim':
      return 'Готовит правку артефакта'
    case 'artifact_save_version':
    case 'doc_finish':
      return 'Сохраняет версию артефакта'
    case 'artifact_file_put':
      return 'Добавляет файл в артефакт'
    case 'artifact_import':
      return 'Переносит файл в артефакт'
    case 'artifact_layout':
      return 'Проверяет вёрстку на компьютере и телефоне'
    case 'artifact_render':
      return 'Смотрит на макет'
    case 'artifact_comments':
      return 'Читает заметки к артефакту'
    case 'artifact_reply':
      return 'Отвечает на заметку'
    case 'artifact_trash':
      return 'Убирает артефакт в корзину'
    default:
      return null
  }
}
