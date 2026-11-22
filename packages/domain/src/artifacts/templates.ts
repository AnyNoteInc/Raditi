import type { ArtifactCells, ArtifactColumn } from './blocks.ts'
import { brandStartTokens } from './brand.ts'
import { artifactReleasedKinds, type ArtifactBlockKind, type ArtifactKind } from './kinds.ts'

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
  /**
   * The blocks it starts with, in order: a section of a document (`heading` — its text property),
   * the `columns` and `row` blocks of a table, the `html`, `style`, `script` and `settings` parts
   * of a mockup. They are the person's writes: checked as they are written, shown at once.
   */
  blocks: readonly ArtifactTemplateBlock[]
}

export interface ArtifactTemplateBlock {
  kind: ArtifactBlockKind
  content: string
  /** The text properties of the block (a section's heading). */
  heading?: string
  /** Its own key (a screen of a canvas and its parts); absent — `s1…`, `b1…` by order. */
  key?: string
  /** The frame it stands in (a part of a screen of a canvas); absent — the top. */
  parent?: string
  /** Its other properties: a screen's name, place and path. */
  props?: Readonly<Record<string, string | number | boolean>>
}

/** A screen of a canvas of a template (slice 88.15): its frame and one part of HTML. */
const screen = (
  key: string,
  name: string,
  path: string,
  place: { x: number; y: number },
  html: string,
): ArtifactTemplateBlock[] => [
  { kind: 'frame', key, content: '', props: { name, path, ...place } },
  { kind: 'html', key: `${key}-html`, parent: key, content: html },
]

/** A slide of a presentation of a template (slice 88.25): its frame, its HTML and its notes. */
const slide = (key: string, name: string, html: string, notes: string): ArtifactTemplateBlock[] => [
  { kind: 'frame', key, content: '', props: { name } },
  { kind: 'html', key: `${key}-html`, parent: key, content: html },
  { kind: 'note', key: `${key}-note`, parent: key, content: notes },
]

/** The common style of the slides: 1280×720, the brand's variables or plain (slice 88.25). */
const SLIDE_STYLE = [
  "html,body{margin:0;width:1280px;height:720px;overflow:hidden;font-family:var(--brand-font-body,'Golos Text',Arial,sans-serif);color:var(--brand-text,#1f2421);background:var(--brand-background,#fff)}",
  '.slide{box-sizing:border-box;width:1280px;height:720px;padding:72px 96px;display:flex;flex-direction:column;justify-content:center;gap:24px}',
  'h1,h2{margin:0;font-family:var(--brand-font-heading,inherit);color:var(--brand-primary,#2f5d50);line-height:1.15}',
  'h1{font-size:64px}h2{font-size:48px}p,li{font-size:28px;line-height:1.45;margin:0}ul{margin:0;padding-left:1.2em;display:grid;gap:12px}',
  '.accent{color:var(--brand-accent,#e07a3f);font-weight:700}.muted{color:var(--brand-muted,#6b706c)}',
  '.cover{background:var(--brand-surface,#f6f3ee)}',
].join('\n')

/** The page of a screen of the template «Холст для нового сайта»: the brand's variables or plain. */
const page = (title: string, body: string) =>
  [
    '<header class="top"><a class="logo" href="/">[Название]</a><nav><a href="/">Главная</a><a href="/uslugi">Услуги</a><a href="/kontakty">Контакты</a></nav></header>',
    `<main class="page"><h1>${title}</h1>${body}</main>`,
    '<footer class="bottom">[Телефон] · [Адрес]</footer>',
  ].join('\n')

const SITE_STYLE = [
  "body{margin:0;font-family:var(--brand-font-body,'Golos Text',Arial,sans-serif);color:var(--brand-text,#1f2421);background:var(--brand-background,#fff)}",
  'h1,h2{font-family:var(--brand-font-heading,inherit);color:var(--brand-primary,#2f5d50);line-height:1.2}',
  '.top{display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between;align-items:center;padding:16px 24px;background:var(--brand-surface,#f6f3ee)}',
  '.top nav{display:flex;flex-wrap:wrap;gap:16px}.top a{color:inherit;text-decoration:none}.logo{font-weight:700}',
  '.page{max-width:1040px;margin:0 auto;padding:48px 24px}.page p{font-size:18px;line-height:1.6;max-width:680px}',
  '.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin:24px 0}',
  '.card{padding:20px;border-radius:var(--brand-radius,12px);background:var(--brand-surface,#f6f3ee)}',
  '.button{display:inline-block;padding:14px 24px;border-radius:var(--brand-radius,12px);background:var(--brand-accent,#e07a3f);color:#fff;text-decoration:none;font-weight:600}',
  '.bottom{padding:24px;text-align:center;color:var(--brand-muted,#6b706c)}',
].join('\n')

