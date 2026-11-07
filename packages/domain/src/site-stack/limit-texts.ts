/**
 * What the client reads for each `SiteLimit` (docs/plan/62-site-stacks.md, Т27, Т16; screens —
 * docs/plan/62-onboarding.md). A subpath of its own (`@repo/domain/site-stack/limit-texts`): the
 * wizard reads it in the browser, where the root of `@repo/domain` is not imported. Imports only
 * the type `SiteLimit`.
 */
import type { SiteLimit } from './stacks.ts'

export interface SiteLimitWords {
  /** `stackLabels`: «Joomla». */
  readonly platform: string
  /** `connection.fullName`: «MODX Revolution». */
  readonly product: string
  readonly version: string
  /** `refuseBelow` of the stack. */
  readonly minimum: string
  /** The way «Без доступа к файлам» is really open: `found.panel`. */
  readonly panel: boolean
}

/** The last sentence of a limit whose way goes on through the panel. */
const nextWay = (words: SiteLimitWords) =>
  words.panel
    ? 'Подключите сайт вариантом «Без доступа к файлам».'
    : 'Напишите нам, расскажем, что можно сделать.'

/** What `readLayout` refuses with: the project is saved by then, the way to the panel is not advice (Т16). */
export const lateSiteLimits = [
  'outside_root',
  'renamed_folder',
  'other_engine',
  'encoding_unsupported',
] as const satisfies readonly SiteLimit[]
export type LateSiteLimit = (typeof lateSiteLimits)[number]

const firstSentences: Readonly<Record<LateSiteLimit, string>> = Object.freeze({
  outside_root:
    'Часть файлов сайта лежит выше выбранной папки, поэтому копию сайта мы собрать не сможем.',
  renamed_folder:
    'Папки этого сайта названы не так, как обычно, поэтому копию сайта мы собрать не сможем.',
  other_engine: 'Сайт работает с базой данных, которую наша копия не поддерживает.',
  encoding_unsupported:
    'Сайт использует старую кодировку текста, с которой наша копия не работает.',
})

/** The screen «Настройка остановилась»: the first sentence of the limit, then the tail of Т16. */
export function siteLimitLateText(limit: LateSiteLimit, panel: boolean): string {
  const tail = panel
    ? 'Проект сохранён: агент будет работать через панель управления, правки идут сразу на сайт, и отменить их мы не сможем.'
    : 'Проект сохранён, но работать с этим сайтом мы пока не можем. Укажите другую папку или удалите проект.'
  return `${firstSentences[limit]} ${tail}`
}

export const siteLimitTexts: Readonly<Record<SiteLimit, (words: SiteLimitWords) => string>> =
  Object.freeze({
    version_unsupported: ({ platform, version, minimum }) =>
      `На сайте стоит ${platform} ${version}. Такую версию мы не поддерживаем: она давно не получает обновлений. Подключить сайт получится после обновления до ${platform} ${minimum} или новее. Обновить её может ваш разработчик или студия.`,
    version_unknown: ({ panel }) =>
      `Мы не смогли узнать версию сайта. Проверьте, что выбрана папка сайта. ${
        panel
          ? 'Если папка верная, подключите сайт вариантом «Без доступа к файлам».'
          : 'Напишите нам, расскажем, что можно сделать.'
      }`,
    not_yet: ({ platform, version }) =>
      `На сайте стоит ${platform} ${version}. С этой версией мы пока не работаем.`,
    other_product: ({ product }) =>
      `Это не ${product}, а другая система. Такие сайты мы не подключаем.`,
    outside_root: (words) => `${firstSentences.outside_root} ${nextWay(words)}`,
    renamed_folder: (words) => `${firstSentences.renamed_folder} ${nextWay(words)}`,
    // Only `readLayout` gives these, after `project.create`: the tail of a saved project (Т16).
    other_engine: ({ panel }) => siteLimitLateText('other_engine', panel),
    encoding_unsupported: ({ panel }) => siteLimitLateText('encoding_unsupported', panel),
    stack_off: ({ platform }) => `Сайты на ${platform} мы пока не подключаем.`,
  })
