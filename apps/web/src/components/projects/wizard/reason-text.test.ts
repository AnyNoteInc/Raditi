import { connectionCheckReasons } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { callErrorText, databaseReasonText, OFFLINE, sourceReasonText } from './reason-text'

const context = { kind: 'sftp', platform: 'WordPress' }
/** Latin words a client would not know; the names of protocols and products are fine. */
const jargon = /\b(?:host|key|TLS handshake|ECONN|timeout|socket|DNS|root|SFTP)\b/i

describe('the texts of a refused check', () => {
  it.each(connectionCheckReasons)('says %s of the files in plain Russian', (reason) => {
    const text = sourceReasonText(reason, context)
    expect(text).toMatch(/^[А-ЯЁ]/)
    expect(text).toMatch(/[.»]$/)
    expect(text).not.toMatch(jargon)
  })

  it.each(connectionCheckReasons)('says %s of the database in plain Russian', (reason) => {
    const text = databaseReasonText(reason)
    expect(text).toMatch(/^[А-ЯЁ]/)
    expect(text).not.toMatch(jargon)
  })

  it('names the platform whose files the folder lacks', () => {
    expect(sourceReasonText('not_site_root', context)).toBe(
      'В этой папке нет файлов сайта на WordPress. Укажите папку, где лежат файлы сайта.',
    )
  })

  it('tells the database and the files apart where it matters', () => {
    for (const reason of ['unreachable', 'auth_failed', 'not_found', 'access_denied'] as const) {
      expect(databaseReasonText(reason)).not.toBe(sourceReasonText(reason, context))
      expect(databaseReasonText(reason)).toMatch(/баз/)
    }
  })

  it('names the protection to choose when the server takes only encrypted connections', () => {
    expect(sourceReasonText('tls_required', { ...context, kind: 'ftp' })).toContain(
      'Выберите FTPS в поле «Защита соединения»',
    )
    expect(databaseReasonText('tls_required')).toContain('Выберите TLS в поле «Защита соединения»')
    // Not a refused login: the user name and the password are not what to check.
    expect(sourceReasonText('tls_required', { ...context, kind: 'ftp' })).not.toMatch(/парол/)
  })

  it('names the protocol the server must accept', () => {
    expect(sourceReasonText('unreachable', { ...context, kind: 'ftp' })).toContain('по FTP')
    expect(sourceReasonText('unreachable', context)).toContain('по SSH')
  })
})

describe('the text of a failed call', () => {
  const texts = { invalid: 'Проверьте данные.', failed: 'Не получилось.' }

  it('passes on the Russian text of a refusal of the domain, with a full stop', () => {
    const refusal = Object.assign(new Error('Сайт с таким адресом уже добавлен'), {
      data: { code: 'CONFLICT', domainCode: 'PROJECT_ALREADY_EXISTS' },
    })
    expect(callErrorText(refusal, texts)).toBe('Сайт с таким адресом уже добавлен.')
  })

  it('never shows the text of an input the server did not take, or of a failure', () => {
    const invalid = Object.assign(new Error('[{"code":"invalid_type"}]'), {
      data: { code: 'BAD_REQUEST', domainCode: null },
    })
    expect(callErrorText(invalid, texts)).toBe('Проверьте данные.')
    const failure = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
      data: { code: 'INTERNAL_SERVER_ERROR', domainCode: null },
    })
    expect(callErrorText(failure, texts)).toBe('Не получилось.')
  })

  it('says the server was not reached when no answer came', () => {
    expect(callErrorText(new Error('Failed to fetch'), texts)).toBe(OFFLINE)
  })
})
