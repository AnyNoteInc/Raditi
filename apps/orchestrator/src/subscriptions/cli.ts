import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { createPrismaClient, dbConfigFromEnv } from '@repo/db'
import {
  appEnvSchema,
  clientIdentitySchema,
  isDomainError,
  llmBackendIdSchema,
  type Env,
  type LlmBackend,
} from '@repo/domain'
import { codexBackend, kimiCodeBackend, llmBackends, zaiCodingBackend } from '@repo/llm-backends'
import { createDevSubscriptionToken, createVaultSecretStore } from '@repo/vault'
import { z } from 'zod'

import { egressConfigFromEnv, type EgressConfig } from '../config/llm-config.ts'
import { createEgressProbe } from '../llm-gateway/egress-probe.ts'
import { createControlEgress, createEgressTransport } from '../llm-gateway/egress.ts'
import { SessionSubscriptionLock } from '../llm-gateway/session-lock.ts'
import { GatewayTurnCredentials } from '../llm/turn-credentials.ts'
import {
  authenticateSubscription,
  saveIssuedCredential,
  UnsavedSubscriptionLogin,
} from './device-login.ts'
import {
  createSubscriptionClientIdentity,
  subscriptionLabelSchema,
  SubscriptionLogin,
  SubscriptionLoginError,
} from './login.ts'
import {
  retirementLabelSchema,
  retirementRefusals,
  SubscriptionRetirement,
  type SubscriptionRetirementStage,
} from './retire.ts'
import {
  createOperatorTerminal,
  readSecretFile,
  readSecretInput,
  writeSecretFile,
} from './secret-input.ts'

export type SubscriptionCommand = 'login' | 'retire' | 'token'
const invalid = () => new Error('Неверные параметры команды подписок. Используйте --help.')
class OperatorCommandError extends Error {}
const path = z.string().refine(isAbsolute)
const account = z.uuid().regex(/^[0-9a-f-]+$/)
const plan = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9_-]+$/)
const date = z.iso.date().transform((value) => new Date(`${value}T00:00:00.000Z`))
const loginSchema = z
  .strictObject({
    backend: llmBackendIdSchema,
    label: subscriptionLabelSchema.optional(),
    relogin: account.optional(),
    plan: plan.optional(),
    paidUntil: date.optional(),
    vaultTokenFile: path,
  })
  .refine((value) =>
    value.relogin
      ? value.label === undefined && value.plan === undefined && value.paidUntil === undefined
      : value.label !== undefined,
  )
const retireSchema = z
  .strictObject({
    account,
    // The account is named twice, by id and by label: a mistyped id retires nothing.
    label: retirementLabelSchema.optional(),
    cancel: z.boolean().default(false),
    compromised: z.boolean().default(false),
    finalize: z.boolean().default(false),
    consoleRevoked: z.boolean().default(false),
    vaultTokenFile: path.optional(),
    turnsTokenFile: path.optional(),
  })
  .refine(
    (value) =>
      (!value.compromised || (!value.finalize && value.turnsTokenFile !== undefined)) &&
      (!value.finalize || value.vaultTokenFile !== undefined) &&
      (!value.consoleRevoked || value.finalize) &&
      (!value.vaultTokenFile || value.finalize) &&
      (value.cancel
        ? !value.compromised &&
          !value.finalize &&
          value.turnsTokenFile === undefined &&
          value.label === undefined
        : value.label !== undefined),
  )
const tokenSchema = z.strictObject({ policy: z.enum(['writer', 'admin']), out: path })
export type SubscriptionOptions =
  | { command: SubscriptionCommand; help: true }
  | { command: 'login'; help: false; value: z.output<typeof loginSchema> }
  | { command: 'retire'; help: false; value: z.output<typeof retireSchema> }
  | { command: 'token'; help: false; value: z.output<typeof tokenSchema> }

