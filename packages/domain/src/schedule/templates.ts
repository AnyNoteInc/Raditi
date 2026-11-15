import type { ReasoningEffort } from '../llm/model-class.ts'
import type { ScheduleTrigger } from './triggers.ts'

/**
 * The templates of «Шаблоны» (docs/plan/82-scheduled-tasks.md, §4.6, Зп9): a click opens the
 * window with the fields filled in, nothing is created before «Создать». The server knows them
 * too: a template about a site is not saved without a project, and the place for the addresses
 * of «Конкуренты» has to be filled in.
 */

/** Its project: needed — without one «Создать» is not offered; possible; none. */
export const scheduleTemplateProjects = ['required', 'optional', 'none'] as const
export type ScheduleTemplateProject = (typeof scheduleTemplateProjects)[number]

export const scheduleTemplateSlugs = [
  'site-check',
  'leads-digest',
  'news-ideas',
  'site-week',
  'competitors',
  'seo-check',
] as const
export type ScheduleTemplateSlug = (typeof scheduleTemplateSlugs)[number]

/** The icon of a template, by its name in the icons of the cabinet (`app-icon.tsx`). */
export type ScheduleTemplateIcon = 'pulse' | 'inbox' | 'bulb' | 'results' | 'binoculars' | 'search'

export interface ScheduleTemplate {
  slug: ScheduleTemplateSlug
  name: string
  icon: ScheduleTemplateIcon
  project: ScheduleTemplateProject
  instructions: string
  /** A hint of the window under the instructions; absent — none. */
  hint?: string
  triggers: readonly ScheduleTrigger[]
  effort: ReasoningEffort
}

/** The place for the addresses in «Конкуренты»: the client writes them instead (Зп9). */
export const SCHEDULE_TEMPLATE_PLACEHOLDER = '[впишите адреса]'

export const scheduleTemplates: readonly ScheduleTemplate[] = Object.freeze([
  {
    slug: 'site-check',
    name: 'Проверка сайта',
    icon: 'pulse',
    project: 'required',
    instructions:
      'Откройте сайт и пройдите главную и важные страницы: всё ли открывается, нет ли ошибок и пустых блоков, работают ли ссылки, открываются ли формы. Формы не отправляйте. Скажите, если что-то не так.',
    triggers: [{ kind: 'weekdays', time: '09:00' }],
    effort: 'low',
  },
  {
    slug: 'leads-digest',
    name: 'Заявки за сутки',
    icon: 'inbox',
    project: 'required',
    instructions:
      'Откройте админку сайта и соберите заявки с форм за прошедшие сутки: кто, когда и что просил. Пришлите короткую сводку.',
    hint: 'Нужен сохранённый вход в админку — раздел «Переменные» проекта',
    triggers: [{ kind: 'weekdays', time: '08:00' }],
    effort: 'low',
  },
  {
    slug: 'news-ideas',
    name: 'Идеи для новостей',
    icon: 'bulb',
    project: 'optional',
    instructions:
      'Предложите три идеи для новостей на сайт по теме моего бизнеса: заголовок и короткий план каждой. Посмотрите, что уже есть на сайте, чтобы не повторяться.',
    triggers: [{ kind: 'weekly', time: '09:00', days: [1] }],
    effort: 'high',
  },
  {
    slug: 'site-week',
    name: 'Новое на сайте за неделю',
    icon: 'results',
    project: 'required',
    instructions:
      'Посмотрите на сайте, что появилось за последнюю неделю: новые записи, страницы, товары. Коротко перечислите.',
    triggers: [{ kind: 'weekly', time: '16:00', days: [5] }],
    effort: 'low',
  },
  {
    slug: 'competitors',
    name: 'Конкуренты',
    icon: 'binoculars',
    project: 'none',
    instructions: `Посмотрите сайты конкурентов: ${SCHEDULE_TEMPLATE_PLACEHOLDER}. Расскажите, какие у них сейчас цены, акции и новости.`,
    triggers: [{ kind: 'weekly', time: '10:00', days: [1] }],
    effort: 'high',
  },
  {
    slug: 'seo-check',
    name: 'Проверка для поисковиков',
    icon: 'search',
    project: 'required',
    instructions: 'Проверьте заголовки и описания страниц сайта и битые ссылки; предложите правки.',
    triggers: [{ kind: 'monthly', time: '10:00', day: 1 }],
    effort: 'high',
  },
] satisfies ScheduleTemplate[])

/** The template of a slug; undefined — none of §4.6. */
export const scheduleTemplateOf = (slug: string): ScheduleTemplate | undefined =>
  scheduleTemplates.find((template) => template.slug === slug)

/** The instructions still hold the place for the addresses of «Конкуренты» (Зп9). */
export const hasScheduleTemplatePlaceholder = (instructions: string): boolean =>
  instructions.toLowerCase().includes(SCHEDULE_TEMPLATE_PLACEHOLDER)
