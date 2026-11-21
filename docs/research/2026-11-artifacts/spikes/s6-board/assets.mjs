// Synthetic "photos" for the mockups: drawn by Chromium canvas with a seeded generator, saved as
// JPEG into frames/files. Gradients, bokeh, shapes and grain — so that file sizes and decoded
// sizes are like real photos (grain makes JPEG as heavy as a photo). Deterministic: same seed, same bytes.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'frames', 'files')

const palettes = {
  coffee: ['#3b2416', '#7a4a2a', '#c58b52', '#e9d3b4', '#f4efe6', '#2e4a3a'],
  dental: ['#e8f3fb', '#9cc9ea', '#1479c9', '#ffffff', '#cfe0ea', '#18b394'],
  honey: ['#f6c343', '#e09b00', '#7a4f01', '#fff2c7', '#5b6e2b', '#c87f0a'],
  salon: ['#f7d6df', '#c2477a', '#fff5f7', '#8a5a6b', '#e8c4a0', '#3a1f2b'],
  repair: ['#d9dde2', '#8f99a4', '#ff6b1a', '#f2efe9', '#2b3a4a', '#c7b299'],
}

const list = []
const add = (set, name, w, h, n = 1) => {
  for (let i = 1; i <= n; i++) list.push({ set, name: n === 1 ? name : `${name}${i}`, w, h, seed: list.length * 7919 + 17 })
}
add('coffee', 'coffee-hero', 1920, 1080)
add('coffee', 'coffee-g', 800, 600, 6)
add('dental', 'dental-hero', 1200, 1400)
add('dental', 'dental-d', 500, 500, 4)
add('honey', 'honey-hero', 1920, 800)
add('honey', 'honey-p', 700, 700, 6)
add('honey', 'honey-apiary', 1200, 800)
add('salon', 'salon-hero', 1920, 1080)
add('salon', 'salon-s', 600, 720, 4)
for (const [i, h] of [[1, 900], [2, 640], [3, 1000], [4, 760], [5, 600], [6, 880]]) list.push({ set: 'salon', name: `salon-g${i}`, w: 800, h, seed: 9000 + i })
add('repair', 'repair-hero', 1920, 1080)
add('repair', 'repair-r', 600, 800, 6)

function draw({ w, h, seed, colors }) {
  let s = seed >>> 0
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const pick = () => colors[Math.floor(rnd() * colors.length)]
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const x = c.getContext('2d')
  const a = rnd() * Math.PI
  const g = x.createLinearGradient(w / 2 - Math.cos(a) * w, h / 2 - Math.sin(a) * h, w / 2 + Math.cos(a) * w, h / 2 + Math.sin(a) * h)
  g.addColorStop(0, pick()); g.addColorStop(0.5, pick()); g.addColorStop(1, pick())
  x.fillStyle = g; x.fillRect(0, 0, w, h)
  for (let i = 0; i < 6; i++) { // shapes: tables, windows, shelves
    x.filter = `blur(${2 + rnd() * 6}px)`; x.globalAlpha = 0.35 + rnd() * 0.4; x.fillStyle = pick()
    const rw = w * (0.1 + rnd() * 0.4), rh = h * (0.05 + rnd() * 0.3)
    x.fillRect(rnd() * (w - rw), rnd() * (h - rh), rw, rh)
  }
  for (let i = 0; i < 26; i++) { // bokeh
    x.filter = `blur(${4 + rnd() * 26}px)`; x.globalAlpha = 0.18 + rnd() * 0.45; x.fillStyle = pick()
    x.beginPath(); x.arc(rnd() * w, rnd() * h, Math.min(w, h) * (0.02 + rnd() * 0.18), 0, Math.PI * 2); x.fill()
  }
  x.filter = 'none'; x.globalAlpha = 1
  const img = x.getImageData(0, 0, w, h), d = img.data
  for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * 26; d[i] += n; d[i + 1] += n; d[i + 2] += n }
  x.putImageData(img, 0, 0)
  return c.toDataURL('image/jpeg', 0.82)
}

export async function makeAssets({ force = false } = {}) {
  fs.mkdirSync(out, { recursive: true })
  const missing = list.filter((it) => force || !fs.existsSync(path.join(out, `${it.name}.jpg`)))
  if (!missing.length) return { made: 0, total: list.length }
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.setContent('<!doctype html><title>assets</title>')
  let bytes = 0
  for (const it of missing) {
    const url = await page.evaluate(draw, { w: it.w, h: it.h, seed: it.seed, colors: palettes[it.set] })
    const buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
    fs.writeFileSync(path.join(out, `${it.name}.jpg`), buf)
    bytes += buf.length
  }
  await browser.close()
  return { made: missing.length, total: list.length, bytes }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await makeAssets({ force: process.argv.includes('--force') })
  console.log(JSON.stringify(r))
}
