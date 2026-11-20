import { z } from 'zod'

import { docViewSchema } from '../pages/doc.ts'
import { outboxFileNameSchema } from '../tasks/chat-files.ts'
import { artifactBlockKeySchema, artifactIntentSchema, artifactTitleSchema } from './blocks.ts'
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

export const artifactToolArgumentSchemas = {
  artifact_list: artifactListArgumentsSchema,
  artifact_read: artifactReadArgumentsSchema,
  artifact_create: artifactCreateArgumentsSchema,
  artifact_edit: artifactEditArgumentsSchema,
  artifact_claim: artifactClaimArgumentsSchema,
  artifact_save_version: artifactSaveVersionArgumentsSchema,
  artifact_file_put: artifactFilePutArgumentsSchema,
  artifact_import: artifactImportArgumentsSchema,
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
    default:
      return null
  }
}
