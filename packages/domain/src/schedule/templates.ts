import type { ReasoningEffort } from '../llm/model-class.ts'
import type { ScheduleTrigger } from './triggers.ts'

/**
 * The templates of «Шаблоны» (docs/plan/82-scheduled-tasks.md, §4.6, Зп9, Зп58): six everyday
 * errands, none of which needs a file or a write on a site. A click opens the window
 * with the fields filled in, nothing is created before «Создать». The instructions are written as
 * the client's own request in the chat, as «Что можно поручить» of the landing; the words of the
 * platform to the client are in the brackets of a place to fill in, and in the hint.
 */

export const scheduleTemplateSlugs = [
  'currency-rates',
  'competitors',
  'site-check',
  'reviews',
  'post-ideas',
  'holidays',
] as const

/**
 * The templates of a project (docs/plan/84-projects.md, ПР19, slice 84.14): the window opened in a
 * project offers them before the six. Two read the repository of the project, and the window shows
 * them only to a project that has one; the instructions never ask what a run without its client
 * may not do — send a branch, open a merge request, accept, deploy.
 */
export const scheduleProjectTemplateSlugs = ['build-check', 'merge-requests', 'week-plan'] as const

export type ScheduleTemplateSlug =
  (typeof scheduleTemplateSlugs)[number] | (typeof scheduleProjectTemplateSlugs)[number]

/** The icon of a template, by its name in the icons of the cabinet (`app-icon.tsx`). */
export type ScheduleTemplateIcon =
  'results' | 'binoculars' | 'pulse' | 'search' | 'bulb' | 'clock' | 'runs' | 'gitlab'

export interface ScheduleTemplate {
  slug: ScheduleTemplateSlug
  /** Of a project only; `repository` — of a project with a repository. Absent — of any task. */
  needs?: 'project' | 'repository'
  name: string
  icon: ScheduleTemplateIcon
  instructions: string
  /** A hint of the window under the instructions; absent — none. */
  hint?: string
  triggers: readonly ScheduleTrigger[]
  effort: ReasoningEffort
}

/**
 * A place of a template for the client's own words, `[впишите …]` (Зп59): while the instructions
 * hold one, the task is not saved.
 */
export const SCHEDULE_TEMPLATE_PLACEHOLDER = /\[впишите[^\]]*\]/i

export const scheduleTemplates: readonly ScheduleTemplate[] = Object.freeze([
  {
    slug: 'currency-rates',
    name: 'Курс валют',
    icon: 'results',
    instructions:
      'Пришли курс доллара, евро и юаня по ЦБ на сегодня и насколько он изменился со вчера.',
    triggers: [{ kind: 'weekdays', time: '09:00' }],
    effort: 'low',
  },
  {
    slug: 'competitors',
    name: 'Цены конкурентов',
    icon: 'binoculars',
    instructions:
      'Посмотри сайты конкурентов: [впишите адреса сайтов]. Расскажи, какие у них сейчас цены, акции и новости.',
    triggers: [{ kind: 'weekly', time: '10:00', days: [1] }],
    effort: 'high',
  },
  {
    slug: 'site-check',
    name: 'Проверка сайта',
    icon: 'pulse',
    instructions:
      'Открой сайт [впишите адрес сайта] и пройди главную и важные страницы: всё ли открывается, нет ли ошибок и пустых блоков, работают ли ссылки. Формы не отправляй. Скажи, если что-то не так.',
    triggers: [{ kind: 'weekdays', time: '09:00' }],
    effort: 'low',
  },
  {
    slug: 'reviews',
    name: 'Отзывы за неделю',
    icon: 'search',
    instructions:
      'Найди новые отзывы о [впишите название и город] на картах и сайтах отзывов за последнюю неделю. Коротко перескажи, что хвалят и на что жалуются, без имён авторов, и предложи вежливые ответы на жалобы.',
    triggers: [{ kind: 'weekly', time: '09:00', days: [1] }],
    effort: 'high',
  },
  {
    slug: 'post-ideas',
    name: 'Идеи для постов',
    icon: 'bulb',
    instructions:
      'Предложи три идеи постов для соцсетей на эту неделю: тема, короткий текст и лучший день для публикации. Учти ближайшие праздники.',
    hint: 'О вашем деле агент знает то, что написано в «Инструкциях агенту» в настройках.',
    triggers: [{ kind: 'weekly', time: '09:00', days: [1] }],
    effort: 'high',
  },
  {
    slug: 'holidays',
    name: 'Праздники месяца',
    icon: 'clock',
    instructions:
      'Назови праздники и памятные даты следующего месяца, к которым можно сделать акцию или поздравить клиентов, и к каждой предложи одну идею.',
    triggers: [{ kind: 'monthly', time: '10:00', day: 25 }],
    effort: 'high',
  },
] satisfies ScheduleTemplate[])

export const scheduleProjectTemplates: readonly ScheduleTemplate[] = Object.freeze([
  {
    slug: 'build-check',
    needs: 'repository',
    name: 'Проверка сборок по утрам',
    icon: 'runs',
    instructions:
      'Проверь последние сборки в репозитории. Если какая-то упала — разберись по журналу, исправь и подготовь изменения — запрос на слияние открою я сам. Пришли короткую сводку.',
    triggers: [{ kind: 'weekdays', time: '09:00' }],
    effort: 'high',
  },
  {
    slug: 'merge-requests',
    needs: 'repository',
    name: 'Сводка запросов на слияние',
    icon: 'gitlab',
    instructions:
      'Пришли короткую сводку открытых запросов на слияние: что в каждом меняется, прошла ли сборка и что мешает принять. Ничего не принимай и не меняй.',
    triggers: [{ kind: 'weekly', time: '10:00', days: [1] }],
    effort: 'high',
  },
  {
    slug: 'week-plan',
    needs: 'project',
    name: 'План на неделю',
    icon: 'bulb',
    instructions:
      'Посмотри цель, инструкции и файлы проекта и предложи план работ на эту неделю: три-пять дел по порядку и что для каждого нужно от меня.',
    triggers: [{ kind: 'weekly', time: '09:00', days: [1] }],
    effort: 'high',
  },
] satisfies ScheduleTemplate[])

/** The templates the window of a project offers: of its project first, then the six (ПР19). */
export function scheduleTemplatesOfProject(project: {
  repository: boolean
}): readonly ScheduleTemplate[] {
  return [
    ...scheduleProjectTemplates.filter(
      (template) => template.needs !== 'repository' || project.repository,
    ),
    ...scheduleTemplates,
  ]
}

/** The template of a slug; undefined — none of §4.6 and of a project. */
export const scheduleTemplateOf = (slug: string): ScheduleTemplate | undefined =>
  scheduleTemplates.find((template) => template.slug === slug) ??
  scheduleProjectTemplates.find((template) => template.slug === slug)

/** The instructions still hold a place of a template for the client's words (Зп59). */
export const hasScheduleTemplatePlaceholder = (instructions: string): boolean =>
  SCHEDULE_TEMPLATE_PLACEHOLDER.test(instructions)

/** Where the first place to fill in stands in the instructions; null — none (Зп59). */
export function scheduleTemplatePlaceholderRange(
  instructions: string,
): { start: number; end: number } | null {
  const found = SCHEDULE_TEMPLATE_PLACEHOLDER.exec(instructions)
  return found === null ? null : { start: found.index, end: found.index + found[0].length }
}
