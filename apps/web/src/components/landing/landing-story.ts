import { nbsp } from '@/lib/nbsp'

// The one story of the landing: the fictional cafe «Крошка» and the requests of its owner.
// No 'use client' here: the server page and the client islands read the same words and numbers,
// so a request, a price or a schedule is written once. The first request of the demo, the frames
// of «Как это работает» and the card of the safety block tell the same change of one price.
// The cafe is fictional: every place that shows it says «Пример» or «Демо».

const ITEM = 'Капучино'
const VOLUME = '250 мл'
/** The price that the story changes, in rubles, as the menu of the cafe writes it. */
const PRICE = { before: '250', after: '290' } as const
/** The Saturday hours of the cafe. */
const HOURS = { before: '09:00–21:00', after: '08:00–21:00' } as const

type Scenario = {
  /** The name of the request on its button. */
  label: string
  /** What the owner writes in the chat. */
  request: string
  /** The field of the site that the request changes. */
  field: string
  before: string
  after: string
  /** What the chat says once the change is on the site. */
  result: string
}

// Typed with plain spaces: a label for a screen reader takes these words as they are.
const words = {
  price: {
    label: 'Цена',
    request: `Поменяй цену капучино на ${PRICE.after} ₽`,
    field: `${ITEM}, ${VOLUME}`,
    before: `${PRICE.before} ₽`,
    after: `${PRICE.after} ₽`,
    result: 'Готово. В меню уже новая цена.',
  },
  hours: {
    label: 'График',
    request: 'По субботам открываемся в 8:00. Обнови сайт',
    field: 'Часы работы в субботу',
    before: HOURS.before,
    after: HOURS.after,
    result: 'Готово. По субботам — с восьми утра.',
  },
  promotion: {
    label: 'Акция',
    request: 'Добавь акцию: второй кофе за полцены',
    field: 'Плашка над меню',
    before: 'Без акции',
    after: 'Второй кофе −50%',
    result: 'Готово. Акция появилась на сайте.',
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

/** The site of the cafe, as its window in the examples shows it. */
export const cafe = {
  name: 'КРОШКА',
  address: 'kroshka.example',
  item: ITEM,
  volume: nbsp(VOLUME),
  /** The banner over the menu: before the promotion request and after it. */
  banner: {
    before: 'ХОРОШИЙ ДЕНЬ. ХОРОШИЙ КОФЕ.',
    after: nbsp('ВТОРОЙ КОФЕ −50% · БЕРИТЕ ДРУГА'),
  },
} as const

/** The change that the page follows from the request to its undo. */
export const story = {
  ...scenarios.price,
  /** The same words with plain spaces, for the labels that a screen reader takes. */
  inWords: words.price,
  /** The prices without the ruble sign, for the card that sets the sign in a face of its own. */
  amount: PRICE,
} as const
