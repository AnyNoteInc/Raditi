// The `site` images of every PHP version, checked from outside by the real preview runtime
// (docs/plan/62, Э1.2, М1): each row of infra/preview/site-bases.json is built as the target
// `site` on the stage `php-base`, started by createDockerPreviewRuntime with a recipe that uses
// the shared files of a stack's recipe (infra/preview/site-apache.conf and prologue.php), and
// probed from inside its container: `php -m` against the base's modules plus the list, init.sh,
// the database, the rules of the recipe, /server-status closed, an ini of the stack under Apache
// and through run-as.sh, mail that goes nowhere, OPcache, ionCube, IPC, images, WP-CLI, the uid.
// Then the rows of each stack's own file (site-<stack>.mjs) on the versions its recipe runs on.
// Requests go from inside the container to its gateway, so the stand works the same on Docker
// Desktop, in CI and from the Mac on the daemon of Colima. No .env, no push; what it built
// stays, what it started goes (`--keep` leaves it).
import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ustar } from './probes.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const preview = (name) => readFileSync(new URL(`../../preview/${name}`, import.meta.url), 'utf8')
const BASES = JSON.parse(preview('site-bases.json')).versions

/** Nine names no version goes without (Т21). */
export const MANDATORY = [
  'bcmath',
  'exif',
  'gd',
  'imagick',
  'intl',
  'mysqli',
  'opcache',
  'pdo_mysql',
  'zip',
]
/** The 26 names of the installer, in the order of infra/preview/Dockerfile. */
export const EXTENSIONS = [
  'apcu',
  'bcmath',
  'bz2',
  'calendar',
  'exif',
  'gd',
  'gettext',
  'gmp',
  'imagick',
  'intl',
  'ldap',
  'mcrypt',
  'memcached',
  'mysqli',
  'opcache',
  'pdo_mysql',
  'redis',
  'shmop',
  'soap',
  'sockets',
  'sysvmsg',
  'sysvsem',
  'sysvshm',
  'xmlrpc',
  'xsl',
  'zip',
]
/** Modules an extension of the list pulls in: empty unless a build proves otherwise. */
export const PULLED_IN = []
/** `php -m` names an extension otherwise than the installer does. */
const MODULE_NAMES = { opcache: 'zend opcache' }
/** The stacks with rows of their own: `site-<stack>.mjs` next to this file. */
export const STACKS = readdirSync(new URL('./', import.meta.url))
  .filter((name) => /^site-[a-z0-9]+\.mjs$/.test(name))
  .sort()
  .map((name) => `./${name}`)

/** `php -m`: the names of [PHP Modules], lower case. */
export function parsePhpModules(text) {
  const names = []
  let inside = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inside = line === '[PHP Modules]'
      continue
    }
    if (inside && line !== '') names.push(line.toLowerCase())
  }
  return names
}

/** What `php -m` of the built image holds: the base's, the list without `without`, PULLED_IN. No ionCube. */
export function expectedModules(row, baseModules) {
  const names = new Set(baseModules.filter((name) => !name.includes('ioncube')))
  for (const name of EXTENSIONS)
    if (!row.without.includes(name)) names.add(MODULE_NAMES[name] ?? name)
  for (const name of PULLED_IN) names.add(name)
  return [...names].sort()
}

/** The arguments of `docker build`: PHP_PECL_PINS always, PHP_EXTENSIONS_SKIP only when `without` is not empty. */
export function siteImageBuildArgs(row) {
  return [
    '--build-arg',
    'BASE=php-base',
    '--build-arg',
    `PHP_BASE=${row.image}`,
    '--build-arg',
    `PHP_PECL_PINS=${row.pecl.join(' ')}`,
    ...(row.without.length ? ['--build-arg', `PHP_EXTENSIONS_SKIP=${row.without.join(' ')}`] : []),
  ]
}

const USAGE =
  'pnpm verify:site-images [-- --only 7.4,8.3] [--image=<image>] [--no-build] [--build-only] [--keep] [--runtime=runsc]'
const refuse = (why) => {
  throw new Error(`verify:site-images: ${why}. Usage: ${USAGE}`)
}

