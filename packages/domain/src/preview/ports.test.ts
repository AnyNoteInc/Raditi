import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  clipPageText,
  PREVIEW_SETTINGS_PATH,
  pageNavigateInputSchema,
  previewExecInputSchema,
  previewRuntimeSecretsSchema,
  previewRuntimeSpecSchema,
  previewSettingsSchema,
} from './ports.ts'
import {
  databaseCopyPolicySchema,
  previewRecipeSchema,
  siteDatabaseSettingsSchema,
} from './recipe.ts'

const image = (name: string) => `registry.raditi.ru/${name}@sha256:${'a'.repeat(64)}`
const recipe = {
  runtime: 'php',
  runtimeVersions: ['8.3', '8.2'],
  database: 'mysql',
  requiredPaths: ['wp-includes/version.php'],
  generatedFiles: [
    { path: 'wp-config.php', content: '<?php // reads the settings file' },
    { path: 'wp-content/mu-plugins/raditi-preview.php', content: '<?php' },
  ],
  settings: { DISABLE_WP_CRON: true, WP_DEBUG: false },
  healthPath: '/',
  web: {
    command: ['httpd', '-f', '/run/raditi/preview/httpd.conf'],
    env: { SERVER_RUN_DIR: '/tmp/httpd' },
    port: 8080,
    user: '33:33',
    docroot: '/var/www/html',
    tmpfs: ['/tmp'],
    configFiles: [{ name: 'httpd.conf', content: 'Listen 8080' }],
  },
}

describe('what a stack says about previews', () => {
  it('takes a recipe with relative paths and a path of the preview', () => {
    expect(previewRecipeSchema.parse(recipe)).toEqual(recipe)
    for (const broken of [
      { ...recipe, requiredPaths: ['/etc/passwd'] },
      { ...recipe, generatedFiles: [{ path: '../wp-config.php', content: '' }] },
      { ...recipe, generatedFiles: [recipe.generatedFiles[0], recipe.generatedFiles[0]] },
      { ...recipe, healthPath: 'https://evil.example/' },
      { ...recipe, runtimeVersions: [] },
      { ...recipe, settings: { 'DB-NAME': 'x' } },
      { ...recipe, runtime: 'node' },
      // The server runs unprivileged, from a path of its container, with each file once.
      { ...recipe, web: { ...recipe.web, port: 80 } },
      { ...recipe, web: { ...recipe.web, user: '0:0' } },
      { ...recipe, web: { ...recipe.web, docroot: 'var/www/html' } },
      { ...recipe, web: { ...recipe.web, tmpfs: ['/tmp/../etc'] } },
      { ...recipe, web: { ...recipe.web, configFiles: [{ name: '../x', content: '' }] } },
      {
        ...recipe,
        web: {
          ...recipe.web,
          configFiles: [recipe.web.configFiles[0], recipe.web.configFiles[0]],
        },
      },
    ])
      expect(previewRecipeSchema.safeParse(broken).success).toBe(false)
  })

  it('takes a copy policy of allowed tables, filters at the source and overrides', () => {
    const policy = {
      engine: 'mysql',
      tables: [
        {
          table: 'posts',
          where: [
            { op: 'in', column: 'post_type', values: ['post', 'page'] },
            { op: 'in', column: 'post_status', values: ['publish', 'private', 'draft'] },
          ],
          columns: { post_password: 'empty' },
        },
        {
          table: 'postmeta',
          where: [
            { op: 'inCopied', column: 'post_id', table: 'posts', key: 'ID' },
            { op: 'notLike', column: 'meta_key', patterns: ['%secret%', '%token%'] },
          ],
        },
        {
          table: 'users',
          where: [],
          columns: { user_email: 'synthetic_email', user_pass: 'random_password_hash' },
        },
      ],
      overrides: [
        {
          table: 'options',
          match: { column: 'option_name', value: 'raditi_content_epoch' },
          set: { option_value: '0' },
        },
        { table: 'options', match: { column: 'option_name', value: 'raditi_receipts' }, set: null },
      ],
    }
    expect(databaseCopyPolicySchema.parse(policy)).toEqual(policy)
    expect(
      databaseCopyPolicySchema.safeParse({
        ...policy,
        tables: [{ table: 'posts; DROP', where: [] }],
      }).success,
    ).toBe(false)
    expect(
      databaseCopyPolicySchema.safeParse({
        ...policy,
        tables: [{ table: 'posts', where: [{ op: 'raw', sql: '1=1' }] }],
      }).success,
    ).toBe(false)
    // Names and prefixes of an allow list; one rule per table, so rules never overlap.
    const options = {
      table: 'options',
      where: [{ op: 'like', column: 'option_name', patterns: ['blogname', 'theme\\_mods\\_%'] }],
    }
    expect(databaseCopyPolicySchema.safeParse({ ...policy, tables: [options] }).success).toBe(true)
    expect(
      databaseCopyPolicySchema.safeParse({ ...policy, tables: [options, options] }).success,
    ).toBe(false)
  })

  it('takes the database settings of a production configuration', () => {
    const settings = { tablePrefix: 'wp_', charset: 'utf8mb4', collation: null }
    expect(siteDatabaseSettingsSchema.parse(settings)).toEqual(settings)
    expect(siteDatabaseSettingsSchema.parse({ ...settings, tablePrefix: '' }).tablePrefix).toBe('')
    for (const broken of [
      { ...settings, tablePrefix: 'wp-' },
      { ...settings, charset: 'utf8mb4; SET' },
      { ...settings, collation: '' },
    ])
      expect(siteDatabaseSettingsSchema.safeParse(broken).success).toBe(false)
  })
})

