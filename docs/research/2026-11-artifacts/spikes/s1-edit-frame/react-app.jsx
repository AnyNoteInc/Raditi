// The React side of spike 1: what reaches React handlers from the edit frame, and the pattern the
// cabinet needs (native listeners on contentDocument, re-attached on every load, cleaned up).
import React, { useEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

const META =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'">`
const docHtml = (n) =>
  `<!doctype html><html lang="ru" data-artifact="1"><head>${META}<meta charset="utf-8"><style>h1{background:#ffe08a;margin:8px}body{margin:0}</style></head>` +
  `<body><h1 id="hero">Документ ${n}</h1><p id="p">Текст</p></body></html>`

const counts = { wrapperOnClick: 0, wrapperOnClickCapture: 0, iframeOnLoad: 0, nativeClicks: 0, attached: 0, aborted: 0, portalOnClick: 0 }
let loads = 0

function EditFrame({ n, portal }) {
  const ref = useRef(null)
  const [body, setBody] = useState(null)
  useEffect(() => {
    const iframe = ref.current
    let ac = null
    const attach = () => {
      if (ac) {
        ac.abort()
        counts.aborted++
      }
      ac = null
      const doc = iframe.contentDocument
      // The first load may be the initial about:blank; the artifact marks its own root.
      if (!doc || doc.documentElement?.getAttribute('data-artifact') !== '1') return
      ac = new AbortController()
      EventTarget.prototype.addEventListener.call(doc, 'click', () => counts.nativeClicks++, { capture: true, signal: ac.signal })
      counts.attached++
      setBody(doc.body)
    }
    iframe.addEventListener('load', attach)
    attach() // the document may have loaded before the effect ran
    return () => {
      iframe.removeEventListener('load', attach)
      if (ac) {
        ac.abort()
        counts.aborted++
      }
    }
  }, [])
  return (
    <div id="wrapper" onClick={() => counts.wrapperOnClick++} onClickCapture={() => counts.wrapperOnClickCapture++}>
      <iframe
        ref={ref}
        id="edit"
        title="артефакт"
        sandbox="allow-same-origin"
        srcDoc={docHtml(n)}
        width={600}
        height={200}
        onLoad={() => {
          counts.iframeOnLoad++
          loads++
        }}
      />
      {portal && body && body.isConnected
        ? createPortal(
            <button id="portal-button" onClick={() => counts.portalOnClick++}>
              Кнопка портала
            </button>,
            body,
          )
        : null}
    </div>
  )
}

function Toggle({ mode, order, keyed, edit, view }) {
  const sandbox = mode === 'edit' ? 'allow-same-origin' : 'allow-scripts'
  const source = mode === 'edit' ? { srcDoc: edit } : { src: view }
  const props = order === 'sandbox-first' ? { sandbox, ...source } : { ...source, sandbox }
  return <iframe key={keyed ? mode : 'one'} id="toggle" title="переключение" width={300} height={80} {...props} />
}

let root = null
const state = { n: 1, portal: false, mounted: true, toggle: null }
const container = document.getElementById('root')
const render = () =>
  flushSync(() =>
    root.render(
      <>
        {state.mounted ? <EditFrame n={state.n} portal={state.portal} /> : null}
        {state.toggle ? <Toggle {...state.toggle} /> : null}
      </>,
    ),
  )
root = createRoot(container)
render()

const frameEl = () => document.getElementById('edit')
const waitLoad = (el, ms = 4000) => new Promise((ok) => {
  const t = setTimeout(() => ok(false), ms)
  el.addEventListener('load', () => {
    clearTimeout(t)
    ok(true)
  }, { once: true })
})
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
window.__ran = []
window.addEventListener('message', (e) => {
  if (typeof e.data === 'string' && e.data.startsWith('ran:')) window.__ran.push(e.data.slice(4))
})
const mark = (v) => `(function(v){try{top.postMessage('ran:'+v,'*')}catch(e){}try{document.documentElement.setAttribute('data-ran','1')}catch(e){}})('${v}')`

window.R = {
  ready: true,
  counts: () => ({ ...counts }),
  loads: () => loads,
  setDoc: (n) => {
    state.n = n
    render()
  },
  showPortal: (v) => {
    state.portal = v
    render()
  },
  unmount: () => {
    state.mounted = false
    render()
  },
  pageRect: (id) => {
    const f = frameEl()
    if (!f || !f.contentDocument) return null
    const el = f.contentDocument.getElementById(id)
    if (!el) return null
    const fr = f.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { x: fr.left + f.clientLeft + r.left, y: fr.top + f.clientTop + r.top, w: r.width, h: r.height }
  },
  selfTest: async () => ({ react: React.version, initialLoads: loads }),
  /** One iframe element switched between view and edit by props: which flags did the new document get? */
  toggleTest: async (ext) => {
    const out = {}
    for (const order of ['sandbox-first', 'src-first']) {
      for (const keyed of [false, true]) {
        const label = `${order}${keyed ? ', keyed by mode' : ', same element'}`
        const edit = `<!doctype html><html data-artifact="1"><body><p>правка</p><script>${mark(`edit-${order}-${keyed}`)}</script></body></html>`
        const view = `${ext}/view?t=toggle&v=view-${order}-${keyed}`
        window.__ran.length = 0
        state.toggle = { mode: 'view', order, keyed, edit, view }
        render()
        await waitLoad(document.getElementById('toggle'))
        await sleep(200)
        const rounds = []
        for (let i = 0; i < 2; i++) {
          state.toggle = { ...state.toggle, mode: 'edit' }
          render()
          await waitLoad(document.getElementById('toggle'))
          await sleep(300)
          const el = document.getElementById('toggle')
          let access = false
          try {
            access = !!el.contentDocument && el.contentDocument.documentElement?.getAttribute('data-artifact') === '1'
          } catch {}
          rounds.push({ editDocAccessible: access, editScriptRan: window.__ran.includes(`edit-${order}-${keyed}`), sandboxAttr: el.getAttribute('sandbox') })
          window.__ran.length = 0
          state.toggle = { ...state.toggle, mode: 'view' }
          render()
          await waitLoad(document.getElementById('toggle'))
          await sleep(300)
          rounds[i].viewScriptRan = window.__ran.includes(`view-${order}-${keyed}`)
          window.__ran.length = 0
        }
        out[label] = rounds
        state.toggle = null
        render()
      }
    }
    return out
  },
}
