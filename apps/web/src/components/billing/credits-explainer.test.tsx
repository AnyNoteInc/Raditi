// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { CreditConversion } from './billing-types'
import { CreditsExplainer } from './credits-explainer'
import { plain } from './testing'

afterEach(cleanup)

const SOL = {
  model: null,
  input: '38.75',
  cacheRead: '3.88',
  cacheWrite: '38.75',
  output: '193.75',
}
const show = (conversion: CreditConversion | null) =>
  render(<CreditsExplainer conversion={conversion} />)
/** The collapsed block a summary opens. */
const blockOf = (summary: string) => {
  const details = screen.getByText(summary).closest('details')
  if (details === null) throw new Error(`«${summary}» opens no block`)
  return details
}

describe('«Как считаются кредиты»', () => {
  it('is collapsed, and holds the definition, the list, the promises and the two rules', () => {
    show(null)
    const block = blockOf('Как считаются кредиты')

    expect(block.open).toBe(false)
    const text = plain(block.textContent)
    expect(text).toContain('Кредит — это единица, в которой мы считаем работу Радити')
    expect(text).toContain(
      'небольшая правка обычно стоит 5 кредитов, а в среднем задача — около 11.',
    )
    expect(text).toContain(
      'Кредиты списываются только за выполненную задачу — не меньше 5 за задачу.',
    )
    expect(text).toContain('Больше 45 кредитов без вашего согласия задача не потратит')
    expect(text).toContain(
      'Продолжение большой задачи и повторная попытка считаются в дневном лимите как ещё одна задача.',
    )
    expect(text).toContain('не чаще раза в квартал и предупредим об этом за 10 дней')

    const list = within(block).getByRole('table')
    expect(
      within(list)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Что вы просите', 'Сколько это стоит'])
    expect(
      within(list)
        .getAllByRole('row')
        .slice(1)
        .map((row) => plain(row.textContent)),
    ).toEqual([
      'Поменять текст, цену, телефон или фотообычно 5 кредитов',
      'Добавить блок, баннер или страницу, поправить оформлениеобычно 15–25 кредитов',
      'Большая задача: несколько страниц, новая форма, сложная логикаобычно 25–40 кредитов',
    ])
  })

  it('does not show «Точный расчёт» without a credit rate, and names no token anywhere', () => {
    show(null)

    expect(screen.queryByText('Точный расчёт')).toBeNull()
    expect(plain(document.body.textContent)).not.toMatch(/токен/i)
    // One level only: nothing is nested in the block.
    expect(document.querySelectorAll('details')).toHaveLength(1)
  })

  it('shows «Точный расчёт» one level deeper, collapsed, with the table in a sentence', () => {
    show({ rows: [SOL] })
    const outer = blockOf('Как считаются кредиты')
    const exact = blockOf('Точный расчёт')

    expect(outer.contains(exact)).toBe(true)
    expect(exact).not.toBe(outer)
    expect(exact.open).toBe(false)
    expect(plain(exact.textContent)).toContain(
      'Объём работы считается в токенах — так называют единицы текста, которыми оперирует модель: один токен — примерно слог или короткое слово. За 1 млн токенов нового текста — 38,75 кредита, повторно прочитанного — 3,88, написанного — 193,75.',
    )
    expect(plain(exact.textContent)).toContain(
      'Итог по задаче округляется до целого кредита; за выполненную задачу списывается не меньше 5. Таблица округлена до сотых, поэтому при пересчёте вручную итог может отличаться на один кредит; точный расчёт — в «Использовании».',
    )
    expect(within(exact).queryByRole('table')).toBeNull()
  })

  it('keeps the word for the unit of a model inside «Точный расчёт»', () => {
    show({ rows: [SOL] })
    const outer = blockOf('Как считаются кредиты')
    const exact = blockOf('Точный расчёт')

    // Everything of the block but «Точный расчёт» itself.
    const rest = outer.cloneNode(true) as HTMLElement
    rest.querySelector('details')?.remove()
    expect(plain(rest.textContent)).not.toMatch(/токен/i)
    expect(plain(exact.textContent)).toMatch(/токен/i)
  })

  it('prints a row per model when their prices differ', () => {
    show({
      rows: [
        { ...SOL, model: 'Модель А' },
        { ...SOL, model: 'Модель Б', output: '200.00' },
      ],
    })
    const exact = blockOf('Точный расчёт')

    const table = within(exact).getByRole('table')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => plain(header.textContent)),
    ).toEqual(['Модель', 'Новый текст', 'Повторно прочитанный', 'Написанный'])
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => [...row.children].map((cellOfRow) => plain(cellOfRow.textContent))),
    ).toEqual([
      ['Модель А', '38,75', '3,88', '193,75'],
      ['Модель Б', '38,75', '3,88', '200,00'],
    ])
    // The table scrolls inside a frame the keyboard reaches, named by what it holds.
    expect(within(exact).getByRole('group', { name: 'За 1 млн токенов, по моделям' })).toBeTruthy()
  })
})
