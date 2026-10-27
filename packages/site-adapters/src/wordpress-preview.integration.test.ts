import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { PreviewSettings, SiteFacts } from '@repo/domain'
import { PREVIEW_SETTINGS_PATH, previewSettingsSchema } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { wordpressPreviewRecipe } from './wordpress-preview.ts'

// The recipe as a preview runs it: WordPress 7.1.2 of the official image, read-only, as
// www-data, with the generated wp-config.php, the mu-plugin and Apache's configuration, a
// settings file like the runtime's, and a disposable MariaDB on an internal network — the
// recipe's files, not the container of a preview (docs/plan/58: the runtime's suite and the
// network stand run that). Needs Docker and the pulled images below; runs with
// RADITI_PREVIEW_DOCKER_TESTS=1.

const enabled = process.env.RADITI_PREVIEW_DOCKER_TESTS === '1'
const run = promisify(execFile)
const WEB_IMAGE = 'wordpress:7.1.2-php8.3-apache'
const CLI_IMAGE = 'wordpress:cli-php8.3'
const DB_IMAGE = 'mariadb:11.4.13'

const site: SiteFacts = {
  stack: 'wordpress',
  url: 'https://shop.example.ru',
  docroot: '/var/www/html',
  extras: {},
  database: { tablePrefix: 'shop_', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' },
}
const recipe = wordpressPreviewRecipe(site)
const hostname = 'site-0f3a9c1b-chat-a1b2c3.localhost'
const origin = `http://${hostname}:8090`
const suffix = randomBytes(4).toString('hex')
const names = {
  network: `raditi-r5b-net-${suffix}`,
  volume: `raditi-r5b-docroot-${suffix}`,
  db: `raditi-r5b-db-${suffix}`,
  web: `raditi-r5b-web-${suffix}`,
}
const password = randomBytes(24).toString('base64url')
const settingsFolder = PREVIEW_SETTINGS_PATH.slice(0, PREVIEW_SETTINGS_PATH.lastIndexOf('/'))
let folder = ''

const docker = async (...args: string[]) => (await run('docker', args)).stdout

/** A command with its stdin, as `docker run -i` takes a file. */
function dockerWithInput(input: string, ...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))))
    child.stdin.end(input)
  })
}

/** WP-CLI on the preview's tree and database, as the runtime's CLI container runs it. */
const wp = (...args: string[]) =>
  docker(
    'run',
    '--rm',
    '--network',
    names.network,
    '--user',
    recipe.web.user,
    '--volume',
    `${names.volume}:${recipe.web.docroot}`,
    '--volume',
    `${folder}:${settingsFolder}:ro`,
    CLI_IMAGE,
    'wp',
    ...args,
  )

