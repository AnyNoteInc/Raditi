// The configuration of the preview app as a test env gives it. Only for *.test.ts files.
import { loadPreviewConfig, type PreviewGatewayConfig } from '../config.ts'

export function testPreviewConfig(): PreviewGatewayConfig {
  return loadPreviewConfig({
    APP_ENV: 'test',
    APP_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi_test',
    PREVIEW_BASE_DOMAIN: 'localhost',
    PREVIEW_PUBLIC_PORT: '8090',
  })
}
