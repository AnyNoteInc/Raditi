import { randomBytes } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { joomlaAdapter } from '@repo/site-adapters'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  buildStackPreview,
  stackTreeOf,
  startStackProduction,
  type StackBuild,
  type StackPreview,
  type StackProduction,
} from '../testing/stack-preview.ts'

// М2 of Joomla (docs/plan/62-site-stacks.md, §5.5; docs/plan/62-slices/e3.md, Э3.8): each build of
// the stand — a release of joomla.org downloaded and checked by infra/dev/stack-verify/fetch-cms.mjs —
// installed on a synthetic production, seeded with synthetic content and marks, then run as a preview
// by the adapter of Joomla, the real copier and the real runtime of previews (PREVIEW_RUNTIME, runc
// by default). Needs the images `raditi-site-verify:<php>` of `pnpm verify:site-images`, the tools
// and the host rules of infra/preview/README.md; runs with RADITI_PREVIEW_DOCKER_TESTS=1 and
// RADITI_CMS_DIR, the absolute folder of the archives. A build whose tree is not there fails: a skip
// would hide a download that was forgotten. Only synthetic data.

const enabled =
  process.env.RADITI_PREVIEW_DOCKER_TESTS === '1' && Boolean(process.env.RADITI_CMS_DIR)

const standFile = fileURLToPath(
  new URL('../../../../infra/dev/stack-verify/joomla.mjs', import.meta.url),
)
const fn = <T>() => z.custom<T>((value) => typeof value === 'function')
const stand = z
  .object({
    JOOMLA_BUILDS: z.array(
      z.object({
        archive: z.string(),
        php: z.string(),
        generation: z.string(),
        version: z.string(),
      }),
    ),
    JOOMLA_PREFIX: z.string(),
    JOOMLA_SEED: z.object({
      authorId: z.number(),
      articleId: z.number(),
      draftId: z.number(),
      articleTitle: z.string(),
      articleFullText: z.string(),
      articlePath: z.string(),
    }),
    JOOMLA_INSTALLATION_MARKER: z.string(),
    JOOMLA_CANARIES: z.array(z.string()),
    JOOMLA_CONFIG_CANARIES: z.object({ smtppass: z.string(), secret: z.string() }),
    installJoomla:
      fn<
        (
          production: StackProduction,
          build: StackBuild,
          options: { productionOrigin: string },
        ) => Promise<void>
      >(),
    joomlaSeedSql: fn<(prefix: string, build: StackBuild) => string>(),
    joomlaIndexerArgv: fn<(build: StackBuild) => string[]>(),
  })
  .parse(await import(pathToFileURL(standFile).href))
const { JOOMLA_SEED: seed, JOOMLA_PREFIX: prefix } = stand

/** A value as text or as the hex of its UTF-8: the copier writes a binary column in hex. */
const holds = (text: string, value: string) =>
  text.includes(value) || text.toLowerCase().includes(Buffer.from(value, 'utf8').toString('hex'))
const count = async (preview: StackPreview, query: string) =>
  Number((await preview.rootSql(query)).trim())