/** Strict argument parsing completes before reading environment, files or any secret. */
export function parseSubscriptionArguments(
  command: SubscriptionCommand,
  written: readonly string[],
): SubscriptionOptions {
  const args = written[0] === '--' ? written.slice(1) : written
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { command, help: true }
  const names: Record<string, string> = {
    '--backend': 'backend',
    '--label': 'label',
    '--relogin': 'relogin',
    '--plan': 'plan',
    '--paid-until': 'paidUntil',
    '--vault-token-file': 'vaultTokenFile',
    '--account': 'account',
    '--compromised': 'compromised',
    '--finalize': 'finalize',
    '--console-revoked': 'consoleRevoked',
    '--cancel': 'cancel',
    '--turns-token-file': 'turnsTokenFile',
    '--policy': 'policy',
    '--out': 'out',
  }
  const booleans = new Set(['compromised', 'finalize', 'consoleRevoked', 'cancel'])
  const value: Record<string, unknown> = {}
  for (let at = 0; at < args.length; at++) {
    const name = names[args[at]!]
    if (!name || Object.hasOwn(value, name)) throw invalid()
    if (booleans.has(name)) value[name] = true
    else {
      const next = args[++at]
      if (!next || next.startsWith('--')) throw invalid()
      value[name] = next
    }
  }
  if (command === 'login') {
    const parsed = loginSchema.safeParse(value)
    if (!parsed.success) throw invalid()
    return { command, help: false, value: parsed.data }
  }
  if (command === 'retire') {
    const parsed = retireSchema.safeParse(value)
    if (!parsed.success) throw invalid()
    return { command, help: false, value: parsed.data }
  }
  const parsed = tokenSchema.safeParse(value)
  if (!parsed.success) throw invalid()
  return { command, help: false, value: parsed.data }
}

// The platform's own list, the one the egress channel is configured from: an account of any of
// its backends can be retired here. An import also needs the settings below.
const backends = llmBackends
// Composition selects an adapter and its configured driver/capacity, without provider branches.
// A device-flow backend also names the only page the operator terminal may show.
export interface SubscriptionImport {
  backend: LlmBackend
  driverId: string
  turns: number
  requests: number
  deviceUri?: string
}
const imports = new Map<string, SubscriptionImport>([
  [
    codexBackend.id,
    {
      backend: codexBackend,
      driverId: 'codex',
      turns: 1,
      requests: 2,
      deviceUri: 'https://auth.openai.com/codex/device',
    },
  ],
  [kimiCodeBackend.id, { backend: kimiCodeBackend, driverId: 'kimi', turns: 2, requests: 3 }],
  // One turn at a time until the plan's real concurrency is measured (owner's question П4).
  [zaiCodingBackend.id, { backend: zaiCodingBackend, driverId: 'opencode', turns: 1, requests: 2 }],
])
/** Every backend `--backend` accepts has an entry: a login never meets an id without settings. */
export const subscriptionImports: ReadonlyMap<string, SubscriptionImport> = imports

