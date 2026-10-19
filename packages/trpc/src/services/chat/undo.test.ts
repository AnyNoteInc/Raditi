import type { UndoPlanItem } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { undoItemText } from './undo.ts'

// The words of the window «Отменить выпуск» for each object of the release undone (docs/plan/53,
// «Отмена выпуска»): the platform's, by the kind and the verdict, never the agent's.

const created = (
  verdict: UndoPlanItem['verdict'],
  productionRef: string | null = 'page:900',
): UndoPlanItem => ({
  objectRef: 'page:1000000001',
  productionRef,
  kind: 'post_create',
  fields: ['title', 'content', 'excerpt'],
  verdict,
})

describe('undoItemText', () => {
  it('says what becomes of a new page of the release, in whole sentences', () => {
    expect(undoItemText(created('return')).text).toBe(
      'Страница 900, которую добавил выпуск, уйдёт в корзину',
    )
    // The clause about the release is closed before the rest of the sentence.
    expect(undoItemText(created('missing')).text).toBe(
      'Страница 900, которую добавил выпуск, уже убрана с сайта',
    )
    expect(undoItemText(created('missing', null)).text).toBe(
      'Новая страница выпуска уже убрана с сайта',
    )
    expect(undoItemText(created('changed')).text).toBe(
      'Страница 900, которую добавил выпуск, останется: её изменили на сайте после выпуска',
    )
    // A new page had no content before the release: what is no longer kept is its record.
    expect(undoItemText(created('no_value')).text).toBe(
      'Страница 900, которую добавил выпуск, останется: сведения о ней больше не хранятся',
    )
  })

  it('keeps the reason of an existing record whose content before the release is gone', () => {
    expect(
      undoItemText({
        objectRef: 'page:42',
        productionRef: null,
        kind: 'content_update',
        fields: ['title'],
        verdict: 'no_value',
      }).text,
    ).toBe('Страница 42: не вернём — прежнее содержимое больше не хранится')
  })
})
