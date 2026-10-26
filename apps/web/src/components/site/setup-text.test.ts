import {
  connectionCheckReasons,
  provisioningErrorCodes,
  siteConnectionLimits,
  siteImportLimits,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { RETRIES_PER_HOUR, setupErrorText, setupStageText } from './setup-text'

const context = { kind: 'sftp', platform: 'WordPress' }

describe('the setup screen', () => {
  it.each([
    [{ status: 'queued', step: null }, 'Ожидаем начала настройки'],
    [{ status: 'running', step: 'fetch' }, 'Копируем файлы сайта'],
    [{ status: 'running', step: null }, 'Копируем файлы сайта'],
    [{ status: 'running', step: 'publish' }, 'Сохраняем первоначальную версию'],
  ])('names the stage %o', (stage, title) => {
    expect(setupStageText(stage).title).toBe(title)
  })

  it.each(provisioningErrorCodes)('explains the stop %s without a detail of ours', (code) => {
    const text = setupErrorText(code, context)
    expect(text).toMatch(/^[А-ЯЁ]/)
    expect(text).toMatch(/[.»]$/)
    // No code, no English word of our machinery.
    expect(text).not.toMatch(/[a-z]+_[a-z]+|\b(?:git|gitleaks|Vault|repository|push|commit)\b/i)
  })

  it('says the import-only codes in words of their own', () => {
    const importCodes = provisioningErrorCodes.filter(
      (code) => !(connectionCheckReasons as readonly string[]).includes(code),
    )
    for (const code of importCodes) {
      expect(setupErrorText(code, context)).not.toBe(setupErrorText(null, context))
    }
  })

  it('names the ceilings of an import as the domain has them', () => {
    expect(siteImportLimits.files).toBe(100_000)
    expect(siteImportLimits.treeBytes).toBe(1024 * 1024 * 1024)
    expect(setupErrorText('source_too_large', context)).toContain('100 000 файлов и до 1 ГБ')
    expect(RETRIES_PER_HOUR).toBe(siteConnectionLimits.retriesPerHour)
  })

  it('tells an access that stopped working from one that never did', () => {
    expect(setupErrorText('auth_failed', context)).toMatch(/сохранённые данные/)
    expect(setupErrorText('host_key_changed', context)).toMatch(/укажите доступ заново/)
    expect(setupErrorText('not_site_root', context)).toContain('WordPress')
    expect(setupErrorText('tls_required', { ...context, kind: 'ftp' })).toBe(
      'Сервер больше не принимает подключения без шифрования. Укажите доступ заново и выберите FTPS в поле «Защита соединения».',
    )
  })

  it('says that the copying broke, not that the listing failed, once the access was saved', () => {
    expect(setupErrorText('transfer_failed', context)).toMatch(/пока мы копировали файлы/)
    expect(setupErrorText('transfer_failed', context)).not.toMatch(/список файлов/)
    expect(setupErrorText('unreachable', context)).toMatch(/перестал принимать подключения/)
  })
})
