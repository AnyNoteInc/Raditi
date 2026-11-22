import { createPrismaClient, dbConfigFromEnv, operatorPageDecision } from '@repo/db'
import {
  appEnvSchema,
  pagePathSchema,
  pageHostLabelSchema,
  pagesBaseDomainSchema,
  type Env,
} from '@repo/domain'

import {
  OperatorCommandError,
  operatorName,
  parseOperatorArguments,
  type OperatorOptions,
} from '../operator/operator-args.ts'

// The operator's commands of published pages (docs/plan/73-pages-sites.md, Дер18; Ст31):
//
//   pnpm --filter core pages:take-down -- <address> --reason "…" [--operator <name>]
//   pnpm --filter core pages:return -- <address> --reason "…" [--operator <name>]
//
// The address is the one a complaint names: https://<slug>.pages.raditi.ru/ — the whole site,
// 410 on every path — or https://<slug>.pages.raditi.ru/a/b — that page alone. `take-down` stands
// over the client's take-down and over the trash: neither a deletion nor a purge removes what the
// support took down. `return` takes back only what the support took down. Each decision is an
// audit entry with the reason; repeating it changes nothing.
//
// Environment, given explicitly (no `.env` is loaded): APP_ENV and DATABASE_URL, as the core
// role has them. On the app VM: `docker compose run --rm --no-deps --entrypoint node core
// scripts/pages-take-down.mjs <address> …`. Nothing secret is taken or printed.

export type PagesCommand = 'take-down' | 'return'
type Write = (text: string) => void

const invalid = () =>
  new OperatorCommandError('Неверные параметры команды страниц. Используйте --help.')

export type PagesOptions = OperatorOptions

/** Strict argument parsing completes before reading the environment or connecting anywhere. */
export const parsePagesArguments = (written: readonly string[]): PagesOptions =>
  parseOperatorArguments(written, invalid)

/**
 * The site and the path of an address: one label under a base domain and a canonical path. The
 * base domain is not checked here — the slug is unique across them all.
 */
export function addressOf(address: string): { slug: string; path: string } {
  // The URL parser resolves dots on its own: an address with them names another page than it says.
  if (/\/\.{1,2}(?:[/?#]|$)|%2e/i.test(address))
    throw new OperatorCommandError('Путь страницы не распознан.')
  const url = URL.parse(address)
  if (url === null || !/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new OperatorCommandError('Адрес страницы не распознан: нужен https://<сайт>.pages…/путь.')
  const host = url.hostname.toLowerCase()
  const dot = host.indexOf('.')
  // A random slug or the own name of a site (docs/plan/73-pages-sites.md, Дер33).
  const slug = pageHostLabelSchema.safeParse(host.slice(0, dot))
  if (dot < 1 || !slug.success || !pagesBaseDomainSchema.safeParse(host.slice(dot + 1)).success)
    throw new OperatorCommandError('Адрес страницы не распознан: нужен https://<сайт>.pages…/путь.')
  const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '')
  if (!pagePathSchema.safeParse(path).success)
    throw new OperatorCommandError('Путь страницы не распознан.')
  return { slug: slug.data, path }
}

export const pagesHelp = (command: PagesCommand) =>
  `pages:${command} -- <адрес> --reason "<причина>" [--operator <имя>]\n` +
  (command === 'take-down'
    ? 'Снимает с публикации по жалобе: адрес главной — весь сайт (410 на всех путях), адрес страницы — её одну. Клиент вернуть снятое поддержкой не может, удалить — тоже.\n'
    : 'Возвращает на публикацию то, что сняла поддержка. Снятое клиентом команда не трогает.\n') +
  'Решение пишется в журнал аудита с причиной; повтор ничего не меняет.\n' +
  '--operator — имя оператора для журнала; без него берётся имя пользователя ОС.\n' +
  'Окружение задаётся явно; команда не загружает .env автоматически. Нужны APP_ENV и DATABASE_URL.\n'

export async function runPagesCommand(
  command: PagesCommand,
  args: readonly string[],
  env: Env = process.env,
  write: Write = (text) => void process.stdout.write(text),
): Promise<void> {
  try {
    const options = parsePagesArguments(args)
    if (options.help) {
      write(pagesHelp(command))
      return
    }
    const { slug, path } = addressOf(options.value.address)
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
      const result = await operatorPageDecision(prisma, {
        slug,
        path,
        decision: command === 'take-down' ? 'take_down' : 'return',
        reason: options.value.reason,
        operator,
      })
      const what = path === '/' ? `Сайт ${slug}` : `Страница ${path} сайта ${slug}`
      if (result.kind === 'not_found') throw new OperatorCommandError(`${what} не найдена.`)
      if (result.kind === 'repeated') write(`${what}: уже так, ничего не изменено.\n`)
      else
        write(
          command === 'take-down'
            ? `${what} снята с публикации поддержкой.\n`
            : `${what} возвращена на публикацию.\n`,
        )
    } finally {
      await prisma.$disconnect().catch(() => undefined)
    }
  } catch (error) {
    if (error instanceof OperatorCommandError) throw new Error(error.message, { cause: error })
    throw new Error(
      'Команда страниц не завершена. Проверьте окружение и доступность базы данных.',
      {
        cause: error,
      },
    )
  }
}
