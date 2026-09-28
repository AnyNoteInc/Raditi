import { readFileSync } from 'node:fs'

import { z } from 'zod'

// src/version.ts and dist/version.js sit at the same depth, so the path works for both.
const manifest = z
  .object({ version: z.string().min(1) })
  .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')))

export const ORCHESTRATOR_VERSION: string = manifest.version
