import type { Page } from 'playwright-core'
import { describe, expect, it, vi } from 'vitest'

import { findSecretFields, hideSecrets, SECRET_INPUTS } from './secret-fields.ts'

// The tree is Playwright 1.63's `ai` snapshot of a sign-in form after the client typed into it.
const TREE = [
  '- generic [ref=e1]:',
  '  - textbox "Имя пользователя" [ref=e2]: admin',
  '  - textbox "Поле 2" [ref=e3]: Tr0ub4dor&3',
  '  - textbox "Пароль" [ref=e4]: s3cret-pass',
  '  - generic [ref=e5]: "Подсказка: Tr0ub4dor&3"',
  '  - textbox "Число" [ref=e6]: "4711"',
  '  - button "Войти" [ref=e7]',
].join('\n')

describe('the secret fields of a page', () => {
  it('are hidden by reference, by name and by value wherever it still stands', () => {
    const hidden = hideSecrets(TREE, {
      refs: new Set(['e3', 'e6']),
      values: ['Tr0ub4dor&3'],
      read: 2,
    })
    expect(hidden).not.toContain('Tr0ub4dor&3')
    expect(hidden).not.toContain('s3cret-pass')
    expect(hidden).not.toContain('4711')
    expect(hidden).toContain('- textbox "Имя пользователя" [ref=e2]: admin')
    expect(hidden).toContain('- textbox "Поле 2" [ref=e3]: [hidden]')
    expect(hidden).toContain('- textbox "Пароль" [ref=e4]: [hidden]')
    expect(hidden).toContain('- button "Войти" [ref=e7]')
  })

  it('are hidden as the tree quotes them', () => {
    const tree = '- generic [ref=e9]: "say \\"pa\\\\ss\\" now"'
    expect(hideSecrets(tree, { refs: new Set(), values: ['"pa\\ss"'], read: 1 })).toBe(
      '- generic [ref=e9]: "say [hidden] now"',
    )
  })

  it('are found in every frame by type and autocomplete, their own trees read before the page’s', async () => {
    const calls: string[] = []
    const field = (ref: string, value: string) => ({
      ariaSnapshot: vi.fn(async () => {
        calls.push(`snapshot ${ref}`)
        return `- textbox "Поле" [ref=${ref}]: ${value}`
      }),
      inputValue: vi.fn(async () => value),
    })
    const frame = (fields: ReturnType<typeof field>[]) => ({
      locator: vi.fn((selector: string) => {
        expect(selector).toBe(SECRET_INPUTS)
        return { count: async () => fields.length, nth: (index: number) => fields[index] }
      }),
    })
    const page = {
      frames: () => [frame([field('e3', 'Tr0ub4dor&3')]), frame([]), frame([field('f1e2', '42')])],
    } as unknown as Page
    const found = await findSecretFields(page, 1_000)
    expect([...found.refs]).toEqual(['e3', 'f1e2'])
    // A two-character code is hidden by its reference only: as text it would hide the page's words.
    expect(found.values).toEqual(['Tr0ub4dor&3'])
    expect(found.read).toBe(2)
    expect(calls).toEqual(['snapshot e3', 'snapshot f1e2'])
  })

  it('a frame that is gone hides nothing of the others', async () => {
    const page = {
      frames: () => [
        { locator: () => ({ count: async () => Promise.reject(new Error('detached')) }) },
      ],
    } as unknown as Page
    expect(await findSecretFields(page, 1_000)).toEqual({ refs: new Set(), values: [], read: 0 })
  })
})