export function siteImagesOptions(argv) {
  const known = BASES.map((row) => row.php)
  const options = {
    versions: known,
    image: null,
    build: true,
    buildOnly: false,
    keep: false,
    runtime: 'runc',
  }
  let only = null
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--only' || arg.startsWith('--only=')) {
      only = arg === '--only' ? argv[++index] : arg.slice('--only='.length)
      if (!only) refuse('--only needs versions')
      const wanted = only.split(',')
      for (const version of wanted)
        if (!known.includes(version)) refuse(`no version ${version} in site-bases.json`)
      options.versions = known.filter((version) => wanted.includes(version))
    } else if (arg.startsWith('--image=')) {
      options.image = arg.slice('--image='.length)
      if (!options.image) refuse('--image needs an image')
    } else if (arg === '--no-build') options.build = false
    else if (arg === '--build-only') options.buildOnly = true
    else if (arg === '--keep') options.keep = true
    else if (arg === '--runtime=runc' || arg === '--runtime=runsc')
      options.runtime = arg.slice('--runtime='.length)
    else refuse(`unknown argument ${arg}`)
  }
  if (options.image !== null) {
    if (only === null || options.versions.length !== 1)
      refuse('--image takes the image of one version: name it with --only')
    if (options.buildOnly) refuse('--image builds no image of a version')
  }
  return options
}

// --- Docker ---------------------------------------------------------------------------------

const dockerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => ['PATH', 'HOME'].includes(name) || name.startsWith('DOCKER_'),
  ),
)
let stage = 'preflight'

/** Docker CLI with a private output; a failure names the stage, never arguments or output. */
function docker(argv, { allowFailure = false, timeoutMs = 120_000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', argv, { env: dockerEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.resume()
    child.once('error', () => reject(new Error(`Docker could not start during ${stage}`)))
    child.once('close', (code) => {
      clearTimeout(timer)
      const bytes = Buffer.concat(out)
      if (code !== 0 && !allowFailure)
        reject(new Error(`Docker command failed during ${stage} (exit ${code ?? 'killed'})`))
      else resolve({ code, stdout: binary ? bytes : bytes.toString('utf8').trim() })
    })
  })
}

/** The digest of a local tag; only the image store of containerd gives one to a local build. */
async function digestOf(tag) {
  const { stdout } = await docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', tag])
  const [digest] = JSON.parse(stdout) ?? []
  if (!digest)
    throw new Error(
      `${tag} has no digest: a local build gets one only in the image store of containerd (Docker Desktop by default, on Linux "features": {"containerd-snapshotter": true})`,
    )
  return digest
}

async function buildImage({ dockerfile, target, context, tag, buildArgs = [], timeoutMs }) {
  await docker(
    ['build', '-q', '-f', dockerfile, '--target', target, ...buildArgs, '-t', tag, context],
    { timeoutMs },
  ).catch(() => {
    throw new Error(`docker build of ${tag} failed (run from ${repository})`)
  })
}

/** The tools and the rules of the host, as verify-preview-network.mjs builds them, under tags of this stand. */
async function platformImages(options) {
  const tools = 'raditi-site-verify-tools:local'
  const guard = 'raditi-site-verify-guard:local'
  if (options.build) {
    stage = 'tools image'
    await buildImage({
      dockerfile: 'infra/preview/Dockerfile',
      target: 'tools',
      context: 'infra/preview',
      tag: tools,
      timeoutMs: 900_000,
    })
    if (!process.env.SANDBOX_NETWORK_GUARD_IMAGE) {
      stage = 'network guard image'
      await buildImage({
        dockerfile: 'infra/sandbox/Dockerfile',
        target: 'network-guard',
        context: '.',
        tag: guard,
        timeoutMs: 900_000,
      })
    }
  }
  return {
    tools: await digestOf(tools),
    guard: process.env.SANDBOX_NETWORK_GUARD_IMAGE ?? (await digestOf(guard)),
  }
}

async function siteImage(row, options) {
  if (options.image)
    return /@sha256:[0-9a-f]{64}$/.test(options.image) ? options.image : digestOf(options.image)
  const tag = `raditi-site-verify:${row.php}`
  if (options.build) {
    stage = `build ${row.php}`
    const started = Date.now()
    await buildImage({
      dockerfile: 'infra/preview/Dockerfile',
      target: 'site',
      context: 'infra/preview',
      tag,
      buildArgs: siteImageBuildArgs(row),
      timeoutMs: 30 * 60_000,
    })
    console.log(`built ${tag} in ${Math.round((Date.now() - started) / 1000)} s`)
  }
  return digestOf(tag)
}

// --- The preview ----------------------------------------------------------------------------

const RULES = '    RewriteEngine On\n    RewriteRule ^stand/rule$ index.php?q=rule [L,QSA]'
const PROLOGUE = "<?php require '/run/raditi/preview/prologue.php';\n"
const STACK_INI = 'max_input_vars = 4321\n'