export function subscriptionHelp(command: SubscriptionCommand): string {
  // Built from the settings above: a backend added there is named here.
  const entries = [...imports.values()]
  const ids = (list: SubscriptionImport[]) => list.map((entry) => entry.backend.id).join(', ')
  const keyed = entries.filter((entry) => entry.backend.importCredential)
  const device = entries.filter((entry) => entry.backend.login)
  const input = [
    keyed.length ? `Ключ подписки (${ids(keyed)}) поступает через stdin или скрытый ввод.` : '',
    device.length ? `Код входа (${ids(device)}) выводится только в интерактивный терминал.` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const usage = {
    login: `subscriptions:login -- --backend ${[...imports.keys()].join('|')} --label <имя> [--plan <план>] [--paid-until YYYY-MM-DD] --vault-token-file <абсолютный путь>\nПовторный вход: --backend <оболочка> --relogin <UUID> --vault-token-file <путь>.\n${input}`,
    retire:
      'subscriptions:retire -- --account <UUID> --label <метка> [--compromised --turns-token-file <путь>]\nОкончательное удаление: --account <UUID> --label <метка> --finalize --vault-token-file <путь> [--console-revoked].\n--console-revoked подтверждает ручной отзыв ключа в консоли провайдера.\nОтмена запроса, пока токены не отозваны: --account <UUID> --cancel.',
    token:
      'subscriptions:token -- --policy writer|admin --out <абсолютный путь>\nТокен dev-root поступает через stdin или скрытый ввод. Новый файл создаётся с правами 0400.\nТолько development/test и числовой loopback VAULT_ADDR; срок — 15 минут.',
  }
  return `${usage[command]}\nОкружение задаётся явно; команда не загружает .env автоматически. APP_ENV и VAULT_ADDR обязательны; login/retire также требуют DATABASE_URL, login — ещё LLM_EGRESS_PROXY_URL, LLM_EGRESS_CA_FILE, LLM_EGRESS_CLIENT_CERT_FILE и LLM_EGRESS_CLIENT_KEY_FILE.\n`
}

const stages: Record<SubscriptionRetirementStage, string> = {
  draining: 'Вывод запрошен. Ожидается завершение действующих ходов и вызовов.',
  turn_revocation_pending:
    'Допуск закрыт. Отзыв ключей хода ещё не завершён; повторите с --turns-token-file.',
  provider_revocation_pending: 'Допуск закрыт. Роль llm должна завершить отзыв токенов провайдера.',
  console_revocation_required:
    'Допуск закрыт. Отзовите ключ в консоли провайдера, затем выполните --finalize --console-revoked.',
  ready_for_finalization:
    'Отзыв завершён. Выполните --finalize с токеном admin для удаления из Vault.',
  retired: 'Аккаунт выведен; все версии его учётных данных удалены из Vault.',
  cancelled:
    'Запрос вывода отменён. Если аккаунт уже выключен, включите его вручную после обычных проверок.',
}

const retirementTexts: Record<string, string> = {
  [retirementRefusals.busy]:
    'Аккаунт сейчас обновляет другой процесс (обновление токена, вход или вывод). Повторите команду позже.',
  [retirementRefusals.automaticRevocation]:
    'Для этого аккаунта --console-revoked не подходит: токены отзывает роль llm.',
  [retirementRefusals.notRequested]:
    'Вывод аккаунта не запрошен. Сначала выполните subscriptions:retire без --finalize.',
  [retirementRefusals.unconfirmed]: 'Отзыв токенов у провайдера ещё не подтверждён.',
  [retirementRefusals.changed]: 'Состояние вывода изменилось во время команды. Повторите её.',
  [retirementRefusals.notDrained]:
    'Ходы и вызовы аккаунта ещё не завершились. Повторите команду позже.',
  [retirementRefusals.notFound]: 'Аккаунт не найден.',
  [retirementRefusals.unsupported]: 'Оболочка аккаунта не поддерживается этой командой.',
  [retirementRefusals.backendChanged]:
    'Оболочка аккаунта изменилась во время команды. Повторите её.',
  [retirementRefusals.foreignPath]:
    'Ссылка на учётные данные не совпадает с аккаунтом. Удаление остановлено, нужна ручная проверка.',
  [retirementRefusals.labelMismatch]: 'Метка не совпадает с аккаунтом. Проверьте UUID и --label.',
  [retirementRefusals.revoked]:
    'Токены аккаунта уже отозваны, вывод нельзя отменить. Чтобы вернуть подписку в пул, импортируйте её заново.',
}

/** Only fixed texts reach the operator; anything else may carry a credential or a response. */
export function operatorFailure(error: unknown): Error {
  let revocation = ''
  if (error instanceof UnsavedSubscriptionLogin) {
    revocation = error.revoked
      ? ' Выданный провайдером вход отозван.'
      : ' Отозвать выданный провайдером вход не удалось: завершите его в настройках безопасности аккаунта у провайдера.'
    error = error.failure
  }
  if (error instanceof OperatorCommandError) return new Error(`${error.message}${revocation}`)
  if (error instanceof SubscriptionLoginError) {
    const accountHint = error.accountId ? ` Аккаунт: ${error.accountId}.` : ''
    return new Error(
      `Вход не завершён (${error.code}).${accountHint} Для незавершённого импорта повторите вход с --relogin.${revocation}`,
    )
  }
  const known = isDomainError(error) ? retirementTexts[error.message] : undefined
  if (known) return new Error(`${known}${revocation}`)
  // Do not rethrow driver, database, Vault or JSON errors, which may expose private input.
  return new Error(
    `Команда подписок не завершена. Проверьте настройки, доступность сервисов и права токена.${revocation}`,
  )
}

/** parseEnv and the egress check name variables and rules, never their values. */
function configuration<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    throw new OperatorCommandError(
      `Окружение задано неверно: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`,
    )
  }
}

