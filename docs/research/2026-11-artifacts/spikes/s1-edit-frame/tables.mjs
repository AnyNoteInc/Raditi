// The curated tables of the README from results/*.json: one column per engine; where macOS and
// Linux builds differ, both values are shown.
// node tables.mjs results/darwin.json results/linux.json > tables.md
import { readFileSync } from 'node:fs'

const runs = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')))
const ENGINES = ['chromium', 'webkit', 'firefox']
const NAMES = { chromium: 'Chromium', webkit: 'WebKit', firefox: 'Firefox' }
const plat = (r) => (r.platform === 'darwin' ? 'macOS' : 'Linux')

/** One cell per engine: the value of `fn` on every run that has this engine. */
function cell(engine, fn) {
  const vals = []
  for (const r of runs) {
    const e = r.engines[engine]
    if (!e) continue
    let v
    try {
      v = fn(e.groups, e)
    } catch (err) {
      v = `ошибка: ${String(err.message).slice(0, 50)}`
    }
    vals.push({ p: plat(r), v: v === undefined ? '—' : String(v) })
  }
  if (!vals.length) return 'не запускался'
  if (vals.every((x) => x.v === vals[0].v)) return vals[0].v
  return vals.map((x) => `${x.p}: ${x.v}`).join('; ')
}
const row = (label, fn) => [label, ...ENGINES.map((e) => cell(e, fn))]
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
const head = (first) => [first, ...ENGINES.map((e) => NAMES[e])]
const out = []
const say = (s = '') => out.push(s)

// Versions.
say(table(['Движок', ...runs.map(plat)], ENGINES.map((e) => [NAMES[e], ...runs.map((r) => r.engines[e]?.version ?? 'не запускался')])))
say()
say('Где ответы macOS и Linux расходятся, в ячейке указаны оба; в остальных ячейках они одинаковы.')
say()

// 1. Script vectors.
const SANDBOXED = ['srcdoc+sandbox', 'srcdoc+sandbox+meta', 'route+sandbox', 'route-csp-sandbox-only']
const ranIn = (status, n, labels) => labels.filter((l) => status[l]?.status?.[n] === 'RAN')
const vecCell = (n) => (g) => {
  const v = g.vectors
  const ran = ranIn(v, n, SANDBOXED)
  const ctl = v.control.status[n]
  const c = ctl === 'RAN' ? 'да' : 'нет'
  return `${c} → ${ran.length ? `**да** (${ran.join(', ')})` : 'нет'}`
}
const autoNames = ['inline-script', 'script-module', 'script-src-ext', 'script-src-same', 'script-src-data', 'body-onload', 'img-onerror', 'img-onload', 'svg-onload', 'svg-script', 'svg-animate-onbegin', 'style-onload', 'link-css-onload', 'details-ontoggle', 'input-autofocus-onfocus', 'video-source-onerror', 'marquee-onstart', 'iframe-srcdoc-script', 'iframe-src-ext', 'iframe-javascript-src', 'iframe-onload', 'object-html', 'embed-html', 'object-data-url']
const rows1 = autoNames.map((n) => row(`\`${n}\``, vecCell(n)))
const parCell = (n) => (g) => {
  const p = g.parent
  const ran = SANDBOXED.filter((l) => p[l]?.status[n] === 'RAN')
  return `${p.control.status[n] === 'RAN' ? 'да' : 'нет'} → ${ran.length ? `**да** (${ran.join(', ')})` : 'нет'}`
}
const parentNames = ['parent-created-script', 'parent-created-script-src', 'parent-innerhtml-onerror', 'parent-setattribute-onclick', 'parent-eval', 'parent-function', 'parent-settimeout-string', 'parent-document-write', 'parent-location-javascript']
for (const n of parentNames) rows1.push(row(`\`${n}\` (кабинет)`, parCell(n)))
const clickScript = ['javascript-link', 'onclick-button', 'onclick-link', 'form-javascript-action']
const clkRan = (n) => (g) => {
  const k = g.click
  const c = /SCRIPT RAN/.test(k.control[n]) ? 'да' : 'нет'
  const sb = ['srcdoc+sandbox+meta', 'route+sandbox'].filter((l) => /SCRIPT RAN/.test(k[l][n]))
  return `${c} → ${sb.length ? `**да** (${sb.join(', ')})` : 'нет'}`
}
for (const n of clickScript) rows1.push(row(`\`${n}\` (клик)`, clkRan(n)))
const navRan = (n) => (g) => {
  const k = g.nav
  const c = /SCRIPT RAN|navigated/.test(k.control[n]) ? 'да' : 'нет'
  const sb = ['srcdoc+sandbox', 'srcdoc+sandbox+meta', 'route+sandbox'].filter((l) => /SCRIPT RAN|navigated/.test(k[l][n]))
  return `${c} → ${sb.length ? `**да** (${sb.join(', ')})` : 'нет'}`
}
rows1.push(row('`meta-refresh` на чужой адрес', navRan('meta-refresh')))
rows1.push(row('`meta-refresh` на `javascript:`', navRan('meta-refresh-javascript')))
rows1.push(row('маршрут открыт вкладкой', (g) => `${g.toplevel['route without policy (control)'].scriptsThatRan} → ${g.toplevel['route good, opened as a tab'].scriptsThatRan}`))
say('### Таблица 1. Векторы × движки')
say()
say('В ячейке: контроль без песочницы → рамка правки. «Рамка правки» — четыре варианта с `sandbox="allow-same-origin"` или CSP `sandbox allow-same-origin` без `allow-scripts`: `srcdoc` без meta CSP, `srcdoc` с meta CSP, маршрут с атрибутом, маршрут только с CSP. Если вектор выполнился хотя бы в одном, он назван. Строки «(кабинет)» — код, который кабинет сам вставляет в рамку или вызывает в её окне; «(клик)» — клик пользователя по элементу артефакта. У строки «маршрут открыт вкладкой» — число выполнившихся векторов документа.')
say()
say(table(head('Вектор'), rows1))
say()

