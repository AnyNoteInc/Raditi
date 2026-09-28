import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRepoEnv } from './env-file.ts'

// Imported first by main.ts, before anything reads process.env.
loadRepoEnv({ startDir: dirname(fileURLToPath(import.meta.url)), nodeEnv: process.env.NODE_ENV })
