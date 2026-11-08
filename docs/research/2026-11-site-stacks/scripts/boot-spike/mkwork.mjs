// mkwork.mjs <cms dir> <work dir> <settings JSON> [policy export name]: writes apache2.conf, platform.json, settings.json and policy.json.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
const [cmsDir, work, settings, policyName = 'tables'] = process.argv.slice(2)
const real = readFileSync('<repo>/infra/wordpress/preview-apache.conf', 'utf8')
const rewrite = readFileSync(join(cmsDir, 'rewrite.conf'), 'utf8')
const from = real.indexOf('    # The rules WordPress writes')
const to = real.indexOf('</Directory>', from)
if (from < 0 || to < 0) throw new Error('the block of WordPress was not found')
writeFileSync(join(work, 'apache2.conf'), real.slice(0, from) + rewrite + real.slice(to))
const platformDir = join(cmsDir, 'platform')
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
const files = walk(platformDir).map((p) => ({ path: relative(platformDir, p), content: readFileSync(p, 'utf8') }))
writeFileSync(join(work, 'platform.json'), JSON.stringify({ files }))
writeFileSync(join(work, 'settings.json'), settings)
const mod = await import(join(cmsDir, 'policy.mjs'))
const overrides = mod.overrides ?? []
writeFileSync(join(work, 'policy.json'), JSON.stringify({ engine: 'mysql', tables: mod[policyName], overrides }))
console.log(`work: ${files.length} platform files: ${files.map((f) => f.path).join(', ')}; ${mod[policyName].length} tables`)
