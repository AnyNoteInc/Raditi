// The agent's job in OpenCart 4: sign in by refs, reach a product through the menu, change its name and description, save, read it back.
import { openAgent } from './agent-lib.mjs'
const [tag, origin, name, bodyMark] = process.argv.slice(2)
const a = await openAgent({ tag: `${tag}-job`, origin, startPath: '/admin/' })
try {
  await a.observe('login')
  await a.fill(/- textbox "Username"/, 'spikeadmin'); await a.fill(/- textbox "Password"/, '<hidden>')
  await a.click(/- button "Login"/); console.log('events', a.events.length); for (let i = 0; i < 8; i++) { await a.wait(1000); const t = await a.session.observe({}); console.log(' t', i, t.page.url.replace(origin, '').slice(0, 70), t.tree.length); if (t.tree.length > 1500) break }
  const o = await a.observe('dashboard')
  console.log('url has token:', /user_token=/.test(o.page.url), 'buttons:', a.lines(/- button/).length)

  const lines = a.tree.split('\n'); const i = lines.findIndex((l) => /Important Security Notification/.test(l))
  if (i >= 0) { const m = /\[ref=([a-z0-9]+)\]/.exec(lines[i + 1]); console.log('close of the modal:', lines[i + 1].trim()); await a.session.act({ tool: 'web_click', ref: m[1] }); await a.wait(900); await a.observe('no-modal') }
  await a.click(/- link "Catalog/); await a.wait(500)
  await a.observe('menu')
  await a.click(/- link "[^A-Za-z]*Products"/); await a.wait(1800, { until: "load" })
  await a.observe('products')
  const ls = a.tree.split('\n'); const row = ls.findIndex((l) => /- cell "iPhone"/.test(l)); const editLine = ls.slice(row).find((l) => /- link "Edit"/.test(l)); console.log('edit in the row:', editLine.trim())
  await a.session.act({ tool: 'web_click', ref: /\[ref=([a-z0-9]+)\]/.exec(editLine)[1] }); await a.wait(2500, { until: 'load' })
  await a.observe('form')
  console.log('save:', a.lines(/- button "Save"|- button "Back"|- link "Back"/).map((l) => l.trim().slice(0, 80)).join(' | '))
  console.log('tabs:', a.lines(/- (link|tab) "(General|Data|Links|Attribute|Option|Subscription|Discount|Special|Image|Reward|SEO|Design)/).map((l) => l.trim().slice(0, 40)).join(' | '))
  console.log('name:', a.lines(/Product Name/).slice(0, 4).map((l) => l.trim().slice(0, 100)).join(' | '))
  console.log('desc:', a.lines(/Description|Rich Text|editor|iframe/i).slice(0, 8).map((l) => l.trim().slice(0, 100)).join(' | '))
  await a.fill(/- textbox "\* Product Name/, name)
  const rte = a.line(/- textbox "Editor, /); console.log('rte line:', rte?.trim().slice(0, 120))
  if (rte) { await a.fill(/- textbox "Editor, /, bodyMark) }
  await a.observe('form2')
  await a.click(/- button "Save"/); await a.wait(2000)
  await a.observe('saved')
  console.log('alert:', a.lines(/Success|Warning|error/i).slice(0, 3).map((l) => l.trim().slice(0, 120)).join(' | '))
  console.log('rows:', a.lines(/iPhone/).slice(0, 6).map((l) => l.trim().slice(0, 110)).join(' || '))
  console.log('toolbar:', a.lines(/- (link|button)( "[^"]*")? \[ref=[a-z0-9]+\]( \[cursor=pointer\])?:?$/).slice(0, 14).map((l) => l.trim().slice(0, 70)).join(' || '))
} catch (e) { console.log('FAILED', e?.code ?? '', e?.message?.slice(0, 240)); await a.observe('failed').catch(() => {}) } finally { await a.close() }
