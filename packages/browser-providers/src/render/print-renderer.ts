import { Buffer } from 'node:buffer'

import { DomainError } from '@repo/domain'
import { artifactPrintLimits } from '@repo/domain/artifacts'
import type { Browser } from 'playwright-core'

import { renderFontCss, renderFontFaces } from './fonts.ts'

// The print of a page into a PDF (docs/plan/88-artifacts.md, §7.13; slice 88.32): «Скачать PDF» of
// «Отчёт». A page without scripts, assembled by the platform, is printed in a context of its own
// with JavaScript off: every request goes through `context.route`, which serves the fonts of the
// platform from memory and refuses the rest (the charts come inline as `data:` addresses). A4,
// the backgrounds printed, at most `pages` pages; one print 30 s at most.

/** The origin the fonts of a print are served on; `.invalid` never resolves (RFC 6761). */
export const PRINT_FILES_ORIGIN = 'https://print.render.invalid'

export interface PrintJob {
  html: string
  deadlineMs?: number
}

export async function printOn(browser: Browser, job: PrintJob): Promise<Uint8Array> {
  const fonts = renderFontCss(PRINT_FILES_ORIGIN)
  const files = new Map(
    renderFontFaces().map((face, index) => [fonts.urls[index]!, face.bytes] as const),
  )
  const context = await browser.newContext({
    javaScriptEnabled: false,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    colorScheme: 'light',
    acceptDownloads: false,
    serviceWorkers: 'block',
  })
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      // A page that does not print in time will not on another try: a refusal, not a fault.
      () => reject(new DomainError('RENDER_TIMEOUT', 'The page did not print in time', 422)),
      job.deadlineMs ?? artifactPrintLimits.printMs,
    )
  })
  deadline.catch(() => undefined)
  const work = async () => {
    await context.route('**/*', async (route) => {
      const bytes = files.get(route.request().url())
      if (bytes)
        await route
          .fulfill({ status: 200, contentType: 'font/woff2', body: Buffer.from(bytes) })
          .catch(() => undefined)
      else await route.abort().catch(() => undefined)
    })
    await context.routeWebSocket(/.*/, (socket) => socket.close())
    const page = await context.newPage()
    // The fonts of the platform first: the page's own style decides where Golos Text is used.
    const html = job.html.replace(/<head>/i, `<head><style>${fonts.css}</style>`)
    await page.setContent(html, { waitUntil: 'load' })
    await page.evaluate('document.fonts.ready.then(() => true)').catch(() => undefined)
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
      pageRanges: `1-${artifactPrintLimits.pages}`,
    })
    return new Uint8Array(pdf)
  }
  try {
    return await Promise.race([work(), deadline])
  } finally {
    clearTimeout(timer)
    await context.close().catch(() => undefined)
  }
}
