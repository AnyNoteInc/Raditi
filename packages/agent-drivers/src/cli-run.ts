import type { PreparedRun, RunContext, SandboxFile } from '@repo/domain'
import {
  badRequest,
  nativeSessionIdSchema,
  SANDBOX_SECRETS_DIR,
  turnInputSchema,
} from '@repo/domain'
import { z } from 'zod'

// The per-turn plumbing shared by the subscription CLI drivers: what a driver accepts from
// the turn, where its two credentials are installed and how per-turn input files are staged.
// Everything specific to one CLI (settings, argv, the launch wrapper) stays in its driver.

/** The turn's two credential files; each launch wrapper reads both once and removes them. */
export const llmKey = `${SANDBOX_SECRETS_DIR}/llm`
export const mcpKey = `${SANDBOX_SECRETS_DIR}/mcp`

const credential = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/)
const endpoint = z.url().refine((value) => {
  const url = new URL(value)
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  )
})

/** The run context a CLI driver accepts; `effort` lists the reasoning profiles of that CLI. */
export const runContextSchema = <Effort extends z.ZodType>(effort: Effort) =>
  z.object({
    llm: z.object({
      baseUrl: endpoint,
      apiKey: credential,
      model: z.string().min(1).max(200),
      reasoningEffort: effort.nullable().optional(),
    }),
    mcp: z.object({ url: endpoint, token: credential }),
    instructions: z.string().max(256 * 1024),
    nativeSessionId: nativeSessionIdSchema.optional(),
  })

export const turnSecrets = (context: RunContext): SandboxFile[] => [
  { path: llmKey, content: context.llm.apiKey, mode: 0o400 },
  { path: mcpKey, content: context.mcp.token, mode: 0o400 },
]

/**
 * The rule of the turn plan itself (turnInputSchema), not a copy of it: the attachments the
 * plan accepts launch, and a list it refuses (a path or the number of them) reaches no CLI.
 */
export function assertAttachments(paths: readonly string[]): void {
  if (!turnInputSchema.shape.attachments.safeParse(paths).success)
    throw badRequest('Invalid attachment path')
}

/**
 * Puts the turn's input files into the prepared run. Core calls command() before it
 * validates and writes PreparedRun.files, so a driver stages them there; a path staged
 * earlier is replaced in place, never duplicated.
 */
export function stageFiles(run: PreparedRun, files: readonly SandboxFile[]): void {
  for (const file of files) {
    const previous = run.files.findIndex((existing) => existing.path === file.path)
    if (previous < 0) run.files.push(file)
    else run.files[previous] = file
  }
}