// 2. Links.
const L = (variant, n) => (g) => {
  const x = g.click[variant]?.[n]
  return (x ?? '—')
    .replace('nothing happened', 'ничего')
    .replace(/request: [^;]*/g, 'запрос')
    .replace('frame navigated (other origin)', 'рамка ушла')
    .replace('frame navigated (same origin)', 'рамка ушла')
    .replace('SCRIPT RAN', 'скрипт')
    .replace('TOP NAVIGATED', '**ушла вся вкладка**')
    .replace(/POPUP (\d+)/, '**новое окно**')
    .replace('DOWNLOAD', '**скачивание**')
    .replace(/; запрос/g, ' + запрос')
}
const linkNames = ['link-self', 'link-same-origin', 'link-blank', 'link-blank-opener', 'link-top', 'link-parent', 'link-ping', 'link-download', 'base-target-top', 'area-link', 'onclick-link', 'form-submit']
const variants = [
  ['control', 'без песочницы'],
  ['route+sandbox', 'рамка (маршрут)'],
  ['srcdoc+sandbox+meta', 'рамка (srcdoc)'],
  ['route+sandbox + preventDefault', 'маршрут + preventDefault'],
  ['srcdoc+sandbox+meta + preventDefault', 'srcdoc + preventDefault'],
  ['route+sandbox, links rewritten by the server', 'маршрут, ссылки переписаны'],
  ['srcdoc+sandbox+meta, links rewritten by the server', 'srcdoc, ссылки переписаны'],
  ['route+sandbox, overlay mode', 'слой поверх рамки'],
]
const short = (x) => {
  if (!x) return '—'
  if (/TOP NAVIGATED/.test(x)) return '**вкладка ушла**'
  if (/POPUP/.test(x)) return '**окно**'
  if (/DOWNLOAD/.test(x)) return '**скачивание**'
  if (/SCRIPT RAN/.test(x)) return '**скрипт**'
  if (/frame navigated/.test(x)) return 'ушла'
  if (/frame not accessible/.test(x)) return 'нет доступа'
  return 'нет'
}
const cols4 = [
  ['control', 'контроль'],
  ['route+sandbox', 'рамка'],
  ['route+sandbox + preventDefault', 'отмена'],
  ['route+sandbox, links rewritten by the server', 'адреса переписаны'],
  ['route+sandbox, overlay mode', 'слой'],
]
say('### Таблица 2. Клик по ссылке × движки')
say()
say('Рамка — маршрут с CSP правки. В ячейке пять ответов через «·»: контроль без песочницы · рамка без обработчика кабинета · рамка с `preventDefault` в capture-обработчике `click` и `auxclick` · ссылки в копии переписаны сервером · клик пришёлся на слой кабинета над рамкой. «ушла» — рамка перешла на другой адрес (её документ потерян), «нет» — ничего не произошло.')
say()
say(table(head('Вектор'), linkNames.map((n) => row(`\`${n}\``, (g) => cols4.map(([k]) => short(g.click[k]?.[n])).join(' · ')))))
say()
say('**`srcdoc` с meta CSP вместо маршрута** — четыре ответа: контроль · рамка · отмена · адреса переписаны. В `srcdoc` переписанный адрес `#…` тоже уводит рамку: его база — адрес кабинета.')
say()
const srcdocCols = [['control'], ['srcdoc+sandbox+meta'], ['srcdoc+sandbox+meta + preventDefault'], ['srcdoc+sandbox+meta, links rewritten by the server']]
say(table(head('Вектор'), ['link-self', 'link-blank', 'onclick-link', 'area-link'].map((n) => row(`\`${n}\``, (g) => srcdocCols.map(([k]) => short(g.click[k]?.[n])).join(' · ')))))
say()
const ways = (key) => (g) => (g.click.otherWays[key]?.result ?? '—').replace('nothing happened', 'ничего').replace(/request: [^;]*/g, 'запрос').replace('frame navigated', 'рамка ушла').replace(/POPUP (\d+)/, '**новое окно**').replace(/; запрос/g, ' + запрос')
const wayRows = []
for (const label of ['route+sandbox', 'srcdoc+sandbox+meta'])
  for (const [n, how] of [['link-self', 'keyboard Enter'], ['link-self', 'middle click'], ['link-self', 'MOD+click'], ['link-blank', 'middle click'], ['link-blank', 'MOD+click'], ['link-self', 'middle click, listener on click only']])
    wayRows.push(row(`${label}: \`${n}\`, ${how.replace('MOD', 'Cmd/Ctrl').replace('listener on click only', 'обработчик только на click').replace('keyboard Enter', 'Enter с клавиатуры').replace('middle click', 'средняя кнопка')}`, (g) => {
      const k = Object.keys(g.click.otherWays).find((x) => x.startsWith(`${label} | ${n} | `) && x.endsWith(how.replace('MOD', '')) && (how.includes('MOD') ? /(Meta|Control)\+click$/.test(x) : true))
      return k ? ways(k)(g) : '—'
    }))