/** The recipe of this stand: the shared files of a recipe, an ini of its own. */
function standRecipe(php) {
  return {
    runtime: 'php',
    runtimeVersions: [php],
    database: 'mysql',
    requiredPaths: [],
    generatedFiles: [],
    settings: {},
    healthPath: '/',
    web: {
      command: ['apache2-foreground', '-f', '/run/raditi/preview/apache2.conf'],
      env: {
        APACHE_RUN_DIR: '/tmp/apache2/run',
        APACHE_LOCK_DIR: '/tmp/apache2/lock',
        APACHE_PID_FILE: '/tmp/apache2/run/apache2.pid',
        PHP_INI_SCAN_DIR: ':/run/raditi/preview',
      },
      port: 8081,
      user: '33:33',
      docroot: '/var/www/html',
      tmpfs: ['/tmp'],
      configFiles: [
        {
          name: 'apache2.conf',
          content: preview('site-apache.conf').replace('    # RADITI_SITE_RULES', RULES),
        },
        { name: 'prologue.php', content: preview('prologue.php') },
        { name: 'raditi-stack.ini', content: STACK_INI },
      ],
    },
  }
}

function specOf(images, recipe, runtime) {
  const hostname = `site-${randomBytes(4).toString('hex')}-chat-${randomBytes(3).toString('hex')}.localhost`
  return {
    previewId: randomUUID(),
    siteId: randomUUID(),
    taskId: randomUUID(),
    runtime,
    images,
    database: true,
    recipe,
    limits: { cpu: 2, memoryMiB: 2048, pids: 512 },
    upstreamHost: '127.0.0.1',
    hostname,
    origin: `http://${hostname}:8090`,
    productionOrigin: 'https://shop.example.ru',
    expiresAt: Date.now() + 60 * 60_000,
  }
}

/** A GET to the preview's own gateway from inside its container: status, headers, body. */
const HTTP_PHP = [
  '$c = stream_context_create(["http" => ["method" => "GET", "header" => "Host: " . $argv[1] . "\\r\\n",',
  '"ignore_errors" => true, "follow_location" => 0, "timeout" => 30]]);',
  '$b = @file_get_contents("http://127.0.0.1:8080" . $argv[2], false, $c);',
  '$h = function_exists("http_get_last_response_headers") ? http_get_last_response_headers() : $http_response_header;',
  '$h = is_array($h) ? $h : [];',
  '$s = isset($h[0]) && preg_match("#^HTTP/\\\\S+ (\\\\d{3})#", $h[0], $m) ? (int) $m[1] : 0;',
  'echo json_encode(["status" => $s, "headers" => $h, "body" => base64_encode($b === false ? "" : $b)]);',
].join(' ')

/** The checks under Apache, as JSON; the password of the database from the settings file. */
const PROBE_PHP = `<?php
require '/run/raditi/preview/prologue.php';
$s = json_decode(file_get_contents('/run/raditi/preview/settings.json'), true);
$d = $s['database'];
$r = ['sapi' => PHP_SAPI];
$r['server'] = ['host' => $_SERVER['HTTP_HOST'] ?? null, 'name' => $_SERVER['SERVER_NAME'] ?? null,
    'https' => isset($_SERVER['HTTPS'])];
try {
    $m = new mysqli($d['host'], $d['user'], $d['password'], $d['name'], $d['port']);
    $r['mysqli'] = $m->query('SELECT VERSION()')->fetch_row()[0];
} catch (Throwable $e) { $r['mysqli'] = 'error'; }
try {
    $p = new PDO('mysql:host=' . $d['host'] . ';port=' . $d['port'] . ';dbname=' . $d['name'], $d['user'], $d['password']);
    $r['pdo'] = $p->query('SELECT VERSION()')->fetchColumn();
} catch (Throwable $e) { $r['pdo'] = 'error'; }
$r['max_input_vars'] = ini_get('max_input_vars');
$r['display_errors'] = ini_get('display_errors');
$r['mail'] = mail('nobody@preview.invalid', 's', 'b');
$o = function_exists('opcache_get_status') ? opcache_get_status(false) : false;
$r['opcache'] = is_array($o) && $o['opcache_enabled'] === true;
$r['revalidate_freq'] = ini_get('opcache.revalidate_freq');
$k = ftok(__FILE__, 'r');
$ipc = [];
$sem = @sem_get($k, 1, 0600, 1);
$ipc['sem'] = $sem && sem_acquire($sem) && sem_release($sem);
$shm = @shm_attach($k + 1, 4096, 0600);
$ipc['shm'] = $shm && shm_put_var($shm, 1, 'v') && shm_get_var($shm, 1) === 'v';
if ($shm) { shm_remove($shm); }
$op = @shmop_open($k + 2, 'c', 0600, 64);
$ipc['shmop'] = $op && shmop_write($op, 'v', 0) === 1 && shmop_read($op, 0, 1) === 'v';
if ($op) { shmop_delete($op); }
$q = @msg_get_queue($k + 3, 0600);
$ipc['msg'] = $q && msg_send($q, 1, 'v') && msg_receive($q, 1, $type, 64, $message) && $message === 'v';
if ($q) { msg_remove_queue($q); }
foreach (['/tmp', '/var/www/html'] as $folder) {
    $f = @fopen($folder . '/raditi-stand.lock', 'c');
    $ipc['flock ' . $folder] = $f && flock($f, LOCK_EX) && flock($f, LOCK_UN);
    if ($f) { fclose($f); @unlink($folder . '/raditi-stand.lock'); }
}
$r['ipc'] = $ipc;
$png = "\\x89PNG";
$g = imagecreatetruecolor(2, 2);
ob_start();
imagepng($g);
$r['gd_png'] = strpos(ob_get_clean(), $png) === 0;
$i = gd_info();
$r['gd'] = ['freetype' => !empty($i['FreeType Support']), 'jpeg' => !empty($i['JPEG Support']),
    'webp' => !empty($i['WebP Support']), 'avif' => !empty($i['AVIF Support'])];
try {
    $im = new Imagick();
    $im->newImage(2, 2, 'white');
    $im->setImageFormat('png');
    $r['imagick_png'] = strpos($im->getImageBlob(), $png) === 0;
} catch (Throwable $e) { $r['imagick_png'] = false; }
echo json_encode($r);
`