/** One request inside the web container, no redirect followed: status, headers, body. */
async function request(path: string, headers: Record<string, string> = {}) {
  const code = `$c = stream_context_create(['http' => ['ignore_errors' => true, 'follow_location' => 0,
      'header' => implode("\\r\\n", json_decode($argv[2], true))]]);
    $body = file_get_contents('http://127.0.0.1:${recipe.web.port}' . $argv[1], false, $c);
    echo json_encode(['headers' => $http_response_header, 'body' => base64_encode((string) $body)]);`
  const lines = JSON.stringify(Object.entries(headers).map(([name, value]) => `${name}: ${value}`))
  const answer = JSON.parse(await docker('exec', names.web, 'php', '-r', code, path, lines)) as {
    headers: string[]
    body: string
  }
  return {
    status: Number(answer.headers[0]?.split(' ')[1]),
    header: (name: string) =>
      answer.headers
        .filter((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
        .map((line) => line.slice(name.length + 1).trim()),
    body: Buffer.from(answer.body, 'base64').toString('utf8'),
  }
}

describe.skipIf(!enabled)('a WordPress preview as the recipe runs it', () => {
  let pageId = ''

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'raditi-r5b-'))
    const settings: PreviewSettings = previewSettingsSchema.parse({
      v: 2,
      hostname,
      origin,
      productionOrigin: site.url,
      database: {
        engine: 'mysql',
        host: 'db',
        port: 3306,
        name: 'preview',
        user: 'preview',
        password,
      },
      settings: recipe.settings,
      // A name WordPress reads as its own configuration stays in the environment only.
      env: {
        SHOP_API_KEY: 'shop-key-123456',
        WPMU_PLUGIN_DIR: '/tmp/no-mu-plugins',
        SHORTINIT: 'not-a-flag',
      },
    })
    writeFileSync(join(folder, 'settings.json'), JSON.stringify(settings))
    for (const file of recipe.web.configFiles) writeFileSync(join(folder, file.name), file.content)
    // The runtime keeps them for the PHP user alone; a bind mount of a test reads them as others.
    chmodSync(folder, 0o755)

    await docker('network', 'create', '--internal', names.network)
    await docker('volume', 'create', names.volume)
    await docker(
      'run',
      '--detach',
      '--rm',
      '--name',
      names.db,
      '--network',
      names.network,
      '--network-alias',
      'db',
      '--tmpfs',
      '/var/lib/mysql',
      '--env',
      `MARIADB_RANDOM_ROOT_PASSWORD=1`,
      '--env',
      'MARIADB_DATABASE=preview',
      '--env',
      'MARIADB_USER=preview',
      '--env',
      `MARIADB_PASSWORD=${password}`,
      DB_IMAGE,
    )
    // The tree: the core of the image, then the platform's files over it.
    await docker(
      'run',
      '--rm',
      '--network',
      'none',
      '--volume',
      `${names.volume}:/var/www/html`,
      '--entrypoint',
      'sh',
      WEB_IMAGE,
      '-c',
      'cp -a /usr/src/wordpress/. /var/www/html/ && mkdir -p /var/www/html/wp-content/mu-plugins && chown -R 33:33 /var/www/html',
    )
    // The platform's files as the runtime is to write them (plan 53, R5b): root's and read-only,
    // in folders of root with the sticky bit, where the PHP user keeps the site's own files.
    for (const file of recipe.generatedFiles)
      await dockerWithInput(
        file.content,
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '--user',
        '0:0',
        '--volume',
        `${names.volume}:/var/www/html`,
        '--entrypoint',
        'sh',
        WEB_IMAGE,
        '-c',
        `cat > /var/www/html/${file.path}`,
      )
    const generated = recipe.generatedFiles.map((file) => `/var/www/html/${file.path}`)
    const folders = ['/var/www/html', '/var/www/html/wp-content/mu-plugins']
    const group = recipe.web.user.split(':')[1]!
    await docker(
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '0:0',
      '--volume',
      `${names.volume}:/var/www/html`,
      '--entrypoint',
      'sh',
      WEB_IMAGE,
      '-c',
      `chown 0:0 ${generated.join(' ')} && chmod 0444 ${generated.join(' ')} && chown 0:${group} ${folders.join(' ')} && chmod 1775 ${folders.join(' ')}`,
    )
    // A page that loads WordPress and answers with the addresses of production in its headers.
    await dockerWithInput(
      `<?php require __DIR__ . '/wp-load.php';
      if (($_GET['to'] ?? '') === 'wp') { wp_redirect('https://shop.example.ru/target/'); exit; }
      header('Location: https://shop.example.ru/header/', true, 302);
      header('Link: <https://shop.example.ru/next/>; rel="next"', false);
      exit;`,
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '--user',
      recipe.web.user,
      '--volume',
      `${names.volume}:/var/www/html`,
      '--entrypoint',
      'sh',
      WEB_IMAGE,
      '-c',
      'cat > /var/www/html/redirect-test.php',
    )

    for (let attempt = 0; ; attempt += 1) {
      try {
        await wp('db', 'check', '--quiet')
        break
      } catch (error) {
        if (attempt > 60) throw error
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
    await wp(
      'core',
      'install',
      `--url=${origin}`,
      '--title=Превью',
      '--admin_user=admin',
      `--admin_password=${randomBytes(12).toString('hex')}`,
      '--admin_email=admin@preview.invalid',
      '--skip-email',
    )
    pageId = (
      await wp(
        'post',
        'create',
        '--post_type=page',
        '--post_status=publish',
        '--post_title=Главная',
        '--post_name=glavnaya',
        '--post_content=<a href="https://shop.example.ru/about/">О нас</a> <img src="https://shop.example.ru/wp-content/uploads/a.jpg"> <a href="https://shop.example.ru.evil.ru/x">чужой</a> <a href="https://WWW.shop.example.ru/contacts/">www</a> <a href="https://old.example.ru/legacy/">прежний адрес</a>',
        '--porcelain',
      )
    ).trim()

    await docker(
      'run',
      '--detach',
      '--rm',
      '--name',
      names.web,
      '--network',
      names.network,
      '--user',
      recipe.web.user,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      ...recipe.web.tmpfs.flatMap((path) => ['--tmpfs', path]),
      ...Object.entries(recipe.web.env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
      '--volume',
      `${names.volume}:${recipe.web.docroot}`,
      '--volume',
      `${folder}:${settingsFolder}:ro`,
      '--entrypoint',
      recipe.web.command[0]!,
      WEB_IMAGE,
      ...recipe.web.command.slice(1),
    )
    for (let attempt = 0; ; attempt += 1) {
      try {
        await request('/wp-includes/images/blank.gif')
        break
      } catch (error) {
        if (attempt > 30) throw error
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }, 240_000)

  afterAll(async () => {
    for (const container of [names.web, names.db])
      await docker('rm', '--force', container).catch(() => '')
    await docker('volume', 'rm', '--force', names.volume).catch(() => '')
    await docker('network', 'rm', names.network).catch(() => '')
    if (folder) rmSync(folder, { recursive: true, force: true })
  }, 60_000)

  it('serves the page with the preview address where the database keeps production', async () => {
    const page = await request(`/?page_id=${pageId}`)
    expect(page.status).toBe(200)
    expect(page.body).toContain(`href="${origin}/about/"`)
    expect(page.body).toContain(`src="${origin}/wp-content/uploads/a.jpg"`)
    // The other spelling of the same host too, in any letter case.
    expect(page.body).toContain(`href="${origin}/contacts/"`)
    // Only the whole host: another domain that starts like it stays.
    expect(page.body).toContain('https://shop.example.ru.evil.ru/x')
    expect(page.body).not.toMatch(/https:\/\/shop\.example\.ru(?!\.evil)/)
    expect(page.body).toContain('noindex')
    // Pretty permalinks go through the rules of the configuration, no .htaccess.
    await wp('rewrite', 'structure', '/%postname%/')
    const pretty = await request('/glavnaya/')
    expect(pretty.status).toBe(200)
    expect(pretty.body).toContain(`href="${origin}/about/"`)
  })

  it('answers with its own address where the copied database keeps another of the site', async () => {
    // The `home` and `siteurl` of the seed are production's, which may be an older address.
    const raw = (value: string) =>
      wp(
        'eval',
        `global $wpdb; foreach (array('home', 'siteurl') as $name) { $wpdb->update($wpdb->options, array('option_value' => '${value}'), array('option_name' => $name)); }`,
      )
    await raw('https://old.example.ru')
    try {
      // Pretty permalinks are on since the first case.
      const page = await request('/glavnaya/')
      expect(page.status).toBe(200)
      expect(page.body).toContain(`href="${origin}/legacy/"`)
      expect(page.body).toContain(`href="${origin}/about/"`)
      expect(page.body).not.toContain('old.example.ru')
    } finally {
      await raw(origin)
    }
  })

  it('answers JSON of the public API with the preview address', async () => {
    const json = await request(`/?rest_route=/wp/v2/pages/${pageId}`)
    expect(json.status).toBe(200)
    expect(json.body).toContain(`${origin.replaceAll('/', '\\/')}\\/about\\/`)
    expect(json.body).not.toContain('https:\\/\\/shop.example.ru\\/about')
  })

  it('keeps the text of the routes of the platform as the database holds it', async () => {
    // The binding and the application password core sets up when it builds a preview (Р24).
    const previewId = '0196abcd-0000-7000-8000-00000000000a'
    await wp('option', 'update', 'raditi_content_site_id', previewId)
    const secret = (
      await wp('user', 'application-password', 'create', 'admin', 'raditi', '--porcelain')
    ).trim()
    const content = await request(`/?rest_route=/raditi/v1/content/${pageId}`, {
      Authorization: `Basic ${Buffer.from(`admin:${secret}`).toString('base64')}`,
      'X-Raditi-Site': previewId,
    })
    expect(content.status).toBe(200)
    const state = JSON.parse(content.body) as { content?: string; stateHash?: string }
    expect(state.content).toContain('href="https://shop.example.ru/about/"')
    expect(state.stateHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('redirects to the preview, whoever sets the header', async () => {
    const header = await request('/redirect-test.php')
    expect(header.status).toBe(302)
    expect(header.header('location')).toEqual([`${origin}/header/`])
    expect(header.header('link')).toContain(`<${origin}/next/>; rel="next"`)
    const redirect = await request('/redirect-test.php?to=wp')
    expect(redirect.header('location')).toEqual([`${origin}/target/`])
  })

  it('sends no mail, runs no cron, leaves the way out to the rules of its bridge', async () => {
    const check = await wp(
      'eval',
      `echo json_encode([
        'mail' => wp_mail('someone@example.com', 'Тема', 'Текст'),
        'cron' => wp_get_ready_cron_jobs(),
        'cronDisabled' => DISABLE_WP_CRON,
        'blockExternal' => defined('WP_HTTP_BLOCK_EXTERNAL'),
        'proxy' => defined('WP_PROXY_HOST'),
        'httpFilter' => has_filter('pre_http_request'),
        'environment' => wp_get_environment_type(),
        'fileMods' => DISALLOW_FILE_MODS,
        'home' => home_url('/'),
        'prefix' => $GLOBALS['table_prefix'],
        'charset' => DB_CHARSET,
        'variable' => SHOP_API_KEY . '|' . getenv('SHOP_API_KEY'),
        'reserved' => array(WPMU_PLUGIN_DIR, getenv('WPMU_PLUGIN_DIR'), SHORTINIT, getenv('SHORTINIT')),
      ]);`,
    )
    expect(JSON.parse(check)).toEqual({
      mail: false,
      cron: [],
      cronDisabled: true,
      // The internet of a preview is open (owner's answer of 26.10.2026, docs/plan/58).
      blockExternal: false,
      proxy: false,
      httpFilter: false,
      environment: 'staging',
      fileMods: true,
      home: `${origin}/`,
      prefix: 'shop_',
      charset: 'utf8mb4',
      variable: 'shop-key-123456|shop-key-123456',
      reserved: [
        `${recipe.web.docroot}/wp-content/mu-plugins`,
        '/tmp/no-mu-plugins',
        false,
        'not-a-flag',
      ],
    })
  })

  it('keeps the platform files away from the PHP of the site, and the site its own files', async () => {
    const check = await wp(
      'eval',
      `$result = array();
      foreach (${JSON.stringify(recipe.generatedFiles.map((file) => file.path))} as $path) {
        $file = ABSPATH . $path;
        $result[$path] = array(
          'write' => @file_put_contents($file, 'x', FILE_APPEND) !== false,
          'chmod' => @chmod($file, 0666),
          'rename' => @rename($file, $file . '.moved'),
          'unlink' => @unlink($file),
          'intact' => md5_file($file),
        );
      }
      $own = WPMU_PLUGIN_DIR . '/site-own.php';
      $result['own'] = @file_put_contents($own, '<?php') !== false && @unlink($own);
      echo json_encode($result);`,
    )
    const md5 = (text: string) => createHash('md5').update(text).digest('hex')
    expect(JSON.parse(check)).toEqual({
      ...Object.fromEntries(
        recipe.generatedFiles.map((file) => [
          file.path,
          { write: false, chmod: false, rename: false, unlink: false, intact: md5(file.content) },
        ]),
      ),
      own: true,
    })
  })

  it('says the preview is not ready while it has no settings', async () => {
    const result = await run('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '--volume',
      `${names.volume}:/var/www/html:ro`,
      '--entrypoint',
      'php',
      WEB_IMAGE,
      '/var/www/html/wp-config.php',
    ]).catch((error: { code?: number; stdout?: string }) => error)
    expect(result).toMatchObject({ code: 1 })
    expect((result as { stdout?: string }).stdout).toContain('Предпросмотр ещё не готов')
  })
})
