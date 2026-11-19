// Display run inside mcr.microsoft.com/playwright:v1.63.0-noble (used for Firefox: on the macOS host
// the agent sandbox does not let Firefox open its profile). Linux fonts: Liberation, FreeSans, WenQuanYi.
//   node /work/display-docker.mjs firefox /out/display-items.json /out/display-firefox.json /out/png/firefox
import { readFileSync, writeFileSync } from 'node:fs'
import * as pw from 'playwright-core'
import { displayRun } from './lib/display.mjs'

const [name, itemsFile, outFile, pngDir] = process.argv.slice(2)
const items = JSON.parse(readFileSync(itemsFile, 'utf8'))
const res = await displayRun(pw[name], items, pngDir)
writeFileSync(outFile, JSON.stringify(res))
console.log(JSON.stringify({ browser: name, version: res.version, items: items.length, requests: res.requests.length }))
