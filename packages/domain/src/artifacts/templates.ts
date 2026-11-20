import type { ArtifactKind } from './kinds.ts'

/**
 * The templates «С чего начать» of the gallery and of «Создать» (docs/plan/88-artifacts.md, Ар50,
 * boards A-empty and A-create). A template is the skeleton of a new artifact: its sections with a
 * heading and a short start the client replaces; the words in square brackets are what to put in.
 * Only kinds whose view shipped have templates (`artifactReleasedKinds`): the document for now, the
 * table, the mockup and the canvas bring theirs with Э5 and Э6.
 */
export interface ArtifactTemplate {
  id: string
  kind: ArtifactKind
  /** The title of the template and of the artifact it makes. */
  title: string
  /** One line under the title in the gallery. */
  description: string
  sections: readonly { heading: string; content: string }[]
}

export const artifactTemplates: readonly ArtifactTemplate[] = Object.freeze([
  {
    id: 'offer',
    kind: 'document',
    title: 'Коммерческое предложение',
    description: 'Что вы предлагаете, сколько стоит и как начать работу',
    sections: [
      {
        heading: 'Кому и зачем',
        content: 'Коротко о задаче клиента: [что ему нужно и к какому сроку].',
      },
      {
        heading: 'Что мы сделаем',
        content: '- [Первая работа]\n- [Вторая работа]\n- [Третья работа]',
      },
      {
        heading: 'Стоимость и сроки',
        content: '| Работа | Срок | Цена |\n| --- | --- | --- |\n| [Работа] | [дней] | [цена] |',
      },
      {
        heading: 'Как начать',
        content:
          'Ответьте на это письмо или позвоните: [телефон]. Предложение действует до [даты].',
      },
    ],
  },
  {
    id: 'faq',
    kind: 'document',
    title: 'Ответы на частые вопросы',
    description: 'Вопросы покупателей и ваши ответы — для сайта и переписки',
    sections: [
      {
        heading: 'Заказ и оплата',
        content: '**[Вопрос покупателя]**\n\n[Ваш ответ.]',
      },
      {
        heading: 'Доставка',
        content: '**Сколько стоит доставка?**\n\n[Условия и цены доставки.]',
      },
      {
        heading: 'Возврат',
        content: '**Можно ли вернуть товар?**\n\n[Срок и порядок возврата.]',
      },
    ],
  },
  {
    id: 'returns',
    kind: 'document',
    title: 'Правила возврата',
    description: 'Сроки, условия и порядок возврата товара или денег',
    sections: [
      {
        heading: 'Сроки',
        content: 'Вернуть товар можно в течение [числа] дней со дня покупки.',
      },
      {
        heading: 'Условия',
        content: '- Товар не был в употреблении.\n- Сохранены упаковка и чек.\n- [Ваше условие]',
      },
      {
        heading: 'Как вернуть',
        content: '1. Напишите нам: [адрес или телефон].\n2. [Что сделать дальше.]',
      },
    ],
  },
  {
    id: 'promotion',
    kind: 'document',
    title: 'План продвижения на месяц',
    description: 'Цели, каналы и задачи по неделям',
    sections: [
      { heading: 'Цель месяца', content: '[Сколько заявок или продаж вы хотите получить.]' },
      {
        heading: 'Каналы',
        content: '- [Сайт]\n- [Соцсети]\n- [Рассылка]',
      },
      {
        heading: 'Задачи по неделям',
        content:
          '| Неделя | Что сделать |\n| --- | --- |\n| 1 | [задача] |\n| 2 | [задача] |\n| 3 | [задача] |\n| 4 | [задача] |',
      },
    ],
  },
] satisfies readonly ArtifactTemplate[])

/** The template of an id, of a kind that may be created now; null — no such template. */
export function artifactTemplateOf(id: string): ArtifactTemplate | null {
  return artifactTemplates.find((template) => template.id === id) ?? null
}
