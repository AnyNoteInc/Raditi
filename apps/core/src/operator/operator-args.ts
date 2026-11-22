import { userInfo } from 'node:os'

import { z } from 'zod'

// The arguments of the operator's commands on a complaint — of pages (docs/plan/73-pages-sites.md,
// Дер18) and of artifacts (docs/plan/88-artifacts.md, Ар57): one address, `--reason`, and the
// optional `--operator`. Parsed strictly before the environment is read or anything connected.

/** A refusal the operator reads as it is: in Russian, without a stack. */
export class OperatorCommandError extends Error {}

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/\p{Cc}/u.test(value))

const optionsSchema = z.strictObject({
  address: z.string().min(1).max(700),
  reason: oneLine(500),
  operator: oneLine(128).optional(),
})

export type OperatorOptions =
  { help: true } | { help: false; value: z.output<typeof optionsSchema> }

const flags: Record<string, keyof z.input<typeof optionsSchema>> = {
  '--reason': 'reason',
  '--operator': 'operator',
}

/** `invalid` — the refusal in the words of the command («Неверные параметры команды …»). */
export function parseOperatorArguments(
  written: readonly string[],
  invalid: () => Error,
): OperatorOptions {
  const args = written[0] === '--' ? written.slice(1) : written
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { help: true }
  const value: Record<string, unknown> = {}
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!
    if (!arg.startsWith('-')) {
      if (Object.hasOwn(value, 'address')) throw invalid()
      value.address = arg
      continue
    }
    const name = flags[arg]
    if (!name || Object.hasOwn(value, name)) throw invalid()
    const next = args[++at]
    if (!next || next.startsWith('--')) throw invalid()
    value[name] = next
  }
  const parsed = optionsSchema.safeParse(value)
  if (!parsed.success) throw invalid()
  return { help: false, value: parsed.data }
}

/** The name in the audit log: given, or the user of the OS. */
export function operatorName(given: string | undefined): string {
  if (given !== undefined) return given
  let name: string | undefined
  try {
    name = userInfo().username
  } catch {
    // A uid without a passwd entry: a container.
  }
  const parsed = oneLine(128).safeParse(name)
  if (!parsed.success)
    throw new OperatorCommandError('Имя оператора не определено: укажите --operator <имя>.')
  return parsed.data
}
