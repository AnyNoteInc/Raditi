import { artifactReleasedKinds, type ArtifactBlockKind, type ArtifactKind } from './kinds.ts'
import { slidesThemeBlock } from './slides.ts'

/**
 * The templates «С чего начать» of the gallery and of «Создать» (docs/plan/88-artifacts.md, Ар50,
 * boards A-empty and A-create). A template is the skeleton of a new artifact: its sections with a
 * heading and a short start the client replaces; the words in square brackets are what to put in.
 * Only kinds whose view shipped have templates (`artifactReleasedKinds`). A template brings its own
 * colours in its own common style, as CSS variables on `:root` (docs/plan/93-artifacts-trim.md, АТ5).
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
   * the frames of a canvas, a presentation or an image with their `html`, `style` and `script`
   * parts, the `settings` of a canvas. They are the person's writes: checked as they are written,
   * shown at once.
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

/** The colours of a template, its own: CSS variables on `:root` of its common style (АТ5). */
const TEMPLATE_COLORS =
  ':root{--primary:#2f5d50;--accent:#e07a3f;--text:#1f2421;--muted:#6b706c;--surface:#f6f3ee;--background:#fff;--radius:12px}'

/** The page of a screen of the template «Холст для нового сайта». */
const page = (title: string, body: string) =>
  [
    '<header class="top"><a class="logo" href="/">[Название]</a><nav><a href="/">Главная</a><a href="/uslugi">Услуги</a><a href="/kontakty">Контакты</a></nav></header>',
    `<main class="page"><h1>${title}</h1>${body}</main>`,
    '<footer class="bottom">[Телефон] · [Адрес]</footer>',
  ].join('\n')

const SITE_STYLE = [
  TEMPLATE_COLORS,
  "body{margin:0;font-family:'Golos Text',Arial,sans-serif;color:var(--text);background:var(--background)}",
  'h1,h2{color:var(--primary);line-height:1.2}',
  '.top{display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between;align-items:center;padding:16px 24px;background:var(--surface)}',
  '.top nav{display:flex;flex-wrap:wrap;gap:16px}.top a{color:inherit;text-decoration:none}.logo{font-weight:700}',
  '.page{max-width:1040px;margin:0 auto;padding:48px 24px}.page p{font-size:18px;line-height:1.6;max-width:680px}',
  '.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin:24px 0}',
  '.card{padding:20px;border-radius:var(--radius);background:var(--surface)}',
  '.button{display:inline-block;padding:14px 24px;border-radius:var(--radius);background:var(--accent);color:#fff;text-decoration:none;font-weight:600}',
  '.bottom{padding:24px;text-align:center;color:var(--muted)}',
].join('\n')

/** A section of a document of a template. */
const section = (heading: string, content: string): ArtifactTemplateBlock => ({
  kind: 'section',
  heading,
  content,
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
    id: 'cost-calculator',
    kind: 'canvas',
    title: 'Калькулятор стоимости',
    description: 'Посетитель вводит размеры — видит цену. Цены меняются в «Настройках»',
    blocks: [
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
        kind: 'frame',
        key: 'calc',
        content: '',
        props: { name: 'Калькулятор', path: '/', x: 0, y: 0 },
      },
      {
        kind: 'style',
        key: 'calc-style',
        parent: 'calc',
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
        key: 'calc-html',
        parent: 'calc',
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
        kind: 'script',
        key: 'calc-script',
        parent: 'calc',
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
    id: 'company-deck',
    kind: 'slides',
    title: 'Новая презентация',
    description: 'Семь слайдов о компании: титул, о вас, услуги, фото, цифра, отзыв и контакты',
    blocks: [
      slidesThemeBlock,
      ...slide(
        'slide1',
        'Титул',
        '<section class="slide s-title"><h1>[Название компании]</h1><p>[Чем вы полезны клиенту — одной строкой]</p></section>',
        'Поздоровайтесь и назовите себя. Скажите, о чём будет разговор, за 10 секунд.',
      ),
      ...slide(
        'slide2',
        'О нас',
        '<section class="slide s-section"><p class="label">О нас</p><h2>[Главное о компании в одной фразе]</h2></section>',
        'Расскажите, с чего вы начали и для кого работаете.',
      ),
      ...slide(
        'slide3',
        'Что мы делаем',
        '<section class="slide s-points"><h2>Что мы делаем</h2><ul><li>[Услуга или товар 1]</li><li>[Услуга или товар 2]</li><li>[Услуга или товар 3]</li></ul></section>',
        'Коротко о главном: что покупают у вас чаще всего.',
      ),
      ...slide(
        'slide4',
        'Как это выглядит',
        '<section class="slide s-split"><div><h2>Как это выглядит</h2><p>[Одна-две строки о работе на фото]</p></div><figure>[Фото работы]</figure></section>',
        'Покажите лучшую работу и скажите, чем она помогла клиенту.',
      ),
      ...slide(
        'slide5',
        'Результат',
        '<section class="slide s-number"><p class="value">[120+]</p><p>[довольных клиентов за прошлый год]</p></section>',
        'Назовите цифру и объясните, откуда она.',
      ),
      ...slide(
        'slide6',
        'Отзыв',
        '<section class="slide s-quote"><blockquote>[Короткий отзыв клиента своими словами]</blockquote><cite>[Имя, компания]</cite></section>',
        'Прочитайте отзыв вслух и скажите, что было до вас.',
      ),
      ...slide(
        'slide7',
        'Контакты',
        '<section class="slide s-end"><h2>Давайте работать вместе</h2><div class="contacts"><span>[Телефон]</span><span>[Сайт]</span><span>[Адрес]</span></div></section>',
        'Спросите, остались ли вопросы, и договоритесь о следующем шаге.',
      ),
    ],
  },
  {
    id: 'social-post',
    kind: 'image',
    title: 'Пост для соцсетей',
    description: 'Квадратный пост и история с предложением',
    blocks: [
      {
        kind: 'style',
        key: 'picture-style',
        content: [
          TEMPLATE_COLORS,
          "html,body{margin:0;overflow:hidden;font-family:'Golos Text',Arial,sans-serif;color:var(--text)}",
          '.picture{box-sizing:border-box;width:100%;height:100vh;padding:96px;display:flex;flex-direction:column;justify-content:center;gap:32px;background:var(--surface)}',
          'h1{margin:0;color:var(--primary);font-size:96px;line-height:1.05}',
          'p{margin:0;font-size:44px;line-height:1.3}.price{color:var(--accent);font-weight:700}',
        ].join('\n'),
      },
      { kind: 'frame', key: 'post', content: '', props: { name: 'Пост', size: 'post' } },
      {
        kind: 'html',
        key: 'post-html',
        parent: 'post',
        content:
          '<section class="picture"><h1>[Ваше предложение]</h1><p>[Чем оно полезно — одной строкой]</p><p class="price">от [цена] ₽</p></section>',
      },
      { kind: 'frame', key: 'story', content: '', props: { name: 'История', size: 'story' } },
      {
        kind: 'html',
        key: 'story-html',
        parent: 'story',
        content:
          '<section class="picture"><h1>[Ваше предложение]</h1><p>[Чем оно полезно]</p><p class="price">от [цена] ₽</p><p>[Как записаться]</p></section>',
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
