import { createPrismaClient, dbConfigFromEnv, exportOriJournals } from '@repo/db'
import { appEnvSchema, type Env } from '@repo/domain'
import { z } from 'zod'

import { OperatorCommandError } from './operator-args.ts'

// The export for a request of an authorised body (149-FZ, art. 10.1; Government Decree № 1526,
// p. 3, 7–11; docs/plan/88-artifacts.md, Ар56, slice 88.16а; docs/ops/ori-requests.md):
//
//   pnpm --filter core ori:export -- --user <id> --from <ISO> --to <ISO> [--messages]
//
// Prints JSON to stdout: the facts of the user over the period, and with --messages the messages of
// shared artifacts they wrote (kept 6 months). The fact of a request is never logged (p. 16).
// Environment, given explicitly: APP_ENV and DATABASE_URL.

const argsSchema = z.strictObject({
  user: z.uuid(),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  messages: z.boolean(),
})

export function parseOriExportArguments(written: readonly string[]) {
  const args = written[0] === '--' ? written.slice(1) : written
  const value: Record<string, unknown> = { messages: false }
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!
    if (arg === '--messages') {
      value.messages = true
      continue
    }
    const name = { '--user': 'user', '--from': 'from', '--to': 'to' }[arg]
    const next = args[++at]
    if (!name || !next || Object.hasOwn(value, name)) throw invalid()
    value[name] = next
  }
  const parsed = argsSchema.safeParse(value)
  if (!parsed.success || new Date(parsed.data.from) >= new Date(parsed.data.to)) throw invalid()
  return parsed.data
}

const invalid = () =>
  new OperatorCommandError(
    'Неверные параметры: ori:export -- --user <id> --from <ISO> --to <ISO> [--messages].',
  )

export async function runOriExport(
  args: readonly string[],
  env: Env = process.env,
  write: (text: string) => void = (text) => void process.stdout.write(text),
): Promise<void> {
  try {
    const options = parseOriExportArguments(args)
    if (!appEnvSchema.safeParse(env.APP_ENV).success)
      throw new OperatorCommandError('Задайте APP_ENV: development, test или production.')
    let config
    try {
      config = dbConfigFromEnv(env)
    } catch {
      throw new OperatorCommandError('Окружение задано неверно: нужен DATABASE_URL.')
    }
    const prisma = createPrismaClient({ ...config, log: [] })
    try {
      const result = await exportOriJournals(prisma, {
        userId: options.user,
        from: new Date(options.from),
        to: new Date(options.to),
        messages: options.messages,
      })
      write(`${JSON.stringify(result, null, 2)}\n`)
    } finally {
      await prisma.$disconnect().catch(() => undefined)
    }
  } catch (error) {
    if (error instanceof OperatorCommandError) throw new Error(error.message, { cause: error })
    throw new Error('Выгрузка не завершена. Проверьте окружение и доступность базы данных.', {
      cause: error,
    })
  }
}
