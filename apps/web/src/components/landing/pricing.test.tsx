// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ANNOUNCE_DELAY_MS, Pricing } from './pricing'
import { pass, plain, pricing } from './testing'

const { plans, pack } = pricing

function planCard(name: string): HTMLElement {
  const card = screen.getByRole('heading', { name }).closest('article')
  if (!card) throw new Error(`no card for the plan ${name}`)
  return card
}

describe('landing pricing', () => {
  it('names the slider value in words and marks the cheapest plan for it', () => {
    render(<Pricing plans={plans} pack={pack} />)

    const slider = screen.getByRole('slider', { name: 'Сколько правок нужно в месяц?' })
    expect(slider).toHaveAttribute('aria-valuetext', '30 правок в месяц')
    expect(within(planCard('Старт')).getByText('Ваш вариант')).toBeInTheDocument()
    expect(within(planCard('Бизнес')).queryByText('Ваш вариант')).not.toBeInTheDocument()
  })

  it('moves the mark to another plan when more edits are asked for', () => {
    render(<Pricing plans={plans} pack={pack} />)

    const slider = screen.getByRole('slider', { name: 'Сколько правок нужно в месяц?' })
    fireEvent.change(slider, { target: { value: '120' } })

    expect(slider).toHaveAttribute('aria-valuetext', '120 правок в месяц')
    expect(within(planCard('Бизнес')).getByText('Ваш вариант')).toBeInTheDocument()
    expect(within(planCard('Старт')).queryByText('Ваш вариант')).not.toBeInTheDocument()
  })

  it('draws the name of the plan anew when the plan changes, not when a pack is added', () => {
    render(<Pricing plans={plans} pack={pack} />)
    const slider = screen.getByRole('slider', { name: 'Сколько правок нужно в месяц?' })
    // A new node plays its move; the same node stands still.
    const name = () => screen.getByText(/^Тариф «/)
    const start = name()
    expect(start).toHaveTextContent('Тариф «Старт»')
    // Seen, not heard: the announcement of the result has its own region.
    expect(start.closest('[aria-live]')).toBeNull()

    fireEvent.change(slider, { target: { value: '40' } })
    expect(name()).toBe(start)
    expect(plain(name().parentElement?.textContent ?? '')).toBe(
      'Тариф «Старт» и 1 дополнительный пакет по 10 правок',
    )

    fireEvent.change(slider, { target: { value: '80' } })
    const business = name()
    expect(business).toHaveTextContent('Тариф «Бизнес»')
    expect(business).not.toBe(start)

    fireEvent.change(slider, { target: { value: '100' } })
    expect(name()).toBe(business)
  })

  it('tells the result in words and rounds the price of one edit to rubles', () => {
    render(<Pricing plans={plans} pack={pack} />)

    const hint = screen.getByText(
      'Правка — одна ваша просьба: поменять цены, заменить фото, добавить акцию.',
    )
    expect(screen.getByText('Тариф «Старт»')).toBeInTheDocument()
    expect(screen.queryByText(/дополнительн/)).not.toBeInTheDocument()
    expect(screen.getByText('Около 163 ₽ за правку, если использовать все 30')).toBeInTheDocument()

    const slider = screen.getByRole('slider', { name: 'Сколько правок нужно в месяц?' })
    expect(slider).toHaveAttribute('aria-describedby', hint.id)
    fireEvent.change(slider, { target: { value: '120' } })

    // The name of the plan is an element of its own inside the sentence of the result.
    const result = screen.getByText(/^Тариф «Бизнес»/).parentElement
    expect(result).toHaveTextContent('Тариф «Бизнес» и 4 дополнительных пакета по 10 правок')
    expect(screen.getByText('12 900 ₽ + 4 × 1 990 ₽')).toBeInTheDocument()
    expect(screen.getByText('Около 174 ₽ за правку, если использовать все 120')).toBeInTheDocument()
    expect(
      screen.getByText('Если сайтов больше одного — смотрите число сайтов в тарифе.'),
    ).toBeInTheDocument()
  })

  describe('for a screen reader', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('announces the result once, when the slider comes to rest', () => {
      vi.useFakeTimers()
      const { container } = render(<Pricing plans={plans} pack={pack} />)

      // One live region instead of three: the count above the slider is for the eye only, and
      // the visible result is plain text.
      const regions = container.querySelectorAll('[aria-live]')
      expect(regions).toHaveLength(1)
      const [announcement] = regions
      if (!announcement) throw new Error('no live region')
      expect(announcement).toHaveAttribute('aria-live', 'polite')
      expect(announcement).toHaveAttribute('aria-atomic', 'true')
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(container.querySelector('output')?.closest('[aria-hidden="true"]')).not.toBeNull()
      expect(screen.getByText(/^Тариф «Старт»/).closest('[aria-live]')).toBeNull()

      // Nothing is said until the visitor moves the slider.
      pass(ANNOUNCE_DELAY_MS * 2)
      expect(announcement).toBeEmptyDOMElement()

      // A drag passes several values: only the one it stops on is announced.
      const slider = screen.getByRole('slider', { name: 'Сколько правок нужно в месяц?' })
      for (const value of ['35', '80', '120']) {
        fireEvent.change(slider, { target: { value } })
        pass(ANNOUNCE_DELAY_MS - 1)
        expect(announcement).toBeEmptyDOMElement()
      }
      pass(1)
      const business =
        'Тариф «Бизнес» и 4 дополнительных пакета по 10 правок, 20 860 ₽ в месяц, около 174 ₽ за правку'
      expect(plain(announcement.textContent)).toBe(business)

      // The next step keeps the last words until it rests too; then the plan alone is named,
      // as no pack is needed.
      fireEvent.change(slider, { target: { value: '30' } })
      pass(ANNOUNCE_DELAY_MS - 1)
      expect(plain(announcement.textContent)).toBe(business)
      pass(1)
      expect(plain(announcement.textContent)).toBe(
        'Тариф «Старт», 4 900 ₽ в месяц, около 163 ₽ за правку',
      )
    })

    it('announces that no pack fits the number of edits', () => {
      vi.useFakeTimers()
      const { container } = render(<Pricing plans={plans.slice(0, 1)} pack={null} />)

      fireEvent.change(screen.getByRole('slider'), { target: { value: '120' } })
      pass(ANNOUNCE_DELAY_MS)
      const message = 'Для такого числа правок пока нет доступного пакета. Выберите меньше правок.'
      const announcement = container.querySelector('[aria-live]')
      expect(announcement).toHaveTextContent(message)
      // The same words as the visible result.
      const [visible, ...others] = screen
        .getAllByText(message)
        .filter((element) => element !== announcement)
      expect(others).toHaveLength(0)
      // On the screen a line does not end with a preposition; a screen reader takes plain spaces.
      expect(visible?.textContent).toContain('Для\u00a0такого числа')
      expect(announcement?.textContent).toBe(message)
    })
  })

  it('offers the packs in the future tense, and not at all when there are none', () => {
    const { unmount } = render(<Pricing plans={plans} pack={pack} />)
    expect(
      screen.getByText(
        'Правок не хватит? Можно будет докупить пакет — 10 правок за 1 990 ₽. Пакеты будут продаваться целиком.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Цены в рублях.')).toBeInTheDocument()
    unmount()

    render(<Pricing plans={plans} pack={null} />)
    expect(screen.queryByText(/докупить пакет/)).not.toBeInTheDocument()
    expect(screen.getByText('Цены в рублях.')).toBeInTheDocument()
  })

  it('keeps the limits of a plan in one line and what every plan includes under the plans', () => {
    render(<Pricing plans={plans} pack={pack} />)

    expect(
      within(planCard('Старт'))
        .getAllByRole('listitem')
        .map((item) => plain(item.textContent)),
    ).toEqual(['30 правок в месяц, не больше 5 в день', 'Один сайт'])
    expect(
      within(planCard('Бизнес'))
        .getAllByRole('listitem')
        .map((item) => plain(item.textContent)),
    ).toEqual(['80 правок в месяц, не больше 10 в день', 'До 3 сайтов'])
    expect(
      within(planCard('Агентство'))
        .getAllByRole('listitem')
        .map((item) => plain(item.textContent)),
    ).toEqual(['250 правок в месяц, не больше 30 в день', 'До 15 сайтов'])

    const included = screen.getByText(/^В каждый тариф войдут/)
    expect(included).toHaveTextContent(
      'В каждый тариф войдут правки текстов, цен, фото, акций и страниц на сайтах WordPress, копия перед правкой и отмена.',
    )
    for (const name of ['Старт', 'Бизнес', 'Агентство']) {
      expect(planCard(name).contains(included)).toBe(false)
      expect(planCard(name)).not.toHaveTextContent('WordPress')
    }
  })

  it('offers one registration under the plans and none inside a plan', () => {
    render(<Pricing plans={plans} pack={pack} />)

    const action = screen.getByRole('link', { name: 'Зарегистрироваться' })
    // The plan is chosen later, so the link carries no plan.
    expect(action).toHaveAttribute('href', '/sign-up')
    expect(screen.getAllByRole('link')).toEqual([action])
    for (const name of ['Старт', 'Бизнес', 'Агентство']) {
      expect(planCard(name).contains(action)).toBe(false)
    }
    expect(screen.getByText('Тариф выберете позже, когда откроется оплата')).toBeInTheDocument()
  })

  it('leads a signed-in visitor to the projects with the same single action', () => {
    render(<Pricing plans={plans} pack={pack} isGuest={false} />)

    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Открыть проекты' })).toHaveAttribute(
      'href',
      '/projects',
    )
  })

  it('shows no prices and keeps the way to the account when the plans are unavailable', () => {
    render(<Pricing plans={[]} pack={null} />)

    expect(screen.getByText('Сейчас не удалось загрузить тарифы.')).toBeInTheDocument()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(screen.getByText(/Зарегистрироваться можно уже сейчас\./)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Зарегистрироваться' })).toHaveAttribute(
      'href',
      '/sign-up',
    )
  })

  it('leads a signed-in visitor to the projects when the plans are unavailable', () => {
    render(<Pricing plans={[]} pack={null} isGuest={false} />)

    const way = screen.getByText(/Перейти к проектам можно по ссылке ниже\./)
    // The prepositions stay with their words.
    expect(way.textContent).toContain('к\u00a0проектам можно по\u00a0ссылке')
    expect(screen.queryByText(/Зарегистрироваться/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Открыть проекты' })).toHaveAttribute(
      'href',
      '/projects',
    )
  })
})
