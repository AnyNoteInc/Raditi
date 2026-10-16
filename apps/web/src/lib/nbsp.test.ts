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
    expect(shown('10 кредитов за 1 990 ₽.')).toBe('10_кредитов за_1_990_₽.')
    // Every form of the unit stays with its count: «1 кредит», «2 кредита», «из 21 кредита».
    expect(shown('Добавим 1 кредит сразу после оплаты.')).toBe(
      'Добавим 1_кредит сразу после оплаты.',
    )
    expect(shown('2 кредита осталось')).toBe('2_кредита осталось')
    expect(shown('Из 21 кредита по тарифу, пакет из 10 кредитов — 1 990 ₽')).toBe(
      'Из_21_кредита по_тарифу, пакет из_10_кредитов_— 1_990_₽',
    )
    expect(shown('скидка 20 % на всё')).toBe('скидка 20_% на_всё')
    expect(shown('До 3 сайтов')).toBe('До_3_сайтов')
  })

  // A count of four digits comes with a plain space between its groups (formatCount): no line
  // parts them, and the noun stays with the whole number.
  it('binds the groups of a count of four digits to each other and to their noun', () => {
    expect(shown('2 500')).toBe('2_500')
    expect(shown('2 500 кредитов в месяц — в среднем около 230 задач')).toBe(
      '2_500_кредитов в_месяц_— в_среднем около 230_задач',
    )
    expect(shown('Осталось 3 600: 2 500 по тарифу и 1 100 из пакета')).toBe(
      'Осталось 3_600: 2_500_по_тарифу и_1_100_из_пакета',
    )
  })

  it('keeps the numbers of the rule of a task with their words, and a range whole', () => {
    expect(shown('не меньше 5: небольшая правка — обычно 5 кредитов, добавить блок — 15–25.')).toBe(
      'не_меньше 5: небольшая правка_— обычно 5_кредитов, добавить блок_— 15–25.',
    )
    expect(shown('В среднем около 197 ₽ за задачу при 45 задачах в месяц')).toBe(
      'В_среднем около 197_₽ за_задачу при_45_задачах в_месяц',
    )
    expect(shown('До 5 задач в день')).toBe('До_5_задач в_день')
  })

  // The lines of the landing about credits: under the slider, by the registration, in the answer.
  it('keeps the counts of the landing with their words: the average, the gift, a day without a tariff', () => {
    expect(
      shown(
        'Задача — одна ваша просьба. В расчёте берём 11 кредитов на задачу — это среднее: поменять цену или фото стоит обычно 5 кредитов, добавить блок или страницу — 15–25.',
      ),
    ).toBe(
      'Задача_— одна ваша просьба. В_расчёте берём 11_кредитов на_задачу_— это среднее: поменять цену или фото стоит обычно 5_кредитов, добавить блок или страницу_— 15–25.',
    )
    expect(
      shown(
        'При регистрации — 35 кредитов в подарок: хватит на несколько небольших правок. Без тарифа — до 3 задач в день. Тариф выберете позже.',
      ),
    ).toBe(
      'При_регистрации_— 35_кредитов в_подарок: хватит на_несколько небольших правок. Без_тарифа_— до_3_задач в_день. Тариф выберете позже.',
    )
    expect(
      shown(
        'Поменять цену, текст или фото — обычно 5 кредитов, добавить блок или страницу — 15–25. Кредиты тарифа начисляются каждый месяц, а кредиты из пакета не сгорают.',
      ),
    ).toBe(
      'Поменять цену, текст или фото_— обычно 5_кредитов, добавить блок или страницу_— 15–25. Кредиты тарифа начисляются каждый месяц, а_кредиты из_пакета не_сгорают.',
    )
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
    const once = nbsp(
      'Кредитов не хватит? Можно будет докупить пакет — 100 кредитов за 1 990 ₽. Кредиты из пакета не сгорают.',
    )
    expect(nbsp(once)).toBe(once)
  })
})
