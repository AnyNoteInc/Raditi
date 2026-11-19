// Prints the tables of the report from <run>/results/*.json.
//   node summary.mjs --run <run>
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { run: { type: 'string' } } })
const read = (name) => {
  const file = join(values.run, 'results', `${name}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}
const scrub = (text) => String(text ?? '').replace(/S8[QFPN]\w+x[0-9a-f]{12}/g, '<маркер>')

const prod = read('prod')
console.log('### prod\n\n| Случай | Что | Код | Строк журнала | RequestPath | Маркер в журналах |\n| --- | --- | --- | --- | --- | --- |')
for (const r of prod.results)
  console.log(
    `| ${r.id} | ${r.about} | ${r.status ?? '—'} | ${r.accessLines} | ${r.accessSample?.RequestPath ? `\`${scrub(r.accessSample.RequestPath)}\`` : '—'} | ${r.leaks.length ? r.leaks.join(', ') : 'нет'} |`,
  )
console.log(`\nmetric labels: ${prod.metricLabels.join(', ')}; general levels ${JSON.stringify(prod.generalLevels)}`)

const variants = ['keep', 'redact', 'Drop', 'dup', 'dup-first', 'common', 'genericCLF', 'common-keep', 'path-drop', 'route-off', 'rewrite', 'headers-keep', 'file', 'debug', 'trace']
console.log('\n### variants\n\n| Вариант | Что | Случаев | С маркером в журналах | Какие |\n| --- | --- | --- | --- | --- |')
for (const v of variants) {
  const r = read(v)
  if (!r) continue
  const leaking = r.results.filter((x) => x.leaks.length)
  console.log(`| \`${v}\` | ${r.about} | ${r.results.length} | ${leaking.length} | ${leaking.map((x) => x.id).join(', ') || '—'} |`)
}
for (const v of ['debug', 'trace']) {
  const r = read(v)
  if (!r) continue
  for (const x of r.results)
    for (const g of x.generalWithSecret) console.log(`${v} ${x.id}: ${scrub(g).slice(0, 150)}`)
}
const sample = (v, id) => read(v)?.results.find((x) => x.id === id)?.accessSample
console.log('\nP01 lines:')
for (const v of ['prod', 'keep', 'common', 'genericCLF', 'common-keep']) console.log(v, scrub(JSON.stringify(sample(v, 'P01'))))

const b = read('browsers')
if (b) {
  console.log('\n### browsers\n\n| Браузер | Платформа | Запрос к серверу | Маркер у сервера | location.hash | После replaceState | Referer (fetch / unsafe-url / переход) | www→apex | http→https | fetch и ссылка с # | /a?k=: токен в Referer |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const x of b.browsers) {
    if (x.error) {
      console.log(`| ${x.browser} | ${x.platform} | не запустился: ${x.error.slice(0, 80)} |`)
      continue
    }
    console.log(
      `| ${x.browser} ${x.version} | ${x.platform} | \`${x.navigation.backendRequestLine}\` | ${x.navigation.backendSawToken ? 'да' : 'нет'} | \`${x.navigation.locationHash}\` | \`${x.afterReplaceState.url.replace('https://cabinet.example.test', '')}\` | ${x.referer.tokenInAny ? 'с токеном' : 'без токена'} | ${x.wwwRedirect.keptToken ? 'фрагмент сохранён' : 'потерян'}, \`${x.wwwRedirect.backendRequestLine}\` | ${x.httpRedirect.keptToken ? 'фрагмент сохранён' : 'потерян'}, \`${x.httpRedirect.backendRequestLine}\` | \`${x.fetchWithFragment.backendRequestLine}\`, \`${x.linkWithFragment.backendRequestLine}\` | ${x.queryVariant.tokenInReferer ? 'да' : 'нет'} (no-referrer: ${x.queryVariant.tokenWithNoReferrer ? 'да' : 'нет'}) |`,
    )
  }
  console.log('\n| Браузер | Платформа | Прямо к http://127.0.0.1 | Через HTTP-прокси (http://…) |\n| --- | --- | --- | --- |')
  for (const x of b.plainHttp) console.log(`| ${x.browser} | ${x.platform} | \`${x.directOrigin?.join(' ')}\` | \`${x.viaHttpProxy?.join(' ')}\` |`)
  console.log('\n| Клиент | Версия | Запрос к серверу | Маркер у сервера |\n| --- | --- | --- | --- |')
  for (const [k, x] of Object.entries(b.clients)) console.log(`| ${k} | ${x.version} | \`${x.backendRequestLine}\` | ${x.backendSawToken ? 'да' : 'нет'} |`)
  console.log(`\nmarkers ${b.markers}; in edge logs: ${JSON.stringify(Object.values(b.markersInEdgeLogs))}`)
}
const n = read('next')
if (n) {
  console.log('\n### next\n\n| Случай | Что | Код | Токен в Location | Маркер в stdout / stderr |\n| --- | --- | --- | --- | --- |')
  for (const x of n.results) console.log(`| ${x.id} | ${x.about} | ${x.status} | ${x.locationCarriesToken ? 'да' : 'нет'} | ${x.inStdout || x.inStderr ? 'да' : 'нет'} |`)
}
const sw = read('sw')
if (sw) for (const x of sw.results) console.log(`sw ${x.browser} ${x.version}: SW saw token ${x.serviceWorkerSawToken}, network ${x.networkSawToken} (${x.networkLines.length} lines)`)