async function channelHealthy(egress: EgressConfig, signal: AbortSignal): Promise<boolean> {
  try {
    return await createEgressProbe(egress).check(
      AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    )
  } catch {
    // Unreadable mTLS files or a refused handshake: the channel is not usable either way.
    return false
  }
}

/** Thin operator entrypoint: no app bootstrap, dotenv discovery or secret-bearing logging. */
export async function runSubscriptionCommand(
  command: SubscriptionCommand,
  args: readonly string[],
  env: Env = process.env,
): Promise<void> {
  const options = parseSubscriptionArguments(command, args)
  if (options.help) {
    process.stdout.write(subscriptionHelp(command))
    return
  }
  const parsedEnv = appEnvSchema.safeParse(env.APP_ENV)
  if (!parsedEnv.success) throw new Error('Задайте APP_ENV: development, test или production.')
  const appEnv = parsedEnv.data
  const address = operatorVaultAddress(env.VAULT_ADDR, appEnv)
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    if (options.command === 'token') {
      if (appEnv === 'production')
        throw new OperatorCommandError(
          'В production используйте вход оператора в Vault; dev-root запрещён.',
        )
      await requireNewOutput(options.value.out)
      const rootToken = await readSecretInput('Токен dev-root: ', controller.signal)
      const token = await createDevSubscriptionToken({
        appEnv,
        addr: address,
        rootToken,
        policy: options.value.policy,
      })
      await writeSecretFile(options.value.out, token)
      process.stdout.write('Токен записан в новый закрытый файл. Срок действия — 15 минут.\n')
      return
    }
    const config = configuration(() => dbConfigFromEnv(env))
    const prisma = createPrismaClient({ ...config, log: [] })
    const locks = new SessionSubscriptionLock(config.databaseUrl)
    let terminal: Awaited<ReturnType<typeof createOperatorTerminal>> | undefined
    try {
      if (options.command === 'login') {
        const value = options.value
        const entry = imports.get(value.backend)!
        if (!value.relogin && entry.backend.importCredential && !value.plan)
          throw new OperatorCommandError('Для нового аккаунта с ключом укажите --plan.')
        // Only the egress channel: the command sends through it and never listens like the role.
        const egress = configuration(() => egressConfigFromEnv(env, appEnv))
        if (!egress)
          throw new OperatorCommandError(
            'Для входа требуется настроенный канал mTLS через узел выхода.',
          )
        // Fail before opening a device flow or accepting a subscription key on a broken channel.
        if (!(await channelHealthy(egress, controller.signal)))
          throw new OperatorCommandError('Проверка канала выхода не прошла.')
        const vaultToken = await readSecretFile(value.vaultTokenFile)
        const writer = createVaultSecretStore({ addr: address, token: vaultToken })
        const login = new SubscriptionLogin({ prisma, writer, locks, backends })
        let identity = createSubscriptionClientIdentity()
        if (value.relogin) {
          const existing = await prisma.subscriptionAccount.findUnique({
            where: { id: value.relogin },
            include: { provider: true },
          })
          const stable = clientIdentitySchema.safeParse(existing?.clientIdentity)
          if (
            !existing ||
            existing.provider.slug !== entry.backend.id ||
            existing.retireRequestedAt ||
            existing.status === 'retired' ||
            !stable.success
          )
            throw new OperatorCommandError('Аккаунт недоступен для повторного входа.')
          identity = stable.data
        }
        // A dead writer token or a taken label is refused before the provider issues anything.
        await login.preflight({
          backend: value.backend,
          ...(value.relogin ? {} : { label: value.label! }),
        })
        if (entry.backend.login) {
          if (!entry.deviceUri)
            throw new OperatorCommandError('Для этой оболочки не задан адрес страницы входа.')
          terminal = await createOperatorTerminal(entry.deviceUri)
        }
        const http = createControlEgress(createEgressTransport(egress))
        const credential = await authenticateSubscription({
          backend: entry.backend,
          identity,
          http,
          signal: controller.signal,
          readSecret: () => readSecretInput('Ключ подписки: ', controller.signal),
          showDeviceCode: async (state) => {
            if (!terminal) throw new Error('Интерактивный терминал недоступен.')
            await terminal.showDeviceCode(state)
          },
        })
        const result = await saveIssuedCredential({
          backend: entry.backend,
          credential,
          http,
          save: async () => {
            if (controller.signal.aborted) throw new OperatorCommandError('Операция прервана.')
            return value.relogin
              ? login.relogin({ backend: value.backend, accountId: value.relogin, credential })
              : login.importAccount({
                  backend: value.backend,
                  driverId: entry.driverId,
                  credential,
                  label: value.label!,
                  plan: value.plan,
                  paidUntil: value.paidUntil,
                  clientIdentity: identity,
                  maxConcurrentTurns: entry.turns,
                  maxConcurrentRequests: entry.requests,
                })
          },
        })
        process.stdout.write(
          JSON.stringify({
            accountId: result.accountId,
            backend: result.backend,
            credentialVersion: result.credentialVersion,
            enabled: result.enabled,
          }) + '\n',
        )
      } else {
        const value = options.value
        const secrets = value.vaultTokenFile
          ? createVaultSecretStore({
              addr: address,
              token: await readSecretFile(value.vaultTokenFile),
            })
          : {
              kvDestroyAll: async () => {
                throw new Error('Admin token required')
              },
            }
        const credentials = value.turnsTokenFile
          ? new GatewayTurnCredentials({
              prisma,
              secrets: createVaultSecretStore({
                addr: address,
                token: await readSecretFile(value.turnsTokenFile),
              }),
            })
          : {
              revoke: async () => {
                throw new Error('Turn token required')
              },
            }
        const retirement = new SubscriptionRetirement({
          prisma,
          secrets,
          credentials,
          locks,
          backends,
        })
        const result = value.cancel
          ? await retirement.cancel({ accountId: value.account })
          : value.finalize
            ? await retirement.finalize({
                accountId: value.account,
                consoleRevoked: value.consoleRevoked,
                label: value.label,
              })
            : await retirement.request({
                accountId: value.account,
                compromised: value.compromised,
                label: value.label,
              })
        process.stdout.write(`${stages[result.stage]}\n`)
      }
    } finally {
      await terminal?.close().catch(() => undefined)
      await locks.close().catch(() => undefined)
      await prisma.$disconnect().catch(() => undefined)
    }
  } catch (error) {
    throw operatorFailure(error)
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
}

function operatorVaultAddress(raw: string | undefined, appEnv: string): string {
  const url = raw ? URL.parse(raw) : null
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (appEnv === 'production' && url.protocol !== 'https:')
  )
    throw new Error(
      'Задайте корректный VAULT_ADDR без учётных данных и пути; в production требуется HTTPS.',
    )
  return url.origin
}

async function requireNewOutput(file: string): Promise<void> {
  try {
    await lstat(file)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return
    // Keep operator filesystem details private.
    throw new OperatorCommandError('Не удалось проверить новый файл токена.')
  }
  throw new OperatorCommandError('Файл токена уже существует.')
}
