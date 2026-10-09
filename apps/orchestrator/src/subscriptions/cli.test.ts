import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { agentDriverIds, badRequest, conflict, llmGatewayUnavailable } from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { afterEach, describe, expect, it } from 'vitest'

import {
  operatorFailure,
  parseSubscriptionArguments,
  subscriptionHelp,
  subscriptionImports,
  type SubscriptionCommand,
} from './cli.ts'
import { UnsavedSubscriptionLogin } from './device-login.ts'
import { SubscriptionLoginError } from './login.ts'
import { retirementRefusals } from './retire.ts'

const account = 'c96006db-9cfb-4d2c-819e-66802f97879f'
const cwd = fileURLToPath(new URL('../../', import.meta.url))
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function command(
  name: SubscriptionCommand,
  args: string[],
  { env = {}, input = '' }: { env?: Record<string, string>; input?: string } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [`scripts/subscription-${name}.mjs`, ...args], {
      cwd,
      env: { PATH: process.env.PATH, ...env },
      stdio: 'pipe',
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.stdin.on('error', () => undefined)
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      })
    })
    child.stdin.end(input)
  })
}
async function fakeVault(auth: object) {
  const requests: { path: string; token: string | undefined; body: unknown }[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({
        path: req.url!,
        token: req.headers['x-vault-token'] as string | undefined,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ auth }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { requests, address: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

describe('operator subscription commands', () => {
  it.each(['login', 'retire', 'token'] as const)(
    'native %s entrypoint supports help without env or service connections',
    async (name) => {
      expect(parseSubscriptionArguments(name, ['--', '--help'])).toEqual({
        command: name,
        help: true,
      })
      const result = await command(name, ['--help'])
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(subscriptionHelp(name))
      expect(result.stderr).toBe('')
    },
  )
  it('imports a Z.ai plan key for the OpenCode driver: one turn and two requests at a time', () => {
    expect(
      parseSubscriptionArguments('login', [
        '--backend',
        'zai-coding',
        '--label',
        'glm-a',
        '--plan',
        'lite',
        '--vault-token-file',
        '/tmp/writer',
      ]),
    ).toMatchObject({ command: 'login', value: { backend: 'zai-coding', plan: 'lite' } })
    const entry = subscriptionImports.get('zai-coding')!
    expect(entry.backend.id).toBe('zai-coding')
    expect(entry).toMatchObject({ driverId: 'opencode', turns: 1, requests: 2 })
    // A key from stdin, no device page.
    expect(entry.backend.importCredential).toBeTypeOf('function')
    expect(entry.backend.login).toBeUndefined()
    expect(entry.deviceUri).toBeUndefined()
  })
  it('has import settings for every backend the platform registers', () => {
    // `--backend` accepts every registered id: one without settings would fail after parsing.
    expect([...subscriptionImports.keys()]).toEqual(llmBackends.map((backend) => backend.id))
    for (const [id, entry] of subscriptionImports) {
      expect(entry.backend.id).toBe(id)
      expect(agentDriverIds).toContain(entry.driverId)
      expect(Boolean(entry.deviceUri)).toBe(entry.backend.login !== undefined)
      expect(
        entry.backend.login !== undefined || entry.backend.importCredential !== undefined,
      ).toBe(true)
    }
  })
  it('builds the help of login from the import settings', () => {
    const help = subscriptionHelp('login')
    expect(help).toContain('--backend openai-chatgpt|kimi-code|zai-coding ')
    expect(help).toContain(
      'Ключ подписки (kimi-code, zai-coding) поступает через stdin или скрытый ввод.',
    )
    expect(help).toContain('Код входа (openai-chatgpt) выводится только в интерактивный терминал.')
  })
  it('accepts a fresh import and the separate relogin form', () => {
    expect(
      parseSubscriptionArguments('login', [
        '--backend',
        'kimi-code',
        '--label',
        'local-kimi',
        '--plan',
        'pro',
        '--vault-token-file',
        '/tmp/writer',
      ]),
    ).toMatchObject({ command: 'login', value: { backend: 'kimi-code', plan: 'pro' } })
    expect(
      parseSubscriptionArguments('login', [
        '--backend',
        'openai-chatgpt',
        '--relogin',
        account,
        '--vault-token-file',
        '/tmp/writer',
      ]),
    ).toMatchObject({ command: 'login', value: { relogin: account } })
  })
  it.each([
    ['login', ['--backend', 'openai-chatgpt', '--label', 'a', '--vault-token-file', 'relative']],
    [
      'login',
      [
        '--backend',
        'openai-chatgpt',
        '--relogin',
        account,
        '--label',
        'a',
        '--vault-token-file',
        '/tmp/token',
      ],
    ],
    ['login', ['--backend', 'private-api-key']],
    ['retire', ['--account', account, '--compromised']],
    ['retire', ['--account', account, '--finalize']],
    ['retire', ['--account', account, '--console-revoked']],
    ['retire', ['--account', account, '--account', account]],
    ['retire', ['--account', 'private-invalid-id']],
    ['retire', ['--account', account]],
    ['retire', ['--account', account, '--label', 'a', '--cancel']],
    [
      'retire',
      ['--account', account, '--cancel', '--finalize', '--vault-token-file', '/tmp/admin'],
    ],
    ['token', ['--policy', 'root', '--out', '/tmp/token']],
    ['token', ['--policy', 'writer', '--out', '/tmp/token', '--secret', 'private-token']],
  ] as const)('rejects malformed %s options with fixed text', (name, args) => {
    expect(() => parseSubscriptionArguments(name, args)).toThrow(
      /^Неверные параметры команды подписок\. Используйте --help\.$/,
    )
  })
  // Cases are named, not printed with %j: JSON leaves C1 controls raw, and the reporter would
  // write them to the terminal and the CI log.
  const controls = [
    ['U+009B, an 8-bit CSI', 'a\u009bb'],
    ['U+0085, a next-line', 'a\u0085b'],
    ['U+007F, a delete', 'a\u007fb'],
    ['a tab', 'a\tb'],
    ['a line feed', 'a\nb'],
  ] as const
  it.each(controls)(
    'rejects a new label with %s: it would reach the terminal and the logs',
    (_name, label) => {
      const refused = /^Неверные параметры команды подписок\. Используйте --help\.$/
      expect(() =>
        parseSubscriptionArguments('login', [
          '--backend',
          'kimi-code',
          '--label',
          label,
          '--plan',
          'pro',
          '--vault-token-file',
          '/tmp/writer',
        ]),
      ).toThrow(refused)
    },
  )
  it.each(controls)(
    'retires an account by a stored label with %s: the value is only compared',
    (_name, label) => {
      // The rule above is for new labels. A label stored before it (or written by hand) must
      // still be nameable here, or an emergency --compromised could not reach its account.
      expect(
        parseSubscriptionArguments('retire', [
          '--account',
          account,
          '--label',
          label,
          '--compromised',
          '--turns-token-file',
          '/tmp/turns',
        ]),
      ).toMatchObject({ command: 'retire', value: { label, compromised: true } })
    },
  )
  it.each([
    ['empty', ''],
    ['longer than the column', 'x'.repeat(256)],
  ])('rejects a retirement label that is %s', (_name, label) => {
    expect(() =>
      parseSubscriptionArguments('retire', ['--account', account, '--label', label]),
    ).toThrow(/^Неверные параметры команды подписок\. Используйте --help\.$/)
  })
  it('accepts a one-line label in Cyrillic', () => {
    const label = 'Кодекс — основной №1'
    expect(
      parseSubscriptionArguments('login', [
        '--backend',
        'openai-chatgpt',
        '--label',
        label,
        '--vault-token-file',
        '/tmp/writer',
      ]),
    ).toMatchObject({ command: 'login', value: { label } })
    expect(
      parseSubscriptionArguments('retire', ['--account', account, '--label', label]),
    ).toMatchObject({ command: 'retire', value: { label } })
  })
  it('names the account to retire twice, and cancels by its id alone', () => {
    expect(
      parseSubscriptionArguments('retire', ['--account', account, '--label', 'codex-a']),
    ).toMatchObject({ value: { account, label: 'codex-a', cancel: false } })
    expect(
      parseSubscriptionArguments('retire', [
        '--account',
        account,
        '--label',
        'codex-a',
        '--finalize',
        '--vault-token-file',
        '/tmp/admin',
      ]),
    ).toMatchObject({ value: { label: 'codex-a', finalize: true } })
    expect(parseSubscriptionArguments('retire', ['--account', account, '--cancel'])).toMatchObject({
      value: { account, cancel: true },
    })
  })
  it('shows fixed operator reasons and hides everything else', () => {
    expect(operatorFailure(conflict(retirementRefusals.notRequested)).message).toBe(
      'Вывод аккаунта не запрошен. Сначала выполните subscriptions:retire без --finalize.',
    )
    expect(operatorFailure(badRequest(retirementRefusals.automaticRevocation)).message).toContain(
      '--console-revoked не подходит',
    )
    for (const message of Object.values(retirementRefusals))
      expect(operatorFailure(conflict(message)).message).toMatch(/^[А-Я]/)
    for (const hidden of [
      new Error('refresh_token=private-token'),
      conflict('private-unlisted refusal'),
      llmGatewayUnavailable(),
    ])
      expect(operatorFailure(hidden).message).toBe(
        'Команда подписок не завершена. Проверьте настройки, доступность сервисов и права токена.',
      )
    expect(
      operatorFailure(
        new UnsavedSubscriptionLogin(new SubscriptionLoginError('account_conflict'), true),
      ).message,
    ).toMatch(/^Вход не завершён \(account_conflict\)\..* Выданный провайдером вход отозван\.$/)
    expect(
      operatorFailure(new UnsavedSubscriptionLogin(new Error('private-vault-body'), false)).message,
    ).toMatch(/^Команда подписок не завершена\..*Отозвать выданный провайдером вход не удалось/)
  })
  it('starts a production login with the documented environment and reports why it stopped', async () => {
    const env = {
      APP_ENV: 'production',
      VAULT_ADDR: 'https://127.0.0.1:1',
      DATABASE_URL: 'postgresql://raditi:private-password@127.0.0.1:1/raditi',
      LLM_EGRESS_PROXY_URL: 'https://127.0.0.1:1',
      LLM_EGRESS_CA_FILE: '/nonexistent/raditi/ca.pem',
      LLM_EGRESS_CLIENT_CERT_FILE: '/nonexistent/raditi/client.pem',
      LLM_EGRESS_CLIENT_KEY_FILE: '/nonexistent/raditi/client-key.pem',
    }
    const args = [
      '--backend',
      'kimi-code',
      '--label',
      'kimi-a',
      '--plan',
      'pro',
      '--vault-token-file',
      '/nonexistent/raditi/writer.token',
    ]
    // Without LLM_GATEWAY_*: the command reaches its channel check, which fails here.
    const login = await command('login', args, { env })
    expect(login.code).toBe(1)
    expect(login.stderr).toBe('Проверка канала выхода не прошла.\n')
    const invalid = await command('login', args, {
      env: { ...env, LLM_EGRESS_PROXY_URL: 'https://private-user:private-secret@127.0.0.1:1' },
    })
    expect(invalid.code).toBe(1)
    expect(invalid.stderr).toContain('Окружение задано неверно')
    expect(invalid.stderr).toContain('LLM_EGRESS_PROXY_URL')
    expect(invalid.stderr).not.toContain('private-')
  })
  it('writes a minted token only to the new private file, never to output', async () => {
    const vault = await fakeVault({
      client_token: 'private-minted-token',
      policies: ['subscriptions-writer'],
      lease_duration: 900,
      renewable: false,
    })
    const directory = await mkdtemp(join(tmpdir(), 'raditi-subscription-cli-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const out = join(directory, 'operator-token')
    const result = await command('token', ['--policy', 'writer', '--out', out], {
      env: { APP_ENV: 'test', VAULT_ADDR: vault.address },
      input: 'private-root-token\n',
    })
    expect(result.code).toBe(0)
    expect(result.stdout + result.stderr).not.toContain('private-')
    expect(await readFile(out, 'utf8')).toBe('private-minted-token')
    expect((await stat(out)).mode & 0o777).toBe(0o400)
    expect(vault.requests).toEqual([
      {
        path: '/v1/auth/token/create',
        token: 'private-root-token',
        body: {
          policies: ['subscriptions-writer'],
          no_default_policy: true,
          ttl: '15m',
          explicit_max_ttl: '15m',
          renewable: false,
        },
      },
    ])
    const second = await command('token', ['--policy', 'writer', '--out', out], {
      env: { APP_ENV: 'test', VAULT_ADDR: vault.address },
      input: 'private-root-token\n',
    })
    expect(second.code).toBe(1)
    expect(vault.requests).toHaveLength(1)
    expect(await readFile(out, 'utf8')).toBe('private-minted-token')
  })
  it('rejects production root minting before any network request', async () => {
    const vault = await fakeVault({})
    const result = await command(
      'token',
      ['--policy', 'writer', '--out', '/tmp/uncreated-raditi-token'],
      { env: { APP_ENV: 'production', VAULT_ADDR: vault.address }, input: 'private-root-token\n' },
    )
    expect(result.code).toBe(1)
    expect(vault.requests).toHaveLength(0)
    expect(result.stdout + result.stderr).not.toContain('private-root-token')
  })
  it('malformed privilege responses do not create a file or leak a token', async () => {
    const vault = await fakeVault({
      client_token: 'private-root-privileged',
      policies: ['root'],
      lease_duration: 900,
      renewable: false,
    })
    const directory = await mkdtemp(join(tmpdir(), 'raditi-subscription-cli-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const out = join(directory, 'uncreated')
    const result = await command('token', ['--policy', 'writer', '--out', out], {
      env: { APP_ENV: 'test', VAULT_ADDR: vault.address },
      input: 'private-root-token\n',
    })
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).not.toContain('private-')
    await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
