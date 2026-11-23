// Starts the stand and prints the answers of a few addresses through its proxy (curl).
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { startStand } from './stand.mjs'
const run = promisify(execFile)
const require = createRequire(import.meta.url)
const stand = await startStand({ certDir: new URL('./certs', import.meta.url).pathname, fontFile: require.resolve('@fontsource-variable/golos-text/files/golos-text-cyrillic-wght-normal.woff2') })
const curl = async (url) => (await run('curl', ['-sk', '--max-time', '5', '-x', `http://127.0.0.1:${stand.proxyPort}`, '-D', '-', '-o', '/dev/null', url]).catch((e) => ({ stdout: 'curl failed: ' + e.code + ' ' + (e.stdout || '') }))).stdout
for (const url of process.argv.slice(2)) console.log('### ' + url + '\n' + (await curl(url)))
console.log('refused:', stand.refused)
await stand.close()
