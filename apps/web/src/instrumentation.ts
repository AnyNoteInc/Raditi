/** Production fails at start on any broken settings section; development stays lazy (env.ts). */
export async function register(): Promise<void> {
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- set by Next.js itself, never a task input
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.APP_ENV === 'production') {
    const { brokenSections } = await import('./server/config-check')
    const broken = brokenSections()
    if (broken.length === 0) return
    // Section names only: a value or a zod message could carry a secret.
    console.error(`web: broken production settings: ${broken.join(', ')}`)
    process.exit(1)
  }
}
