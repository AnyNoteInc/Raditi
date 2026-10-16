import { describe, expect, it } from 'vitest'

import { formatMoscowMoment } from '@/lib/moscow-date'

import { accessLabel } from './site-format'

describe('site page formatting', () => {
  it('shows a moment in Moscow time', () => {
    expect(formatMoscowMoment(new Date('2026-10-04T09:40:00Z'))).toBe('4\u00a0октября 2026, 12:40')
    expect(formatMoscowMoment(new Date('2026-12-31T21:05:00Z'))).toBe('1\u00a0января 2027, 00:05')
  })

  it('names the accesses a site can have and does not fail on a new kind', () => {
    expect(accessLabel('ftp')).toBe('SFTP / FTP')
    expect(accessLabel('wp')).toBe('Вход в панель сайта')
    expect(accessLabel('something-new')).toBe('Доступ')
  })
})
