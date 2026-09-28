import { z } from 'zod'

/** process.env or any env-like object. */
export type Env = Readonly<Record<string, string | undefined>>

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

/** One variable: blank counts as unset, as in a copied .env.example, so defaults apply. */
export const envVar = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema)

/** `PATH: message` per issue; zod messages name expectations, never the received values. */
export function envProblems(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
  )
}

/** Parses the variables or throws one error listing every problem, without values. */
export function parseEnv<T extends z.ZodType>(label: string, schema: T, env: Env): z.output<T> {
  const parsed = schema.safeParse(env)
  if (parsed.success) return parsed.data
  throw new Error(`[${label}] invalid configuration: ${envProblems(parsed.error).join('; ')}`)
}