/**
 * The prologue in the CLI on settings of its own: the file as the recipe wrote it, with the path
 * of the settings replaced by a file of this run under /tmp. Prints what the request looks like
 * after it; a refusal exits on its own.
 */
const PROLOGUE_CASE_PHP = [
  '$p = "/tmp/raditi-prologue-" . getmypid();',
  'register_shutdown_function(function () use ($p) { @unlink($p . ".json"); @unlink($p . ".php"); });',
  'if ($argv[1] !== "") { file_put_contents($p . ".json", $argv[1]); }',
  'file_put_contents($p . ".php", str_replace("\'/run/raditi/preview/settings.json\'", var_export($p . ".json", true),',
  'file_get_contents("/run/raditi/preview/prologue.php")));',
  '$_SERVER["HTTP_HOST"] = "stand.invalid"; $_SERVER["SERVER_NAME"] = "stand.invalid";',
  'if ($argv[2] === "https") { $_SERVER["HTTPS"] = "on"; } else { unset($_SERVER["HTTPS"]); }',
  'require $p . ".php";',
  'echo json_encode(["host" => $_SERVER["HTTP_HOST"], "name" => $_SERVER["SERVER_NAME"],',
  '"https" => $_SERVER["HTTPS"] ?? null, "port" => $_SERVER["SERVER_PORT"] ?? null]);',
].join(' ')
const settingsOf = (v, origin) =>
  JSON.stringify({ v, origin, productionOrigin: 'https://shop.example.ru' })
/** Each case: the settings (empty — no file), what HTTPS was before, what the prologue must do. */
const PROLOGUE_CASES = [
  { name: 'no settings', settings: '', before: 'http', refused: true },
  {
    name: 'version 1',
    settings: settingsOf(1, 'http://p.stand.invalid:8090'),
    before: 'http',
    refused: true,
  },
  {
    name: 'https with a port',
    settings: settingsOf(2, 'https://p.stand.invalid:8443'),
    before: 'http',
    want: { host: 'p.stand.invalid:8443', name: 'p.stand.invalid', https: 'on', port: '8443' },
  },
  {
    name: 'https',
    settings: settingsOf(2, 'https://p.stand.invalid'),
    before: 'http',
    want: { host: 'p.stand.invalid', name: 'p.stand.invalid', https: 'on', port: '443' },
  },
  {
    name: 'http',
    settings: settingsOf(2, 'http://p.stand.invalid:8090'),
    before: 'https',
    want: { host: 'p.stand.invalid:8090', name: 'p.stand.invalid', https: null, port: null },
  },
]

/** An error of a page must never reach the page (preview-php.ini). */
const ERRORS_PHP = `${PROLOGUE}echo 'errors-page ';
echo file_get_contents('/raditi-no-such-file');
echo 'done';
`
const INDEX_PHP = `${PROLOGUE}echo $_GET['q'] ?? 'home';\n`

