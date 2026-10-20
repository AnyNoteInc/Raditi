import { envSearchStart, loadRepoEnv } from './env-file.ts'

// Imported first by main.ts, before anything reads process.env. The search for .env starts at the
// app being run (its main.js), not at this package: a .env beside the app wins over the root's.
loadRepoEnv({
  startDir: envSearchStart(process.argv[1], import.meta.url),
  nodeEnv: process.env.NODE_ENV,
})
