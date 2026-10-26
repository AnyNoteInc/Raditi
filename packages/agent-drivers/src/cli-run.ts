import type { PreparedRun, RunContext, SandboxFile } from '@repo/domain'
import {
  badRequest,
  envVarNameProblem,
  envVarValueSchema,
  nativeSessionIdSchema,
  SANDBOX_SECRET_CHARS,
  SANDBOX_SECRET_FILES,
  SANDBOX_SECRETS_DIR,
  turnInputSchema,
  turnSkillsSchema,
} from '@repo/domain'
import { z } from 'zod'

// The per-turn plumbing shared by the subscription CLI drivers: what a driver accepts from
// the turn, where its two credentials are installed and how per-turn input files are staged.
// Everything specific to one CLI (settings, argv, the launch wrapper) stays in its driver.

/** The turn's two credential files; each launch wrapper reads both once and removes them. */
export const llmKey = `${SANDBOX_SECRETS_DIR}/llm`
export const mcpKey = `${SANDBOX_SECRETS_DIR}/mcp`
/**
 * The client's variables of the turn (docs/plan/53-chat-preview-release.md, Р13), in as many
 * files as they take — `env.0`, `env.1`, …: the launch wrapper reads them once, removes them and
 * hands the values to the commands of the agent's shell tool only.
 */
export const envKey = (index: number): string => `${SANDBOX_SECRETS_DIR}/env.${index}`

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
    // Names the shell, the runtime and the platform read are refused here as on the form.
    envValues: z
      .record(
        z.string().refine((name) => envVarNameProblem(name) === null),
        envVarValueSchema,
      )
      .optional(),
    egressProxy: endpoint.optional(),
    internet: z.literal(true).optional(),
    skills: turnSkillsSchema.optional(),
  })

/** Secret files the variables may take: the LLM key and the MCP token have one each. */
const ENV_FILES = SANDBOX_SECRET_FILES - 2

/**
 * The variables as the wrapper reads them: `NAME\0value\0` for each, names in order, as many to
 * a file as fit into one secret file. A name has no NUL, a value none either (envVarValueSchema),
 * and nothing is escaped: every set of variables a site may have — 64 values of up to 8 KiB, of
 * any text — takes a few files of the tmpfs, never more than the text itself.
 */
export function envFiles(values: Readonly<Record<string, string>> | undefined): string[] {
  const names = Object.keys(values ?? {}).sort()
  if (names.some((name) => envVarNameProblem(name) !== null))
    throw badRequest('A client variable of the turn has a name the platform reserves')
  const files: string[] = []
  let file = ''
  for (const name of names) {
    const value = values![name]!
    if (!envVarValueSchema.safeParse(value).success)
      throw badRequest('A client variable of the turn has an invalid value')
    const pair = `${name}\0${value}\0`
    if (file.length + pair.length > SANDBOX_SECRET_CHARS) {
      files.push(file)
      file = ''
    }
    file += pair
  }
  if (file !== '') files.push(file)
  if (files.length > ENV_FILES)
    throw badRequest('The client variables of the turn do not fit the secrets of a sandbox')
  return files
}

export const turnSecrets = (context: RunContext): SandboxFile[] => [
  { path: llmKey, content: context.llm.apiKey, mode: 0o400 },
  { path: mcpKey, content: context.mcp.token, mode: 0o400 },
  ...envFiles(context.envValues).map((content, index) => ({
    path: envKey(index),
    content,
    mode: 0o400,
  })),
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
