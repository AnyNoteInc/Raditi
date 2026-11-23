import { existsSync } from 'node:fs'

import { chromium, type Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { renderChromiumArgs } from './frame-renderer.ts'
import { printOn } from './print-renderer.ts'

// The print of a report into a PDF (docs/plan/88-artifacts.md, §7.13, 88.32). Needs a Chromium of
// this machine: Playwright's, or a system Chrome; without one the suite is skipped.

const executable = [
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
].find((path): path is string => typeof path === 'string' && existsSync(path))

describe.skipIf(!executable)('the print of a page in a Chromium', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: renderChromiumArgs(),
      proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
      executablePath: executable!,
    })
  }, 60_000)
  afterAll(async () => {
    await browser?.close()
  })

  it('prints A4 pages with an inline picture, loads nothing and runs no script', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#2f5d50"/></svg>',
    ).toString('base64')
    const html =
      '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
      '<h1>Отчёт о продажах</h1><p>Выручка выросла.</p>' +
      `<img src="data:image/svg+xml;base64,${svg}" width="40" height="20">` +
      '<img src="https://example.com/x.png">' +
      '<script>document.body.innerHTML="ran"</script>' +
      '<p style="break-before:page">Вторая страница</p></body></html>'
    const pdf = Buffer.from(await printOn(browser, { html }))
    const text = pdf.toString('latin1')
    expect(text.startsWith('%PDF-')).toBe(true)
    // Two pages of A4 (595×842 points): the script, had it run, would have left one.
    expect(text.match(/\/Type\s*\/Page[^s]/g)?.length).toBe(2)
    const box = /\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/.exec(text)
    expect(Math.round(Number(box?.[1]))).toBeGreaterThanOrEqual(594)
    expect(Math.round(Number(box?.[1]))).toBeLessThanOrEqual(596)
    expect(Math.round(Number(box?.[2]))).toBeGreaterThanOrEqual(841)
    expect(Math.round(Number(box?.[2]))).toBeLessThanOrEqual(843)
  }, 60_000)

  it('prints at most 30 pages', async () => {
    const pages = Array.from(
      { length: 35 },
      (_, at) => `<p style="break-before:page">Страница ${at + 1}</p>`,
    ).join('')
    const pdf = Buffer.from(
      await printOn(browser, {
        html: `<!doctype html><html><head><meta charset="utf-8"></head><body>${pages}</body></html>`,
      }),
    ).toString('latin1')
    expect(pdf.match(/\/Type\s*\/Page[^s]/g)?.length).toBe(30)
  }, 60_000)
})