say('**Другие способы перейти по ссылке** (обработчик кабинета на `click` и `auxclick`, если не сказано иначе):')
say()
say(table(head('Случай'), wayRows))
say()

// 3. Network.
const netNames = ['css-background', 'css-import', 'css-font-face', 'css-list-image', 'css-image-set', 'link-stylesheet', 'link-prefetch', 'link-preload', 'img-ext', 'img-srcset', 'picture-source', 'video-poster', 'audio-src', 'input-image', 'svg-image', 'svg-use', 'object-image', 'embed-image', 'table-background', 'base-href', 'noscript-img', 'same-origin-img', 'same-origin-css', 'noscript-same-origin-img']
const NET_D = ['control', 'srcdoc-no-sandbox', 'srcdoc+sandbox', 'srcdoc+sandbox+meta', 'route+sandbox']
const nword = (s) => (s ?? '—').replace('loaded with cookie', 'да, с cookie').replace(/^loaded$/, 'да').replace('blocked', 'нет')
say('### Таблица 3. Запросы без скриптов × способ доставки')
say()
say('Колонки: без песочницы / `srcdoc` без песочницы / `srcdoc` с песочницей без meta CSP / `srcdoc` с песочницей и meta CSP / маршрут. «да» — запрос ушёл (наружу или, у `same-origin-*`, к кабинету).')
say()
const netRows = []
for (const n of netNames) netRows.push(row(`\`${n}\``, (g) => NET_D.map((d) => nword(g.vectors[d]?.status[n])).join(' / ')))
say(table(head('Вектор'), netRows))
say()

