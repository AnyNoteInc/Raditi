// The 52 constructs the check of spike 4 added (verify/new-constructs.mjs).
// 52 constructs the spike did not have (my own, in the manner of agent documents), for both ways:
// the remark bridge and @tiptap/markdown. The reader's text and HTML come from the real
// doc-render (DocumentMarkdown with rehypeDocumentRules), not from hast-util-to-text.
const NB = ' ',
  NN = ' '
export const newConstructs: readonly (readonly [string, string])[] = [
  [
    'table-in-list',
    '- Прайс на услуги:\n\n  | Услуга | Цена |\n  |---|---|\n  | Стрижка | 1' +
      NB +
      '990' +
      NB +
      '₽ |\n\n- Дальше',
  ],
  ['quote-in-list', '1. Шаг\n\n   > Важно: заранее.\n\n2. Шаг'],
  ['code-in-quote', '> Команда:\n>\n> ```bash\n> npm run build\n> ```'],
  ['heading-in-list', '- ### Заголовок в пункте\n- обычный'],
  ['ordered-10-nested', '10. десятый\n    - вложенный\n    - ещё\n11. одиннадцатый'],
  ['loose-nested-mixed', '1. Первый\n\n   - а\n   - б\n\n2. Второй\n\n   Пояснение.'],
  ['strong-nbsp', `**1${NB}990${NB}₽** за стрижку`],
  ['link-nbsp-text', `[Стрижка за 1${NB}990${NB}₽](https://example.ru/стрижка)`],
  ['autolink-email', 'Пишите: <info@example.ru>'],
  ['bare-url-paren', 'Подробнее (https://example.ru/путь).'],
  ['bare-url-cyr-tld', 'Сайт www.пример.рф и http://пример.рф/каталог'],
  ['break-in-bold', '**первая\\\nвторая**'],
  ['code-nbsp', `Введите \`1${NB}990\` в поле`],
  [
    'cell-mix',
    `| Тариф | Цена |\n|---|--:|\n| **Бизнес** [подробнее](https://example.ru) | ~~12${NB}900${NB}₽~~ 9${NB}990${NB}₽ |`,
  ],
  ['cell-code-pipe', '| Команда | Что |\n|---|---|\n| `ls \\| grep a` | поиск |'],
  ['task-ordered-nested', '- [ ] Подготовить:\n  1. договор\n  2. счёт\n- [x] Отправить'],
  ['quote-list-code', '> - пункт\n>   ```\n>   код\n>   ```\n> - ещё'],
  ['footnote-multi', 'Текст[^a].\n\n[^a]: Первый абзац сноски.\n\n    Второй абзац сноски.'],
  [
    'footnote-in-cell',
    '| Услуга | Цена |\n|---|---|\n| Стрижка[^1] | 1 990 ₽ |\n\n[^1]: Без мытья.',
  ],
  ['footnote-in-heading', '### Тарифы[^т]\n\n[^т]: Цены на 2026 год.'],
  ['footnote-list', 'См. условия[^у].\n\n[^у]: Условия:\n    - первое\n    - второе'],
  ['footnote-twice', 'Раз[^1] и два[^1].\n\n[^1]: Одна сноска.'],
  ['image-nbsp-alt', `![Зал на 20${NB}мест](зал.png)`],
  ['paren-not-list', '1\\) не список'],
  ['cell-lt-amp', '| Знак | Смысл |\n|---|---|\n| a < b & c | меньше |'],
  ['entity-nbsp', 'Цена 1&#160;990&nbsp;₽'],
  ['entity-nbsp-cell', '| Цена |\n|---|\n| 1&nbsp;990&nbsp;₽ |'],
  ['heading-trailing-hash', '## Раздел ##   '],
  ['hr-between-lists', '- а\n- б\n\n---\n\n- в'],
  ['item-starts-code', '- ```\n  код\n  ```\n- пункт'],
  ['strike-in-cell', '| Было | Стало |\n|---|---|\n| ~~1 500 ₽~~ | 1 200 ₽ |'],
  ['link-title-parens', '[Каталог](https://example.ru "Каталог (весна)")'],
  ['url-unbalanced', '[Кофе](https://example.ru/a_(b)'],
  ['stars-hr', 'Абзац\n\n* * *\n\nАбзац'],
  ['emoji-cell', '| Статус | Что |\n|---|---|\n| ✅ | готово |\n| ⚠️ | внимание |'],
  ['yo-nfd-cell', '| Слово |\n|---|\n| ' + 'ещё'.normalize('NFD') + ' |'],
  ['nnbsp-heading', `## Итоги 2${NN}026`],
  ['label-footnote', `**Итого:** 12${NB}400${NB}₽ (с НДС[^1])\n\n[^1]: Не облагается.`],
  ['code-span-backticks', 'Код `` `a` `` и ``` `` ``` здесь'],
  ['phone-start', '+7 (900) 000-00-00 — звоните'],
  ['decimal-start', '1.5 часа на работу'],
  ['year-soft-break', 'Мы работаем с\n2026. Года'],
  ['item-only-image', '- ![фото](a.png)\n- текст'],
  ['empty-header-cells', '|  |  |\n|---|---|\n| 1 | 2 |'],
  [
    'long-row',
    '| ' +
      Array.from({ length: 12 }, (_, i) => `Колонка ${i}`).join(' | ') +
      ' |\n|' +
      '---|'.repeat(12) +
      '\n| ' +
      Array.from({ length: 12 }, (_, i) => `1${NB}${i}00${NB}₽`).join(' | ') +
      ' |',
  ],
  ['bold-in-link-in-bold', '**Смотрите [каталог **весна**](https://example.ru)**'],
  ['underscore-intraword', 'файл_имя_тест и мега_важно'],
  ['escaped-underscore-word', 'snake\\_case и @user\\_name'],
  ['two-links-adjacent', '[раз](https://example.ru)[два](https://example.ru)'],
  ['html-table', '<table><tr><td>Ячейка</td></tr></table>\n\nПосле таблицы'],
  ['sup-tag', 'м<sup>2</sup> и H<sub>2</sub>O'],
  ['math-dollar', 'Формула $E = mc^2$ и $$x$$'],
]
