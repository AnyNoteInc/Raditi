import type { Page } from 'playwright-core'
import { describe, expect, it, vi } from 'vitest'

import { CARD_INPUTS, findSecretFields, hideSecrets, SECRET_INPUTS } from './secret-fields.ts'

// The tree is Playwright 1.63's `ai` snapshot of a sign-in form after the client typed into it.
/** A field of `findSecretFields`, by what Playwright would answer of it. */
const field = (ref: string, value: string, attributes: Record<string, string>) => ({
  ariaSnapshot: async () => `- textbox "Поле" [ref=${ref}]: ${value}`,
  inputValue: async () => value,
  getAttribute: async (name: string) => attributes[name] ?? null,
})

/** A page of one frame, whose selectors find these fields. */
const pageOf = (rows: Record<string, ReturnType<typeof field>[]>) =>
  ({
    frames: () => [
      {
        locator: (selector: string) => ({
          count: async () => rows[selector]?.length ?? 0,
          nth: (index: number) => rows[selector]?.[index],
        }),
      },
    ],
  }) as unknown as Page

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
      codes: [],
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
    expect(hideSecrets(tree, { refs: new Set(), values: ['"pa\\ss"'], codes: [], read: 1 })).toBe(
      '- generic [ref=e9]: "say [hidden] now"',
    )
  })

  it('are found in every frame by type and autocomplete, their own trees read before the page’s', async () => {
    const calls: string[] = []
    const logged = (ref: string, value: string) => ({
      ariaSnapshot: vi.fn(async () => {
        calls.push(`snapshot ${ref}`)
        return `- textbox "Поле" [ref=${ref}]: ${value}`
      }),
      inputValue: vi.fn(async () => value),
      getAttribute: vi.fn(async () => null),
    })
    const frame = (fields: ReturnType<typeof logged>[]) => ({
      locator: vi.fn((selector: string) => {
        const found = selector === SECRET_INPUTS ? fields : []
        return { count: async () => found.length, nth: (index: number) => found[index] }
      }),
    })
    const page = {
      frames: () => [
        frame([logged('e3', 'Tr0ub4dor&3')]),
        frame([]),
        frame([logged('f1e2', '42')]),
      ],
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
    expect(await findSecretFields(page, 1_000)).toEqual({
      refs: new Set(),
      values: [],
      codes: [],
      read: 0,
    })
  })

  it('include a card’s code and expiry at any length, where they stand alone', async () => {
    const page = pageOf({
      [SECRET_INPUTS]: [
        field('e8', '4111 1111 1111 1111', { autocomplete: 'cc-number' }),
        field('e9', '123', { autocomplete: 'cc-csc' }),
        field('e10', '12/27', { autocomplete: 'section-pay cc-exp' }),
      ],
      [CARD_INPUTS]: [field('e11', '77', { name: 'card_cvv' })],
    })
    const found = await findSecretFields(page, 1_000)
    expect(found.values).toEqual(['4111 1111 1111 1111'])
    expect(found.codes).toEqual(['123', '12/27', '77'])
    const tree = [
      '- generic [ref=e123]: "Код 123 действует до 12/27"',
      '- text: "Заказ 1234 на 77 рублей и 177"',
    ].join('\n')
    expect(hideSecrets(tree, found)).toBe(
      [
        '- generic [ref=e123]: "Код [hidden] действует до [hidden]"',
        '- text: "Заказ 1234 на [hidden] рублей и 177"',
      ].join('\n'),
    )
  })

  it('take a field for a card’s by a word of its name, never a word that only holds «card»', async () => {
    const cards: Record<string, string>[] = [
      { name: 'card' },
      { name: 'cards' },
      { name: 'cardnumber' },
      { name: 'cardNumber' },
      { name: 'card_number' },
      { name: 'card-number' },
      { name: 'card[number]' },
      { name: 'card1' },
      { name: 'payment[card][pan]' },
      { name: 'creditcard' },
      { name: 'creditCard' },
      { name: 'credit_card' },
      { id: 'card-pan' },
      { name: 'cardholder' },
      { name: 'pan_number' },
      { name: 'payment[pan]' },
      { name: 'cvc' },
      { id: 'discard', name: 'payment_cvv' },
    ]
    for (const attributes of cards) {
      const found = await findSecretFields(
        pageOf({ [CARD_INPUTS]: [field('e1', 'значение', attributes)] }),
        1_000,
      )
      expect([...found.refs], JSON.stringify(attributes)).toEqual(['e1'])
    }
    for (const name of ['wildcard', 'discard', 'postcard', 'scorecard', 'cardio', 'dashboard']) {
      const found = await findSecretFields(
        pageOf({ [CARD_INPUTS]: [field('e1', 'значение', { name })] }),
        1_000,
      )
      expect(found, name).toEqual({ refs: new Set(), values: [], codes: [], read: 0 })
    }
  })

  it('hide a field found by its name in the field, and leave the same words on the page', async () => {
    const found = await findSecretFields(
      pageOf({ [CARD_INPUTS]: [field('e1', 'Новости', { name: 'card_title' })] }),
      1_000,
    )
    expect(found).toMatchObject({ values: [], codes: [], read: 1 })
    const tree = '- textbox "Заголовок" [ref=e1]: Новости\n- heading "Новости" [level=1] [ref=e2]'
    expect(hideSecrets(tree, found)).toBe(
      '- textbox "Заголовок" [ref=e1]: [hidden]\n- heading "Новости" [level=1] [ref=e2]',
    )
  })
})
