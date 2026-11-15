import { nbsp } from '@/lib/nbsp'

// The one story of the landing: the fictional cafe «Крошка» and the everyday tasks its owner gives
// the assistant (owner's request of 15.11.2026: «ИИ-помощник на каждый день», docs/plan/83).
// No 'use client' here: the server page and the client islands read the same words, so a request
// or a result is written once. Every task is one the agent of a chat does today: it searches the
// web, writes a text, makes a document and publishes a page by a link. The cafe is fictional:
// every place that shows it says «Пример» or «Демо».

type Scenario = {
  /** The name of the request on its button. */
  label: string
  /** What the owner writes in the chat. */
  request: string
  /** The line of the documents the request fills in. */
  field: string
  before: string
  after: string
  /** What the chat says once the result is kept. */
  result: string
}

/** The page the third request publishes: a page of the agent, by its own link. */
const PAGE_ADDRESS = 'kroshka.pages.raditi.ru'
/** The address of the window of the demo: a fictional one, as every place of the cafe says. */
const WINDOW_ADDRESS = 'kroshka.example'

// Typed with plain spaces: a label for a screen reader takes these words as they are.
const words = {
  compare: {
    label: 'Цены',
    request: 'Найди трёх поставщиков кофейного зерна и сравни цены за килограмм',
    field: 'Зерно, 1 кг',
    before: 'Не сравнивали',
    after: 'от 1 390 ₽',
    result: 'Готово. Таблица с поставщиками и ссылками — в документах.',
  },
  letter: {
    label: 'Письмо',
    request: 'Напиши поставщику письмо: переносим поставку на пятницу',
    field: 'Письмо поставщику',
    before: 'Нет текста',
    after: 'Готово к отправке',
    result: 'Готово. Текст письма — в документах, можно копировать.',
  },
  page: {
    label: 'Меню',
    request: 'Сделай страницу с нашим меню и дай ссылку',
    field: 'Меню по ссылке',
    before: 'Нет страницы',
    after: PAGE_ADDRESS,
    result: 'Готово. Меню открывается по ссылке.',
  },
} as const satisfies Record<string, Scenario>

export type ScenarioId = keyof typeof words

/** The requests of the demo, in the order of their buttons. */
export const scenarioIds = Object.keys(words) as ScenarioId[]

/** The visible text: a price keeps its ruble sign, a line its preposition. The label of a
 *  button stays as typed, it is looked up by its exact name. */
const typeset = ({ label, request, field, before, after, result }: Scenario): Scenario => ({
  label,
  request: nbsp(request),
  field: nbsp(field),
  before: nbsp(before),
  after: nbsp(after),
  result: nbsp(result),
})

export const scenarios = Object.fromEntries(
  scenarioIds.map((id) => [id, typeset(words[id])]),
) as Record<ScenarioId, Scenario>

/** The documents of the cafe, as the window of the demo shows them. */
export const cafe = {
  name: 'КРОШКА',
  address: WINDOW_ADDRESS,
  /** The banner over the documents: before the page request and after it. */
  banner: {
    before: nbsp('МЕНЮ — ТОЛЬКО В ЗАЛЕ'),
    after: nbsp('МЕНЮ ТЕПЕРЬ ПО ССЫЛКЕ'),
  },
} as const
