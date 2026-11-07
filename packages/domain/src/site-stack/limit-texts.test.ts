import { describe, expect, it } from 'vitest'

import {
  lateSiteLimits,
  siteLimitLateText,
  siteLimitTexts,
  type SiteLimitWords,
} from './limit-texts.ts'
import { siteLimits, type SiteLimit } from './stacks.ts'

// The words of decisions Т27 and Т16 (docs/plan/62-site-stacks.md), byte for byte. The screen
// quotes are «»; „…“ stand in the decisions only as nesting.

const words = (panel: boolean): SiteLimitWords => ({
  platform: 'Joomla',
  product: 'MODX Revolution',
  version: '2.5',
  minimum: '3.9',
  panel,
})

const panelWay = 'Подключите сайт вариантом «Без доступа к файлам».'
const writeUs = 'Напишите нам, расскажем, что можно сделать.'
const savedWithPanel =
  'Проект сохранён: агент будет работать через панель управления, правки идут сразу на сайт, и отменить их мы не сможем.'
const savedWithoutPanel =
  'Проект сохранён, но работать с этим сайтом мы пока не можем. Укажите другую папку или удалите проект.'

const firstSentences: Record<(typeof lateSiteLimits)[number], string> = {
  outside_root:
    'Часть файлов сайта лежит выше выбранной папки, поэтому копию сайта мы собрать не сможем.',
  renamed_folder:
    'Папки этого сайта названы не так, как обычно, поэтому копию сайта мы собрать не сможем.',
  other_engine: 'Сайт работает с базой данных, которую наша копия не поддерживает.',
  encoding_unsupported:
    'Сайт использует старую кодировку текста, с которой наша копия не работает.',
}

const expected = (panel: boolean): Record<SiteLimit, string> => ({
  version_unsupported:
    'На сайте стоит Joomla 2.5. Такую версию мы не поддерживаем: она давно не получает обновлений. Подключить сайт получится после обновления до Joomla 3.9 или новее. Обновить её может ваш разработчик или студия.',
  version_unknown: `Мы не смогли узнать версию сайта. Проверьте, что выбрана папка сайта. ${
    panel ? 'Если папка верная, подключите сайт вариантом «Без доступа к файлам».' : writeUs
  }`,
  not_yet: 'На сайте стоит Joomla 2.5. С этой версией мы пока не работаем.',
  other_product: 'Это не MODX Revolution, а другая система. Такие сайты мы не подключаем.',
  outside_root: `${firstSentences.outside_root} ${panel ? panelWay : writeUs}`,
  renamed_folder: `${firstSentences.renamed_folder} ${panel ? panelWay : writeUs}`,
  other_engine: `${firstSentences.other_engine} ${panel ? savedWithPanel : savedWithoutPanel}`,
  encoding_unsupported: `${firstSentences.encoding_unsupported} ${
    panel ? savedWithPanel : savedWithoutPanel
  }`,
  stack_off: 'Сайты на Joomla мы пока не подключаем.',
})

describe('siteLimitTexts', () => {
  it('has a text for every limit and nothing else', () => {
    expect(Object.keys(siteLimitTexts)).toEqual([...siteLimits])
  })

  it.each([true, false])('says the words of Т27 with panel %s', (panel) => {
    for (const limit of siteLimits)
      expect(siteLimitTexts[limit](words(panel)), limit).toBe(expected(panel)[limit])
  })

  it('never sends to «Без доступа» when the panel is not open', () => {
    for (const limit of siteLimits)
      expect(siteLimitTexts[limit](words(false)), limit).not.toContain('Без доступа')
  })

  it('asks to check the folder first when the version is unknown and the panel is open', () => {
    expect(siteLimitTexts.version_unknown(words(true))).toContain('Если папка верная,')
  })

  // The project is saved by the time `readLayout` refuses: advice to connect it again is wrong.
  it.each([true, false])('gives no «Без доступа» advice to a saved project, panel %s', (panel) => {
    expect(siteLimitTexts.other_engine(words(panel))).not.toContain('Без доступа')
    expect(siteLimitTexts.encoding_unsupported(words(panel))).not.toContain('Без доступа')
  })

  it('names the platform when a stack is off', () => {
    expect(siteLimitTexts.stack_off({ ...words(true), platform: '1С-Битрикс' })).toBe(
      'Сайты на 1С-Битрикс мы пока не подключаем.',
    )
  })
})

describe('siteLimitLateText', () => {
  it('takes the four limits `readLayout` refuses with', () => {
    expect([...lateSiteLimits].sort()).toEqual(Object.keys(firstSentences).sort())
  })

  it.each(lateSiteLimits)('starts with the first sentence of %s', (limit) => {
    for (const panel of [true, false])
      expect(siteLimitLateText(limit, panel).startsWith(firstSentences[limit])).toBe(true)
  })

  it.each(lateSiteLimits)('ends %s with the tail of Т16', (limit) => {
    expect(siteLimitLateText(limit, true)).toBe(`${firstSentences[limit]} ${savedWithPanel}`)
    expect(siteLimitLateText(limit, false)).toBe(`${firstSentences[limit]} ${savedWithoutPanel}`)
  })
})
