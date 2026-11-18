import { fileURLToPath } from 'node:url'

// The web server of the two landing configs: playwright.landing.config.ts and
// playwright.style-snapshot.config.ts. A database with seeds is enough for it (the plans come
// from the database), core and the other apps are not started. As for the smoke suite, stop `pnpm dev`
// first: Next allows one dev server per app directory.
const PORT = 3100

export const baseURL = `http://localhost:${PORT}`

/** The `webServer` of a config: the development server of web, or `start` for its production build. */
export function webServer(mode: 'dev' | 'start' = 'dev') {
  return {
    name: 'Web',
    // Next's own bin, not `pnpm exec`: see playwright.config.ts.
    command: `node_modules/.bin/next ${mode} --port ${PORT}`,
    cwd: fileURLToPath(new URL('../web/', import.meta.url)),
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    // A tree without the repository .env (a worktree, a clean checkout) has neither APP_ENV nor
    // the secret of sign-in, and web refuses to start without them: `development`, as
    // .env.example has it, and a synthetic secret — the landing signs nobody in — unless exported.
    env: {
      APP_ENV: process.env.APP_ENV ?? 'development',
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? 'synthetic-secret-of-the-e2e-landing-run',
      APP_URL: baseURL,
      BETTER_AUTH_URL: baseURL,
    },
  }
}
