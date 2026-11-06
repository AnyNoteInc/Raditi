// The row `wordpress` of verify:site-images (docs/plan/62, Э1.2, Т22): a real WordPress on the
// image of every PHP version its recipe runs on. The core is read from /usr/src/wordpress of the
// pinned image `wordpress` on each run and goes nowhere but into the preview; the files of the
// platform, the configuration of Apache and the account of the platform are the recipe's own
// (packages/site-adapters/src/wordpress-preview.ts). Its control: the same tree without the
// recipe's wp-config.php does not answer 200.
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'

import {
  wordpressPhpVersions,
  wordpressPreviewRecipe,
} from '../../../packages/site-adapters/src/wordpress-preview.ts'

/** wordpress:7.1.2-php8.3-apache, the base of the `site` image until Э1.5 (infra/preview/Dockerfile). */
export const WORDPRESS_IMAGE =
  'wordpress@sha256:8ae73d594a154e30b112e8d085afbc0895acf7651d8f53ef63aefb42e30822d5'

export const name = 'wordpress'

/** What the recipe's wp-config.php says on every page it served (`ready` of the recipe, Э1.6). */
export const PREVIEW_HEADER = 'x-raditi-preview'

/** The versions of PHP the recipe runs on: the row is there only on them. */
export const versions = () => wordpressPhpVersions(undefined)

/** The recipe of a synthetic site, on one version of PHP. */
export function recipe(php) {
  const facts = {
    stack: 'wordpress',
    url: 'https://shop.example.ru',
    docroot: '/',
    database: { tablePrefix: 'wp_', charset: 'utf8mb4', collation: null },
    extras: {},
  }
  return { ...wordpressPreviewRecipe(facts), runtimeVersions: [php] }
}

/** What `php -m` of that image holds on PHP 8.3 (a measure of it): the new image keeps all of it. */
export const oldModules = {
  php: '8.3',
  names: [
    'bcmath',
    'Core',
    'ctype',
    'curl',
    'date',
    'dom',
    'exif',
    'fileinfo',
    'filter',
    'gd',
    'hash',
    'iconv',
    'imagick',
    'intl',
    'json',
    'libxml',
    'mbstring',
    'mysqli',
    'mysqlnd',
    'openssl',
    'pcre',
    'PDO',
    'pdo_sqlite',
    'Phar',
    'posix',
    'random',
    'readline',
    'Reflection',
    'session',
    'SimpleXML',
    'sodium',
    'SPL',
    'sqlite3',
    'standard',
    'tokenizer',
    'xml',
    'xmlreader',
    'xmlwriter',
    'Zend OPcache',
    'zip',
    'zlib',
  ],
}

/** The image the tree of the core is read from, and the tar of it `docker run` prints. */
export const treeImage = WORDPRESS_IMAGE
export const treeArchiveArgv = [
  'run',
  '--rm',
  '--network',
  'none',
  '--entrypoint',
  'tar',
  WORDPRESS_IMAGE,
  '-C',
  '/usr/src/wordpress',
  '-cf',
  '-',
  '.',
]

/**
 * The preview is up (`ensure` answered) with an empty tree. `stand` gives what the row needs:
 * `write(input)`, `loadSeed()`, `exec(argv, ms)` and `http(path)` of this preview, `tree` — the tar
 * of the core — and the recipe. A failure is a sentence of what did not happen.
 */
export async function check(stand) {
  const recipeOf = stand.recipe
  // The row proves on every version that a live page comes from the recipe's wp-config.php
  // (Э1.6): a recipe without `ready`, or with another header, proves nothing — the row fails.
  if (recipeOf.ready?.header !== PREVIEW_HEADER)
    return { ok: false, detail: `the recipe's ready names no ${PREVIEW_HEADER}` }
  await stand.write({ archive: [stand.tree], deletes: [], replace: true })
  const bare = await stand.http('/')
  if (bare.status === 200) return { ok: false, detail: 'control: / is 200 without wp-config.php' }
  await stand.write({
    archive: [Buffer.alloc(1024)],
    deletes: [],
    replace: false,
    platform: recipeOf.generatedFiles,
  })
  await stand.loadSeed()
  const install = await stand.exec(
    [
      'wp',
      'core',
      'install',
      `--url=${stand.origin}`,
      '--title=Stand',
      '--admin_user=stand',
      `--admin_password=${randomBytes(18).toString('base64url')}`,
      '--admin_email=stand@preview.invalid',
      '--skip-email',
    ],
    120_000,
  )
  if (install.code !== 0) return { ok: false, detail: `wp core install: exit ${install.code}` }
  // Pretty permalinks, as a real site has them: /wp-json/ then goes through the rules of the
  // recipe's Apache configuration, not through a redirect of plain links.
  const links = await stand.exec(['wp', 'rewrite', 'structure', '/%postname%/'], 60_000)
  if (links.code !== 0) return { ok: false, detail: `wp rewrite structure: exit ${links.code}` }
  const access = await stand.exec(recipeOf.content.access, 120_000)
  if (access.code !== 0) return { ok: false, detail: `content.access: exit ${access.code}` }
  if (!/"applicationPassword"/.test(access.stdout))
    return { ok: false, detail: 'content.access printed no account' }
  for (const path of ['/', '/wp-login.php']) {
    const page = await stand.http(path)
    if (page.status !== 200) return { ok: false, detail: `${path}: ${page.status}` }
    if (!page.headers.has(PREVIEW_HEADER))
      return { ok: false, detail: `${path}: no ${PREVIEW_HEADER}` }
  }
  const api = await stand.http('/wp-json/raditi/v1/capabilities')
  // The route of the plugin answers itself — 401 without an account — not a redirect.
  if (
    api.status < 200 ||
    api.status >= 500 ||
    api.status === 404 ||
    (api.status >= 300 && api.status < 400)
  )
    return { ok: false, detail: `/wp-json/raditi/v1/capabilities: ${api.status}` }
  return {
    ok: true,
    detail: `control ${bare.status}; / and /wp-login.php 200 with ${PREVIEW_HEADER}; capabilities ${api.status}`,
  }
}