describe.skipIf(!enabled).each(stand.JOOMLA_BUILDS)('Joomla $version as a preview', (build) => {
  const productionOrigin = `https://joomla-${randomBytes(3).toString('hex')}.example.ru`
  let production: StackProduction | undefined
  let preview: StackPreview
  let password = ''

  beforeAll(async () => {
    const started = Date.now()
    production = await startStackProduction({ build, treeFolder: stackTreeOf(build) })
    await stand.installJoomla(production, build, { productionOrigin })
    await production.sql(stand.joomlaSeedSql(prefix, build))
    // The control of case 5: the file the import rules must drop is there to be dropped.
    await production.exec(['test', '-f', `/var/www/html/${stand.JOOMLA_INSTALLATION_MARKER}`])
    password = (await production.exec(['cat', '/prod-secrets/db'])).trim()
    const building = Date.now()
    preview = await buildStackPreview({
      adapter: joomlaAdapter,
      production,
      build,
      productionOrigin,
    })
    const tables = preview.seed.match(/^DROP TABLE IF EXISTS /gm)?.length ?? 0
    const rows = preview.seed.match(/^INSERT INTO /gm)?.length ?? 0
    // The numbers of the measurement (Э3.8): PHP, the time, the files and the tables of the copy.
    console.log(
      `M2 ${build.archive}: PHP ${preview.recipe.runtimeVersions[0]}, production ${Math.round(
        (building - started) / 1000,
      )} s, preview ${Math.round((Date.now() - building) / 1000)} s, ${
        preview.treePaths.length
      } files, ${tables} tables, ${rows} statements of rows`,
    )
  }, 30 * 60_000)

  afterAll(async () => {
    try {
      await preview?.destroy()
    } finally {
      await production?.remove()
    }
  }, 5 * 60_000)

  it('is ready: the home page answers as the preview, and a build would keep it', async () => {
    const home = await preview.request('/')
    expect(home.status).toBe(200)
    expect(home.header('x-raditi-preview')).toBe('1')
    for (const text of preview.recipe.ready!.absent) expect(home.body).not.toContain(text)
    expect(await preview.boot()).toEqual({ state: 'alive', redirectsAway: false })
    // Under the runtime the run asked for: М7 of the stack is the preview under runsc.
    expect(await preview.containerRuntime()).toBe(
      process.env.PREVIEW_RUNTIME === 'runsc' ? 'runsc' : 'runc',
    )
  })

  it('answers the article at the address of its menu item and by its query', async () => {
    // The full text is on the article's own page only: the featured blog of `/` shows the intro.
    const home = await preview.request('/')
    expect(home.body).toContain(seed.articleTitle)
    expect(home.body).not.toContain(seed.articleFullText)
    const article = await preview.request(seed.articlePath)
    expect(article.status).toBe(200)
    expect(article.body).toContain(seed.articleFullText)
    const byQuery = await preview.request(
      `/index.php?option=com_content&view=article&id=${seed.articleId}`,
    )
    if (byQuery.status >= 300 && byQuery.status < 400) {
      const location = new URL(byQuery.header('location') ?? '', `${preview.origin}/`)
      expect(location.origin).toBe(preview.origin)
      const followed = await preview.request(`${location.pathname}${location.search}`)
      expect(followed.status).toBe(200)
      expect(followed.body).toContain(seed.articleFullText)
    } else {
      expect(byQuery.status).toBe(200)
      expect(byQuery.body).toContain(seed.articleFullText)
    }
  })

  it('links to the preview’s own origin, never to production', async () => {
    // The production names itself in its `$live_site` (installJoomla): a preview that took it
    // would link there. Absolute links in the content are not rewritten for Joomla — the seed has
    // none, and the copy holds them as the production does (docs/plan/62-site-stacks.md, §10).
    const production = new URL(productionOrigin)
    for (const path of ['/', seed.articlePath]) {
      const page = await preview.request(path)
      expect(page.body, path).not.toContain(production.hostname)
      const absolute = [...page.body.matchAll(/\b(?:href|src|action)="((?:https?:)?\/\/[^"]+)"/g)]
        .map(([, link]) => new URL(link!.replaceAll('&amp;', '&'), `${preview.origin}/`))
        // Links to joomla.org and other sites of the template are not addresses of the site.
        .filter(
          (link) => link.hostname.endsWith('.localhost') || link.hostname === production.hostname,
        )
      expect(absolute.length, path).toBeGreaterThan(0)
      // The scheme, the name and the port of the gateway: a link without the port is broken.
      for (const link of absolute) expect(link.origin, link.href).toBe(preview.origin)
    }
  })

  it('without the files of the platform is dead, with them alive again', async () => {
    await preview.rewriteTree({ platform: false })
    const bare = await preview.request('/')
    expect(bare.status).toBe(200)
    expect(bare.body).toContain('No configuration file found')
    expect(await preview.boot()).toEqual({ state: 'dead' })
    await preview.rewriteTree({ platform: true })
    expect(await preview.boot()).toEqual({ state: 'alive', redirectsAway: false })
  })

  it('holds no person, no secret and no draft', async () => {
    // The control: the text of the published article is found the same way.
    expect(holds(preview.seed, seed.articleTitle)).toBe(true)
    const config = Object.values(stand.JOOMLA_CONFIG_CANARIES)
    for (const value of [...stand.JOOMLA_CANARIES, ...config, password]) {
      expect(value.length).toBeGreaterThan(8)
      expect(holds(preview.seed, value), value).toBe(false)
    }
    for (const table of ['contact_details', 'user_profiles', 'session', 'update_sites']) {
      expect(preview.seed).not.toContain(`INSERT INTO \`${prefix}${table}\``)
      if (table !== 'session')
        expect(await count(preview, `SELECT COUNT(*) FROM \`${prefix}${table}\``)).toBe(0)
    }
    expect((await preview.rootSql(`SELECT email FROM \`${prefix}users\``)).trim()).toBe(
      `user${seed.authorId}@preview.invalid`,
    )
    expect(
      await count(preview, `SELECT COUNT(*) FROM \`${prefix}content\` WHERE id = ${seed.draftId}`),
    ).toBe(0)
    expect(
      await count(
        preview,
        `SELECT COUNT(*) FROM \`${prefix}content\` WHERE id = ${seed.articleId}`,
      ),
    ).toBe(1)
    expect(preview.treePaths).not.toContain('configuration.php')
    expect(preview.treePaths.some((path) => path.startsWith('administrator/logs/'))).toBe(false)
    // The production keeps a file there (beforeAll checks it): the import rules drop it.
    expect(preview.treePaths.some((path) => path.startsWith('installation/'))).toBe(false)
    expect(preview.treePaths).toContain('index.php')

    // Where a value of the production's configuration could travel besides the seed: the facts
    // the import keeps for the site, the recipe of the preview, the configuration the preview
    // runs with and every file of its docroot.
    const running = await preview.exec([
      'php',
      '-r',
      "require '/var/www/html/configuration.php'; var_export(get_object_vars(new JConfig));",
    ])
    expect(running.code, running.output).toBe(0)
    expect(running.output).toContain("'mailonline' => false")
    for (const value of [...config, password]) {
      expect(JSON.stringify(preview.stackFacts), value).not.toContain(value)
      expect(JSON.stringify(preview.recipe), value).not.toContain(value)
      expect(running.output, value).not.toContain(value)
      const found = await preview.exec(['grep', '-rFls', '--', value, '/var/www/html'])
      expect(found.output.trim(), value).toBe('')
      expect(found.code, value).not.toBe(0)
    }
  })

  it('runs no cache, no scheduler, no statistics and sends no mail', async () => {
    expect(
      await count(
        preview,
        `SELECT COUNT(*) FROM \`${prefix}extensions\` WHERE name IN ('plg_system_cache', 'plg_system_schedulerunner', 'plg_system_stats')`,
      ),
    ).toBe(0)
    expect((await preview.request('/')).status).toBe(200)
    const mail = await preview.exec([
      'php',
      '-r',
      "require '/var/www/html/configuration.php'; $c = new JConfig(); var_export($c->mailonline === false);",
    ])
    expect(mail).toMatchObject({ code: 0, output: 'true' })
    const info = await preview.exec(['php', '-i'])
    expect(info.output).toMatch(/^sendmail_path => \/usr\/local\/lib\/raditi\/no-sendmail/m)
  })

  it('indexes the site: the branch Author of the copy takes the leaves', async () => {
    const leaves = `SELECT COUNT(*) FROM \`${prefix}finder_taxonomy\` WHERE parent_id NOT IN (0, 1)`
    const author = (
      await preview.rootSql(
        `SELECT id FROM \`${prefix}finder_taxonomy\` WHERE parent_id = 1 AND title = 'Author'`,
      )
    ).trim()
    expect(author).toMatch(/^\d+$/)
    expect(await count(preview, leaves)).toBe(0)
    const indexed = await preview.exec(stand.joomlaIndexerArgv(build))
    expect(indexed.code, indexed.output).toBe(0)
    expect(await count(preview, leaves)).toBeGreaterThan(0)
    expect(
      await count(
        preview,
        `SELECT COUNT(*) FROM \`${prefix}finder_taxonomy\` WHERE parent_id = ${author}`,
      ),
    ).toBeGreaterThan(0)
    // One branch Author: the indexer took the copied one, it made no second.
    expect(
      await count(
        preview,
        `SELECT COUNT(*) FROM \`${prefix}finder_taxonomy\` WHERE parent_id = 1 AND title = 'Author'`,
      ),
    ).toBe(1)
  })

  it('closes the configuration, the logs, the cache and the temporary files', async () => {
    for (const path of ['/configuration.php', '/administrator/logs/', '/cache/', '/tmp/'])
      expect((await preview.request(path)).status, path).toBe(403)
  })
})