/** The handle of one preview the checks use. */
function previewHandle(runtime, spec) {
  const exec = async (argv, timeoutMs = 60_000) => {
    const outcome = await runtime.exec(spec.previewId, { argv, timeoutMs })
    return {
      code: outcome.code,
      stdout: Buffer.from(outcome.stdout).toString('utf8').trim(),
      stderr: Buffer.from(outcome.stderr).toString('utf8').trim(),
    }
  }
  const http = async (path) => {
    const outcome = await exec(['php', '-r', HTTP_PHP, '--', spec.hostname, path])
    if (outcome.code !== 0) return { status: 0, headers: new Map(), body: '' }
    const answer = JSON.parse(outcome.stdout)
    const headers = new Map()
    for (const line of answer.headers.slice(1)) {
      const at = line.indexOf(':')
      if (at > 0) headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim())
    }
    return {
      status: answer.status,
      headers,
      body: Buffer.from(answer.body, 'base64').toString('utf8'),
    }
  }
  return { exec, http, spec }
}

const passwordsOf = () => ({
  user: randomBytes(24).toString('base64url'),
  root: randomBytes(24).toString('base64url'),
})

/** `docker run` of an image as it is: for the base and for what the image itself holds. */
const plainRun = (runtime, argv) =>
  docker(['run', '--rm', '--network', 'none', '--runtime', runtime, ...argv], {
    allowFailure: true,
    timeoutMs: 120_000,
  })

// --- The rows -------------------------------------------------------------------------------

/**
 * Every row of one version: a name, whether it passed, what was seen, pushed to `rows` as it
 * goes. A step outside a row that throws leaves the rows so far; the caller adds a failed row.
 */
