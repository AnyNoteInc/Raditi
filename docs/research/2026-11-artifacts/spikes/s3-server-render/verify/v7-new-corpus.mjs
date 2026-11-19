// Detectors of spike s3 (plan 88) on frames they were not tuned on (skeptic). Seven new mockups:
// three with planted bugs of other shapes than the builder's corpus, four clean ones built from
// patterns agents and designers use every day (a visually hidden label, a sideways card scroller
// on a phone, a ticker, a sticky header, a closed accordion, fluid grids).
//   node v7-new-corpus.mjs <harness dir> [--axe]
// `data-bug="<kind>@<width>"` marks the element a finding must name (width: 1440, 390 or both).
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const dir = resolve(process.argv[2])
const withAxe = process.argv.includes('--axe')
const { chromium } = await import(pathToFileURL(join(dir, 'node_modules/playwright-core/index.mjs')).href)
const { stamp, fontCss } = await import(pathToFileURL(join(dir, 'lib/frames.mjs')).href)
const { launch, renderFrame } = await import(pathToFileURL(join(dir, 'lib/render.mjs')).href)
const { findingsOf, layoutReport } = await import(pathToFileURL(join(dir, 'lib/report.mjs')).href)
const AXE = withAxe ? readFileSync(createRequire(join(dir, 'package.json')).resolve('axe-core/axe.min.js'), 'utf8') : null