// 4. Delivery.
const dLabels = [
  ['srcdoc+sandbox', '`srcdoc` + `sandbox="allow-same-origin"`'],
  ['srcdoc+sandbox+meta', 'то же + meta CSP первой в head'],
  ['route+sandbox', 'маршрут, CSP правки + атрибут'],
  ['route-csp-sandbox-only', 'маршрут, только CSP `sandbox allow-same-origin`'],
  ['route-no-xfo', 'маршрут без `X-Frame-Options`'],
  ['route-xfo-deny', 'маршрут с `X-Frame-Options: DENY` и `frame-ancestors \'self\'`'],
  ['route-cabinet-headers', 'маршрут с заголовками кабинета (не исключён из `headers()`)'],
  ['route-two-csp', 'маршрут: CSP кабинета + своя CSP'],
  ['alt-scripts+csp', 'для сравнения: `allow-same-origin allow-scripts` + `script-src \'none\'`'],
  ['alt-csp-only', 'для сравнения: без песочницы, только CSP'],
  ['srcdoc-no-sandbox', 'для сравнения: `srcdoc` без песочницы'],
  ['control', 'контроль: маршрут без политики, без песочницы'],
]
const dcell = (k) => (g) => {
  const s = g.delivery[k]
  if (!s) return '—'
  if (!s.artifact) return '**не загружен**'
  const parts = ['загружен', s.origin === '<cabinet>' ? 'origin кабинета' : s.origin]
  if (s.listeners === true) parts.push('обработчики: да')
  if (s.listeners === false) parts.push('обработчики: **нет**')
  if (s.routeCookie === true) parts.push('cookie: да')
  return parts.join(', ')
}
say('### Таблица 4. Способ доставки × движки')
say()
say(table(head('Вариант'), dLabels.map(([k, l]) => row(l, dcell(k)))))
say()
const coep = (k) => (g) => (g.coep[k] ? (g.coep[k].artifact ? 'загружен' : '**не загружен**') : '—')
say('**Если кабинет пошлёт `Cross-Origin-Embedder-Policy: require-corp`:**')
say()
say(table(head('Вариант'), [row('`srcdoc` + meta', coep('srcdoc+sandbox+meta')), row('маршрут без COEP', coep('route+sandbox')), row('маршрут с COEP', coep('route+sandbox (route sends COEP)'))]))
say()

