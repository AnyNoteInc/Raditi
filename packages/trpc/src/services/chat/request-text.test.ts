import { FEED_REQUEST_TEXT_LIMIT, feedLimits } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { dialogTitle, requestPayload, requestText } from './request-text.ts'

const ids = {
  authorId: '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60',
  requestId: '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61',
}

describe('the words of the client', () => {
  it('are kept trimmed, as the feed stores them', () => {
    expect(requestText('  Поменяйте телефон в шапке \n')).toBe('Поменяйте телефон в шапке')
  })

  it('are refused in the client’s terms: nothing to read, too long, a password or a key', () => {
    for (const empty of ['', '   ', '​​', '\n\t'])
      expect(() => requestText(empty), JSON.stringify(empty)).toThrow(
        expect.objectContaining({ code: 'TASK_TEXT_EMPTY' }),
      )
    expect(() => requestText('я'.repeat(FEED_REQUEST_TEXT_LIMIT + 1))).toThrow(
      expect.objectContaining({ code: 'TASK_TEXT_TOO_LONG' }),
    )
    expect(requestText(` ${'я'.repeat(FEED_REQUEST_TEXT_LIMIT)} `)).toHaveLength(
      FEED_REQUEST_TEXT_LIMIT,
    )
    const secret = expect.objectContaining({ code: 'TASK_TEXT_HAS_SECRET', httpStatus: 400 })
    expect(() => requestText('Войдите: логин admin, пароль: Qwerty123456')).toThrow(secret)
    expect(() => requestText(`Ключ ghp_${'A'.repeat(30)}`)).toThrow(secret)
  })

  it('never repeat the words in the message of a refusal', () => {
    try {
      requestText('пароль: Qwerty123456')
    } catch (error) {
      expect((error as Error).message).not.toContain('Qwerty')
    }
  })

  it('refuse what the feed cannot store, before the transaction', () => {
    expect(() =>
      requestPayload({ v: 1, kind: 'first', ...ids, text: 'Звонок\u0007 в шапке' }),
    ).toThrow(expect.objectContaining({ code: 'TASK_TEXT_INVALID' }))
    expect(requestPayload({ v: 1, kind: 'first', ...ids, text: 'Строка\nещё' })).toMatchObject({
      text: 'Строка\nещё',
    })
  })
})

describe('the title of a dialog', () => {
  it('is the first line with something to read, spaces collapsed', () => {
    expect(dialogTitle('\n  ​\n  Поменяйте   телефон \nв шапке')).toBe('Поменяйте телефон')
  })

  it('hides what the feed hides', () => {
    expect(dialogTitle('Позвоните [[raditi:phone:3f2b8c1e-5d4a-4b6c-8e7f-9a0b1c2d3e4f]]')).toBe(
      'Позвоните (телефон скрыт)',
    )
  })

  it('keeps 120 characters at most, cut with an ellipsis and never inside a pair', () => {
    const long = `${'а'.repeat(118)}😀😀`
    const title = dialogTitle(long)!
    expect(title.length).toBeLessThanOrEqual(feedLimits.title)
    expect(title.endsWith('…')).toBe(true)
    expect(title.isWellFormed()).toBe(true)
    expect(dialogTitle('я'.repeat(feedLimits.title))).toBe('я'.repeat(feedLimits.title))
  })
})
