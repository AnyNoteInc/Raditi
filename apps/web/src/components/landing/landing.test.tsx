// @vitest-environment jsdom
import { signupGiftCredits, typicalTaskCredits } from '@repo/domain/billing/credit-numbers'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { LandingViewer } from '@/server/landing-viewer'

import { Landing } from './landing'
import { cafe, story } from './landing-story'
import { Pricing } from './pricing'
import { guest, HANGING, member, plain, pricing } from './testing'

vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))

function renderLanding(viewer: LandingViewer) {
  return render(
    <Landing
      viewer={viewer}
      pricing={<Pricing {...pricing} isGuest={viewer.status === 'guest'} />}
    />,
  ).container
}

/** Every piece of text of the page with the element that holds it. */
function textsOf(container: HTMLElement): { text: string; parent: HTMLElement }[] {
  const texts: { text: string; parent: HTMLElement }[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    if (text.trim() && node.parentElement) texts.push({ text, parent: node.parentElement })
  }
  return texts
}

// The names of controls keep plain spaces: they are looked up by exact name.
const isControl = (element: HTMLElement) => element.closest('a, button, label') !== null

describe('landing texts', () => {
  it('sets a non-breaking space before a dash and between a number and the ruble sign', () => {
    const texts = textsOf(renderLanding(guest)).map(({ text }) => text)

    expect(texts.length).toBeGreaterThan(100)
    expect(texts.filter((text) => / —/.test(text))).toEqual([])
    expect(texts.filter((text) => /\d ₽/.test(text))).toEqual([])
    // The page does have both, so the two checks above are not empty.
    expect(texts.some((text) => text.includes('\u00a0—'))).toBe(true)
    expect(texts.some((text) => /\d\u00a0₽/.test(text))).toBe(true)
  })

  it('leaves no short preposition or conjunction at the end of a line of prose', () => {
    for (const viewer of [guest, member]) {
      const prose = textsOf(renderLanding(viewer)).filter(({ parent }) => !isControl(parent))

      expect(prose.filter(({ text }) => HANGING.test(text)).map(({ text }) => text)).toEqual([])
    }
  })

  it('keeps the names with a hyphen or a slash in one piece', () => {
    const texts = textsOf(renderLanding(guest))
    const names = texts.filter(({ text }) => /1С-Битрикс/.test(text))

    // The answer about the sites, the first step, the row of the board of systems and the line at
    // the foot of the page (docs/plan/65-landing-platforms-leads.md, Л2).
    expect(names.map(({ text }) => text)).toEqual(Array.from({ length: 4 }, () => '1С-Битрикс'))
    for (const { parent } of names) expect(parent.className).toContain('nowrap')
  })

  it('keeps the range of figures of an answer in one piece', () => {
    const faq = renderLanding(guest).querySelector<HTMLElement>('#faq')
    if (!faq) throw new Error('no questions on the page')
    const { from, to } = typicalTaskCredits.block
    // A dash between figures is a place to break the line, like a hyphen: the range stands in a
    // piece of text of its own, so «15–» cannot end a line with «25» at the start of the next.
    const ranges = textsOf(faq).filter(({ text }) => /\d–\d/.test(text))

    expect(ranges.map(({ text }) => text)).toEqual([`${from}–${to}`])
    for (const { parent } of ranges) expect(parent.className).toContain('nowrap')
  })

  it('calls the registration by one name wherever a guest is led to it', () => {
    const container = renderLanding(guest)
    const labels = [...container.querySelectorAll('a[href="/sign-up"]')].map((link) =>
      link.textContent.trim(),
    )

    // The header, its mobile menu, the first screen, the plans and the final block.
    expect(labels).toEqual(Array.from({ length: 5 }, () => 'Зарегистрироваться'))
    expect(plain(container.textContent)).toContain(
      'Зарегистрируйтесь и оставьте заявку — подключим сайт бесплатно.',
    )
  })

  it('gives the final action the role of the main one', () => {
    const container = renderLanding(guest)
    const main = container.querySelector('section[aria-labelledby="hero-title"] a[href="/sign-up"]')
    const final = container.querySelector(
      'section[aria-labelledby="start-title"] a[href="/sign-up"]',
    )

    // One class for the role, so hover, press and weight cannot drift apart; the final action
    // adds a class for its size.
    expect(main?.className).toContain('primaryButton')
    expect(final?.className.split(' ')).toEqual(
      expect.arrayContaining(main?.className.split(' ') ?? ['no main action']),
    )
    expect(final?.className).toContain('finalButton')
  })

  it('does not ask a signed-in visitor to register', () => {
    const container = renderLanding(member)

    expect(container.querySelectorAll('a[href="/sign-up"]')).toHaveLength(0)
    expect(container.textContent).not.toContain('Зарегистрируйтесь')
    expect(plain(container.textContent)).toContain('Оставьте заявку — подключим сайт бесплатно.')
    // Nor is the gift of the registration offered again: by the action under the tariffs they
    // read only when the tariff is chosen.
    const tariffs = plain(container.querySelector('#pricing')?.textContent)
    expect(tariffs).not.toMatch(/при регистрации|в подарок/i)
    expect(tariffs).toContain('Тариф выберете позже.')
    // The first screen says what is open now without the registration. The whole page is not
    // searched for the word: an answer about the launch names the registration for everybody.
    const hero = plain(
      container.querySelector('section[aria-labelledby="hero-title"]')?.textContent,
    )
    expect(hero).not.toMatch(/зарегистр/i)
    expect(hero).toContain(
      'Сервис готовится к запуску. Оставьте заявку — подключим сайт бесплатно. Оплата откроется позже.',
    )
  })

  it('ends the page with the way in: sign-in for a guest, the chats for anybody else', () => {
    const wayIn = (viewer: LandingViewer) => {
      const links = renderLanding(viewer).querySelectorAll('footer a')
      return Array.from(links).find((link) => link.textContent?.trim().match(/^(Войти|Открыть)/))
    }

    expect(wayIn(guest)).toHaveAttribute('href', '/sign-in')
    expect(wayIn(guest)).toHaveTextContent(/^Войти$/)
    expect(wayIn(member)).toHaveAttribute('href', '/chats')
    expect(wayIn(member)).toHaveTextContent(/^Открыть чаты$/)
  })

  it('tells a visitor whose session is unknown what is open without the registration either', () => {
    const container = renderLanding({ status: 'unavailable', user: null })
    const hero = plain(
      container.querySelector('section[aria-labelledby="hero-title"]')?.textContent,
    )

    expect(hero).not.toMatch(/зарегистр/i)
    expect(hero).toContain('Оставьте заявку — подключим сайт бесплатно.')
    // And no gift is promised to a visitor who may have had it.
    expect(plain(container.querySelector('#pricing')?.textContent)).not.toMatch(
      /при регистрации|в подарок/i,
    )
  })

  it('says what the service is and that it is not launched yet on the first screen', () => {
    const hero = renderLanding(guest).querySelector('section[aria-labelledby="hero-title"]')
    const text = plain(hero?.textContent)

    expect(text).toContain('Радити — ИИ-помощник для сайта вашего бизнеса.')
    expect(text).toContain(
      'Сервис готовится к запуску. Попробуйте пример, зарегистрируйтесь и оставьте заявку — подключим сайт бесплатно. Оплата откроется позже.',
    )
    expect(text).toContain('ИИ-помощник для вашего сайта')
  })

  it('tells one change with one request and one pair of prices in the demo, the steps and the safety card', () => {
    const container = renderLanding(guest)
    const text = (selector: string) => plain(container.querySelector(selector)?.textContent)
    const request = plain(story.request)

    // The first request of the demo is the example of the steps: the same words, not a
    // retelling of them, and no other schedule than the one of the demo.
    expect(text('#site-demo')).toContain(request)
    expect(text('#how')).toContain(request)
    expect(text('#how')).not.toContain('18:00')
    // The card of the safety block undoes the same change of the same price.
    expect(text('#safety')).toContain(`${cafe.item} · ${plain(story.before)}`)
    expect(text('#safety')).toContain(`${story.amount.after}₽`)
    // Wherever the cafe appears, it is called an example or a demo.
    expect(text('#site-demo')).toContain('Интерактивное демо')
    expect(text('#how')).toContain('Пример')
    expect(text('#safety')).toContain('Демо')
  })

  it('keeps one word for the saved state and the words of the launch status', () => {
    const text = plain(renderLanding(guest).textContent)

    for (const gone of [
      'нимок',
      'Повторить правку',
      'анний доступ',
      'Агент ',
      'Создать аккаунт',
      'Начать с Радити',
      'Познакомиться',
      'портфолио',
      'платформы, на которых',
    ]) {
      expect(text).not.toContain(gone)
    }
    for (const kept of [
      'Сначала — копия',
      'Копия сохранена',
      'Вернём как было.',
      'После запуска',
      'Оплату пока не принимаем: сервис готовится к запуску.',
      'Ваш сайт в заботливых руках.',
    ]) {
      expect(text).toContain(kept)
    }
  })

  it('counts credits in the tariffs and says «правка» only of a change on the site', () => {
    const container = renderLanding(guest)
    const text = plain(container.textContent)

    for (const counted of [
      'Подберите тариф под свои задачи.',
      'Сколько задач в месяц вы планируете?',
      'Задача — одна ваша просьба. В расчёте берём 11 кредитов на задачу — это среднее',
      '150 кредитов в месяц — в среднем около 14 задач',
      'Небольшая правка — около 66 ₽',
      'При регистрации — 50 кредитов в подарок: хватит на несколько небольших правок. Тариф выберете позже.',
    ]) {
      expect(text).toContain(counted)
    }
    const questions = [...container.querySelectorAll('#faq summary')].map((summary) =>
      plain(summary.textContent),
    )
    expect(questions).toContain('Что такое кредит?')
    // The unit is never «правка»: no count, no price and no volume of it.
    expect(text).not.toMatch(
      /\d правк|\d правок|за правку|числу правок|объём правок|считается правкой|правок не хватит/i,
    )
    // Nor is a tariff chosen by a volume of credits, or a credit something a task «counts as»:
    // the visitor thinks in tasks, and the page translates.
    expect(text).not.toMatch(/объём кредитов|считается кредитом|один кредит — одна/i)
    // The word stays for the change itself.
    expect(text).toContain('В каждый тариф войдут правки текстов')
    expect(text).toContain('Маленькие правки.')
    expect(text).toContain('хватит на несколько небольших правок')
  })

  it('answers what a credit is in the words of the credits model and promises no terms to come', () => {
    const container = renderLanding(guest)
    const question = [...container.querySelectorAll('#faq details')].find(
      (details) => plain(details.querySelector('summary')?.textContent) === 'Что такое кредит?',
    )
    const answer = plain(question?.querySelector('p')?.textContent)

    expect(answer).toBe(
      'Кредитами мы считаем работу Радити над вашими задачами: чем больше нужно прочитать и изменить на сайте, тем больше кредитов стоит задача. Поменять цену, текст или фото — обычно 5 кредитов, добавить блок или страницу — 15–25. Списываем только за выполненную работу: попытка, которая оборвалась из-за сбоя, ничего не стоит. Кредиты тарифа начисляются каждый месяц. Неистраченные кредиты тарифа переходят на следующий месяц, один раз. Кредиты из пакета не сгорают.',
    )
    // The rule of the charge is the sentence under the tariffs, word for word.
    expect(plain(container.querySelector('#pricing')?.textContent)).toContain(
      'Списываем только за выполненную работу: попытка, которая оборвалась из-за сбоя, ничего не стоит.',
    )
    // The examples are the first two rows of the orientation list, said as usual and not as a
    // price; the same two stand under the calculator.
    const { small, block } = typicalTaskCredits
    expect(answer).toContain(`обычно ${small.to} кредитов`)
    expect(answer).toContain(`— ${block.from}–${block.to}.`)
    expect(plain(container.querySelector('#pricing')?.textContent)).toContain(
      `обычно ${small.to} кредитов, добавить блок или страницу — ${block.from}–${block.to}.`,
    )
    // The service is «Радити», never an agent.
    expect(answer).not.toMatch(/агент/i)
    // The answer of before the credits model, and its promise of terms before the payment opens.
    const text = plain(container.textContent)
    for (const gone of [
      'Что считается',
      'В основе тарифа',
      'увеличивают месячный лимит',
      'Подробные условия списаний',
      'перед подключением оплаты',
    ]) {
      expect(text).not.toContain(gone)
    }
  })

  it('promises the gift of the registration twice: by the action under the tariffs and in the lead', () => {
    const container = renderLanding(guest)
    const text = plain(container.textContent)
    const gift = `${signupGiftCredits} кредитов в подарок`

    // The lead offers the same gift (docs/plan/65-landing-platforms-leads.md, Л4) and says it
    // comes with the registration.
    expect(text.split(gift)).toHaveLength(3)
    expect(plain(container.querySelector('#pricing')?.textContent)).toContain(gift)
    expect(plain(container.querySelector('#lead')?.textContent)).toContain(gift)
    expect(plain(container.querySelector('#lead')?.textContent)).toContain(
      'придут вместе с регистрацией',
    )
    // In credits and in small edits: no count of tasks is made of the gift.
    expect(text).not.toMatch(/в подарок[^.]*\d+ задач/)
  })

  it('answers no more than eight questions and keeps the answer about the data as it was', () => {
    const container = renderLanding(guest)
    const questions = [...container.querySelectorAll('#faq details')]

    expect(questions.length).toBeGreaterThan(0)
    expect(questions.length).toBeLessThanOrEqual(8)
    const data = questions.find((question) =>
      question.querySelector('summary')?.textContent.includes('Где будут храниться данные?'),
    )
    // The answer names the one model provider since the move to OpenCode with GLM (G8); its exact
    // words are pinned in landing-data-recipient.test.tsx.
    expect(plain(data?.querySelector('p')?.textContent)).toBe(
      'Для хранилищ платформы предусмотрено размещение в России. Задания обрабатывает модель GLM провайдера Z.ai за рубежом; переданные ему копии могут храниться по условиям этого провайдера. Условия обработки данных описаны в документах сервиса.',
    )
  })
})
