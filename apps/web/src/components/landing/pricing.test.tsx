// @vitest-environment jsdom
import {
  averageTaskCredits,
  signupGiftCredits,
  typicalTaskCredits,
} from '@repo/domain/billing/credit-numbers'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ANNOUNCE_DELAY_MS, Pricing } from './pricing'
import { pass, plain, pricing } from './testing'

const { plans, pack } = pricing

// The line under the slider and the one under the registration, as they read.
const TASK_HINT =
  'Задача — одна ваша просьба. В расчёте берём 11 кредитов на задачу — это среднее: поменять цену или фото стоит обычно 5 кредитов, добавить блок или страницу — 15–25.'
const GIFT_NOTE =
  'При регистрации — 50 кредитов в подарок: хватит на несколько небольших правок. Тариф выберете позже.'

function planCard(name: string): HTMLElement {
  const card = screen.getByRole('heading', { name }).closest('article')
  if (!card) throw new Error(`no card for the plan ${name}`)
  return card
}

describe('landing pricing', () => {
  it('names the slider value in words and marks the cheapest plan for it', () => {
    render(<Pricing plans={plans} pack={pack} />)

    const slider = screen.getByRole('slider', { name: 'Сколько задач в месяц вы планируете?' })
    expect(slider).toHaveAttribute('aria-valuetext', '30 задач в месяц')
    expect(within(planCard('Старт')).getByText('Ваш вариант')).toBeInTheDocument()
    expect(within(planCard('Бизнес')).queryByText('Ваш вариант')).not.toBeInTheDocument()
  })

  it('moves the mark to another plan when more tasks are asked for', () => {
    render(<Pricing plans={plans} pack={pack} />)

    const slider = screen.getByRole('slider', { name: 'Сколько задач в месяц вы планируете?' })
    fireEvent.change(slider, { target: { value: '120' } })

    expect(slider).toHaveAttribute('aria-valuetext', '120 задач в месяц')
    expect(within(planCard('Бизнес')).getByText('Ваш вариант')).toBeInTheDocument()
    expect(within(planCard('Старт')).queryByText('Ваш вариант')).not.toBeInTheDocument()
  })

  it('draws the name of the plan anew when the plan changes, not when a pack is added', () => {
    render(<Pricing plans={plans} pack={pack} />)
    const slider = screen.getByRole('slider', { name: 'Сколько задач в месяц вы планируете?' })
    // A new node plays its move; the same node stands still.
    const name = () => screen.getByText(/^Тариф «/)
    const start = name()
    expect(start).toHaveTextContent('Тариф «Старт»')
    // Seen, not heard: the announcement of the result has its own region.
    expect(start.closest('[aria-live]')).toBeNull()

    expect(plain(name().parentElement?.textContent ?? '')).toBe(
      'Тариф «Старт» и 2 дополнительных пакета по 100 кредитов',
    )

    fireEvent.change(slider, { target: { value: '40' } })
    expect(name()).toBe(start)
    expect(plain(name().parentElement?.textContent ?? '')).toBe(
      'Тариф «Старт» и 3 дополнительных пакета по 100 кредитов',
    )

    fireEvent.change(slider, { target: { value: '80' } })
    const business = name()
    expect(business).toHaveTextContent('Тариф «Бизнес»')
    expect(business).not.toBe(start)

    fireEvent.change(slider, { target: { value: '100' } })
    expect(name()).toBe(business)
  })

  it('tells the result in words and rounds the price of one task to rubles', () => {
    render(<Pricing plans={plans} pack={pack} />)

    // The slider counts tasks, and nothing on it says that a task is one credit.
    const hint = screen.getByText(TASK_HINT)
    expect(screen.queryByText(/Один кредит/)).not.toBeInTheDocument()
    expect(screen.getByText('Самый выгодный вариант для такого числа задач')).toBeInTheDocument()
    // Thirty tasks at eleven credits each are more than the 150 of «Старт»: two packs are added.
    const start = screen.getByText('Тариф «Старт»').parentElement
    expect(start).toHaveTextContent('Тариф «Старт» и 2 дополнительных пакета по 100 кредитов')
    expect(screen.getByText('1 990 ₽ + 2 × 1 490 ₽')).toBeInTheDocument()
    expect(
      screen.getByText('В среднем около 166 ₽ за задачу при 30 задачах в месяц'),
    ).toBeInTheDocument()
    // A small edit on what is paid: 4 970 ₽ for 350 credits.
    expect(screen.getByText('Небольшая правка — около 71 ₽')).toBeInTheDocument()

    const slider = screen.getByRole('slider', { name: 'Сколько задач в месяц вы планируете?' })
    expect(slider).toHaveAttribute('aria-describedby', hint.id)
    // Ten tasks fit the tariff: no pack, no sum of two parts, and the small edit of the card.
    fireEvent.change(slider, { target: { value: '10' } })
    expect(screen.getByText('Тариф «Старт»')).toBeInTheDocument()
    expect(screen.queryByText(/дополнительн/)).not.toBeInTheDocument()
    expect(screen.queryByText(/ × /)).not.toBeInTheDocument()
    expect(
      screen.getByText('В среднем около 199 ₽ за задачу при 10 задачах в месяц'),
    ).toBeInTheDocument()
    const result10 = screen.getByText('Самый выгодный вариант для такого числа задач').parentElement
    expect(within(result10!).getByText('Небольшая правка — около 66 ₽')).toBeInTheDocument()

    fireEvent.change(slider, { target: { value: '120' } })

    // The name of the plan is an element of its own inside the sentence of the result.
    const result = screen.getByText(/^Тариф «Бизнес»/).parentElement
    expect(result).toHaveTextContent('Тариф «Бизнес» и 8 дополнительных пакетов по 100 кредитов')
    expect(screen.getByText('6 990 ₽ + 8 × 1 490 ₽')).toBeInTheDocument()
    expect(
      screen.getByText('В среднем около 158 ₽ за задачу при 120 задачах в месяц'),
    ).toBeInTheDocument()
    expect(screen.getByText('Небольшая правка — около 68 ₽')).toBeInTheDocument()
    expect(
      screen.getByText('Если сайтов больше одного — смотрите число сайтов в тарифе.'),
    ).toBeInTheDocument()
  })

  it('says under the slider what a task is and how many credits the calculator counts for one', () => {
    render(<Pricing plans={plans} pack={pack} />)

    const hint = screen.getByText(TASK_HINT)
    // The numbers are those of the credits model: the average charge the calculator multiplies
    // by, and the first two rows of the orientation list — said as an average and as usual.
    expect(TASK_HINT).toContain(`берём ${averageTaskCredits} кредитов на задачу — это среднее`)
    expect(TASK_HINT).toContain(`обычно ${typicalTaskCredits.small.to} кредитов`)
    expect(TASK_HINT).toContain(
      `— ${typicalTaskCredits.block.from}–${typicalTaskCredits.block.to}.`,
    )
    // The sentence of before the credits model is gone, and so is its promise of one unit a task.
    expect(screen.queryByText(/поменять цены, заменить фото, добавить акцию/)).toBeNull()
    // A number stays with its word and a dash with the word before it.
    expect(hint.textContent).toContain('Задача\u00a0— одна ваша просьба.')
    expect(hint.textContent).toContain('11\u00a0кредитов на\u00a0задачу\u00a0— это среднее')
    expect(hint.textContent).toContain('обычно 5\u00a0кредитов')
    expect(hint.textContent).toContain('страницу\u00a0— 15–25.')
    // The average of the hint is the one the result divides by: thirty tasks need 330 credits,
    // more than the 150 of «Старт», so two packs are added.
    expect(screen.getByText('Тариф «Старт»').parentElement).toHaveTextContent(
      '2 дополнительных пакета',
    )
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
      const slider = screen.getByRole('slider', { name: 'Сколько задач в месяц вы планируете?' })
      for (const value of ['35', '80', '120']) {
        fireEvent.change(slider, { target: { value } })
        pass(ANNOUNCE_DELAY_MS - 1)
        expect(announcement).toBeEmptyDOMElement()
      }
      pass(1)
      const business =
        'Тариф «Бизнес» и 8 дополнительных пакетов по 100 кредитов, 18 910 ₽ в месяц, в среднем около 158 ₽ за задачу. Небольшая правка — около 68 ₽'
      expect(plain(announcement.textContent)).toBe(business)

      // The next step keeps the last words until it rests too; then the plan alone is named,
      // as no pack is needed.
      fireEvent.change(slider, { target: { value: '10' } })
      pass(ANNOUNCE_DELAY_MS - 1)
      expect(plain(announcement.textContent)).toBe(business)
      pass(1)
      expect(plain(announcement.textContent)).toBe(
        'Тариф «Старт», 1 990 ₽ в месяц, в среднем около 199 ₽ за задачу. Небольшая правка — около 66 ₽',
      )

      // And with a pack: the words of the visible result, the amounts and the estimates.
      fireEvent.change(slider, { target: { value: '20' } })
      pass(ANNOUNCE_DELAY_MS)
      expect(plain(announcement.textContent)).toBe(
        'Тариф «Старт» и 1 дополнительный пакет по 100 кредитов, 3 480 ₽ в месяц, в среднем около 174 ₽ за задачу. Небольшая правка — около 70 ₽',
      )
    })

    it('announces that no pack fits the number of tasks', () => {
      vi.useFakeTimers()
      const { container } = render(<Pricing plans={plans.slice(0, 1)} pack={null} />)

      fireEvent.change(screen.getByRole('slider'), { target: { value: '120' } })
      pass(ANNOUNCE_DELAY_MS)
      const message = 'Для такого числа задач пока нет доступного пакета. Выберите меньше задач.'
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
    const offer = screen.getByText(/^Кредитов не хватит\?/)
    expect(plain(offer.textContent)).toBe(
      'Кредитов не хватит? Можно будет докупить пакет — 100 кредитов за 1 490 ₽. Небольшая правка из пакета — около 75 ₽. Кредиты из пакета не сгорают.',
    )
    expect(screen.getByText('Цены в рублях.')).toBeInTheDocument()
    unmount()

    render(<Pricing plans={plans} pack={null} />)
    expect(screen.queryByText(/докупить пакет/)).not.toBeInTheDocument()
    expect(screen.getByText('Цены в рублях.')).toBeInTheDocument()
  })

  it('says the pack is free of the daily limit only while a plan on sale has one', () => {
    const [first, ...others] = plans
    render(<Pricing plans={[{ ...first!, creditsPerDay: 50 }, ...others]} pack={pack} />)

    expect(plain(screen.getByText(/^Кредитов не хватит\?/).textContent)).toBe(
      'Кредитов не хватит? Можно будет докупить пакет — 100 кредитов за 1 490 ₽. Небольшая правка из пакета — около 75 ₽. Кредиты из пакета не сгорают и дневным лимитом не ограничены.',
    )
    expect(
      within(planCard('Старт'))
        .getAllByRole('listitem')
        .map((item) => plain(item.textContent))[0],
    ).toBe('150 кредитов в месяц — в среднем около 14 задач, до 50 кредитов в день')
  })

  it('says once under the plans that only done work is paid for', () => {
    const { unmount } = render(<Pricing plans={plans} pack={pack} />)
    const rule =
      'Списываем только за выполненную работу: если задача не получилась, кредиты возвращаются.'
    expect(screen.getAllByText(rule)).toHaveLength(1)
    for (const name of ['Старт', 'Бизнес', 'Агентство']) {
      expect(planCard(name)).not.toHaveTextContent('только за выполненную')
    }
    unmount()

    // Whether a pack is on sale or not.
    render(<Pricing plans={plans} pack={null} />)
    expect(screen.getAllByText(rule)).toHaveLength(1)
  })

  it('keeps the limits of a plan in one line and what every plan includes under the plans', () => {
    render(<Pricing plans={plans} pack={pack} />)

    expect(
      within(planCard('Старт'))
        .getAllByRole('listitem')
        .map((item) => plain(item.textContent)),
    ).toEqual([
      '150 кредитов в месяц — в среднем около 14 задач',
      'Небольшая правка — около 66 ₽',
      'Один сайт',
    ])
    expect(
      within(planCard('Бизнес'))
        .getAllByRole('listitem')
        .map((item) => plain(item.textContent)),
    ).toEqual([
      '600 кредитов в месяц — в среднем около 55 задач',
      'Небольшая правка — около 58 ₽',
      'До 3 сайтов',
    ])
    expect(
      within(planCard('Агентство'))
        .getAllByRole('listitem')
        .map((item) => plain(item.textContent)),
    ).toEqual([
      '2 000 кредитов в месяц — в среднем около 180 задач',
      'Небольшая правка — около 50 ₽',
      'До 15 сайтов',
    ])
    // No plan on sale has a daily limit: no card speaks of a day.
    for (const name of ['Старт', 'Бизнес', 'Агентство']) {
      expect(planCard(name)).not.toHaveTextContent(/в день|дневн/)
    }

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
  })

  it('tells a guest by the registration of the gift, and of no day without a tariff', () => {
    render(<Pricing plans={plans} pack={pack} />)

    const note = screen.getByText(GIFT_NOTE)
    // Beside the action, under the plans: one paragraph after the link.
    expect(screen.getByRole('link', { name: 'Зарегистрироваться' }).nextElementSibling).toBe(note)
    for (const name of ['Старт', 'Бизнес', 'Агентство']) {
      expect(planCard(name).contains(note)).toBe(false)
    }
    // The gift is a number of the credits model; without a tariff there is no daily limit.
    expect(GIFT_NOTE).toContain(`— ${signupGiftCredits} кредитов в подарок`)
    expect(GIFT_NOTE).not.toMatch(/в день/)
    // The gift is promised in credits and in small edits, never as a count of tasks.
    expect(GIFT_NOTE).not.toMatch(/\d+ задач/)
    // The line of before the gift is gone.
    expect(screen.queryByText(/когда откроется оплата/)).toBeNull()
    // A number stays with its word and a dash with the word before it.
    expect(note.textContent).toContain(
      `При\u00a0регистрации\u00a0— ${signupGiftCredits}\u00a0кредитов в\u00a0подарок:`,
    )
  })

  it('leads a signed-in visitor to the chats with the same single action', () => {
    render(<Pricing plans={plans} pack={pack} isGuest={false} />)

    expect(screen.getAllByRole('link')).toHaveLength(1)
    const action = screen.getByRole('link', { name: 'Открыть чаты' })
    expect(action).toHaveAttribute('href', '/chats')
    // They have registered: the line by the action says only when the tariff is chosen, and
    // promises no gift the page cannot know of.
    expect(action.nextElementSibling).toHaveTextContent(/^Тариф выберете позже\.$/)
    expect(screen.queryByText(/При регистрации/)).toBeNull()
    expect(screen.queryByText(/в подарок/)).toBeNull()
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

  it('leads a signed-in visitor to the chats when the plans are unavailable', () => {
    render(<Pricing plans={[]} pack={null} isGuest={false} />)

    const way = screen.getByText(/Перейти к чатам можно по ссылке ниже\./)
    // The prepositions stay with their words.
    expect(way.textContent).toContain('к\u00a0чатам можно по\u00a0ссылке')
    expect(screen.queryByText(/Зарегистрироваться/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Открыть чаты' })).toHaveAttribute('href', '/chats')
  })
})