async function checkVersion(row, image, context, rows) {
  const { runtime, options, images } = context
  const add = (name, ok, detail = '') => rows.push({ php: row.php, name, ok, detail })
  const attempt = async (name, body) => {
    try {
      const outcome = await body()
      add(name, outcome.ok, outcome.detail)
    } catch (error) {
      add(name, false, error.message)
    }
  }

  stage = `${row.php}: base`
  const baseModules = await plainRun(options.runtime, ['--entrypoint', 'php', row.image, '-m'])
  const baseMail = await plainRun(options.runtime, [
    '--entrypoint',
    'php',
    row.image,
    '-d',
    'display_errors=stderr',
    '-r',
    "var_export(mail('nobody@preview.invalid', 's', 'b'));",
  ])

  stage = `${row.php}: preview`
  const spec = specOf(
    { preview: image, tools: images.tools },
    standRecipe(row.php),
    options.runtime,
  )
  const handle = previewHandle(runtime, spec)
  const { exec, http } = handle
  try {
    try {
      await runtime.ensure(spec, { env: {}, database: passwordsOf() })
      add('started', true, 'ensure answered: init.sh started the database, PHP and the gateway')
    } catch (error) {
      add('started', false, error.message)
      return
    }
    await runtime.writeFiles(spec.previewId, {
      archive: [
        ustar([
          { path: 'index.php', content: INDEX_PHP },
          { path: 'probe.php', content: PROBE_PHP },
          { path: 'errors.php', content: ERRORS_PHP },
        ]),
      ],
      deletes: [],
      replace: true,
    })

    stage = `${row.php}: rows`
    await attempt('base', async () => {
      const release = await exec(['cat', '/etc/os-release'])
      const codename = /^VERSION_CODENAME=(.*)$/m.exec(release.stdout)?.[1]
      const version = await exec(['php', '-r', 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;'])
      return {
        ok: codename === row.debian && version.stdout === row.php,
        detail: `${codename} ${version.stdout}`,
      }
    })
    const modules = await exec(['php', '-m'])
    const built = parsePhpModules(modules.stdout)
    await attempt('modules', async () => {
      if (baseModules.code !== 0) return { ok: false, detail: `php -m of ${row.image}: failed` }
      const actual = built.filter((name) => !name.includes('ioncube')).sort()
      const expected = expectedModules(row, parsePhpModules(baseModules.stdout))
      const extra = actual.filter((name) => !expected.includes(name))
      const missing = expected.filter((name) => !actual.includes(name))
      return {
        ok: modules.code === 0 && !extra.length && !missing.length,
        detail: `${actual.length} modules${extra.length ? `; extra: ${extra.join(' ')}` : ''}${missing.length ? `; missing: ${missing.join(' ')}` : ''}`,
      }
    })
    // What a stack's old image held, on the version it stood on: nothing of it goes.
    for (const stack of context.stacks.filter((entry) => entry.oldModules?.php === row.php))
      await attempt(`${stack.name} modules`, async () => {
        const missing = stack.oldModules.names.filter((name) => !built.includes(name.toLowerCase()))
        return {
          ok: modules.code === 0 && !missing.length,
          detail: missing.length ? `missing: ${missing.join(' ')}` : 'all of the old image',
        }
      })
    const probe = await http('/probe.php')
    const probed = probe.status === 200 ? JSON.parse(probe.body) : null
    await attempt('database', async () => ({
      ok:
        !!probed &&
        String(probed.mysqli).startsWith('11.8.9-MariaDB') &&
        String(probed.pdo).startsWith('11.8.9-MariaDB'),
      detail: probed ? `mysqli ${probed.mysqli}, pdo ${probed.pdo}` : `probe ${probe.status}`,
    }))
    await attempt('page', async () => {
      const page = await http('/')
      return {
        ok:
          page.status === 200 &&
          page.body === 'home' &&
          page.headers.get('x-raditi-preview') === '1',
        detail: `${page.status} ${JSON.stringify(page.body.slice(0, 40))} x-raditi-preview=${page.headers.get('x-raditi-preview') ?? '-'}`,
      }
    })
    await attempt('prologue', async () => {
      // Under Apache: the request came with Host: <hostname>, the page sees the preview's origin.
      const origin = new URL(handle.spec.origin)
      const seen = probed?.server ?? {}
      const apache =
        seen.host === origin.host && seen.name === origin.hostname && seen.https === false
      const failed = []
      for (const item of PROLOGUE_CASES) {
        const run = await exec(['php', '-r', PROLOGUE_CASE_PHP, '--', item.settings, item.before])
        if (item.refused) {
          if (run.code !== 1 || !run.stdout.includes('Предпросмотр ещё не готов'))
            failed.push(`${item.name}: exit ${run.code}`)
          continue
        }
        let got = null
        try {
          got = run.code === 0 ? JSON.parse(run.stdout) : null
        } catch {
          got = null
        }
        if (JSON.stringify(got) !== JSON.stringify(item.want))
          failed.push(
            `${item.name}: ${run.code === 0 ? run.stdout.slice(0, 80) : `exit ${run.code}`}`,
          )
      }
      return {
        ok: apache && !failed.length,
        detail: `apache ${seen.host} ${seen.name} https ${seen.https}; cli ${failed.length ? failed.join('; ') : `${PROLOGUE_CASES.length} cases`}`,
      }
    })
    await attempt('rules', async () => {
      const rule = await http('/stand/rule')
      const nothing = await http('/nothing')
      return {
        ok: rule.status === 200 && rule.body === 'rule' && nothing.status === 404,
        detail: `/stand/rule ${rule.status} ${JSON.stringify(rule.body.slice(0, 20))}; control /nothing ${nothing.status}`,
      }
    })
    await attempt('no server status', async () => {
      const status = await http('/server-status')
      const info = await http('/server-info')
      return {
        ok: status.status !== 200 && info.status !== 200 && status.status > 0 && info.status > 0,
        detail: `/server-status ${status.status}, /server-info ${info.status}`,
      }
    })
    await attempt('stack ini', async () => {
      const cli = await exec(['php', '-r', 'echo ini_get("max_input_vars");'])
      const bare = await exec(['php', '-n', '-r', 'echo ini_get("max_input_vars");'])
      return {
        ok: probed?.max_input_vars === '4321' && cli.stdout === '4321' && bare.stdout === '1000',
        detail: `apache ${probed?.max_input_vars}, run-as ${cli.stdout}; control php -n ${bare.stdout}`,
      }
    })
    await attempt('errors', async () => {
      const page = await http('/errors.php')
      const shown = String(probed?.display_errors ?? 'missing')
      return {
        ok:
          ['', 'off'].includes(shown.toLowerCase()) &&
          page.status === 200 &&
          page.body.startsWith('errors-page ') &&
          !page.body.includes('raditi-no-such-file'),
        detail: `display_errors ${JSON.stringify(shown)}; page ${page.status} ${JSON.stringify(page.body.slice(0, 40))}`,
      }
    })
    await attempt('mail', async () => ({
      ok: probed?.mail === true && baseMail.code === 0 && baseMail.stdout === 'false',
      detail: `mail() ${probed?.mail}; control in ${row.tag}: ${baseMail.stdout || `exit ${baseMail.code}`}`,
    }))
    await attempt('opcache', async () => ({
      ok: probed?.opcache === true && probed?.revalidate_freq === '0',
      detail: `enabled ${probed?.opcache}, revalidate_freq ${probed?.revalidate_freq}`,
    }))
    await attempt('ioncube', async () => {
      const version = await exec(['php', '-v'])
      const license = await exec(['cat', '/usr/local/lib/raditi/ioncube/LICENSE.txt'])
      const folder = await exec(['test', '-e', '/usr/local/lib/raditi/ioncube'])
      // On 8.0 an answer of `php -v` itself and a real "no" of `test -e`, not a broken exec.
      if (row.php === '8.0')
        return {
          ok:
            version.code === 0 &&
            version.stdout.startsWith('PHP 8.0.') &&
            !/ionCube/.test(version.stdout) &&
            folder.code === 1,
          detail: `php -v exit ${version.code} ${JSON.stringify(version.stdout.slice(0, 12))}, without ionCube: ${!/ionCube/.test(version.stdout)}; test -e of the folder: exit ${folder.code}`,
        }
      const loader = version.stdout.indexOf('ionCube PHP Loader')
      const opcache = version.stdout.indexOf('Zend OPcache')
      return {
        ok:
          loader >= 0 &&
          (opcache < 0 || loader < opcache) &&
          license.code === 0 &&
          license.stdout.length > 0,
        detail: `loader at ${loader}, OPcache at ${opcache}; LICENSE.txt read by 33: ${license.code === 0}`,
      }
    })
    await attempt('ipc', async () => {
      const ipc = probed?.ipc ?? {}
      const failed = Object.entries(ipc)
        .filter(([, ok]) => ok !== true)
        .map(([name]) => name)
      return {
        ok: Object.keys(ipc).length === 6 && !failed.length,
        detail: failed.length ? `failed: ${failed.join(', ')}` : Object.keys(ipc).join(', '),
      }
    })
    await attempt('images', async () => {
      const gs = await exec(['gs', '--version'])
      const gd = probed?.gd ?? {}
      const avif = Number(row.php.replace('.', '')) >= 81
      return {
        ok:
          probed?.gd_png === true &&
          gd.freetype &&
          gd.jpeg &&
          gd.webp &&
          (!avif || gd.avif) &&
          probed?.imagick_png === true &&
          gs.code === 0,
        detail: `gd png ${probed?.gd_png} ${JSON.stringify(gd)}; imagick png ${probed?.imagick_png}; gs ${gs.code === 0 ? gs.stdout : `exit ${gs.code}`}`,
      }
    })
    await attempt('wp-cli', async () => {
      const wp = await exec(['wp', '--version'])
      return {
        ok: wp.code === 0 && wp.stdout === 'WP-CLI 2.12.0',
        detail: wp.stdout || `exit ${wp.code}`,
      }
    })
    await attempt('uid', async () => {
      const id = await exec(['id', '-u'])
      const entry = await exec(['getent', 'passwd', 'www-data'])
      return {
        ok: id.stdout === '33' && entry.stdout.split(':')[2] === '33',
        detail: `id -u ${id.stdout}; www-data ${entry.stdout.split(':')[2]}`,
      }
    })
    await attempt('no leftovers', async () => {
      const left = await plainRun(options.runtime, [
        '--entrypoint',
        '/bin/sh',
        image,
        '-c',
        '! command -v install-php-extensions >/dev/null && test ! -e /tmp/ioncube.tar.gz && ! grep -rqs packages.sury.org /etc/apt',
      ])
      return { ok: left.code === 0, detail: left.code === 0 ? 'none' : 'something stayed' }
    })
  } finally {
    if (!options.keep)
      await runtime
        .destroy(spec.previewId)
        .catch(() => console.error(`cleanup of ${row.php} failed`))
  }

  for (const stack of context.stacks) {
    if (!stack.versions().includes(row.php)) continue
    stage = `${row.php}: ${stack.name}`
    await attempt(stack.name, async () => {
      const recipe = stack.recipe(row.php)
      const own = specOf({ preview: image, tools: images.tools }, recipe, options.runtime)
      const passwords = passwordsOf()
      const handleOf = previewHandle(runtime, own)
      try {
        await runtime.ensure(own, { env: {}, database: passwords })
        return await stack.check({
          recipe,
          origin: own.origin,
          tree: await stack.tree(),
          write: (input) => runtime.writeFiles(own.previewId, input),
          loadSeed: () =>
            runtime.loadDatabase(
              own.previewId,
              (async function* () {
                yield Buffer.from('SELECT 1;\n')
              })(),
              passwords,
            ),
          exec: handleOf.exec,
          http: handleOf.http,
        })
      } finally {
        if (!options.keep)
          await runtime
            .destroy(own.previewId)
            .catch(() => console.error(`cleanup of ${row.php} ${stack.name} failed`))
      }
    })
  }
}

/** The rows a stack's file gives on one version of a run: its own and, on one version, `<stack> modules`. */
export function expectedStackRows(stack, php) {
  return [
    ...(stack.oldModules?.php === php ? [`${stack.name} modules`] : []),
    ...(stack.versions().includes(php) ? [stack.name] : []),
  ]
}

/** A stack's file: its name, versions, recipe and check; the tree it reads, once. */
async function loadStacks() {
  const stacks = []
  for (const path of STACKS) {
    const module = await import(path)
    let archive = null
    stacks.push({
      ...module,
      tree: async () => {
        if ((await docker(['image', 'inspect', module.treeImage], { allowFailure: true })).code)
          throw new Error(`${module.treeImage} is missing: docker pull it first (README)`)
        archive ??= (await docker(module.treeArchiveArgv, { binary: true, timeoutMs: 300_000 }))
          .stdout
        return archive
      },
    })
  }
  return stacks
}

function report(rows, options) {
  const widths = [5, Math.max(...rows.map((row) => row.name.length)), 4]
  const lines = rows.map(
    (row) =>
      `${row.php.padEnd(widths[0])}  ${row.name.padEnd(widths[1])}  ${(row.ok ? 'PASS' : 'FAIL').padEnd(widths[2])}  ${row.detail}`,
  )
  console.log(`\nsite images on ${process.platform}/${process.arch}, runtime ${options.runtime}\n`)
  console.log(lines.join('\n'))
  const failed = rows.filter((row) => !row.ok)
  console.log(
    `\n${rows.length} rows: ${rows.length - failed.length} passed, ${failed.length} failed`,
  )
  return failed.length === 0
}

async function main() {
  const options = siteImagesOptions(process.argv.slice(2))
  process.chdir(repository)
  const images = await platformImages(options)
  const built = []
  if (options.buildOnly) {
    for (const row of BASES.filter((entry) => options.versions.includes(entry.php)))
      built.push(`${row.php}=${await siteImage(row, options)}`)
    // Not the line for .env: nothing of these images was checked.
    console.log(`built, not checked: ${built.join(',')}`)
    return
  }
  stage = 'runtime'
  const { createDockerPreviewRuntime } =
    await import('../../../packages/sandbox-providers/src/preview/runtime.ts')
  const runtime = createDockerPreviewRuntime({
    runtime: options.runtime,
    socketPath: process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock',
    gatewayPort: 8090,
    firewallImage: images.guard,
    dnsServers: ['77.88.8.8', '77.88.8.1'],
  })
  const stacks = await loadStacks()
  const rows = []
  for (const row of BASES.filter((entry) => options.versions.includes(entry.php))) {
    const from = rows.length
    try {
      const image = await siteImage(row, options)
      await checkVersion(row, image, { runtime, options, images, stacks }, rows)
      if (!options.image) built.push({ php: row.php, image })
    } catch (error) {
      // The stand goes on to the next version: the rows of this one and of the others are printed.
      rows.push({ php: row.php, name: 'stand', ok: false, detail: `${stage}: ${error.message}` })
    }
    if (!rows.slice(from).some((entry) => entry.php === row.php))
      rows.push({ php: row.php, name: 'stand', ok: false, detail: 'no row' })
  }
  for (const stack of stacks)
    for (const php of options.versions)
      for (const name of expectedStackRows(stack, php))
        if (!rows.some((entry) => entry.php === php && entry.name === name))
          rows.push({ php, name, ok: false, detail: 'the row of the stack is missing' })
  const passed = report(rows, options)
  // The line for .env holds only the versions every row of which passed.
  const ready = built.filter(({ php }) => rows.every((entry) => entry.php !== php || entry.ok))
  if (ready.length)
    console.log(`PREVIEW_SITE_IMAGES=${ready.map(({ php, image }) => `${php}=${image}`).join(',')}`)
  if (ready.length < built.length)
    console.log(
      `not in PREVIEW_SITE_IMAGES, a row failed: ${built
        .filter((entry) => !ready.includes(entry))
        .map(({ php }) => php)
        .join(', ')}`,
    )
  if (!passed) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch((error) => {
    console.error(`site images stand failed during ${stage}: ${error.message}`)
    process.exitCode = 1
  })