// 5. Capabilities.
const ev = (types, label = 'route+sandbox') => (g) => {
  const s = g.events[label].summary
  const fired = types.filter((t) => s[t])
  if (!fired.length) return '**нет**'
  if (types.every((t) => t.startsWith('window-'))) return fired.length === types.length ? 'да' : `частично: ${fired.join(', ')}`
  if (fired.length === types.length) {
    const cap = types.every((t) => s[t].capture > 0)
    const bub = types.filter((t) => !['focus', 'blur', 'window-scroll', 'window-resize'].includes(t)).every((t) => s[t].bubble > 0)
    return `да${cap ? ', capture' : ''}${bub ? ' и bubble' : ''}`
  }
  return `частично: ${fired.join(', ')}`
}
const yes = (b) => (b === true ? 'да' : b === false ? '**нет**' : String(b))
const E = (key, step, fn) => (g) => {
  const steps = g.editing[key] ?? {}
  const name = step.endsWith('*') ? Object.keys(steps).find((k) => k.startsWith(step.slice(0, -1))) : step
  const x = steps[name]
  if (!x) return '—'
  if (x.error) return `ошибка: ${x.error.slice(0, 40)}`
  return fn(x)
}
const KP = 'route+sandbox | plaintext-only'
const KT = 'route+sandbox | true'
const cap = []
cap.push(['**Обработчики кабинета на `contentDocument`**', '', '', ''])
cap.push(row('pointerover/out/move/down/up', ev(['pointerover', 'pointerout', 'pointermove', 'pointerdown', 'pointerup'])))
cap.push(row('mouseover/out/move/down/up', ev(['mouseover', 'mouseout', 'mousemove', 'mousedown', 'mouseup'])))
cap.push(row('click, dblclick, auxclick, contextmenu', ev(['click', 'dblclick', 'auxclick', 'contextmenu'])))
cap.push(row('keydown, keyup', ev(['keydown', 'keyup'])))
cap.push(row('beforeinput, input', ev(['beforeinput', 'input'])))
cap.push(row('paste, copy, cut', ev(['paste', 'copy', 'cut'])))
cap.push(row('selectionchange', ev(['selectionchange'])))
cap.push(row('focus, blur, focusin, focusout', ev(['focus', 'blur', 'focusin', 'focusout'])))
cap.push(row('compositionstart/update/end', (g, e) => {
  const s = g.events['route+sandbox'].summary
  if (!s.compositionstart) return '**нет**'
  const cdp = s.beforeinput?.inputTypes?.includes('insertCompositionText')
  return e.version.startsWith('155') ? 'да (Playwright вводит кириллицу через composition)' : cdp ? 'да (CDP `Input.imeSetComposition`)' : 'да'
}))
cap.push(row('wheel, scroll', ev(['wheel', 'scroll'])))
cap.push(row('resize и scroll на window рамки', ev(['window-resize', 'window-scroll'])))
cap.push(row('то же при `allow-scripts` + `script-src \'none\'`', ev(['pointerdown', 'click', 'keydown', 'beforeinput', 'paste', 'selectionchange', 'focusin'], 'alt-scripts+csp')))
cap.push(['**Колбэки кабинета через API рамки**', '', '', ''])
const cb = (n) => (g) => {
  const v = [...new Set(['srcdoc+sandbox+meta', 'route+sandbox'].map((l) => g.parent[l].cabinetCallbacks[n]))]
  return v.map((x) => (x === 'runs' ? 'да' : x === 'does not run' ? '**нет**' : x)).join('; ')
}
for (const [n, l] of [['frame-settimeout-fn', 'setTimeout(fn) рамки'], ['frame-raf-fn', 'requestAnimationFrame рамки'], ['frame-queuemicrotask-fn', 'queueMicrotask рамки'], ['frame-promise-then', 'Promise рамки'], ['frame-mutationobserver', 'MutationObserver рамки'], ['parent-mutationobserver', 'MutationObserver кабинета на узлах рамки'], ['frame-resizeobserver', 'ResizeObserver рамки'], ['parent-resizeobserver', 'ResizeObserver кабинета'], ['frame-intersectionobserver', 'IntersectionObserver рамки'], ['el-onclick-property', '`el.onclick = fn` + `el.click()`'], ['el-listener-dispatch', '`addEventListener` + `dispatchEvent`']])
  cap.push(row(l, cb(n)))
