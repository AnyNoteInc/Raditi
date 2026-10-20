import { readFileSync } from 'node:fs'

import { z } from 'zod'

/**
 * The version of an app, from its package.json. `manifest` is the URL of that file relative to
 * the caller's own module (src/version.ts and dist/version.js sit at the same depth, so one
 * path works for both).
 */
export function readAppVersion(manifest: URL): string {
  return z.object({ version: z.string().min(1) }).parse(JSON.parse(readFileSync(manifest, 'utf8')))
    .version
}
