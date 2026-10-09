// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { LandingViewer } from '@/server/landing-viewer'

import { Landing } from './landing'
import { cafe, story } from './landing-story'
import { Pricing } from './pricing'

vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))

const plans = [
  {
    slug: 'start',
    name: 'Старт',
    price: '4900.00',
    editsPerMonth: 30,
    editsPerDay: 5,
    maxSites: 1,
  },
  {
    slug: 'business',
    name: 'Бизнес',
    price: '12900.00',
    editsPerMonth: 80,
    editsPerDay: 10,
    maxSites: 3,
  },
  {
    slug: 'agency',
    name: 'Агентство',
    price: '39900.00',
    editsPerMonth: 250,
    editsPerDay: 30,
    maxSites: 15,
  },
]
const pack = { price: '1990.00', edits: 10 }

const guest: LandingViewer = { status: 'guest', user: null }
const member: LandingViewer = {
  status: 'authenticated',
  user: { name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru', image: null },
}

function renderLanding(viewer: LandingViewer) {
  const href = viewer.status === 'guest' ? '/sign-up' : '/projects'
  const label = viewer.status === 'guest' ? 'Зарегистрироваться' : 'Открыть проекты'
  return render(
    <Landing
      viewer={viewer}
      pricing={<Pricing plans={plans} pack={pack} actionHref={href} actionLabel={label} />}
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

/** The text as it reads: non-breaking spaces are the business of the first tests only. */
const plain = (text: string | null | undefined) => (text ?? '').replaceAll('\u00a0', ' ')

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
    const hanging =
      /(?<![\p{L}\p{N}-])(в|во|с|со|к|ко|о|об|у|и|а|но|на|до|за|по|не|ни|от|из|для|без|при|про|над|под) /iu
    for (const viewer of [guest, member]) {
      const prose = textsOf(renderLanding(viewer)).filter(({ parent }) => !isControl(parent))

      expect(prose.filter(({ text }) => hanging.test(text)).map(({ text }) => text)).toEqual([])
    }
  })

  it('keeps the names with a hyphen or a slash in one piece', () => {
    const texts = textsOf(renderLanding(guest))
    const names = texts.filter(({ text }) => /1С-Битрикс|\/wp-admin/.test(text))

    expect(names.map(({ text }) => text).sort()).toEqual(['/wp-admin', '1С-Битрикс', '1С-Битрикс'])
    for (const { parent } of names) expect(parent.className).toContain('nowrap')
  })

  it('calls the registration by one name wherever a guest is led to it', () => {
    const container = renderLanding(guest)
    const labels = [...container.querySelectorAll('a[href="/sign-up"]')].map((link) =>
      link.textContent.trim(),
    )

    // The header, its mobile menu, the first screen, the plans and the final block.
    expect(labels).toEqual(Array.from({ length: 5 }, () => 'Зарегистрироваться'))
    expect(plain(container.textContent)).toContain(
      'Зарегистрируйтесь сейчас — подключение сайта откроется позже.',
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
    expect(container.textContent).toContain('Подключение сайта откроется позже.')
    // The first screen says what is open now without the registration. The whole page is not
    // searched for the word: an answer about the launch names the registration for everybody.
    const hero = plain(
      container.querySelector('section[aria-labelledby="hero-title"]')?.textContent,
    )
    expect(hero).not.toMatch(/зарегистр/i)
    expect(hero).toContain(
      'Сервис готовится к запуску. Сейчас можно попробовать пример; подключение сайта и оплата откроются позже.',
    )
  })

  it('tells a visitor whose session is unknown what is open without the registration either', () => {
    const container = renderLanding({ status: 'unavailable', user: null })
    const hero = plain(
      container.querySelector('section[aria-labelledby="hero-title"]')?.textContent,
    )

    expect(hero).not.toMatch(/зарегистр/i)
    expect(hero).toContain('Сейчас можно попробовать пример; подключение сайта')
  })

  it('says what the service is and that it is not launched yet on the first screen', () => {
    const hero = renderLanding(guest).querySelector('section[aria-labelledby="hero-title"]')
    const text = plain(hero?.textContent)

    expect(text).toContain('Радити — ИИ-помощник для сайта вашего бизнеса.')
    expect(text).toContain(
      'Сервис готовится к запуску. Сейчас можно попробовать пример и зарегистрироваться; подключение сайта и оплата откроются позже.',
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
      'Telegram',
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

  it('answers no more than eight questions and keeps the answer about the data as it was', () => {
    const container = renderLanding(guest)
    const questions = [...container.querySelectorAll('#faq details')]

    expect(questions.length).toBeGreaterThan(0)
    expect(questions.length).toBeLessThanOrEqual(8)
    const data = questions.find((question) =>
      question.querySelector('summary')?.textContent.includes('Где будут храниться данные?'),
    )
    // The lawyer has not approved a new answer: it stays word for word, non-breaking spaces aside.
    expect(plain(data?.querySelector('p')?.textContent)).toBe(
      'Для хранилищ платформы предусмотрено размещение в России. Задания обрабатывают модели OpenAI и Moonshot за рубежом; переданные им копии могут храниться по условиям этих провайдеров. Условия обработки данных описаны в документах сервиса.',
    )
  })
})
