import { createPrismaClient, dbConfigFromEnv, operatorArtifactDecision } from '@repo/db'
import { appEnvSchema, type Env } from '@repo/domain'

import {
  OperatorCommandError,
  operatorName,
  parseOperatorArguments,
  type OperatorOptions,
} from '../operator/operator-args.ts'

// The operator's commands of artifacts (docs/plan/88-artifacts.md, Ар57, slice 88.23):
//
//   pnpm --filter core artifacts:take-down -- <address> --reason "…" [--operator <name>]
//   pnpm --filter core artifacts:return -- <address> --reason "…" [--operator <name>]
//
// The address is the one a complaint names: https://raditi.ru/artifacts/<id>, or the id alone.
// A link `/a#…` is resolved by its token when links come (slice 88.16). `take-down` closes the
// artifact to everyone — its owner, those it was opened to and their agents — over the trash;
// `return` takes back only what the support took down. Its published pages are pages:
// `pages:take-down`. Each decision is an audit entry with the reason; a repeat changes nothing.
//
// Environment, given explicitly (no `.env` is loaded): APP_ENV and DATABASE_URL, as the core role
// has them. On the app VM: `docker compose run --rm --no-deps --entrypoint node core
// scripts/artifacts-take-down.mjs <address> …`. Nothing secret is taken or printed.

export type ArtifactsCommand = 'take-down' | 'return'
type Write = (text: string) => void

const invalid = () =>
  new OperatorCommandError('Неверные параметры команды артефактов. Используйте --help.')

export const parseArtifactsArguments = (written: readonly string[]): OperatorOptions =>
  parseOperatorArguments(written, invalid)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The id of an artifact from an address of the cabinet, or the id itself. */
export function artifactIdOf(address: string): string {
  const unknown = () =>
    new OperatorCommandError(
      'Адрес артефакта не распознан: нужен https://raditi.ru/artifacts/<id> или сам id.',
    )
  if (UUID.test(address)) return address.toLowerCase()
  const url = URL.parse(address)
  if (url === null || !/^https?:$/.test(url.protocol) || url.username || url.password)
    throw unknown()
  if (url.hash.length > 1)
    throw new OperatorCommandError(
      'Ссылки вида /a#… команда пока не читает: попросите у заявителя адрес /artifacts/<id>.',
    )
  const match = /^\/artifacts\/([^/]+)\/?$/.exec(url.pathname)
  if (!match || !UUID.test(match[1]!)) throw unknown()
  return match[1]!.toLowerCase()
}

export const artifactsHelp = (command: ArtifactsCommand) =>
  `artifacts:${command} -- <адрес> --reason "<причина>" [--operator <имя>]\n` +
  (command === 'take-down'
    ? 'Закрывает артефакт по жалобе: его не откроют ни владелец, ни те, кому он открыт, ни их агенты. Корзина и очистка этого не отменяют. Опубликованные из него страницы снимает pages:take-down.\n'
    : 'Открывает артефакт, который закрыла поддержка.\n') +
  'Адрес — https://raditi.ru/artifacts/<id> или id. Решение пишется в журнал аудита с причиной; повтор ничего не меняет.\n' +
  '--operator — имя оператора для журнала; без него берётся имя пользователя ОС.\n' +
  'Окружение задаётся явно; команда не загружает .env автоматически. Нужны APP_ENV и DATABASE_URL.\n'

export async function runArtifactsCommand(
  command: ArtifactsCommand,
  args: readonly string[],
  env: Env = process.env,
  write: Write = (text) => void process.stdout.write(text),
): Promise<void> {
  try {
    const options = parseArtifactsArguments(args)
    if (options.help) {
      write(artifactsHelp(command))
      return
    }
    const artifactId = artifactIdOf(options.value.address)
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
      const result = await operatorArtifactDecision(prisma, {
        artifactId,
        decision: command === 'take-down' ? 'take_down' : 'return',
        reason: options.value.reason,
        operator,
      })
      const what = `Артефакт ${artifactId}`
      if (result.kind === 'not_found') throw new OperatorCommandError(`${what} не найден.`)
      if (result.kind === 'repeated') write(`${what}: уже так, ничего не изменено.\n`)
      else
        write(
          command === 'take-down'
            ? `${what} закрыт поддержкой.\n`
            : `${what} снова открыт владельцу и тем, кому он открыт.\n`,
        )
    } finally {
      await prisma.$disconnect().catch(() => undefined)
    }
  } catch (error) {
    if (error instanceof OperatorCommandError) throw new Error(error.message, { cause: error })
    throw new Error(
      'Команда артефактов не завершена. Проверьте окружение и доступность базы данных.',
      { cause: error },
    )
  }
}
