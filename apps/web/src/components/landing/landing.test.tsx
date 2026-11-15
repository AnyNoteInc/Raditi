// @vitest-environment jsdom

import { legalDocuments } from '@repo/domain'
import {
  giftTaskCounts,
  signupGiftCredits,
  typicalTaskCredits,
} from '@repo/domain/billing/credit-numbers'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { LandingViewer } from '@/server/landing-viewer'

import { Landing, questions } from './landing'
import { cafe, scenarios } from './landing-story'
import { MAIN_ACTION_SHORT, mainAction } from './main-action'
import { Pricing } from './pricing'
import { guest, HANGING, member, plain, pricing } from './testing'

vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))

/** The first request of the demo, the one it opens with. */
const story = scenarios.compare

/** The words of a site to connect that left the page with the projects (docs/plan/83). */
const SITE_WORDS =
  /WordPress|Joomla|OpenCart|MODX|Битрикс|подключ\S* (ваш )?сайт|(?<![а-яё])правк|на сайте/i

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

/** The terms under the main action of the first screen, as they read. */
const termsOf = (container: HTMLElement) =>
  [...container.querySelectorAll('section[aria-labelledby="hero-title"] ul > li')].map((term) =>
    plain(term.textContent),
  )

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

  it('keeps the address of the pages in one piece', () => {
    const container = renderLanding(guest)
    const names = textsOf(container).filter(({ text }) => /pages\.raditi\.ru/.test(text))
    const prose = names.filter(
      ({ parent }) =>
        parent.closest('[data-sr-only], [aria-hidden="true"], #site-demo') === null &&
        !isControl(parent),
    )

    // The dots of an address are places to break a line: in the prose it is bound by the class.
    expect(prose.length).toBeGreaterThan(0)
    for (const { parent, text } of prose) {
      expect(text).toBe('pages.raditi.ru')
      expect(parent.className).toContain('nowrap')
    }
  })

  it('tells of no site to connect: an assistant for every day (docs/plan/83)', () => {
    for (const viewer of [guest, member]) {
      const text = plain(renderLanding(viewer).textContent)
      expect(text.match(SITE_WORDS)).toBeNull()
    }
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

  it('calls the main action by one name wherever a guest is led to it', () => {
    const container = renderLanding(guest)
    const { href, label } = mainAction(true)
    const labels = [...container.querySelectorAll(`a[href="${href}"]`)].map((link) =>
      link.textContent.trim(),
    )

    // The header, its mobile menu, the first screen and the plans: the whole name, or its first
    // word where a row has no room for it.
    expect(href).toBe('#lead')
    expect(labels).toEqual([MAIN_ACTION_SHORT, MAIN_ACTION_SHORT, label, label])
    expect(label.startsWith(`${MAIN_ACTION_SHORT} `)).toBe(true)
    // And the form it leads to is on the page.
    expect(container.querySelector('section#lead form')).not.toBeNull()
    // One way in (the owner, 13.11.2026): the landing leads no guest to the registration.
    expect(container.querySelectorAll('a[href="/sign-up"]')).toHaveLength(0)
    const controls = [...container.querySelectorAll('a, button')].map((control) =>
      plain(control.textContent),
    )
    expect(controls.filter((name) => /зарегистр/i.test(name))).toEqual([])
  })

  it('does not ask a signed-in visitor to register', () => {
    const container = renderLanding(member)

    expect(container.querySelectorAll('a[href="/sign-up"]')).toHaveLength(0)
    expect(container.textContent).not.toMatch(/Зарегистрир/)
    // Nor is the gift of the registration offered again: by the action under the tariffs they
    // read only when the tariff is chosen.
    const tariffs = plain(container.querySelector('#pricing')?.textContent)
    expect(tariffs).not.toMatch(/при регистрации|в подарок/i)
    expect(tariffs).toContain('Тариф выберете позже.')
    // The first screen leads to the chats; the whole page promises no gift and names no
    // registration.
    const hero = container.querySelector('section[aria-labelledby="hero-title"]')
    expect(hero?.querySelector('a[href="/chats"]')).toHaveTextContent(/^Открыть чаты\s*$/)
    expect(hero?.querySelector('a[href="#lead"]')).toBeNull()
    expect(plain(container.textContent)).not.toMatch(/регистрац|в подарок/i)
    // The form of a lead stays on the page; nothing of it leads a signed-in visitor there.
    expect(container.querySelectorAll('a[href="#lead"]')).toHaveLength(0)
    expect(plain(container.querySelector('#lead')?.textContent)).toContain(
      'Оставьте сайт компании и телефон — расскажем, какие ежедневные дела можно поручить Радити, и поможем с первыми задачами.',
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

  it('links every legal document and the map of the site from the foot of the page', () => {
    const container = renderLanding(guest)
    const links = [
      ...container.querySelectorAll('footer nav[aria-labelledby="footer-documents"] a'),
    ].map((link) => [link.textContent, link.getAttribute('href')])

    expect(links).toEqual(
      legalDocuments.map((document) => [document.title, `/terms/${document.slug}`]),
    )
    expect(legalDocuments.length).toBeGreaterThan(0)
    expect(container.querySelector('footer a[href="/sitemap.xml"]')).toHaveTextContent(
      /^Карта сайта$/,
    )
  })

  it('promises a visitor whose session is unknown no gift and no registration', () => {
    const container = renderLanding({ status: 'unavailable', user: null })
    const hero = container.querySelector('section[aria-labelledby="hero-title"]')

    expect(plain(hero?.textContent)).not.toMatch(/зарегистр|подар/i)
    expect(hero?.querySelector('a[href="/chats"]')).toHaveTextContent(/^Открыть чаты\s*$/)
    // No gift is promised to a visitor who may have had it: not on the first screen, not under
    // the tariffs and not in the lead.
    expect(termsOf(container)).toEqual(['В браузере и в Telegram', 'Без установки'])
    for (const id of ['pricing', 'lead']) {
      expect(plain(container.querySelector(`#${id}`)?.textContent)).not.toMatch(
        /при регистрации|в подарок/i,
      )
    }
  })

  it('heads the page with the words people search by, in the one first-level heading', () => {
    for (const viewer of [guest, member]) {
      const container = renderLanding(viewer)
      const headings = container.querySelectorAll('h1')

      expect(headings).toHaveLength(1)
      expect(headings[0]).toHaveAttribute('id', 'hero-title')
      expect(plain(headings[0]?.textContent)).toBe(
        'ИИ-помощник на каждый день для вас и вашего бизнеса',
      )
      // The section of the first screen is named by it.
      expect(headings[0]?.closest('section')).toHaveAttribute('aria-labelledby', 'hero-title')
      // The demo names the service in a heading of the chat it draws, at a lower level.
      expect(container.querySelectorAll('h2').length).toBeGreaterThan(5)
    }
  })

  it('says on the first screen what to do and what comes of it, and nothing of the launch', () => {
    const container = renderLanding(guest)
    const hero = container.querySelector('section[aria-labelledby="hero-title"]')
    const text = plain(hero?.textContent)

    // The slogan is the large line under the heading, a paragraph and not a second heading.
    const slogan = hero?.querySelector('h1 + p')
    expect(plain(slogan?.textContent)).toBe('Напишите в чат. Всё сделаем.')
    expect(text).toContain(
      'Найти, сравнить, написать письмо, собрать таблицу. Напишите обычными словами, что нужно, — Радити сделает.',
    )
    // Two ways on: the main action and the example under the first screen.
    expect(
      [...(hero?.querySelectorAll('a') ?? [])].map((link) => [
        link.textContent.trim(),
        link.getAttribute('href'),
      ]),
    ).toEqual([
      [mainAction(true).label, mainAction(true).href],
      ['Посмотреть пример', '#demo'],
    ])
    expect(hero?.querySelector(`a[href="${mainAction(true).href}"]`)?.className).toContain(
      'primaryButton',
    )
    // The status of the launch has left the first screen; the tariffs still say it.
    expect(text).not.toMatch(/готовится к запуску|Оплата откроется/)
    expect(plain(container.querySelector('#pricing')?.textContent)).toContain(
      'Оплату пока не принимаем: сервис готовится к запуску.',
    )
  })

  it('lists the terms under the main action: the gift for a guest only', () => {
    const { small } = giftTaskCounts(signupGiftCredits)
    const container = renderLanding(guest)

    // The numbers are those of the credits model: the gift and the small tasks it holds.
    expect(termsOf(container)).toEqual([
      `${signupGiftCredits} кредитов в подарок — около ${small} небольших задач`,
      'В браузере и в Telegram',
      'Без установки',
    ])
    expect(small).toBeGreaterThanOrEqual(3)
    const list = container.querySelector('section[aria-labelledby="hero-title"] ul')
    // The role is written out: without its markers Safari stops reading a list as one.
    expect(list).toHaveAttribute('role', 'list')
    // Under the actions, the last thing of the first screen; every term has its sign, which a
    // screen reader passes by.
    expect(list?.previousElementSibling?.querySelector('a[href="#lead"]')).not.toBeNull()
    expect(list?.nextElementSibling).toBeNull()
    for (const term of list?.querySelectorAll('li') ?? []) {
      expect(term.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1)
    }
    // A number stays with its word and a dash with the word before it.
    expect(list?.querySelector('li')?.textContent).toContain(
      `${signupGiftCredits}\u00a0кредитов в\u00a0подарок\u00a0— около ${small}\u00a0небольших задач`,
    )

    // A visitor with an account has had the gift of the sign-up: the two other terms stay.
    expect(termsOf(renderLanding(member))).toEqual(['В браузере и в Telegram', 'Без установки'])
  })

  it('sets the sections in the order of the visitor, each under its own heading', () => {
    const container = renderLanding(guest)
    const sections = [...container.querySelectorAll('main > section')]

    expect(sections.map((section) => section.id)).toEqual([
      '',
      'demo',
      'possibilities',
      'safety',
      'pricing',
      'lead',
      'faq',
    ])
    // Every section is named by a heading inside it; under the first screen, of the second level.
    for (const section of sections) {
      const heading = container.querySelector(`#${section.getAttribute('aria-labelledby')}`)
      expect(section.contains(heading)).toBe(true)
      expect(heading?.tagName).toBe(section.id === '' ? 'H1' : 'H2')
    }
    expect(
      sections.slice(1).map((section) => {
        const heading = section.querySelector('h2')
        return plain(heading?.textContent).replace(/\s+/g, ' ')
      }),
    ).toEqual([
      'Попробуйте сами',
      'Что можно поручить',
      'Вы видите, что делает Радити',
      'Тарифы',
      `${signupGiftCredits} кредитов в подарокза заявку.`,
      'Вопросы',
    ])
    // Every link of the page to a place on it finds that place.
    const anchors = [...container.querySelectorAll('a[href^="#"]')].map(
      (link) => link.getAttribute('href') ?? '',
    )
    expect(new Set(anchors).size).toBeGreaterThanOrEqual(7)
    expect(anchors.filter((href) => container.querySelector(href) === null)).toEqual([])
    // What the redesign of 13.11.2026 took away: the steps, the final call and their anchors.
    expect(
      container.querySelector('#how, #start-title, [aria-labelledby="start-title"]'),
    ).toBeNull()
  })

  it('sets what a section is about under its heading, never beside it', () => {
    const container = renderLanding(guest)
    const under = (id: string) => {
      const heading = container.querySelector(`#${id}`)
      // The heading and its words share one block, the words right after the heading.
      expect(heading?.parentElement?.className).toContain('sectionHeading')
      return plain(heading?.nextElementSibling?.textContent)
    }

    expect(under('demo-title')).toBe(
      'Кофейня для примера. Выберите просьбу — и посмотрите, что сделает Радити.',
    )
    expect(under('can-title')).toBe(
      'Дела, на которые обычно уходит полдня: ваша просьба — и что вы получите в ответ.',
    )
    expect(under('safety-title')).toBe(
      'Каждый шаг — в чате. Остановить работу можно в любой момент.',
    )
    // The tariffs are three cards: the line under their heading is the note about the payment.
    expect(under('pricing-title')).toBe('Оплату пока не принимаем: сервис готовится к запуску.')
    // The questions need no words under their heading; the sign «?» beside it is gone.
    expect(container.querySelector('#faq-title')?.nextElementSibling).toBeNull()
    for (const id of ['demo-title', 'can-title', 'safety-title']) {
      expect(container.querySelector(`#${id}`)?.nextElementSibling?.tagName).toBe('P')
    }
  })

  it('shows the one change of the demo in the section of the example, under the first screen', () => {
    const container = renderLanding(guest)
    const text = (selector: string) => plain(container.querySelector(selector)?.textContent)
    const demo = container.querySelector('#demo')

    // The link of the first screen leads to the section that holds the demo.
    expect(demo?.querySelector('#site-demo')).not.toBeNull()
    expect(demo?.previousElementSibling).toHaveAttribute('aria-labelledby', 'hero-title')
    expect(text('#site-demo')).toContain(plain(story.request))
    expect(text('#site-demo')).toContain(cafe.name)
    expect(text('#site-demo')).toContain(`Станет: ${plain(story.after)}`)
    // Wherever the cafe appears, it is called an example or a demo.
    expect(text('#demo')).toContain('Кофейня для примера.')
    expect(text('#site-demo')).toContain('Интерактивное демо')
    // The request and its prices stand in the demo alone: the safety block undoes nothing by itself.
    const outside = plain(container.textContent).replace(text('#site-demo'), '')
    expect(outside).not.toContain(plain(story.request))
    expect(container.querySelectorAll('#safety button, #safety a')).toHaveLength(0)
  })

  it('tells in three facts that the work of Радити is in view', () => {
    const container = renderLanding(guest)
    const facts = [...container.querySelectorAll('#safety ol > li')]

    expect(container.querySelector('#safety ol')).toHaveAttribute('role', 'list')
    expect(
      facts.map((fact) => [
        plain(fact.querySelector('h3')?.textContent),
        plain(fact.querySelector('p')?.textContent),
      ]),
    ).toEqual([
      [
        'Ход работы на виду',
        'Пока Радити работает, в чате видно, что он ищет, читает и пишет. Браузер помощника можно открыть и посмотреть.',
      ],
      [
        'Остановить и вернуть',
        'Работу можно остановить, а последнюю просьбу — отменить: разговор вернётся к тому, что было до неё.',
      ],
      [
        'Без вашей просьбы — ничего лишнего',
        'Платить, удалять, вводить пароли и что-то менять на чужих сайтах Радити без вашей явной просьбы не станет.',
      ],
    ])
    // The numbers are drawn for the eye; the list itself counts for a screen reader.
    expect(facts.map((fact) => fact.querySelector('[aria-hidden="true"]')?.textContent)).toEqual([
      '01',
      '02',
      '03',
    ])
    // The undo is the one the answer about a result gives.
    const answer = questions.find(({ question }) => question === 'А если результат не понравится?')
    expect(answer?.answer).toContain('Последнюю просьбу можно отменить')
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
      // The sections the redesign of 13.11.2026 took away.
      'Надо найти разработчика',
      'А можно просто написать',
      'надо поправить',
      'уже готово',
      'Как это работает',
      'Вернём как было.',
      'После запуска',
      'Оплата откроется позже',
      // The footer keeps the name and the way in alone (the owner, 15.11.2026).
      'Ваш сайт в заботливых руках.',
    ]) {
      expect(text).not.toContain(gone)
    }
    for (const kept of [
      'Сначала покажу. Решаете вы.',
      'Оплату пока не принимаем: сервис готовится к запуску.',
    ]) {
      expect(text).toContain(kept)
    }
    // The launch is spoken of once, by the tariffs.
    expect(text.split('готовится к запуску')).toHaveLength(2)
  })

  it('counts credits in the tariffs and says «задача» of what the visitor asks', () => {
    const container = renderLanding(guest)
    const text = plain(container.textContent)

    for (const counted of [
      '200 кредитов в месяц — в среднем около 18 задач',
      'Небольшая задача — около 50 ₽',
      'При регистрации — 50 кредитов в подарок: хватит на несколько небольших задач. Тариф выберете позже.',
    ]) {
      expect(text).toContain(counted)
    }
    // No «правка» at all: there is no site to change (docs/plan/83).
    expect(text).not.toMatch(/(?<![а-яё])(правк|правок)/i)
    // Nor is a tariff chosen by a volume of credits, or a credit something a task «counts as»:
    // the visitor thinks in tasks, and the page translates.
    expect(text).not.toMatch(/объём кредитов|считается кредитом|один кредит — одна/i)
    // What a tariff includes, what the gift holds, what the visitor asks the price of.
    expect(text).toContain('В каждый тариф входят поиск в интернете')
    expect(text).toContain('хватит на несколько небольших задач')
    expect(text).toContain('Сколько стоит одна задача?')
  })

  it('answers what a change costs in the words of the credits model and promises no terms to come', () => {
    const container = renderLanding(guest)
    const question = [...container.querySelectorAll('#faq details')].find(
      (details) =>
        plain(details.querySelector('summary')?.textContent) === 'Сколько стоит одна задача?',
    )
    const answer = plain(question?.querySelector('p')?.textContent)

    expect(answer).toBe(
      'Работу мы считаем в кредитах. Короткий ответ или небольшой текст — обычно 5 кредитов, документ, таблица или страница — 15–25. Сколько это в рублях, написано в карточке каждого тарифа. Списываем только за выполненную работу: попытка, которая оборвалась из-за сбоя, ничего не стоит.',
    )
    // The rule of the charge is the sentence under the tariffs, word for word.
    expect(plain(container.querySelector('#pricing')?.textContent)).toContain(
      'Списываем только за выполненную работу: попытка, которая оборвалась из-за сбоя, ничего не стоит.',
    )
    // The examples are the first two rows of the orientation list, said as usual and not as a
    // price.
    const { small, block } = typicalTaskCredits
    expect(answer).toContain(`обычно ${small.to} кредитов`)
    expect(answer).toContain(`— ${block.from}–${block.to}.`)
    // «В карточке каждого тарифа» is true: every card names the price of a small task in rubles.
    const cards = [...container.querySelectorAll('#pricing article')]
    expect(cards).toHaveLength(pricing.plans.length)
    for (const card of cards) {
      expect(plain(card.textContent)).toMatch(/Небольшая задача — около \d+ ₽/)
    }
    // The answer names no price in rubles itself: the cards do.
    expect(answer).not.toContain('₽')
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

  it('promises the gift of the registration three times: on the first screen, under the tariffs and in the lead', () => {
    const container = renderLanding(guest)
    const text = plain(container.textContent)
    const gift = `${signupGiftCredits} кредитов в подарок`

    // The lead offers the same gift (docs/plan/65-landing-platforms-leads.md, Л4) and says it
    // comes with the registration.
    expect(text.split(gift)).toHaveLength(4)
    expect(termsOf(container)[0]).toContain(gift)
    expect(plain(container.querySelector('#pricing')?.textContent)).toContain(gift)
    expect(plain(container.querySelector('#lead')?.textContent)).toContain(gift)
    expect(plain(container.querySelector('#lead')?.textContent)).toContain(
      'придут вместе с регистрацией',
    )
    // In credits and in small tasks: no count of tasks is made of the gift.
    expect(text).not.toMatch(/в подарок[^.]*\d+ задач/)
  })

  it('answers the five questions of the list, in its order, and keeps the answer about the data as it was', () => {
    const container = renderLanding(guest)
    const asked = [...container.querySelectorAll('#faq details')]

    // The page and the FAQPage markup of the search engines read one list.
    expect(
      asked.map((details) => [
        plain(details.querySelector('summary')?.textContent),
        plain(details.querySelector('p')?.textContent),
      ]),
    ).toEqual(questions.map(({ question, answer }) => [question, answer]))
    expect(questions.map(({ question }) => question)).toEqual([
      'Что умеет Радити?',
      'Нужно что-то устанавливать?',
      'Сколько стоит одна задача?',
      'А если результат не понравится?',
      'Где будут храниться данные?',
    ])
    for (const { question, answer } of questions) {
      expect(question).toMatch(/\?$/)
      expect(answer.trim().length).toBeGreaterThan(40)
      // Plain spaces in the list: the page binds the words, the markup takes them as they are.
      expect(question + answer).not.toContain('\u00a0')
    }
    // All closed at first, and each opens by itself.
    expect(asked.filter((details) => details.hasAttribute('open'))).toEqual([])
    const data = asked.find((question) =>
      question.querySelector('summary')?.textContent.includes('Где будут храниться данные?'),
    )
    // The answer names the one model provider since the move to OpenCode with GLM (G8); its exact
    // words are pinned in landing-data-recipient.test.tsx.
    expect(plain(data?.querySelector('p')?.textContent)).toBe(
      'Для хранилищ платформы предусмотрено размещение в России. Задания обрабатывает модель GLM провайдера Z.ai за рубежом; переданные ему копии могут храниться по условиям этого провайдера. Условия обработки данных описаны в документах сервиса.',
    )
  })
})