describe('the runtime and the browser', () => {
  it('takes a spec with images pinned by digest and egress as host:port', () => {
    const spec = {
      previewId: '0196abcd-0000-7000-8000-00000000000a',
      siteId: '0196abcd-0000-7000-8000-00000000000b',
      taskId: '0196abcd-0000-7000-8000-00000000000c',
      runtime: 'runsc',
      images: {
        web: image('php'),
        db: image('mariadb'),
        cli: image('cli'),
        forwarder: image('fwd'),
        egress: null,
      },
      recipe,
      limits: { cpu: 1, memoryMiB: 1024, pids: 256 },
      egress: ['api.example.ru'],
      upstreamHost: '127.0.0.1',
      hostname: 'site-0f3a9c1b-chat-a1b2c3.localhost',
      origin: 'http://site-0f3a9c1b-chat-a1b2c3.localhost:8090',
      productionOrigin: 'https://shop.example.ru',
      expiresAt: Date.parse('2026-10-20T12:00:00Z'),
    }
    expect(previewRuntimeSpecSchema.parse(spec).egress).toEqual(['api.example.ru:443'])
    for (const expiresAt of [0, 1.5, new Date('2026-10-20T12:00:00Z')])
      expect(previewRuntimeSpecSchema.safeParse({ ...spec, expiresAt }).success).toBe(false)
    for (const broken of [
      // The origin of another host, a path, a scheme the gateway does not serve.
      { origin: 'http://site-0f3a9c1b-chat-ffffff.localhost:8090' },
      { origin: 'http://site-0f3a9c1b-chat-a1b2c3.localhost:8090/' },
      { productionOrigin: 'https://shop.example.ru/blog' },
      { productionOrigin: 'ftp://shop.example.ru' },
      { hostname: 'Site-0f3a9c1b-chat-a1b2c3.localhost' },
    ])
      expect(previewRuntimeSpecSchema.safeParse({ ...spec, ...broken }).success).toBe(false)
    expect(
      previewRuntimeSpecSchema.safeParse({ ...spec, images: { ...spec.images, web: 'php:8.3' } })
        .success,
    ).toBe(false)
    expect(previewRuntimeSpecSchema.safeParse({ ...spec, egress: ['10.0.0.1'] }).success).toBe(
      false,
    )
  })

  it('hands the variables and the database to the preview in its settings file only', () => {
    expect(PREVIEW_SETTINGS_PATH).toMatch(/^\/run\/raditi\//)
    expect(
      previewRuntimeSecretsSchema.safeParse({ env: { SHOP_API_KEY: 'k'.repeat(12) } }).success,
    ).toBe(true)
    for (const env of [{ WP_HOME: 'k'.repeat(12) }, { SHOP_API_KEY: 'short' }])
      expect(previewRuntimeSecretsSchema.safeParse({ env }).success).toBe(false)
    const settings = {
      v: 1,
      hostname: 'site-0f3a9c1b-chat-a1b2c3.localhost',
      origin: 'http://site-0f3a9c1b-chat-a1b2c3.localhost:8090',
      productionOrigin: 'https://shop.example.ru',
      database: {
        engine: 'mysql',
        host: 'db',
        port: 3306,
        name: 'preview',
        user: 'preview',
        password: 'p'.repeat(32),
      },
      egress: { proxy: { host: 'egress', port: 3128 }, hosts: ['api.example.ru:443'] },
      settings: { DISABLE_WP_CRON: true },
      env: { SHOP_API_KEY: 'k'.repeat(12) },
    }
    expect(previewSettingsSchema.parse(settings)).toEqual(settings)
    expect(previewSettingsSchema.safeParse({ ...settings, database: null }).success).toBe(true)
    expect(previewSettingsSchema.safeParse({ ...settings, egress: null }).success).toBe(true)
    expect(
      previewSettingsSchema.safeParse({
        ...settings,
        egress: { ...settings.egress, hosts: ['10.0.0.1:443'] },
      }).success,
    ).toBe(false)
    expect(
      previewSettingsSchema.safeParse({
        ...settings,
        database: { ...settings.database, password: "x'; DROP" },
      }).success,
    ).toBe(false)
  })

  it('runs an argv, never a shell line, and navigates only within the preview', () => {
    expect(previewExecInputSchema.safeParse({ argv: [], timeoutMs: 1000 }).success).toBe(false)
    expect(
      previewExecInputSchema.safeParse({ argv: ['wp', 'option', 'get', 'home'], timeoutMs: 1000 })
        .success,
    ).toBe(true)
    expect(pageNavigateInputSchema.safeParse({ path: '/shop/' }).success).toBe(true)
    for (const path of ['https://evil.example/', '//evil.example', 'shop'])
      expect(pageNavigateInputSchema.safeParse({ path }).success).toBe(false)
  })

  it('names no CMS, provider or shell (rule 8)', () => {
    const vocabulary = JSON.stringify([
      z.toJSONSchema(previewRuntimeSpecSchema, { io: 'input' }),
      z.toJSONSchema(databaseCopyPolicySchema),
    ]).toLowerCase()
    for (const name of ['wordpress', 'bitrix', 'docker', 'gitea', 'opencode', 'playwright'])
      expect(vocabulary).not.toContain(name)
  })
})

describe('text of a page cut for the model', () => {
  it('keeps a text within its bound as it is', () => {
    expect(clipPageText('Пишите: anna@example.test', 100)).toBe('Пишите: anna@example.test')
  })

  it('drops the word the bound runs through, never leaving part of an address', () => {
    const text = 'Пишите: ivan.petrov@mail.ru сегодня'
    // A cut at «ivan.petrov@mail» would be no address to the contact search any more.
    for (let limit = 8; limit < 'Пишите: ivan.petrov@mail.ru'.length; limit++) {
      const clipped = clipPageText(text, limit)
      expect(clipped.length).toBeLessThanOrEqual(limit)
      expect(clipped).toBe('Пишите:')
    }
    expect(clipPageText(text, 'Пишите: ivan.petrov@mail.ru'.length)).toBe(
      'Пишите: ivan.petrov@mail.ru',
    )
  })

  it('drops a number cut in its middle with what it is written with', () => {
    for (const phone of ['+7 912 345-67-89', '8 (912) 345 67 89']) {
      const text = `Звоните ${phone} днём`
      for (let limit = 'Звоните '.length; limit < `Звоните ${phone}`.length; limit++) {
        const clipped = clipPageText(text, limit)
        expect(clipped, `${phone} at ${limit}`).toBe('Звоните')
      }
    }
  })

  it('is empty when the first word is longer than the bound', () => {
    expect(clipPageText('a'.repeat(50), 10)).toBe('')
    expect(clipPageText('строка\nещё строка', 0)).toBe('')
  })
})
