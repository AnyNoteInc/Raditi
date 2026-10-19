import { userInfo } from 'node:os'

import {
  createPrismaClient,
  dbConfigFromEnv,
  resolveRelease,
  type ReleaseResolveResult,
} from '@repo/db'
import { appEnvSchema, releaseResolutions, type Env } from '@repo/domain'
import { z } from 'zod'

// The operator's command of releases (docs/plan/53-chat-preview-release.md, Р31, «Маршруты»):
//
//   pnpm --filter orchestrator releases:resolve -- <releaseId> --outcome installed|rolled_back
//        --reason "…" [--operator <name>]
//     Decides a release whose outcome nobody could prove (`unknown`): the operator looked at the
//     hosting and says what it holds — the new version (`installed`) or the old one after a
//     rollback by hand (`rolled_back`). The command writes only the decision, an audit entry
//     and a wake-up of the release; core then ends the release as for any other end: after
//     `rolled_back` it pushes the revert commit to `main` and gives the dialog's credits back,
//     after `installed` it records the version and charges the dialog; then it frees the site.
//     Safe to repeat: the same decision again changes nothing. A release reaches the operator
//     only after core tried what it can: the job's own rollback, then one attempt «только
//     возврат» dispatched on the release tag when the attempt that wrote kept a verified backup
//     (Р31, R8c); a release that could still be rolled back that way is not the operator's yet,
//     and the command refuses it.
//     The same command with `--outcome rolled_back` hands back an ended release whose revert
//     commit could not land (Р27: `main` stood elsewhere, or git refused) once the operator put
//     `main` back at the release commit or at the installed tree: core then pushes the revert
//     commit, or takes `main` as it is, and frees the site.
//
// Environment, given explicitly (no `.env` is loaded): APP_ENV and DATABASE_URL, as the core
// role has them. On the app VM: `docker compose run --rm --no-deps --entrypoint node core
// scripts/releases-resolve.mjs <releaseId> …`. Nothing secret is taken from the command line
// or printed; refusals are fixed texts.

export type ReleasesCommand = 'resolve'
type Write = (text: string) => void

class OperatorCommandError extends Error {}
const invalid = () =>
  new OperatorCommandError('Неверные параметры команды выпуска. Используйте --help.')

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/\p{Cc}/u.test(value))
const resolveSchema = z.strictObject({
  releaseId: z.uuid().transform((id) => id.toLowerCase()),
  outcome: z.enum(releaseResolutions),
  reason: oneLine(500),
  operator: oneLine(128).optional(),
})
export type ResolveOptions = { help: true } | { help: false; value: z.output<typeof resolveSchema> }

const flags: Record<string, keyof z.input<typeof resolveSchema>> = {
  '--outcome': 'outcome',
  '--reason': 'reason',
  '--operator': 'operator',
}

/** Strict argument parsing completes before reading the environment or connecting anywhere. */
export function parseResolveArguments(written: readonly string[]): ResolveOptions {
  const args = written[0] === '--' ? written.slice(1) : written
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { help: true }
  const value: Record<string, unknown> = {}
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!
    if (!arg.startsWith('-')) {
      if (Object.hasOwn(value, 'releaseId')) throw invalid()
      value.releaseId = arg
      continue
    }
    const name = flags[arg]
    if (!name || Object.hasOwn(value, name)) throw invalid()
    const next = args[++at]
    if (!next || next.startsWith('--')) throw invalid()
    value[name] = next
  }
  const parsed = resolveSchema.safeParse(value)
  if (!parsed.success) throw invalid()
  return { help: false, value: parsed.data }
}

export const resolveHelp =
  'releases:resolve -- <UUID выпуска> --outcome installed|rolled_back --reason "<причина>" [--operator <имя>]\n' +
  'Решение по выпуску с неизвестным исходом: оператор проверил хостинг и говорит, что на нём — новая версия (installed) или прежняя после возврата вручную (rolled_back).\n' +
  'Команда записывает только решение, запись журнала и пробуждение выпуска; дальше выпуск завершает core: после rolled_back — revert-коммит в main и возврат кредитов диалога, после installed — установленная версия и списание; затем сайт освобождается.\n' +
  'Повтор того же решения ничего не меняет. До оператора выпуск доходит, когда core уже попробовал вернуть сайт сам: возвратом задания и одной попыткой «только возврат»; раньше команда отказывает.\n' +
  'Выпуск, чей revert-коммит не лёг в main (main стоял на другом коммите или git отказал): верните main к коммиту выпуска или к дереву установленной версии и запустите команду с --outcome rolled_back — core допишет revert-коммит (или примет main как есть) и освободит сайт.\n' +
  '--operator — имя оператора для журнала; без него берётся имя пользователя ОС.\n' +
  'Окружение задаётся явно; команда не загружает .env автоматически. Нужны APP_ENV и DATABASE_URL.\n'

/** The name the audit entry keeps: the option, else the OS user of the process. */
function operatorName(given: string | undefined): string {
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

const outcomeText = { installed: 'установлена', rolled_back: 'возвращена' } as const

export function resolveReport(result: ReleaseResolveResult, releaseId: string): string {
  switch (result.kind) {
    case 'resolved':
      return `Выпуск ${releaseId} (${result.version}): версия ${outcomeText[result.status]}. Core завершит выпуск и освободит сайт ${result.siteId}.\n`
    case 'repeated':
      return `Выпуск ${releaseId} (${result.version}) уже решён так же: ничего не изменено.\n`
    case 'revert_retried':
      return `Выпуск ${releaseId} (${result.version}): core повторит revert-коммит в main, завершит выпуск и освободит сайт ${result.siteId}.\n`
    case 'not_held':
      throw new OperatorCommandError(
        `Выпуск ${releaseId} ещё не передан оператору: core пробует вернуть сайт сам. Ничего не изменено; повторите команду позже.`,
      )
    case 'refused':
      throw new OperatorCommandError(
        `Выпуск ${releaseId} не ждёт оператора (статус ${result.status}): ничего не изменено.`,
      )
    case 'not_found':
      throw new OperatorCommandError(`Выпуск ${releaseId} не найден.`)
  }
}

/** Only fixed texts reach the operator; a database error may quote a connection string. */
export function releasesFailure(error: unknown): Error {
  if (error instanceof OperatorCommandError) return new Error(error.message)
  return new Error('Команда выпуска не завершена. Проверьте окружение и доступность базы данных.')
}

export async function runReleasesCommand(
  _command: ReleasesCommand,
  args: readonly string[],
  env: Env = process.env,
  write: Write = (text) => void process.stdout.write(text),
): Promise<void> {
  try {
    const options = parseResolveArguments(args)
    if (options.help) {
      write(resolveHelp)
      return
    }
    if (!appEnvSchema.safeParse(env.APP_ENV).success)
      throw new OperatorCommandError('Задайте APP_ENV: development, test или production.')
    let config
    try {
      config = dbConfigFromEnv(env)
    } catch {
      throw new OperatorCommandError('Окружение задано неверно: нужен DATABASE_URL.')
    }
    const operator = operatorName(options.value.operator)
    const prisma = createPrismaClient({ ...config, log: [] })
    try {
      const { releaseId, outcome, reason } = options.value
      write(`Решение по выпуску ${releaseId}: ${outcome}.\n`)
      const result = await prisma.$transaction((tx) =>
        resolveRelease(tx, { releaseId, outcome, reason, operator }),
      )
      write(resolveReport(result, releaseId))
    } finally {
      await prisma.$disconnect().catch(() => undefined)
    }
  } catch (error) {
    throw releasesFailure(error)
  }
}
