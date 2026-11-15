// The configuration of the preview app as a test env gives it. Only for *.test.ts files.
import { loadPreviewConfig, type PreviewConfig } from '../config/config.ts'

/** The pages listener alone, on loopback (the preview app needs one listener at least). */
export function testPreviewConfig(): PreviewConfig {
  return loadPreviewConfig({
    APP_ENV: 'test',
    APP_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi_test',
    PAGES_BASE_DOMAIN: 'pages.localhost',
  })
}

/** The same with its listeners on free ports. */
export function testPreviewConfigOnFreePorts(): PreviewConfig {
  const config = testPreviewConfig()
  return { ...config, pages: config.pages && { ...config.pages, port: 0 } }
}