/** A section of a document of a template. */
const section = (heading: string, content: string): ArtifactTemplateBlock => ({
  kind: 'section',
  heading,
  content,
})

/** The columns of a table of a template (`columns`, §7.7). */
const columns = (list: readonly ArtifactColumn[]): ArtifactTemplateBlock => ({
  kind: 'columns',
  content: JSON.stringify(list),
})

/** A row of a table of a template: its cells by the keys of the columns. */
const row = (cells: ArtifactCells): ArtifactTemplateBlock => ({
  kind: 'row',
  content: JSON.stringify(cells),
})

export const artifactTemplates: readonly ArtifactTemplate[] = Object.freeze([
  {
    id: 'offer',
    kind: 'document',
    title: 'Коммерческое предложение',
    description: 'Что вы предлагаете, сколько стоит и как начать работу',
    blocks: [
      section('Кому и зачем', 'Коротко о задаче клиента: [что ему нужно и к какому сроку].'),
      section('Что мы сделаем', '- [Первая работа]\n- [Вторая работа]\n- [Третья работа]'),
      section(
        'Стоимость и сроки',
        '| Работа | Срок | Цена |\n| --- | --- | --- |\n| [Работа] | [дней] | [цена] |',
      ),
      section(
        'Как начать',
        'Ответьте на это письмо или позвоните: [телефон]. Предложение действует до [даты].',
      ),
    ],
  },
  {
    id: 'faq',
    kind: 'document',
    title: 'Ответы на частые вопросы',
    description: 'Вопросы покупателей и ваши ответы — для сайта и переписки',
    blocks: [
      section('Заказ и оплата', '**[Вопрос покупателя]**\n\n[Ваш ответ.]'),
      section('Доставка', '**Сколько стоит доставка?**\n\n[Условия и цены доставки.]'),
      section('Возврат', '**Можно ли вернуть товар?**\n\n[Срок и порядок возврата.]'),
    ],
  },
  {
    id: 'returns',
    kind: 'document',
    title: 'Правила возврата',
    description: 'Сроки, условия и порядок возврата товара или денег',
    blocks: [
      section('Сроки', 'Вернуть товар можно в течение [числа] дней со дня покупки.'),
      section(
        'Условия',
        '- Товар не был в употреблении.\n- Сохранены упаковка и чек.\n- [Ваше условие]',
      ),
      section('Как вернуть', '1. Напишите нам: [адрес или телефон].\n2. [Что сделать дальше.]'),
    ],
  },
  {
    id: 'promotion',
    kind: 'document',
    title: 'План продвижения на месяц',
    description: 'Цели, каналы и задачи по неделям',
    blocks: [
      section('Цель месяца', '[Сколько заявок или продаж вы хотите получить.]'),
      section('Каналы', '- [Сайт]\n- [Соцсети]\n- [Рассылка]'),
      section(
        'Задачи по неделям',
        '| Неделя | Что сделать |\n| --- | --- |\n| 1 | [задача] |\n| 2 | [задача] |\n| 3 | [задача] |\n| 4 | [задача] |',
      ),
    ],
  },
  {
    id: 'price-list',
    kind: 'table',
    title: 'Прайс-лист',
    description: 'Товары и услуги с ценами — для сайта, переписки и Excel',
    blocks: [
      columns([
        { key: 'name', name: 'Название', type: 'text' },
        {
          key: 'category',
          name: 'Категория',
          type: 'select',
          options: ['Товары', 'Услуги', 'Доставка'],
        },
        { key: 'unit', name: 'Ед.', type: 'text' },
        { key: 'price', name: 'Цена, ₽', type: 'money' },
        { key: 'in-stock', name: 'В наличии', type: 'checkbox' },
        { key: 'note', name: 'Примечание', type: 'text' },
      ]),
      row({ name: '[Товар]', category: 'Товары', unit: 'шт', price: '990.00', 'in-stock': true }),
      row({
        name: '[Услуга]',
        category: 'Услуги',
        unit: 'час',
        price: '1500.00',
        'in-stock': true,
      }),
      row({ name: '[Доставка по городу]', category: 'Доставка', unit: 'заказ', price: '300.00' }),
    ],
  },
  {
    id: 'content-plan',
    kind: 'table',
    title: 'Контент-план',
    description: 'Что, где и когда публиковать: посты, статьи, рассылки',
    blocks: [
      columns([
        { key: 'date', name: 'Дата', type: 'date' },
        { key: 'topic', name: 'Тема', type: 'text' },
        {
          key: 'channel',
          name: 'Где',
          type: 'select',
          options: ['Сайт', 'ВКонтакте', 'Telegram', 'Рассылка'],
        },
        {
          key: 'status',
          name: 'Статус',
          type: 'select',
          options: ['Идея', 'Пишется', 'Готово', 'Опубликовано'],
        },
        { key: 'link', name: 'Ссылка', type: 'link' },
      ]),
      row({ date: '2026-12-01', topic: '[Тема первого поста]', channel: 'Сайт', status: 'Идея' }),
      row({
        date: '2026-12-08',
        topic: '[Тема второго поста]',
        channel: 'Telegram',
        status: 'Идея',
      }),
      row({ date: '2026-12-15', topic: '[Тема рассылки]', channel: 'Рассылка', status: 'Идея' }),
    ],
  },
  {
    id: 'cost-calculator',
    kind: 'mockup',
    title: 'Калькулятор стоимости',
    description: 'Посетитель вводит размеры — видит цену. Цены меняются в «Настройках»',
    blocks: [
      {
        kind: 'style',
        content: [
          "body{margin:0;font-family:'Golos Text',Arial,sans-serif;background:#f7f4ef;color:#2b2118}",
          '.calc{max-width:520px;margin:40px auto;padding:28px;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.06)}',
          'h1{font-size:24px;margin:0 0 6px}p{margin:0 0 20px;color:#6b5d50}',
          'label{display:block;margin:14px 0 6px;font-weight:600}',
          'input,select{width:100%;box-sizing:border-box;padding:10px 12px;font:inherit;border:1px solid #d9cfc4;border-radius:10px}',
          '.total{margin-top:24px;padding:16px;border-radius:12px;background:var(--accent,#b5542d);color:#fff;font-size:22px;font-weight:700}',
          '.note{margin-top:10px;font-size:13px;color:#6b5d50}',
        ].join('\n'),
      },
      {
        kind: 'html',
        content: [
          '<main class="calc">',
          '  <h1>Рассчитайте стоимость</h1>',
          '  <p>[Чем вы занимаетесь: например, «Пластиковые окна под ключ»]</p>',
          '  <label for="width">Ширина, см</label>',
          '  <input id="width" type="number" min="1" value="120" inputmode="decimal">',
          '  <label for="height">Высота, см</label>',
          '  <input id="height" type="number" min="1" value="140" inputmode="decimal">',
          '  <label for="count">Количество</label>',
          '  <input id="count" type="number" min="1" value="1" inputmode="numeric">',
          '  <label for="option">Вариант</label>',
          '  <select id="option"><option value="basic">Стандарт</option><option value="premium">Премиум</option></select>',
          '  <div class="total" id="total" aria-live="polite">—</div>',
          '  <div class="note" id="note"></div>',
          '  <noscript><div class="note">Расчёт работает со включёнными скриптами.</div></noscript>',
          '</main>',
        ].join('\n'),
      },
      {
        kind: 'settings',
        content: JSON.stringify(
          {
            pricePerSquareMeter: 6500,
            premiumFactor: 1.35,
            minimumOrder: 9000,
            accentColor: '#b5542d',
            note: 'Точную цену назовём после замера — это бесплатно.',
          },
          null,
          2,
        ),
      },
      {
        kind: 'script',
        content: [
          "const settings = JSON.parse(document.getElementById('raditi-settings')?.textContent || '{}')",
          "document.documentElement.style.setProperty('--accent', settings.accentColor || '#b5542d')",
          "document.getElementById('note').textContent = settings.note || ''",
          "const value = (id) => Math.max(0, Number(String(document.getElementById(id).value).replace(',', '.')) || 0)",
          'const rubles = (n) => Math.round(n).toLocaleString("ru-RU") + " ₽"',
          'function update() {',
          "  const area = (value('width') / 100) * (value('height') / 100)",
          "  const factor = document.getElementById('option').value === 'premium' ? Number(settings.premiumFactor) || 1 : 1",
          "  const sum = area * value('count') * (Number(settings.pricePerSquareMeter) || 0) * factor",
          "  document.getElementById('total').textContent = 'Итого: ' + rubles(Math.max(sum, Number(settings.minimumOrder) || 0))",
          '}',
          "for (const id of ['width', 'height', 'count', 'option']) document.getElementById(id).addEventListener('input', update)",
          'update()',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'new-site',
    kind: 'canvas',
    title: 'Холст для нового сайта',
    description: 'Главная, услуги и контакты — для компьютера и телефона рядом',
    blocks: [
      { kind: 'style', content: SITE_STYLE },
      ...screen(
        'home',
        'Главная',
        '/',
        { x: 0, y: 0 },
        page(
          '[Что вы делаете — одной фразой]',
          '<p>[Для кого вы работаете и чем вы лучше других.]</p><p><a class="button" href="/kontakty">Записаться</a></p>',
        ),
      ),
      ...screen(
        'uslugi',
        'Услуги',
        '/uslugi',
        { x: 0, y: 2400 },
        page(
          'Услуги',
          '<div class="cards"><div class="card"><h2>[Услуга]</h2><p>[Цена и что входит]</p></div><div class="card"><h2>[Услуга]</h2><p>[Цена и что входит]</p></div><div class="card"><h2>[Услуга]</h2><p>[Цена и что входит]</p></div></div>',
        ),
      ),
      ...screen(
        'kontakty',
        'Контакты',
        '/kontakty',
        { x: 0, y: 4800 },
        page('Контакты', '<p>[Телефон]</p><p>[Адрес и часы работы]</p><p>[Мессенджеры]</p>'),
      ),
    ],
  },
  {
    id: 'brand',
    kind: 'brand',
    title: 'Фирменный стиль',
    description: 'Цвета, шрифты и тон текстов — для всех макетов и холстов проекта',
    blocks: [
      { kind: 'settings', content: JSON.stringify(brandStartTokens, null, 2) },
      section(
        'Тон текстов',
        'Пишем [дружелюбно и по делу], обращаемся на «вы». Избегаем [канцелярита и обещаний, которые не выполним].',
      ),
    ],
  },
  {
    id: 'company-deck',
    kind: 'slides',
    title: 'Презентация компании',
    description: 'Пять слайдов: кто вы, что предлагаете, почему вы, цены и как связаться',
    blocks: [
      { kind: 'style', key: 'deck-style', content: SLIDE_STYLE },
      ...slide(
        'slide1',
        'Обложка',
        '<section class="slide cover"><h1>[Название компании]</h1><p class="muted">[Чем вы полезны клиенту — одной строкой]</p></section>',
        'Поздоровайтесь и назовите себя. Скажите, о чём будет разговор, за 10 секунд.',
      ),
      ...slide(
        'slide2',
        'Что мы делаем',
        '<section class="slide"><h2>Что мы делаем</h2><ul><li>[Услуга или товар 1]</li><li>[Услуга или товар 2]</li><li>[Услуга или товар 3]</li></ul></section>',
        'Коротко о главном: что покупают у вас чаще всего.',
      ),
      ...slide(
        'slide3',
        'Почему мы',
        '<section class="slide"><h2>Почему выбирают нас</h2><ul><li><span class="accent">[Цифра]</span> [довольных клиентов]</li><li>[Ваше отличие от конкурентов]</li><li>[Гарантия или срок]</li></ul></section>',
        'Приведите один пример клиента, которому вы помогли.',
      ),
      ...slide(
        'slide4',
        'Цены',
        '<section class="slide"><h2>Сколько стоит</h2><p>[Услуга] — <span class="accent">от [цена] ₽</span></p><p class="muted">[Что входит в цену]</p></section>',
        'Назовите цену уверенно и сразу скажите, что в неё входит.',
      ),
      ...slide(
        'slide5',
        'Контакты',
        '<section class="slide cover"><h2>Давайте работать вместе</h2><p>[Телефон] · [Сайт] · [Адрес]</p></section>',
        'Спросите, остались ли вопросы, и договоритесь о следующем шаге.',
      ),
    ],
  },
  {
    id: 'customer-journey',
    kind: 'diagram',
    title: 'Путь клиента',
    description: 'Как клиент находит вас, выбирает и покупает — по шагам',
    blocks: [
      {
        kind: 'diagram',
        content: [
          'flowchart LR',
          '  A[Узнал о вас] --> B[Зашёл на сайт]',
          '  B --> C{Нашёл, что искал?}',
          '  C -->|да| D[Оставил заявку]',
          '  C -->|нет| E[Ушёл к конкурентам]',
          '  D --> F[Получил ответ]',
          '  F --> G[Купил]',
          '  G --> H[Пришёл снова]',
        ].join('\n'),
      },
    ],
  },
] satisfies readonly ArtifactTemplate[])

/** The template of an id, of a kind that may be created now; null — no such template. */
export function artifactTemplateOf(id: string): ArtifactTemplate | null {
  // A template of a kind not released yet waits for its view (88.25): it is never offered.
  return (
    artifactTemplates.find(
      (template) => template.id === id && artifactReleasedKinds.includes(template.kind),
    ) ?? null
  )
}
