import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  parseResolveArguments,
  releasesFailure,
  resolveHelp,
  resolveReport,
} from './operator-cli.ts'

const RELEASE = '0199a000-0000-7000-8000-0000000000c3'
const SITE = '0199a000-0000-7000-8000-0000000000c4'
const REFUSED = 'Неверные параметры команды выпуска. Используйте --help.'
const UNFINISHED = 'Команда выпуска не завершена. Проверьте окружение и доступность базы данных.'
const cwd = fileURLToPath(new URL('../../', import.meta.url))

function command(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/releases-resolve.mjs', ...args], {
      cwd,
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      })
    })
  })
}

describe('releases:resolve', () => {
  it('answers its help from the native entrypoint without environment or connections', async () => {
    const result = await command(['--', '--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(resolveHelp)
    expect(resolveHelp).toContain('APP_ENV')
    expect(resolveHelp).toContain('DATABASE_URL')
  })

  it('reads the release, the decision, the reason and the operator, strictly', () => {
    expect(
      parseResolveArguments([
        '--',
        RELEASE.toUpperCase(),
        '--outcome',
        'rolled_back',
        '--reason',
        'Проверил файлы на хостинге',
        '--operator',
        'ops',
      ]),
    ).toEqual({
      help: false,
      value: {
        releaseId: RELEASE,
        outcome: 'rolled_back',
        reason: 'Проверил файлы на хостинге',
        operator: 'ops',
      },
    })
    for (const args of [
      [RELEASE, '--outcome', 'installed'],
      [RELEASE, '--outcome', 'failed', '--reason', 'r'],
      [RELEASE, '--outcome', 'installed', '--reason', 'r', '--reason', 'r'],
      [RELEASE, RELEASE, '--outcome', 'installed', '--reason', 'r'],
      ['not-a-uuid', '--outcome', 'installed', '--reason', 'r'],
      [RELEASE, '--outcome', 'installed', '--reason', 'r', '--force', 'yes'],
      [RELEASE, '--outcome', 'installed', '--reason'],
      [RELEASE, '--outcome', 'installed', '--reason', 'a\u0007b'],
    ])
      expect(() => parseResolveArguments(args)).toThrow(REFUSED)
  })

  it('asks for APP_ENV, then for the database by the name of its variable', async () => {
    const args = [RELEASE, '--outcome', 'installed', '--reason', 'r', '--operator', 'ops']
    const noEnv = await command(args)
    expect(noEnv.code).toBe(1)
    expect(noEnv.stdout).toBe('')
    expect(noEnv.stderr).toBe('Задайте APP_ENV: development, test или production.\n')
    const noDatabase = await command(args, { APP_ENV: 'test' })
    expect(noDatabase.code).toBe(1)
    expect(noDatabase.stderr).toBe('Окружение задано неверно: нужен DATABASE_URL.\n')
  })

  it('hides why the database could not be reached', async () => {
    const result = await command(
      [RELEASE, '--outcome', 'installed', '--reason', 'r', '--operator', 'ops'],
      {
        APP_ENV: 'production',
        DATABASE_URL: 'postgresql://raditi:private-password@127.0.0.1:1/raditi',
      },
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`${UNFINISHED}\n`)
    expect(result.stderr).not.toContain('private')
    expect(releasesFailure(new Error('password authentication failed')).message).toBe(UNFINISHED)
  })

  it('reports the decision in fixed words, and refuses what does not wait for an operator', () => {
    expect(
      resolveReport(
        { kind: 'resolved', status: 'installed', siteId: SITE, version: 'v1.2.0' },
        RELEASE,
      ),
    ).toContain('версия установлена')
    expect(
      resolveReport(
        { kind: 'repeated', status: 'rolled_back', siteId: SITE, version: 'v1.2.0' },
        RELEASE,
      ),
    ).toContain('ничего не изменено')
    expect(
      resolveReport(
        { kind: 'revert_retried', status: 'failed', siteId: SITE, version: 'v1.2.0' },
        RELEASE,
      ),
    ).toContain('core повторит revert-коммит в main')
    expect(() => resolveReport({ kind: 'refused', status: 'deploying' }, RELEASE)).toThrow(
      'не ждёт оператора',
    )
    expect(() => resolveReport({ kind: 'not_held', status: 'unknown' }, RELEASE)).toThrow(
      'ещё не передан оператору',
    )
    expect(() => resolveReport({ kind: 'not_found' }, RELEASE)).toThrow('не найден')
  })
})
