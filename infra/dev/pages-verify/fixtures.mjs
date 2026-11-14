// The pages the stand publishes (docs/plan/69-pages.md, §7): synthetic only, nothing of a client.
// The probe page tries what a page must never do and tells what it saw by its console.

/** The first version of the plain page: one line the stand looks for. */
export const FIRST = '<!doctype html><title>Прайс</title><p id="v">Прайс, первая версия</p>'
export const SECOND = '<!doctype html><title>Прайс</title><p id="v">Прайс, вторая версия</p>'

/** The console lines of the probe start with this, then JSON. */
export const PROBE_MARK = 'raditi-pages-probe '

/**
 * A page of the agent that reaches for the cookies, the network and a form. Its script runs —
 * the policy of a page allows inline scripts — and reports each attempt and each violation.
 * `target` is an origin of the stand that would answer, were the request let through.
 */
export function probePage(target) {
  const script = `
const seen = []
const say = (what) => console.log(${JSON.stringify(PROBE_MARK)} + JSON.stringify(what))
document.addEventListener('securitypolicyviolation', (event) =>
  say({ violation: event.effectiveDirective }))
try { say({ cookie: document.cookie }) } catch (error) { say({ cookie: null, error: error.name }) }
try { say({ storage: typeof localStorage.length }) } catch (error) { say({ storage: null, error: error.name }) }
fetch(${JSON.stringify(`${target}/fetch`)}).then(() => say({ fetch: 'answered' }), () => say({ fetch: 'refused' }))
try {
  const xhr = new XMLHttpRequest()
  xhr.open('GET', ${JSON.stringify(`${target}/xhr`)})
  xhr.onload = () => say({ xhr: 'answered' })
  xhr.onerror = () => say({ xhr: 'refused' })
  xhr.send()
} catch (error) { say({ xhr: 'refused', error: error.name }) }
try {
  const socket = new WebSocket(${JSON.stringify(`${target.replace(/^http/, 'ws')}/ws`)})
  socket.onopen = () => say({ ws: 'answered' })
  socket.onerror = () => say({ ws: 'refused' })
} catch (error) { say({ ws: 'refused', error: error.name }) }
const form = document.createElement('form')
form.method = 'post'
form.action = ${JSON.stringify(`${target}/form`)}
document.body.append(form)
try { form.submit(); say({ form: 'submitted' }) } catch (error) { say({ form: 'refused', error: error.name }) }
setTimeout(() => say({ done: true }), 1500)
`
  return `<!doctype html><title>Проба</title><p id="v">Проба страницы</p><script>${script}</script>`
}

/** A page of another site that frames the page: the frame must stay empty. */
export const framingPage = (pageUrl) =>
  `<!doctype html><title>Чужой сайт</title><iframe id="f" src="${pageUrl}" width="400" height="200"></iframe>`
