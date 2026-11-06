import { describe, expect, it } from 'vitest'

import { agentNotesOf, codeNotesOf } from './site-notes.ts'

describe('agentNotesOf', () => {
  it('keeps the hints trimmed, and none when nothing is written', () => {
    expect(agentNotesOf('  Вход по адресу /wp-login.php\nНовости — рубрика «Пресса»  ')).toBe(
      'Вход по адресу /wp-login.php\nНовости — рубрика «Пресса»',
    )
    for (const blank of [undefined, '', ' \n\t ', '​']) expect(agentNotesOf(blank)).toBeNull()
  })

  it('refuses a text that is too long, that a row cannot store or that looks like a secret', () => {
    expect(() => agentNotesOf('я'.repeat(2001))).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOTES_TOO_LONG' }),
    )
    expect(agentNotesOf('я'.repeat(2000))).toHaveLength(2000)
    expect(() => agentNotesOf('Вход\u0000')).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOTES_INVALID' }),
    )
    expect(() => agentNotesOf('Вход \ud800')).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOTES_INVALID' }),
    )
    expect(() => agentNotesOf('логин admin, пароль: Qwerty123456')).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOTES_HAS_SECRET' }),
    )
  })
})

// The wizard reads what a person typed; the answer to `/init` is full of names (docs/plan/61, К31).
describe('codeNotesOf', () => {
  const answer = 'Тема — `Astra-Child`, шапка — `Header.php`, начните с `README.md`.'

  it('keeps an answer about code the wizard would refuse', () => {
    expect(codeNotesOf(`  ${answer}\n`)).toBe(answer)
    expect(() => agentNotesOf(answer)).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOTES_HAS_SECRET' }),
    )
  })

  it('refuses what the wizard refuses for a row, and a named secret', () => {
    expect(codeNotesOf(' \n ')).toBeNull()
    expect(() => codeNotesOf('я'.repeat(2001))).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOTES_TOO_LONG' }),
    )
    expect(() => codeNotesOf('Вход\u0000')).toThrow(
      expect.objectContaining({ code: 'PROJECT_NOTES_INVALID' }),
    )
    for (const secret of ['пароль: Qwerty123', 'sk-abcdefghijklmnopqrstuvwxyz'])
      expect(() => codeNotesOf(secret)).toThrow(
        expect.objectContaining({ code: 'PROJECT_NOTES_HAS_SECRET' }),
      )
  })
})
