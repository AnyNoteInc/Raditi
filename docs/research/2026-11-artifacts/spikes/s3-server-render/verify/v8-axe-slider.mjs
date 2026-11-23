// Is the 170×16 range slider of the calculator a WCAG 2.5.8 failure? axe-core's target-size rule
// as the reference, with passes listed (skeptic of spike s3, plan 88).
//   node v8-axe-slider.mjs <calculator fixture> <axe.min.js>
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
const [fixture, axePath] = process.argv.slice(2)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
await page.setContent(readFileSync(fixture, 'utf8'))
await page.addScriptTag({ content: readFileSync(axePath, 'utf8') })
const r = await page.evaluate(async () => {
  const res = await axe.run(document, { runOnly: { type: 'rule', values: ['target-size'] }, resultTypes: ['passes', 'violations', 'incomplete'] })
  const pick = (list) => list.flatMap((v) => v.nodes.map((n) => ({ target: n.target.join(' '), checks: [...n.any, ...n.all, ...n.none].map((c) => c.id + (c.data && c.data.messageKey ? '/' + c.data.messageKey : '')) })))
  const slider = document.getElementById('area-range').getBoundingClientRect()
  return { slider: [Math.round(slider.width), Math.round(slider.height)], violations: pick(res.violations), incomplete: pick(res.incomplete), passes: pick(res.passes).filter((n) => /range|area/.test(n.target)) }
})
console.log(JSON.stringify(r, null, 1))
await browser.close()
