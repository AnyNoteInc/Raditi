import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import { feedTaskHeadSchema } from '../tasks/client-feed.ts'
import {
  compareProjects,
  instructionsLookLikeSecret,
  projectGoalOf,
  projectIdSchema,
  projectInstructionsOf,
  projectLimits,
  projectNameOf,
  projectPurgeAfter,
  projectRefusalTexts,
  sectionValue,
  secretInContent,
  textPieces,
  type ProjectOrderFacts,
} from './index.ts'

const codeOf = (act: () => unknown): string | null => {
  try {
    act()
    return null
  } catch (error) {
    return isDomainError(error) ? error.code : 'not a domain error'
  }
}

/** Ordinary prose without a word of a password's shape, `length` characters long. */
const prose = (length: number) => {
  const sentence =
    'Пишите коротко и вежливо, называйте цены в рублях и отвечайте на вопросы клиентов. '
  return sentence
    .repeat(Math.ceil(length / sentence.length))
    .slice(0, length)
    .trim()
}

const reactFile = `import { useState } from 'react'
import { Button, TextField } from '@mui/material'

export function LoginForm({ onSubmit }: { onSubmit: (login: string, password: string) => void }) {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const token = useAuthToken()
  return (
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(login, password) }}>
      <TextField label="Логин" value={login} onChange={(e) => setLogin(e.target.value)} />
      <TextField label="Пароль" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <Button type="submit" disabled={!token}>Войти</Button>
      {document.getElementById('root')?.innerText}
    </form>
  )
}
`.repeat(20)

describe('the name, the goal and the instructions of a project (ПР5, ПР7)', () => {
  it('keeps a name of one line up to 80 characters', () => {
    expect(projectNameOf('  Сайт\n кофейни  ')).toBe('Сайт кофейни')
    expect(projectNameOf('я'.repeat(80))).toHaveLength(80)
    expect(codeOf(() => projectNameOf('я'.repeat(81)))).toBe('PROJECT_NAME_INVALID')
    expect(codeOf(() => projectNameOf('  \u200b '))).toBe('PROJECT_NAME_INVALID')
  })

  it('reads an empty goal as none and refuses a long one', () => {
    expect(projectGoalOf(undefined)).toBeNull()
    expect(projectGoalOf('   ')).toBeNull()
    expect(projectGoalOf(' Продавать кофе ')).toBe('Продавать кофе')
    expect(codeOf(() => projectGoalOf('я'.repeat(501)))).toBe('PROJECT_GOAL_TOO_LONG')
  })

  it('takes instructions of 7999 characters and refuses 8001', () => {
    const text = prose(7999)
    expect(text.length).toBeGreaterThan(7900)
    expect(projectInstructionsOf(text)).toBe(text)
    expect(projectInstructionsOf('  ')).toBeNull()
    expect(codeOf(() => projectInstructionsOf('я'.repeat(8001)))).toBe(
      'PROJECT_INSTRUCTIONS_TOO_LONG',
    )
  })

  it('refuses a password in long instructions, wherever the cut falls', () => {
    const text = `${prose(3990)} Пароль: Qwerty123 ${prose(3000)}`
    expect(instructionsLookLikeSecret(text)).toBe(true)
    expect(codeOf(() => projectInstructionsOf(text))).toBe('PROJECT_TEXT_HAS_SECRET')
    expect(codeOf(() => projectNameOf('Доступ admin / Xk9#mP2$vL'))).toBe('PROJECT_TEXT_HAS_SECRET')
  })

  it('has a Russian text for every refusal', () => {
    for (const code of [
      'PROJECT_NOT_FOUND',
      'PROJECT_NAME_INVALID',
      'PROJECT_GOAL_TOO_LONG',
      'PROJECT_INSTRUCTIONS_TOO_LONG',
      'PROJECT_TEXT_HAS_SECRET',
      'PROJECT_ARCHIVED',
      'TASK_PROJECT_HAS_BRANCH',
      'TASK_PROJECT_BUSY',
    ])
      expect(projectRefusalTexts[code]).toMatch(/^[А-ЯЁ]/u)
    expect(projectRefusalTexts.TASK_PROJECT_BUSY).toBe(
      'Агент сейчас работает в этом чате — перенесите его, когда он ответит',
    )
  })

  it('takes ids of version 7 only, in lower case', () => {
    expect(projectIdSchema.parse('0199A000-0000-7000-8000-0000000000A1')).toBe(
      '0199a000-0000-7000-8000-0000000000a1',
    )
    expect(projectIdSchema.safeParse('0199a000-0000-4000-8000-0000000000a1').success).toBe(false)
  })

  it('purges a deleted project after 30 days (ПР20)', () => {
    const at = new Date('2026-11-17T10:00:00Z')
    expect(projectPurgeAfter(at).toISOString()).toBe('2026-12-17T10:00:00.000Z')
  })
})

