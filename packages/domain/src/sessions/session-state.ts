import { z } from 'zod'

import { SANDBOX_AGENT_HOME, type SessionState } from '../ports/agent-driver.ts'

/** Bounded staging before GCM verification and archive validation; never agent-configurable. */
export const snapshotLimits = Object.freeze({
  archiveBytes: 16 * 1024 * 1024,
  patchBytes: 8 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  fileBytes: 32 * 1024 * 1024,
  entries: 10_000,
  path: 1024,
  depth: 32,
  manifestBytes: 64 * 1024,
})

/** Literal relative paths, not shell arguments, globs or tar patterns. */
export const sessionRelativePathSchema = z
  .string()
  .min(1)
  .max(snapshotLimits.path)
  .refine(
    (path) =>
      !['\\', '*', '?', '[', ']'].some((c) => path.includes(c)) &&
      ![...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
      !path.startsWith('-') &&
      path.split('/').length <= snapshotLimits.depth &&
      path.split('/').every((s) => s !== '' && s !== '.' && s !== '..') &&
      !path.split('/').some((s) => s.toLowerCase() === '.git'),
    'expected a safe literal relative path',
  )

export const sessionStateSchema = z
  .object({
    root: z
      .string()
      .max(snapshotLimits.path)
      .refine(
        (path) =>
          path.startsWith(`${SANDBOX_AGENT_HOME}/`) &&
          sessionRelativePathSchema.safeParse(path.slice(SANDBOX_AGENT_HOME.length + 1)).success,
        'session root must be a normalized directory under /agent-home',
      ),
    include: z.array(sessionRelativePathSchema).min(1).max(32),
    exclude: z.array(sessionRelativePathSchema).max(64),
  })
  .strict()
  .superRefine((state, ctx) => {
    for (const field of ['include', 'exclude'] as const) {
      if (new Set(state[field]).size !== state[field].length) {
        ctx.addIssue({ code: 'custom', path: [field], message: 'duplicate session path' })
      }
    }
  }) satisfies z.ZodType<SessionState>