cap.push(['**Правка**', '', '', ''])
cap.push(row('каретка одним кликом: `contenteditable` заранее', E(KP, 'caret: preset', (x) => yes(x.ok))))
cap.push(row('каретка: `contenteditable` в `pointerdown` кабинета', E(KP, 'caret: pointerdown', (x) => yes(x.ok))))
cap.push(row('каретка: в `click` кабинета + `caretPositionFromPoint`', E(KP, 'caret: click+caretFromPoint', (x) => yes(x.ok))))
cap.push(row('каретка: из точки, без обработчиков в рамке', E(KP, 'caret: programmatic', (x) => yes(x.ok))))
cap.push(row('ввод кириллицы `keyboard.type` (plaintext-only)', E(KP, 'type Cyrillic (keyboard.type)', (x) => `${yes(x.ok)}${x.keydown ? `, keydown виден: ${x.keydown}` : ', keydown не виден'}`)))
cap.push(row('`keyboard.insertText`', E(KP, 'insertText (keyboard.insertText)', (x) => yes(x.ok))))
cap.push(row('Enter в plaintext-only', E(KP, 'Enter', (x) => (x.hasBr ? '`<br>`' : x.newline ? '`\\n` в тексте' : x.hasDiv ? '`<div>`' : '?'))))
cap.push(row('Enter в `true`', E(KT, 'Enter', (x) => (x.hasDiv ? '`<div>`' : x.hasBr ? '`<br>`' : x.newline ? '`\\n`' : '?'))))
cap.push(row('Backspace', E(KP, 'Backspace', (x) => yes(x.ok))))
cap.push(row('отмена с клавиатуры (Cmd/Ctrl+Z)', E(KP, 'undo (keyboard)', (x) => `нажатия: ${x.keysRemoved} из 2 убраны, insertText: ${yes(x.insertRemoved)}`)))
cap.push(row('`execCommand("undo")` из кабинета', E(KP, 'undo (execCommand from the cabinet)', (x) => yes(x.removed))))
cap.push(row('`execCommand("insertText")` из кабинета', E(KP, 'execCommand insertText from the cabinet', (x) => yes(x.ok))))
cap.push(row('вставка богатого HTML в plaintext-only', E(KP, 'paste rich HTML (native)', (x) => `${x.elementsInserted ? '**HTML**' : 'простой текст'}${x.pasteEvent ? `, событие: ${x.pasteEvent.types.join(' + ')}` : ', события нет'}`)))
cap.push(row('вставка в `true` без перехвата', E(KT, 'paste rich HTML (native)', (x) => (x.elementsInserted ? '**HTML вставлен**' : 'простой текст'))))
cap.push(row('вставка в `true` с перехватом кабинета', E(KT, 'paste rich HTML (plain)', (x) => (x.elementsInserted ? '**HTML вставлен**' : 'простой текст'))))
cap.push(row('Cmd/Ctrl+B в `true`', E(KT, 'bold shortcut (*', (x) => yes(x.boldInserted))))
cap.push(row('отмена `beforeinput` (formatBold, insertParagraph)', E(KT, 'bold shortcut, beforeinput cancelled', (x) => (x.cancelled.length ? `отменены: ${x.cancelled.join(', ')}` : '**не отменить**'))))
cap.push(row('пробелы → NBSP, `white-space: normal` (plaintext-only)', E(KP, 'spaces typed, white-space: normal', (x) => `+${x.nbspAdded}`)))
cap.push(row('пробелы → NBSP, `white-space: normal` (`true`)', E(KT, 'spaces typed, white-space: normal', (x) => `+${x.nbspAdded}`)))
cap.push(row('пробелы → NBSP, `white-space: pre-wrap`', E(KP, 'spaces typed, white-space: pre-wrap', (x) => `+${x.nbspAdded}`)))
cap.push(row('IME: `Input.imeSetComposition` (CDP)', (g) => {
  const x = g.editing[KP]?.['composition (CDP Input.imeSetComposition)']
  return x ? `${yes(x.ok)}, start ${x.start}, update ${x.update}, end ${x.end}` : 'нет API в Playwright'
}))
cap.push(['**Геометрия и обводка**', '', '', ''])
const G = (fn) => (g) => fn(g.geometry['route+sandbox'])
cap.push(row('`getBoundingClientRect` → кабинет (цвет пикселя в центре)', G((x) => yes(x.rect.colourMatches))))
cap.push(row('рамка Playwright совпала', G((x) => (x.playwrightBox.ok ? `да (Δ ${x.playwrightBox.dx}, ${x.playwrightBox.dy})` : x.playwrightBox.error))))
cap.push(row('`elementFromPoint`', G((x) => yes(x.elementFromPoint === 'swatch'))))
cap.push(row('`Range.getClientRects`', G((x) => yes(x.rangeRects.inside))))
cap.push(row('`caretPositionFromPoint` / `caretRangeFromPoint`', G((x) => `${yes(x.caretApis.caretPositionFromPoint)} / ${yes(x.caretApis.caretRangeFromPoint)}`)))
cap.push(row('`scrollTo` кабинетом, сдвиг рамок', G((x) => yes(x.scrollByCabinet.scrollY === 500 && x.scrollByCabinet.shift === 500))))
cap.push(row('прокрутка колесом над рамкой', G((x) => yes(x.wheel.scrollY > 0))))
cap.push(row('ширина 390: `innerWidth`, медиазапрос', G((x) => yes(x.resize390.innerWidth === 390 && x.resize390.narrow))))
cap.push(row('обводка слоем кабинета (пиксель)', G((x) => yes(x.overlayOutside.ok))))
cap.push(row('обводка `<style>` внутри рамки (пиксель)', G((x) => yes(x.injectedStyle.ok))))
cap.push(row('`adoptedStyleSheets` рамки', G((x) => yes(x.adoptedStyleSheet.ok && x.adoptedStyleSheet.computed === 'solid'))))
cap.push(['**Без обработчиков в рамке: слой кабинета поверх неё**', '', '', ''])
const O = (fn) => (g) => fn(g.overlay['route+sandbox'])
cap.push(row('наведение: элемент и обводка', O((x) => yes(x.hover.hovered === 'hero' && x.hover.outline && x.hoverMoves === 'lead'))))
cap.push(row('выбор кликом', O((x) => yes(x.selected === 'hero'))))
cap.push(row('колесо', O((x) => (x.wheelForwarded.wheel > 0 ? 'кабинет пересылает `scrollBy`' : x.wheelForwarded.scrollY > 0 ? 'рамка прокручивается сама' : '**нет**'))))
cap.push(row('каретка из точки клика, ввод', O((x) => yes(x.typed.at === x.typed.expectedOffset))))
cap.push(row('MutationObserver кабинета видит правку', O((x) => yes(x.typed.mutations > 0))))
cap.push(row('Enter без обработчика', O((x) => (x.enterNative.br ? '`<br>`' : x.enterNative.newline ? '`\\n`' : x.enterNative.div ? '`<div>`' : '?'))))
cap.push(row('конец правки виден на узлах кабинета', O((x) => yes(x.endSeen === 'parent-pointerdown'))))
cap.push(row('фиксация → сервер → новая загрузка', O((x) => yes(x.commit.server?.ok && x.commit.server.outsideUnchanged && x.afterReload.includes('Наш')))))
cap.push(row('своё поле кабинета поверх элемента → сервер', O((x) => yes(x.fieldCommit.server.ok && x.fieldAfterReload === 'Печём с семи утра'))))
cap.push(row('касание выбирает элемент через слой', (g) => yes(g.touch.overlayTapSelected === 'lead')))
cap.push(['**Сервер: правка исходника по смещениям parse5**', '', '', ''])
const R = (fn) => (g) => fn(g.roundtrip['route+sandbox'])
cap.push(row('заголовок целиком, с `&` и `<` (экранированы)', R((x) => yes(x.hero.server.ok && x.hero.server.outsideUnchanged && x.afterReload.hero === 'Пекарня «Колос» & кофе <на вынос>'))))
cap.push(row('одна щель текста смешанного абзаца, ссылка цела', R((x) => yes(x.mixed.server.ok && x.afterReload.phone.replace(/\u00a0/g, ' ') === '+7 000 000-00-00' && x.afterReload.mixed.startsWith('Ещё: Звоните: ')))))
cap.push(row('пустой элемент', R((x) => yes(x.empty.server.ok && x.afterReload.empty === 'Новый абзац'))))
cap.push(row('клон алгоритма adoption agency', R((x) => (x.adoptionClone.server.refusal === 'AMBIGUOUS_ID' ? 'отказ `AMBIGUOUS_ID`' : JSON.stringify(x.adoptionClone.server)))))
cap.push(row('`<p>` внутри `<noscript>` получил id', R((x) => yes(!!x.rids.noscriptPRid))))
cap.push(['**Прочее**', '', '', ''])
cap.push(row('DOM clobbering: `doc.addEventListener`', (g) => (/threw/.test(g.clobber['route+sandbox'].plainAddEventListener) ? '**падает** (`<img name>`)' : 'работает')))
cap.push(row('DOM clobbering: вызовы через прототипы кабинета', (g) => yes(Object.values(g.clobber['route+sandbox'].safe).every((v) => v === 'ok' || v === 'BODY'))))
cap.push(row('касание: события у кабинета', (g) => (g.touch.error ? g.touch.error : Object.values(g.touch.tapEvents).some((v) => v > 0) ? `да (${Object.entries(g.touch.tapEvents).filter(([, v]) => v).map(([k]) => k).join(', ')})` : '**нет**')))
cap.push(row('касание: каретка и ввод', (g) => (g.touch.error ? '—' : yes(g.touch.caretAfterTap.anchor === 'lead' && g.touch.typed))))
say('### Таблица 5. Возможности × движки')
say()
say('Рамка правки — маршрут с CSP правки и `sandbox="allow-same-origin"`; `srcdoc` с meta CSP дал те же ответы (сырые данные — `results/`).')
say()
say(table(head('Возможность'), cap))
say()

