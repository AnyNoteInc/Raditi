// ablate.mjs <cms dir> <prefix> <db port> <container> <host> <port> <policy export> <pages comma> <admin path>: removes the rows of one allowed
// table at a time (structure only, as the copier makes an unnamed table), reloads the seed in the running preview, wipes the caches, reads the pages.
import { execFileSync, spawnSync } from 'node:child_process'
import http from 'node:http'
import { join } from 'node:path'
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs'
const [cmsDir, prefix, dbPort, container, host, port, exportName, pagesCsv, cacheWipe, outFile] = process.argv.slice(2)
const mod = await import(join(cmsDir, 'policy.mjs'))
const tables = mod[exportName]
const overrides = mod.overrides ?? []
const pages = pagesCsv.split(',')
const PW = '<hidden>'
const here = new URL('.', import.meta.url).pathname
const seedFor = (list, file) => {
  const policy = join('/tmp', `ablate-policy-${container}.json`)
  writeFileSync(policy, JSON.stringify({ engine: 'mysql', tables: list, overrides: overrides.filter((o) => list.some((t) => t.table === o.table)) }))
  const r = spawnSync('node', ['--import', './copy-hook.mjs', 'copy.mjs', policy, prefix, dbPort, file], { cwd: here, env: { ...process.env, BS_TABLE_LIMIT: '512' }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`copy: ${r.stderr.slice(-300)}`)
}
const load = (file) => {
  const client = ['exec', '-i', '-u', '999:999', '-e', `MYSQL_PWD=${PW}`, container, 'mariadb', '--no-defaults', '--protocol=tcp', '--host=127.0.0.1', '--user=preview']
  execFileSync('docker', [...client, '--execute=DROP DATABASE IF EXISTS `preview`; CREATE DATABASE `preview`'], { stdio: 'pipe' })
  const r = spawnSync('docker', [...client, '--binary-mode', '--sandbox', '--max-allowed-packet=64M', '--database=preview'], { input: readFileSync(file), encoding: 'utf8' })
  if (r.status !== 0) return `seed: ${r.stderr.slice(-200)}`
  return null
}
const get = (path, { headers = {}, method = 'GET', body } = {}) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: Number(port), path, method, headers: { Host: `${host}:${port}`, 'User-Agent': 'spike', ...headers }, timeout: 30000 }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
  })
  req.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e) })); req.on('timeout', () => { req.destroy() })
  if (body) req.write(body); req.end()
})
const adminProbe = process.env.ADMIN_PROBE
/** Joomla: a user made by its CLI, a real sign-in, the article list and one edit form. */
const joomlaAdmin = async () => {
  const add = spawnSync('docker', ['exec', container, '/usr/local/lib/raditi/run-as.sh', '33:33', '60', '--', 'php', '/var/www/html/cli/joomla.php', 'user:add', '--username=spike', '--password=<hidden>', '--name=Spike', '--email=spike@preview.invalid', '--usergroup=Super Users', '-n'], { encoding: 'utf8' })
  if (!/User created/.test(add.stdout)) return 'cli-user:FAIL'
  const jar = {}
  const take = (r) => { for (const c of r.headers['set-cookie'] ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1) } }
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
  const page = await get('/administrator/index.php'); take(page)
  const token = /name="([0-9a-f]{32})" value="1"/.exec(page.body)?.[1] ?? /"csrf\.token":"([0-9a-f]{32})"/.exec(page.body)?.[1]
  if (!token) return `login-page:${page.status}`
  const form = new URLSearchParams({ username: 'spike', passwd: '<hidden>', option: 'com_login', task: 'login', return: 'aW5kZXgucGhw', [token]: '1' }).toString()
  const post = await get('/administrator/index.php', { method: 'POST', body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form), Cookie: cookie() } }); take(post)
  const list = await get('/administrator/index.php?option=com_content&view=articles', { headers: { Cookie: cookie() } })
  const rows = (list.body.match(/task=article\.edit&amp;id=\d+/g) ?? []).length
  const signedIn = /Log out|logout/i.test(list.body) || rows > 0
  const dash = await get('/administrator/index.php', { headers: { Cookie: cookie() } })
  return `admin:${signedIn ? 'in' : 'OUT'}:${list.status}:rows=${rows}:dash=${dash.status}`
}
const read = async () => {
  spawnSync('docker', ['exec', '-u', '33:33', container, 'sh', '-c', cacheWipe])
  const out = []
  for (const p of pages) {
    const res = await get(p)
    const warn = /<b>(Warning|Notice|Deprecated)<\/b>/.test(res.body.slice(0, 400))
    const title = /<title>([^<]*)/.exec(res.body)?.[1]?.slice(0, 24) ?? ''
    out.push(`${res.status}${warn ? 'w' : ''}:${res.body.length}:${title.replace(/\s+/g, '_')}`)
  }
  if (adminProbe === 'joomla') out.push(await joomlaAdmin())
  return out
}
const baseFile = `/tmp/ablate-base-${container}.sql`
seedFor(tables, baseFile)
console.log('load', load(baseFile))
const base = await read(); await new Promise((r) => setTimeout(r, 300))
const again = await read()
console.log('base', base.join(' '), '|', again.join(' '))
writeFileSync(outFile, `# ${new Date().toISOString()} ${container} pages: ${pages.join(' ')}\n# base ${again.join(' ')}\n`)
const statusOf = (l) => l.map((x) => x.split(':')[0]).join(' ')
let n = 0
for (const rule of tables) {
  n += 1
  const file = `/tmp/ablate-one-${container}.sql`
  const list = tables.filter((t) => t.table !== rule.table)
  // Another rule may follow this table with inCopied: it follows nothing then, so its rows are gone too.
  let without = list; for (;;) { const names = new Set(without.map((t) => t.table)); const next = without.filter((t) => t.where.every((w) => w.op !== 'inCopied' || names.has(w.table))); if (next.length === without.length) break; without = next }
  let line
  try {
    seedFor(without, file)
    const bad = load(file)
    const result = bad ? [bad] : await read()
    const sizeDiff = result.map((r, i) => { const a = Number(r.split(':')[1]); const b = Number(again[i].split(':')[1]); if (Number.isNaN(a) || Number.isNaN(b)) return r === again[i] ? 0 : 1; return Math.abs(a - b) > Math.max(200, b * 0.1) ? 1 : 0 })
    const changed = statusOf(result) !== statusOf(again) ? 'BROKEN' : sizeDiff.some(Boolean) ? 'changed' : 'same'
    line = `${rule.table}\t${changed}\t${result.join(' ')}\t-${tables.length - without.length} rules`
  } catch (e) { line = `${rule.table}\tERROR\t${e.message.slice(0, 160)}` }
  appendFileSync(outFile, `${line}\n`)
  if (n % 10 === 0) console.log(n, '/', tables.length)
}
load(baseFile)
console.log('ABLATE-DONE', outFile)