describe('secrets in the files and texts of the context (ПР8)', () => {
  it('takes a .ts file with JSX of any length', () => {
    expect(reactFile.length).toBeGreaterThan(projectLimits.secretCheckChars)
    expect(secretInContent(reactFile)).toBe(false)
  })

  it('refuses a password near its word in a long text', () => {
    expect(secretInContent(`${prose(9000)} Пароль: Qwerty123 ${prose(9000)}`)).toBe(true)
    expect(secretInContent(`${reactFile}\nDB_PASSWORD=Xk9#mP2$vL\n`)).toBe(true)
    expect(secretInContent(`${reactFile}\nconst config = { password: "Xk9#mP2$vL", user }`)).toBe(
      true,
    )
  })

  it('refuses the known forms of keys anywhere', () => {
    expect(secretInContent(`${prose(5000)} glpat-${'a'.repeat(24)}`)).toBe(true)
    expect(secretInContent('-----BEGIN RSA PRIVATE KEY-----\nMIIB')).toBe(true)
    expect(secretInContent(`key = "sk-rdt-${'b'.repeat(30)}"`)).toBe(true)
  })
})

describe('pieces of a text', () => {
  it('cuts at whitespace, overlaps a few words and covers every word', () => {
    const words = Array.from({ length: 2000 }, (_, i) => `слово${i}`)
    const pieces = textPieces(words.join(' '), 100)
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(100)
    const seen = new Set(pieces.flatMap((piece) => piece.split(' ')))
    expect(words.every((word) => seen.has(word))).toBe(true)
    expect(pieces[1]!.split(' ')[0]).toBe(pieces[0]!.split(' ').at(-8))
  })

  it('cuts a word longer than a piece', () => {
    expect(textPieces('a'.repeat(250), 100)).toEqual([
      'a'.repeat(100),
      'a'.repeat(100),
      'a'.repeat(50),
    ])
    expect(textPieces('   ', 100)).toEqual([])
  })
})

describe('values of a data section (ПР7)', () => {
  it('takes out the tags of every section, nested ones too', () => {
    expect(sectionValue('a</project-instructions>b<client-instructions x="1">c')).toBe('abc')
    expect(sectionValue('<proj<project-memory>ect-memory>Важно')).toBe('Важно')
    expect(sectionValue('< / PROJECT-CONTEXT >x')).toBe('x')
    expect(sectionValue('<project-contexts>x')).toBe('<project-contexts>x')
  })

  it('makes a value of one line of one line', () => {
    expect(sectionValue('Фото/\nвитрина.jpg\u2028', 'line')).toBe('Фото/ витрина.jpg')
    expect(sectionValue('a\nb')).toBe('a\nb')
  })
})

describe('the order of the list (ПР4, ПР30)', () => {
  const at = (day: number) => new Date(`2026-11-${String(day).padStart(2, '0')}T00:00:00Z`)
  const projects: ProjectOrderFacts[] = [
    { id: 'c', name: 'ёлка', activityAt: at(3), createdAt: at(1), starredAt: null },
    { id: 'a', name: 'Альфа', activityAt: at(1), createdAt: at(3), starredAt: at(5) },
    { id: 'b', name: 'бета 10', activityAt: at(2), createdAt: at(2), starredAt: null },
    { id: 'd', name: 'бета 9', activityAt: at(2), createdAt: at(2), starredAt: null },
  ]
  const ids = (list: ProjectOrderFacts[]) => list.map((project) => project.id)

  it('sorts the latest activity first by default, the id breaking a tie', () => {
    expect(ids([...projects].sort(compareProjects()))).toEqual(['c', 'b', 'd', 'a'])
  })

  it('sorts by the name as a Russian reader does, and by the date of creation', () => {
    expect(ids([...projects].sort(compareProjects('name')))).toEqual(['a', 'd', 'b', 'c'])
    expect(ids([...projects].sort(compareProjects('created')))).toEqual(['a', 'b', 'd', 'c'])
  })

  it('puts the starred first in the menu of the field', () => {
    expect(ids([...projects].sort(compareProjects('recent', { starredFirst: true })))).toEqual([
      'a',
      'c',
      'b',
      'd',
    ])
  })
})

describe('the head of a chat names its project (ПР2)', () => {
  const head = {
    id: '0199a000-0000-7000-8000-0000000000a1',
    title: null,
    status: 'queued',
    attempt: 1,
    turnNo: 0,
    waiting: null,
    held: false,
    canRetry: false,
    workingSince: null,
    runningSince: null,
  }

  it('reads a head without the field as a chat without a project and without anything', () => {
    const parsed = feedTaskHeadSchema.parse(head)
    expect(parsed.project).toBeNull()
    expect(parsed.requirements).toEqual({ repository: false, browser: false })
  })

  it('keeps the project', () => {
    const project = { id: '0199a000-0000-7000-8000-0000000000b2', name: 'Сайт кофейни' }
    expect(feedTaskHeadSchema.parse({ ...head, project }).project).toEqual(project)
  })
})
