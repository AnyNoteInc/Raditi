import { z } from 'zod'
import { agentDriverIds } from '../ports/agent-driver.ts'
import { gitProviderKinds } from '../ports/git-provider.ts'

/**
 * Turn snapshot in S3 — spec §8, §14:
 * raditi-sessions/sessions/<sessionId>/turns/<NNNN>/{home.tar.zst, untracked.tar.zst, patch.diff, manifest.json}
 * The manifest is written last. Hashes are computed and archives encrypted on the host, never in the sandbox.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1

export const snapshotPartSchema = z.object({
  name: z.enum(['home', 'untracked', 'patch']),
  key: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  /** Vault Transit key (ws-<workspaceId>) and the wrapped data key. */
  encryption: z.object({ keyId: z.string(), wrappedKey: z.string() }),
})

export const snapshotManifestSchema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  sessionId: z.string().min(1),
  turn: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  /** A session resumes only with the same image; otherwise a new session gets a summary. */
  image: z.string().min(1),
  driver: z.object({
    id: z.enum(agentDriverIds),
    version: z.string(),
    nativeSessionId: z.string().optional(),
  }),
  git: z.object({
    provider: z.enum(gitProviderKinds),
    branch: z.string(),
    baseSha: z.string(),
    headSha: z.string(),
  }),
  parts: z.array(snapshotPartSchema),
})
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>

export function turnSnapshotPrefix(sessionId: string, turn: number): string {
  return `sessions/${sessionId}/turns/${String(turn).padStart(4, '0')}/`
}