// 6. React.
const RC = (fn) => (g) => fn(g.react)
const rrows = [
  row('`onClick` и `onClickCapture` React на обёртке рамки', RC((x) => `${x.clicks.afterFirst.wrapperOnClick} и ${x.clicks.afterFirst.wrapperOnClickCapture} из 1 клика`)),
  row('`onLoad` React на `<iframe>`', RC((x) => `${x.clicks.afterReload.iframeOnLoad} из 2 загрузок`)),
  row('свой слушатель на `contentDocument` после `load`', RC((x) => `${x.clicks.afterReload.nativeClicks} из 2 кликов`)),
  row('переподключение после смены `srcDoc`, `abort()` прежнего', RC((x) => `подключён ${x.clicks.afterReload.attached}, снят ${x.clicks.afterReload.aborted}`)),
  row('снятие при размонтировании', RC((x) => `снят ${x.clicks.afterUnmount.aborted - x.clicks.afterReload.aborted}`)),
  row('`createPortal` в `body` рамки: `onClick`', RC((x) => `${x.clicks.portal.portalOnClick} из 1`)),
  ...['sandbox-first, same element', 'src-first, same element', 'sandbox-first, keyed by mode', 'src-first, keyed by mode'].map((k) =>
    row(`один \`<iframe>\` переключают «просмотр ↔ правка»: ${k.replace('sandbox-first', '`sandbox` раньше источника').replace('src-first', 'источник раньше `sandbox`').replace('same element', 'тот же элемент').replace('keyed by mode', '`key` по режиму')}`, RC((x) => {
      const r = x.toggle[k]
      const bad = r.some((y) => y.editScriptRan || !y.editDocAccessible || !y.viewScriptRan)
      return bad ? `**правка загрузилась со старыми флагами**: скрипт ${r.some((y) => y.editScriptRan) ? 'выполнен' : 'нет'}, доступа ${r.some((y) => !y.editDocAccessible) ? 'нет' : 'есть'}` : 'флаги верные'
    })),
  ),
]
say('### Таблица 6. React 19.3.1')
say()
say(table(head('Проверка'), rrows))
say()

// Server-side, engine independent.
const s = runs[0].server
say(`Сервер (без браузера): штампов в синтетическом лендинге — ${s.stampedElements}; повторяющийся id после разбора — ${s.duplicateIdsAfterStamp.join(', ') || 'нет'}; текст, чьё смещение не совпадает со значением, — ${s.misplacedTexts.map((t) => `«${t}»`).join(', ') || 'нет'}; \`<p>\` в \`<noscript>\` получает id при \`scriptingEnabled: false\` — ${yes(s.noscriptStamped.scriptingFalse)}, при \`true\` — ${yes(s.noscriptStamped.scriptingTrue)}.`)
say()
for (const r of runs) say(`- ${plat(r)}: ${r.os}, Node ${r.node}; начало ${r.startedAt}, \`uptime\`: ${r.uptimeAtStart}; конец ${r.finishedAt}, \`uptime\`: ${r.uptimeAtEnd}.`)
console.log(out.join('\n'))