const head = (title, css) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>
* { box-sizing: border-box } body { margin: 0; font: 16px/1.5 "Golos Text", sans-serif; color: #1f2933; background: #fff } h1, h2, h3 { margin: 0 0 12px; line-height: 1.2 } p { margin: 0 0 12px }
.wrap { max-width: 1120px; margin: 0 auto; padding: 24px 20px } .btn { display: inline-block; padding: 14px 22px; border-radius: 12px; background: #1b5e20; color: #fff; text-decoration: none; font-weight: 600 }
${css}</style></head>`
const FRAMES = {
  // ---------------------------------------------------------------- planted
  'n1-clinic': head('Клиника «Семья» — услуги', `.card { border: 1px solid #e0e0e0; border-radius: 16px; padding: 20px; margin-bottom: 16px }
    .cta { background: #ff9800; color: #fff } input { width: 100%; padding: 14px; border: 1px solid #bbb; border-radius: 10px; font: inherit } input::placeholder { color: #d0d0d0 }`) + `<body><div class="wrap">
    <h1>Клиника «Семья»: приём взрослых и детей</h1>
    <div class="card"><h2>Запись на сайте</h2><p data-bug="hscroll@390">Сайт: priyomnaya.klinika.zdorovie.semya.otdelenie.klinikasemyazdorovie.example</p></div>
    <div class="card"><h2>Обратный звонок</h2><input placeholder="Ваш телефон"><p></p><a class="btn cta" href="#" data-bug="contrast@both">Записаться на приём</a></div>
    <div class="card"><h2>Врачи</h2><p>Терапевт, педиатр, кардиолог, невролог и ещё девять специалистов принимают без выходных.</p></div>
  </div></body></html>`,
  'n2-fitness': head('Фитнес-клуб — расписание', `.band { width: 100vw; padding: 32px 24px; background: #263238; color: #fff; box-sizing: content-box }
    .muted { color: #000; opacity: 0.35 } .caption { font-size: 0.7rem } table { width: 100%; border-collapse: collapse } td { padding: 10px; border-bottom: 1px solid #eee }`) + `<body>
    <div class="band" data-bug="hscroll@both"><h1>Расписание на неделю</h1><p>Групповые занятия для взрослых</p></div>
    <div class="wrap"><table><tr><td>Понедельник</td><td>Йога, 19:00</td></tr><tr><td>Среда</td><td>Пилатес, 20:00</td></tr><tr><td>Пятница</td><td>Растяжка, 18:30</td></tr></table>
    <p class="muted" data-bug="contrast@both">Расписание может меняться в праздничные дни, следите за новостями</p>
    <p class="caption" data-bug="small-text@both">Абонемент действует 30 дней с первого посещения, заморозка — до 14 дней</p></div></body></html>`,
  'n3-restaurant': head('Ресторан — меню с акцией', `.dish { position: relative; border: 1px solid #eee; border-radius: 14px; padding: 18px; margin-bottom: 14px }
    .ribbon { position: absolute; top: 14px; left: 18px; background: #c62828; color: #fff; font-weight: 700; padding: 4px 10px; border-radius: 8px }
    .name { font-size: 22px; font-weight: 700 } .short { display: block; width: 100%; max-width: 360px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
    @media (max-width: 480px) { .short { max-width: 200px } } img { display: block; width: 240px; height: 160px }`) + `<body><div class="wrap"><h1>Меню недели</h1>
    <div class="dish"><span class="ribbon" data-bug="overlap@both">НОВИНКА</span><div class="name">Утка с вишнёвым соусом</div><p>Подаётся с печёным картофелем</p></div>
    <div class="dish"><div class="name short" data-bug="clipped@390">Говяжьи щёчки томлёные в красном вине с пюре из сельдерея</div><p>Готовим 6 часов</p></div>
    <div class="dish"><img data-bug="broken-img@both" alt="Десерт" src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL"><p>Десерт дня</p></div>
  </div></body></html>`,
  // ---------------------------------------------------------------- clean, common patterns
  'c1-salon-gallery': head('Свадебный салон — галерея', `.visually-hidden { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0 }
    header { position: sticky; top: 0; background: rgba(255,255,255,0.96); border-bottom: 1px solid #eee; z-index: 2 } header .wrap { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px }
    .menu-btn { width: 44px; height: 44px; border: 0; border-radius: 12px; background: #f3e5f5; font-size: 22px }
    .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px } .card { border-radius: 16px; padding: 18px; background: #fafafa; border: 1px solid #eee; min-height: 180px }
    .ph { height: 120px; border-radius: 12px; background: linear-gradient(135deg, #f8bbd0, #ce93d8); margin-bottom: 12px }
    @media (max-width: 600px) { .row { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; gap: 12px; padding-bottom: 8px } .card { flex: 0 0 78%; scroll-snap-align: start } }
    details { border: 1px solid #eee; border-radius: 12px; padding: 12px 16px; margin-top: 16px } summary { cursor: pointer; font-weight: 600; min-height: 24px }`) + `<body>
    <header><div class="wrap"><strong>Салон «Белла»</strong><button class="menu-btn" aria-label="Меню">☰<span class="visually-hidden">Открыть меню сайта</span></button></div></header>
    <div class="wrap"><h1>Платья этого сезона</h1><p>Примерка по записи, подгонка по фигуре в подарок.</p>
    <div class="row"><div class="card"><div class="ph"></div><h3>«Аврора»</h3><p>Кружево, шлейф 1,5 м</p></div><div class="card"><div class="ph"></div><h3>«Вега»</h3><p>Атлас, открытая спина</p></div><div class="card"><div class="ph"></div><h3>«Лира»</h3><p>Шифон, рукава-фонарики</p></div></div>
    <details><summary>Как записаться на примерку</summary><p>Позвоните или напишите в мессенджер, примерка длится около часа.</p></details>
    <p>Работаем каждый день с 10:00 до 21:00.</p></div></body></html>`,
  'c2-driving-school': head('Автошкола — тарифы', `.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px }
    .plan { border: 2px solid #e3e8ef; border-radius: 18px; padding: 24px; display: flex; flex-direction: column; gap: 10px } .price { font-size: 30px; font-weight: 800 }
    .chips { display: flex; flex-wrap: wrap; gap: 8px } .chip { background: #e8f5e9; color: #1b5e20; border-radius: 999px; padding: 6px 12px; font-size: 14px }`) + `<body><div class="wrap">
    <h1>Обучение вождению категории B</h1><p>Теория онлайн, практика на механике или автомате.</p>
    <div class="chips"><span class="chip">Свой автодром</span><span class="chip">Рассрочка без процентов</span><span class="chip">Экзамен в ГИБДД с инструктором</span></div>
    <div class="grid"><div class="plan"><h2>Базовый</h2><div class="price">39 900 ₽</div><p>56 часов практики</p><a class="btn" href="#">Записаться</a></div>
    <div class="plan"><h2>Стандарт</h2><div class="price">49 900 ₽</div><p>70 часов практики и город</p><a class="btn" href="#">Записаться</a></div>
    <div class="plan"><h2>Интенсив</h2><div class="price">59 900 ₽</div><p>Права за 6 недель</p><a class="btn" href="#">Записаться</a></div></div></div></body></html>`,
  'c3-vet-ticker': head('Ветклиника — главная', `.ticker { overflow: hidden; white-space: nowrap; background: #fff8e1; border-bottom: 1px solid #ffe082 }
    .ticker span { display: inline-block; padding: 10px 0; animation: run 18s linear infinite } @keyframes run { from { transform: translateX(0) } to { transform: translateX(-50%) } }
    .hero { background: linear-gradient(135deg, #0d47a1, #1565c0); color: #fff; padding: 48px 20px } .hero p { color: #e3f2fd }
    .two { display: flex; flex-wrap: wrap; gap: 20px } .two > div { flex: 1 1 300px; border: 1px solid #eee; border-radius: 14px; padding: 18px }`) + `<body>
    <div class="ticker"><span>Круглосуточно · Вызов врача на дом · Стационар · Анализы за 1 день · Круглосуточно · Вызов врача на дом · Стационар · Анализы за 1 день · </span></div>
    <div class="hero"><div class="wrap"><h1>Ветеринарная клиника «Лапа»</h1><p>Лечим кошек, собак и экзотических животных с 2012 года.</p><a class="btn" href="#" style="background:#fff;color:#0d47a1">Записаться</a></div></div>
    <div class="wrap two"><div><h2>Терапия</h2><p>Осмотр, вакцинация, чипирование.</p></div><div><h2>Хирургия</h2><p>Плановые и срочные операции.</p></div></div></body></html>`,
  'c4-bakery-plain': head('Пекарня — о нас', `.cols { columns: 2 300px; column-gap: 32px } blockquote { margin: 16px 0; padding: 12px 16px; border-left: 4px solid #8d6e63; background: #efebe9 }
    figure { margin: 0 } .art { aspect-ratio: 16 / 9; width: 100%; border-radius: 16px; background: radial-gradient(circle at 30% 40%, #ffe0b2, #a1887f) }
    footer { background: #3e2723; color: #fbe9e7; padding: 24px 20px } footer a { color: #ffccbc }`) + `<body><div class="wrap"><h1>Пекарня «Колос» — с 1998 года</h1>
    <figure><div class="art" role="img" aria-label="Витрина пекарни"></div></figure>
    <div class="cols"><p>Мы печём хлеб на закваске каждое утро с пяти часов. Мука — от мельниц Тульской области, вода — артезианская.</p><p>В меню — багеты, чиабатта, ржаной на солоде и сезонные булочки с ягодами.</p><blockquote>«Хлеб должен быть простым и честным» — основатель пекарни</blockquote><p>Приходите на дегустацию по субботам.</p></div>
    </div><footer><p>Адрес: ул. Садовая, 12 · <a href="#">Как пройти</a></p></footer></body></html>`,
}

const WIDTHS = [1440, 390]
const { browser, server } = await launch(chromium)
const out = { frames: {}, planted: [], unplannedOnPlanted: [], cleanFindings: [] }
for (const [name, source] of Object.entries(FRAMES)) {
  const s = stamp(source.replace('<head>', `<head>\n<style>${fontCss('route')}</style>`))
  const frame = { name, html: s.html, ids: s.ids, bugs: s.bugs, parents: s.parents }
  const byWidth = {}
  for (const width of WIDTHS) byWidth[width] = await renderFrame(browser, frame, { width, assets: {}, outputs: { pixels: true }, axe: AXE })
  const findings = findingsOf(byWidth).filter((f) => !['unsettled', 'photo-text', 'console-error'].includes(f.kind))
  const near = (a, b) => { if (!a || !b) return false; if (a === b) return true; for (const [x, y] of [[a, b], [b, a]]) { let p = s.parents[x]; for (let i = 0; i < 2 && p; i++) { if (p === y) return true; p = s.parents[p] } } return false }
  const named = (f) => [f.id, f.under && f.under.id, ...(f.culprits || []).map((c) => c.id)].filter(Boolean)
  const used = new Set()
  for (const [mark, bug] of Object.entries(s.bugs)) {
    const [kind, w] = mark.split('@')
    for (const width of w === 'both' ? WIDTHS : [Number(w)]) {
      const hits = findings.filter((f) => f.w === width && f.kind === kind && named(f).some((id) => near(id, bug.id)))
      hits.forEach((h) => used.add(h))
      out.planted.push({ frame: name, kind, width, element: `${bug.id} ${bug.tag}`, hit: hits.length > 0 })
    }
  }
  for (const f of findings) if (!used.has(f)) (Object.keys(s.bugs).length ? out.unplannedOnPlanted : out.cleanFindings).push({ frame: name, w: f.w, kind: f.kind, id: f.id || null, tag: f.tag || null, detail: f.ratio ? `${f.ratio}:1 ${f.fg} on ${f.bg}` : f.axis ? `${f.axis} ${f.need || ''}/${f.has || ''} ${f.by ? 'by ' + f.by.tag : ''}` : f.px ? `${f.px} px` : f.culprits ? f.culprits.map((c) => `${c.id} ${c.tag} ${c.width}`).join('; ') : f.text || '' })
  const report = layoutReport({ name, title: name, byWidth })
  out.frames[name] = { report: report.text, chars: report.chars, problems: report.problems, errors: WIDTHS.map((w) => byWidth[w].error || null), axe: AXE ? WIDTHS.map((w) => { const a = byWidth[w].axe; return a ? { w, contrast: (a.violations.find((v) => v.id === 'color-contrast') || { nodes: [] }).nodes.map((n) => n.el), target: (a.violations.find((v) => v.id === 'target-size') || { nodes: [] }).nodes.map((n) => n.el) } : { w, error: byWidth[w].axeError } }) : null }
}
await browser.close(); await server.close()
console.log(JSON.stringify(out, null, 1))
