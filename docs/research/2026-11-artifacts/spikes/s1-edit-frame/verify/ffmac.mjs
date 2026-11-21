// Does the cached Firefox build of Playwright 1.63.0 start on this macOS?
import { firefox } from 'playwright-core'
try {
  const b = await firefox.launch({ timeout: 30_000 })
  console.log('started', b.version())
  await b.close()
} catch (e) {
  console.log('failed:', String(e.message).split('\n').filter(Boolean).slice(0, 6).join(' | ').slice(0, 600))
}
