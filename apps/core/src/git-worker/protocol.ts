import { join } from 'node:path'

import { z } from 'zod'

// The channel between core and its git worker (docs/plan/84-projects.md, ПР33, §4.3): one HTTP
// request over a Unix socket on the volume of the mirrors per command. Core says what to run —
// git subcommand arguments or a gitleaks scan, a working directory on the volume, the grant of
// one operation — and gets the exit code and stdout back; the worker adds every fixed option and
// the whole environment itself, so nothing core sends can switch a check off. No token: the
// socket is reachable only to the processes that mount the volume (core and the worker).

/** The worker listens here, on the volume both mount; nothing else on that volume is a socket. */
export const gitWorkerSocketPath = (mirrorDir: string): string => join(mirrorDir, 'worker.sock')

export const GIT_WORKER_PATH = '/v1/run'

/** The JSON report a gitleaks scan writes into the directory its fourth argument names. */
export const GITLEAKS_REPORT = 'report.json'

/** The environment a request may add to the worker's own: a grant, an identity, a repository. */
export const gitRequestEnvNames = [
  'RADITI_GIT_AUTH',
  'RADITI_GIT_AUTH_EXPIRES',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
] as const

const absolute = z
  .string()
  .min(2)
  .max(4096)
  .refine((path) => path.startsWith('/') && !path.includes('\0'), 'Not an absolute path')

const envValue = z
  .string()
  .max(8192)
  .refine((value) => !value.includes('\0'), 'NUL in a value')

export const gitWorkerRequestSchema = z
  .object({
    tool: z.enum(['git', 'gitleaks']),
    args: z
      .array(
        z
          .string()
          .max(8192)
          .refine((arg) => !arg.includes('\0'), 'NUL in an argument'),
      )
      .max(256),
    cwd: absolute,
    /**
     * How git reaches a remote: `https` to the address `pin` names, `file` — a bare repository of
     * a test fixture, only where the worker allows it (tests). `none` — no remote at all.
     */
    protocol: z.enum(['none', 'https', 'file']),
    /** The one address of the host of an https remote (`http.curloptResolve`, §4.6). */
    pin: z
      .object({
        host: z.string().min(1).max(253),
        address: z.string().min(2).max(64),
      })
      .strict()
      .optional(),
    env: z.partialRecord(z.enum(gitRequestEnvNames), envValue).default({}),
    /** Base64 of stdin. */
    input: z
      .base64()
      .max(64 * 1024 * 1024)
      .optional(),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024)
      .optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
    /** The directory the command writes into and the bytes it may hold (ПР12). */
    quota: z.object({ path: absolute, bytes: z.number().int().positive() }).strict().optional(),
  })
  .strict()
export type GitWorkerRequest = z.input<typeof gitWorkerRequestSchema>

export const gitWorkerResponseSchema = z.union([
  z.object({ code: z.number().int().min(0).max(255), stdout: z.base64() }).strict(),
  z
    .object({
      error: z
        .object({
          code: z.string().max(64),
          message: z.string().max(512),
          status: z.number().int().min(400).max(599),
        })
        .strict(),
    })
    .strict(),
])
export type GitWorkerResponse = z.infer<typeof gitWorkerResponseSchema>
