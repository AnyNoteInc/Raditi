// @vitest-environment jsdom
import { signupGiftCredits } from '@repo/domain/billing/credit-numbers'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { mainAction } from './main-action'
import { Pricing } from './pricing'
import { plain, pricing } from './testing'

const { plans, pack } = pricing

// The line under the main action, as it reads.
const GIFT_NOTE =
  'При регистрации — 50 кредитов в подарок: хватит на несколько небольших задач. Тариф выберете позже.'

function planCard(name: string): HTMLElement {
  const card = screen.getByRole('heading', { name }).closest('article')
  if (!card) throw new Error(`no card for the plan ${name}`)
  return card
}

describe('landing pricing', () => {
  it('shows the three plans without a calculator', () => {
    render(<Pricing plans={plans} pack={pack} />)

    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['Старт', 'Бизнес', 'Агентство'])
    // No slider, no count of tasks to move, no result to announce.
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(screen.queryByText(/Сколько задач в месяц/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Самый выгодный вариант/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Ваш вариант/)).not.toBeInTheDocument()
    expect(document.querySelector('[aria-live]')).toBeNull()
    expect(document.querySelector('input')).toBeNull()
  })

  it('marks the plan in the middle for the visitor, and only it', () => {
    render(<Pricing plans={plans} pack={pack} />)

    expect(within(planCard('Бизнес')).getByText('Для вас')).toBeInTheDocument()
    expect(within(planCard('Старт')).queryByText('Для вас')).not.toBeInTheDocument()
    expect(within(planCard('Агентство')).queryByText('Для вас')).not.toBeInTheDocument()
    expect(screen.getAllByText('Для вас')).toHaveLength(1)
  })

  it('marks no plan when there is no middle one', () => {
    const { unmount } = render(<Pricing plans={plans.slice(0, 2)} pack={pack} />)
    expect(screen.queryByText('Для вас')).not.toBeInTheDocument()
    unmount()

    render(<Pricing plans={plans.slice(0, 1)} pack={null} />)
    expect(screen.queryByText('Для вас')).not.toBeInTheDocument()
  })

  it('offers the packs in the future tense, and not at all when there are none', () => {
    const { unmount } = render(<Pricing plans={plans} pack={pack} />)
    const offer = screen.getByText(/^Кредитов не хватит\?/)
    expect(plain(offer.textContent)).toBe(
      'Кредитов не хватит? Можно будет докупить пакет — 100 кредитов за 1 490 ₽. Небольшая задача из пакета — около 75 ₽. Кредиты из пакета не сгорают.',
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
      'Кредитов не хватит? Можно будет докупить пакет — 100 кредитов за 1 490 ₽. Небольшая задача из пакета — около 75 ₽. Кредиты из пакета не сгорают и дневным лимитом не ограничены.',
    )
    expect(
      within(planCard('Старт'))
        .getAllByRole('listitem')
        .map((item) => plain(item.textContent))[0],
    ).toBe('200 кредитов в месяц — в среднем около 18 задач, до 50 кредитов в день')
  })

  it('says once under the plans that only done work is paid for', () => {
    const { unmount } = render(<Pricing plans={plans} pack={pack} />)
    const rule =
      'Списываем только за выполненную работу: попытка, которая оборвалась из-за сбоя, ничего не стоит.'
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
    ).toEqual(['200 кредитов в месяц — в среднем около 18 задач', 'Небольшая задача — около 50 ₽'])
    expect(
      within(planCard('Бизнес'))
        .getAllByRole('listitem')
        .map((item) => plain(item.textContent)),
    ).toEqual([
      '1 000 кредитов в месяц — в среднем около 91 задачи',
      'Небольшая задача — около 50 ₽',
    ])
    expect(
      within(planCard('Агентство'))
        .getAllByRole('listitem')
        .map((item) => plain(item.textContent)),
    ).toEqual([
      '2 000 кредитов в месяц — в среднем около 180 задач',
      'Небольшая задача — около 50 ₽',
    ])
    // No plan on sale has a daily limit: no card speaks of a day.
    for (const name of ['Старт', 'Бизнес', 'Агентство']) {
      expect(planCard(name)).not.toHaveTextContent(/в день|дневн/)
    }

    const included = screen.getByText(/^В каждый тариф входят/)
    expect(included).toHaveTextContent(
      'В каждый тариф входят поиск в интернете, браузер помощника, письма, документы, таблицы и страницы по ссылке.',
    )
    for (const name of ['Старт', 'Бизнес', 'Агентство']) {
      expect(planCard(name).contains(included)).toBe(false)
    }
  })

  it('offers one action under the plans and none inside a plan', () => {
    render(<Pricing plans={plans} pack={pack} />)

    // The main action of a guest, by its whole name: the way to the form of a lead.
    const action = screen.getByRole('link', { name: 'Начать бесплатно' })
    expect(mainAction(true).label).toBe('Начать бесплатно')
    // The plan is chosen later, so the link carries no plan.
    expect(action).toHaveAttribute('href', '#lead')
    expect(screen.getAllByRole('link')).toEqual([action])
    for (const name of ['Старт', 'Бизнес', 'Агентство']) {
      expect(planCard(name).contains(action)).toBe(false)
    }
  })

  it('tells a guest by the action of the gift of the registration, and of no day without a tariff', () => {
    render(<Pricing plans={plans} pack={pack} />)

    const note = screen.getByText(GIFT_NOTE)
    // Beside the action, under the plans: one paragraph after the link.
    expect(screen.getByRole('link', { name: 'Начать бесплатно' }).nextElementSibling).toBe(note)
    for (const name of ['Старт', 'Бизнес', 'Агентство']) {
      expect(planCard(name).contains(note)).toBe(false)
    }
    // The gift is a number of the credits model; without a tariff there is no daily limit.
    expect(GIFT_NOTE).toContain(`— ${signupGiftCredits} кредитов в подарок`)
    expect(GIFT_NOTE).not.toMatch(/в день/)
    // The gift is promised in credits and in small tasks, never as a count of tasks.
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

  it('shows no prices and keeps the way to the lead when the plans are unavailable', () => {
    render(<Pricing plans={[]} pack={null} />)

    expect(screen.getByText('Сейчас не удалось загрузить тарифы.')).toBeInTheDocument()
    // The sentence names what the link under it does, and no registration.
    const way = screen.getByText(/Оставить заявку можно уже сейчас\./)
    expect(way.textContent).toContain('Оставить заявку можно уже сейчас.')
    expect(screen.queryByText(/Зарегистр/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Начать бесплатно' })).toHaveAttribute('href', '#lead')
  })

  it('leads a signed-in visitor to the chats when the plans are unavailable', () => {
    render(<Pricing plans={[]} pack={null} isGuest={false} />)

    const way = screen.getByText(/Перейти к чатам можно по ссылке ниже\./)
    // The prepositions stay with their words.
    expect(way.textContent).toContain('к\u00a0чатам можно по\u00a0ссылке')
    expect(screen.queryByText(/Зарегистр|заявку/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Открыть чаты' })).toHaveAttribute('href', '/chats')
  })
})
