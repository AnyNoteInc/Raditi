import { describe, expect, it } from 'vitest'

import { nbsp } from './nbsp'

/** Shows the non-breaking spaces of a result: «_» stands for U+00A0. */
const shown = (text: string) => nbsp(text).replaceAll('\u00a0', '_')

describe('nbsp', () => {
  it('keeps a dash and a middle dot off the start of a line', () => {
    expect(shown('Радити — ИИ-помощник')).toBe('Радити_— ИИ-помощник')
    expect(shown('к запуску · пока')).toBe('к_запуску_· пока')
    // A dash without spaces is a range or a hyphen: nothing to bind.
    expect(shown('09:00–21:00, ИИ-помощник')).toBe('09:00–21:00, ИИ-помощник')
  })

  it('binds a number to the ruble sign, to its unit and to the noun it counts', () => {
    expect(shown('Поменяй цену капучино на 290 ₽')).toBe('Поменяй цену капучино на_290_₽')
    expect(shown('Капучино, 250 мл')).toBe('Капучино, 250_мл')
    expect(shown('10 правок за 1 990 ₽.')).toBe('10_правок за_1_990_₽.')
    expect(shown('скидка 20 % на всё')).toBe('скидка 20_% на_всё')
    expect(shown('До 3 сайтов')).toBe('До_3_сайтов')
  })

  it('leaves a number alone before punctuation and inside a time', () => {
    expect(shown('до 18:00. Обнови')).toBe('до_18:00. Обнови')
    expect(shown('все 30, потом 5.')).toBe('все 30, потом 5.')
  })

  it('binds a short preposition, conjunction or negation to the next word', () => {
    expect(shown('Сейчас можно попробовать пример и зарегистрироваться')).toBe(
      'Сейчас можно попробовать пример и_зарегистрироваться',
    )
    expect(shown('В субботу работаем, а не в воскресенье')).toBe(
      'В_субботу работаем, а_не_в_воскресенье',
    )
    expect(shown('нажмите «Отменить правку» на карточке')).toBe(
      'нажмите «Отменить правку» на_карточке',
    )
    expect(shown('От «надо поправить» до «уже готово».')).toBe(
      'От_«надо поправить» до_«уже готово».',
    )
    expect(shown('Не понравилось — отмените, и мы вернём')).toBe(
      'Не_понравилось_— отмените, и_мы вернём',
    )
  })

  it('binds a preposition of three letters as well, but not a longer word', () => {
    expect(shown('Заголовок и описание для поиска')).toBe('Заголовок и_описание для_поиска')
    expect(shown('делать без вашего подтверждения')).toBe('делать без_вашего подтверждения')
    expect(shown('при оплате, про сайт, над меню, под ним')).toBe(
      'при_оплате, про_сайт, над_меню, под_ним',
    )
    expect(shown('или так, как есть, что это')).toBe('или так, как есть, что это')
  })

  it('does not take the end of a longer word or a hyphenated part for a short word', () => {
    expect(shown('цена на сайте')).toBe('цена на_сайте')
    expect(shown('когда спокойно')).toBe('когда спокойно')
    expect(shown('кто-то из нас, что-то о сайте')).toBe('кто-то из_нас, что-то о_сайте')
    expect(shown('Тариф «Бизнес» и пакеты')).toBe('Тариф «Бизнес» и_пакеты')
  })

  it('binds a particle to the word before it', () => {
    expect(shown('как написали бы коллеге')).toBe('как написали_бы коллеге')
    expect(shown('тот же сайт, знаете ли вы')).toBe('тот_же сайт, знаете_ли вы')
    // «Лишний», «бывает» only start with the letters of a particle.
    expect(shown('это лишний шаг, так бывает')).toBe('это лишний шаг, так бывает')
  })

  it('leaves the existing non-breaking spaces and a text without such places as they are', () => {
    expect(nbsp('12\u00a0900\u00a0₽')).toBe('12\u00a0900\u00a0₽')
    expect(nbsp('Обнови цены')).toBe('Обнови цены')
    expect(nbsp('')).toBe('')
  })

  it('gives the same result when applied twice', () => {
    const once = nbsp('Правок не хватит? Можно будет докупить пакет — 10 правок за 1 990 ₽.')
    expect(nbsp(once)).toBe(once)
  })
})
