import { z } from 'zod'

import { badRequest } from '../errors.ts'
import { agentDriverIds, nativeSessionIdSchema } from '../ports/agent-driver.ts'
import { gitProviderKinds } from '../ports/git-provider.ts'
import { DIGEST_PINNED_IMAGE } from '../ports/sandbox-provider.ts'
import { sessionStateSchema, snapshotLimits } from './session-state.ts'
import { workspaceTransitKey } from './workspace-transit-key.ts'

/** First persisted format. Hashes and sizes describe stored ciphertext, not plaintext. */
export const SNAPSHOT_SCHEMA_VERSION = 1
export const snapshotPartNames = ['home', 'untracked', 'patch'] as const
export type SnapshotPartName = (typeof snapshotPartNames)[number]
export const snapshotPartFiles = Object.freeze({
  home: 'home.tar.zst',
  untracked: 'untracked.tar.zst',
  patch: 'patch.diff',
})

export const snapshotIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
const turnSchema = z.number().int().positive().max(999_999)
const imageSchema = z.string().max(512).regex(DIGEST_PINNED_IMAGE)
const versionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/)
const driverSchema = z.object({ id: z.enum(agentDriverIds), version: versionSchema }).strict()
const gitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)

/** Supplied by trusted orchestration, never selected by the agent or an S3 manifest. */
export const snapshotReferenceSchema = z
  .object({
    workspaceId: snapshotIdSchema,
    sessionId: snapshotIdSchema,
    turn: turnSchema,
    image: imageSchema,
    driver: driverSchema,
    home: sessionStateSchema,
  })
  .strict()
export type SnapshotReference = z.infer<typeof snapshotReferenceSchema>

const snapshotGitSchema = z
  .object({
    provider: z.enum(gitProviderKinds),
    branch: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/)
      .refine(
        (s) => !s.includes('..') && !s.includes('//') && !s.endsWith('/') && !s.endsWith('.lock'),
      ),
    baseSha: gitSha,
    headSha: gitSha,
    /** Rebuild the exact trusted candidate from baseSha and the complete saved patch. */
    publication: z
      .object({
        taskId: snapshotIdSchema,
        committedAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const snapshotMetadataSchema = snapshotReferenceSchema
  .extend({
    driver: driverSchema.extend({ nativeSessionId: nativeSessionIdSchema.optional() }).strict(),
    git: snapshotGitSchema,
  })
  .strict()
export type SnapshotMetadata = z.infer<typeof snapshotMetadataSchema>

/**
 * The part of the snapshot metadata known before the agent runs, checked by the same rules as
 * the manifest. The supervisor validates it before taking the lease, so a turn cannot finish
 * with a checkpoint that save() would refuse. `home`, the native session and headSha come later.
 */
export const snapshotPlanSchema = snapshotMetadataSchema
  .omit({ home: true })
  .extend({ git: snapshotGitSchema.omit({ headSha: true }) })
  .strict()

const snapshotPartSchema = z
  .object({
    name: z.enum(snapshotPartNames),
    key: z.string().min(1).max(256),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().nonnegative().max(snapshotLimits.archiveBytes),
    encryption: z
      .object({
        algorithm: z.literal('aes-256-gcm'),
        keyId: z.string().min(1).max(67),
        wrappedKey: z.string().min(1).max(4096),
        iv: z.string().regex(/^[0-9a-f]{24}$/),
        tag: z.string().regex(/^[0-9a-f]{32}$/),
      })
      .strict(),
  })
  .strict()
export type SnapshotPart = z.infer<typeof snapshotPartSchema>

export const snapshotManifestSchema = snapshotMetadataSchema
  .extend({
    schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
    createdAt: z.iso.datetime(),
    parts: z.array(snapshotPartSchema).length(3),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (new Set(manifest.parts.map((p) => p.name)).size !== 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['parts'],
        message: 'expected exactly three unique parts',
      })
    }
    // One data key per snapshot (spec §8): restore unwraps it with a single Vault call.
    if (new Set(manifest.parts.map((p) => p.encryption.wrappedKey)).size !== 1) {
      ctx.addIssue({ code: 'custom', path: ['parts'], message: 'expected one data key' })
    }
    const prefix = turnSnapshotPrefix(manifest.sessionId, manifest.turn)
    for (const [index, part] of manifest.parts.entries()) {
      if (
        part.key !== `${prefix}${snapshotPartFiles[part.name]}` ||
        part.encryption.keyId !== workspaceTransitKey(manifest.workspaceId) ||
        (part.name === 'patch' && part.sizeBytes > snapshotLimits.patchBytes)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['parts', index],
          message: 'invalid part scope or size',
        })
      }
    }
  })
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>

export function turnSnapshotPrefix(sessionId: string, turn: number): string {
  if (!snapshotIdSchema.safeParse(sessionId).success || !turnSchema.safeParse(turn).success) {
    throw badRequest('Invalid snapshot identity')
  }
  return `sessions/${sessionId}/turns/${String(turn).padStart(4, '0')}/`
}
