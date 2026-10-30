import {
  browserCheckpointLimits,
  browserCheckpointRefSchema,
  browserObjectStatuses,
  browserSessionLimits,
  browserVerifiedObjectSchema,
  type BrowserCheckpointRef,
  type BrowserCommitAction,
  type BrowserController,
  type BrowserObjectStatus,
  type BrowserSignInForm,
  type BrowserTaskPolicy,
  type BrowserTaskSite,
  type BrowserVerificationPlan,
  type BrowserVerificationReading,
  type BrowserVerificationReply,
  type SiteBrowserRequest,
} from '@repo/domain'
import { z } from 'zod'

import { isUploadDenied, segmentsOf } from './wordpress-browser.ts'
import { adminScriptPath, isAdminUrlDenied, isRestRouteDenied } from './wordpress-mcp-policy.ts'

/**
 * The browser of a task on a WordPress site itself (docs/plan/57-browser-tasks.md, Б21, Б22): the
 * agent — and the client at the controls — works in the site's own admin pages, signed in as the
 * client, and uploads media there; there is no preview behind it. What stays closed is closed for
 * both (CLAUDE.md rule 4, spec §11): users, plugins, themes and the site's look, settings, tools,
 * comments, orders, form entries, the network admin and every deletion. Pure: no I/O; anything
 * the policy cannot read is denied.
 *
 * Known limits, by design of a check that sees one request:
 * - a page's script can send a method in the `X-HTTP-Method-Override` header, which WordPress's
 *   REST server obeys; the request comes here without headers, so a POST to an object of the REST
 *   API without a text body — the block editor's own way of sending DELETE — is refused, and the
 *   browser adapter is to pass the header's method as `method`;
 * - an order or a form entry opened by its number through `post.php` (WooCommerce's legacy order
 *   storage) cannot be told from a post by its address; their lists and screens are closed;
 * - settings pages a plugin adds as `admin.php?page=…` are not known by name; the ones under
 *   Settings, Tools, Appearance, Users and Plugins are closed with their parent;
 * - a plugin whose single screen shows its own lists by the address after `#` (FluentCRM's
 *   `page=fluentcrm-admin`) is not known by a word of its screen, and opens.
 */

const BASE = 'https://site.invalid'

// ---------------------------------------------------------------------------------------------
// Where the browser starts and what else it loads
// ---------------------------------------------------------------------------------------------

/**
 * The list of posts, not the dashboard: the dashboard's Activity widget names the authors of recent
 * comments — the site's visitors, whom the agent must not see (spec §11) — so it is closed below,
 * and a signed-out session is sent to the login page and comes back here.
 */
const ADMIN_DIR = 'wp-admin/'
const START_PAGE = 'edit.php'

/**
 * No host besides the site's. Everything the admin pages and the block editor need is served by
 * the site itself; what they load from elsewhere is decoration or a channel the task does not
 * need, and stays closed:
 * - `secure.gravatar.com` (avatars in the toolbar and lists): sends a hash of each user's email to
 *   a third party; the pages show a blank square instead;
 * - `s.w.org` (emoji images): only when the browser lacks an emoji font; the text stays readable;
 * - `api.openverse.org` (the inserter's «Openverse» media tab): third-party pictures instead of the
 *   client's files — the task uploads the files the client attached;
 * - `fonts.googleapis.com`, `fonts.gstatic.com` (fonts some themes give the editor): the editor
 *   falls back to the system fonts;
 * - statistics and advertising hosts of plugins (`stats.wp.com`, `pixel.wp.com` and the like).
 * `BROWSER_EXTRA_HOSTS` adds a host a particular installation turns out to need. A page of the
 * site may still take the browser on to another site (docs/plan/60-browser-foreign-redirects.md):
 * that is the page going there, never a load of a page of the site.
 */
const EXTRA_HOSTS: readonly string[] = Object.freeze([])

/** The list of posts below the folder of the site's address: `/wp-admin/edit.php`, `/blog/wp-admin/edit.php`. */
function startPathOf(site: BrowserTaskSite): string {
  let url: URL
  try {
    url = new URL(site.url)
  } catch {
    return `/${ADMIN_DIR}${START_PAGE}`
  }
  const folder = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  return /^\/(?!\/)/.test(folder)
    ? `${folder}${ADMIN_DIR}${START_PAGE}`
    : `/${ADMIN_DIR}${START_PAGE}`
}

// ---------------------------------------------------------------------------------------------
// Reading a request as WordPress reads it
// ---------------------------------------------------------------------------------------------

type Field = readonly [name: string, value: string]

/**
 * PHP's name of a query or form field: `action[]` is `action`, and spaces and dots turn into `_`
 * (`delete.all` reaches the script as `delete_all`). Lower-cased: the policy matches either case.
 */
function phpName(name: string): string {
  return name
    .replace(/^ +/, '')
    .replace(/\[.*\]$/s, '')
    .replace(/[ .]/g, '_')
    .toLowerCase()
}

const MULTIPART_START = /^--([\x21-\x7e]{1,70})\r?\n/

/** The text fields of a multipart body; a file's part (`filename=`) is skipped, whatever it holds. */
function multipartFields(body: string, boundary: string): Field[] {
  const fields: Field[] = []
  for (const part of body.split(`--${boundary}`).slice(1)) {
    if (part.startsWith('--')) break
    const headersEnd = /\r?\n\r?\n/.exec(part)
    if (headersEnd === null) continue
    const headers = part.slice(0, headersEnd.index)
    if (/\bfilename\*?=/i.test(headers)) continue
    const name = /\bname="([^"]*)"/i.exec(headers)?.[1]
    if (name === undefined) continue
    const value = part.slice(headersEnd.index + headersEnd[0].length).replace(/\r?\n$/, '')
    fields.push([name, value])
  }
  return fields
}

/** Scalar fields of a JSON object body; null for a JSON body that does not read as one. */
function jsonFields(body: string): Field[] | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return Object.entries(value).flatMap(([name, field]): Field[] =>
    typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean'
      ? [[name, String(field)]]
      : [],
  )
}

/**
 * The fields of a body: JSON, multipart or URL-encoded, the way the page sent it. null — a body
 * that claims a form it is not (an unreadable JSON or array): denied rather than guessed.
 */
function bodyFields(body: string): Field[] | null {
  const text = body.trimStart()
  if (text.startsWith('{') || text.startsWith('[')) return jsonFields(text)
  const boundary = MULTIPART_START.exec(body)?.[1]
  if (boundary !== undefined) return multipartFields(body, boundary)
  return [...new URLSearchParams(body)]
}

interface SiteRequest {
  method: string
  /** Decoded, lower-case segments of the path. */
  segments: string[]
  /** The fields of the query and of the body, by PHP's name. */
  fields: Field[]
  /** The body is absent or not text. */
  bodyless: boolean
}

function readRequest(request: SiteBrowserRequest): SiteRequest | null {
  if (!request.path.startsWith('/') || request.path.startsWith('//')) return null
  let url: URL
  try {
    url = new URL(request.path, BASE)
  } catch {
    return null
  }
  if (url.origin !== BASE) return null
  const segments = segmentsOf(url.pathname)
  const body = request.postData === null ? [] : bodyFields(request.postData)
  if (segments === null || body === null) return null
  const fields = [...url.searchParams, ...body].map(([name, value]): Field => [
    phpName(name),
    value,
  ])
  return {
    method: request.method.trim().toUpperCase(),
    segments,
    fields,
    bodyless: request.postData === null,
  }
}

const valuesOf = (fields: readonly Field[], name: string) =>
  fields.filter(([field]) => field === name).map(([, value]) => value.trim().toLowerCase())

const has = (fields: readonly Field[], name: string) => fields.some(([field]) => field === name)

// ---------------------------------------------------------------------------------------------
// Admin pages and actions
// ---------------------------------------------------------------------------------------------

/**
 * Pages below /wp-admin/ closed besides `wordpressMcpPolicy.admin.deniedPages` (users, plugins,
 * themes, the settings of the core, tools, updates, comments, orders, form entries, the network):
 * the rest of Appearance, whose changes reach every page of the site (the Customizer, the site
 * editor, widgets, menus), Site Health, the installer and database upgrade and repair, the
 * multisite screens.
 */
const CLOSED_PAGES = new Set([
  'customize.php',
  'site-editor.php',
  'widgets.php',
  'nav-menus.php',
  'site-health.php',
  'upgrade.php',
  'install.php',
  'setup-config.php',
  'authorize-application.php',
])
/** Settings pages a plugin adds next to the core's (`options-connectors.php`), `options.php`. */
const OPTIONS_PAGE = /^options(?:-[a-z0-9_-]+)?\.php$/
const MULTISITE_PAGE = /^ms-[a-z0-9_-]+\.php$/
const CLOSED_FOLDERS = ['maint', 'network', 'user']

/** Kinds of content behind the list and the editor that are the site's look, not its content. */
const CLOSED_POST_TYPES = new Set([
  'wp_template',
  'wp_template_part',
  'wp_navigation',
  'wp_global_styles',
  'wp_font_family',
  'wp_font_face',
  // Form entries of plugins the MCP list does not name: their visitors' data (spec §11).
  'nf_sub',
])
/** `page=` of form entries the MCP list does not name (Gravity, Formidable, Elementor). */
const CLOSED_PLUGIN_PAGES = new Set(['gf_entries', 'formidable-entries', 'e-form-submissions'])
/**
 * Words of a plugin's screen (`page=`, and Fluent Forms' `route=` within it) that list the site's
 * visitors: form entries and submissions, leads, subscribers, messages, CFDB7's saved forms, users,
 * customers, orders. A part of a name is enough, as with actions: a plugin's screen is closed
 * rather than missed (spec §11).
 */
const CLOSED_SCREEN_WORDS = [
  'entr',
  'submission',
  'subscriber',
  'lead',
  'inbox',
  'message',
  'cfdb',
  'user',
  'customer',
  'order',
]
const screenClosed = (value: string) =>
  CLOSED_PLUGIN_PAGES.has(value) || CLOSED_SCREEN_WORDS.some((word) => value.includes(word))

/**
 * Words of an `action` (of an admin page, admin-ajax.php or admin-post.php) that delete, install,
 * update, export or erase — or reach a closed part: comments, users and their passwords and
 * sessions, plugins, themes, options and settings, privacy requests, Site Health. A part of a name
 * is enough (`untrash-post`, `wpseo_set_option`): a plugin's action is closed rather than missed.
 */
const CLOSED_ACTION_WORDS = [
  'delete',
  'trash',
  'install',
  'activate',
  'update',
  'upgrade',
  'export',
  'erase',
  'comment',
  'user',
  'password',
  'session',
  'plugin',
  'theme',
  'option',
  'setting',
  'privacy',
  'health',
]
/**
 * Whole actions closed besides: the dashboard's Quick Draft makes a post without its editor (no
 * address, so no checkpoint guards it against a duplicate, Б22), and a list's Quick Edit
 * (`inline-save`) saves a post's title, status and date without opening it, so no checkpoint
 * counts or confirms the change (Б34, CLAUDE.md rule 4); `parse-embed` and `oembed-cache` make the
 * site's server fetch an address of the page's choosing — the REST proxy the MCP policy closes,
 * in the Classic Editor.
 */
const CLOSED_ACTIONS = new Set([
  'post-quickdraft-save',
  'inline-save',
  'parse-embed',
  'oembed-cache',
])
/** «Empty Trash» and bulk edit of a list: deletions and mass changes (CLAUDE.md rule 4). */
const CLOSED_FIELDS = ['delete_all', 'delete_all2', 'bulk_edit']

const actionClosed = (action: string) =>
  CLOSED_ACTIONS.has(action) || CLOSED_ACTION_WORDS.some((word) => action.includes(word))

/** A request to /wp-admin/: `rest` are the segments below it. */
function adminDenied(rest: readonly string[], fields: readonly Field[]): boolean {
  const page = adminScriptPath(rest)
  // The dashboard (see START_PAGE): its widgets show visitors' comments.
  if (page === '' || page === 'index.php') return true
  if (CLOSED_FOLDERS.includes(page.split('/')[0] ?? '')) return true
  if (CLOSED_PAGES.has(page) || OPTIONS_PAGE.test(page) || MULTISITE_PAGE.test(page)) return true
  // An importer runs as `admin.php?import=…`.
  if (page === 'admin.php' && has(fields, 'import')) return true
  // A plugin's screen opens below any admin script (`admin.php`, `edit.php?post_type=…&page=…`).
  if ([...valuesOf(fields, 'page'), ...valuesOf(fields, 'route')].some(screenClosed)) return true
  if (page === 'edit.php' || page === 'post-new.php') {
    if (valuesOf(fields, 'post_type').some((type) => CLOSED_POST_TYPES.has(type))) return true
  }
  if (CLOSED_FIELDS.some((name) => has(fields, name))) return true
  return [...valuesOf(fields, 'action'), ...valuesOf(fields, 'action2')].some(actionClosed)
}

// ---------------------------------------------------------------------------------------------
// Scripts of the site outside /wp-admin/
// ---------------------------------------------------------------------------------------------

/**
 * Scripts the browser does not reach: XML-RPC (the whole API under a login of its own),
 * comments and trackbacks (the visitors' part of the site), sign-up and activation of new users.
 */
const CLOSED_SCRIPTS = new Set([
  'xmlrpc.php',
  'wp-comments-post.php',
  'wp-trackback.php',
  'wp-signup.php',
  'wp-activate.php',
])

function siteScriptDenied(segments: readonly string[], fields: readonly Field[]): boolean {
  const script = segments.find((segment) => segment.endsWith('.php'))
  if (script === undefined) return false
  if (CLOSED_SCRIPTS.has(script)) return true
  // The login page stays open — the client signs in there —; registering a new user does not.
  return script === 'wp-login.php' && valuesOf(fields, 'action').includes('register')
}

/** The media library from `wp-content`: a visitor's file may lie there (spec §11). */
function uploadDenied(segments: readonly string[]): boolean {
  const at = segments.indexOf('wp-content')
  return at !== -1 && isUploadDenied(segments.slice(at))
}

// ---------------------------------------------------------------------------------------------
// The REST API
// ---------------------------------------------------------------------------------------------

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Routes the site's look lives in: the block editor reads them to draw a post (global styles,
 * templates), and writing them changes every page — the Appearance of the admin pages. Reads
 * pass; writes do not. `url-details` makes the site's server fetch an address of the page's
 * choosing (the oEmbed proxy of the MCP list does the same) and is closed whole.
 */
const LOOK_ROUTES = [
  'wp/v2/templates',
  'wp/v2/template-parts',
  'wp/v2/global-styles',
  'wp/v2/navigation',
  'wp/v2/menus',
  'wp/v2/menu-items',
  'wp/v2/menu-locations',
  'wp/v2/sidebars',
  'wp/v2/widgets',
  'wp/v2/widget-types',
  'wp/v2/font-families',
  'wp/v2/font-collections',
]
const CLOSED_ROUTES = ['wp-site-health', 'wp-block-editor/v1/url-details']

const startsWithRoute = (route: string, prefix: string) =>
  route === prefix || route.startsWith(`${prefix}/`)

/** The routes a request reaches: by its path below /wp-json/ and by every `rest_route` field. */
function restRoutes(request: SiteRequest): (string | null)[] {
  const at = request.segments.indexOf('wp-json')
  const routes: (string | null)[] = at === -1 ? [] : [request.segments.slice(at + 1).join('/')]
  for (const [name, value] of request.fields) {
    if (name !== 'rest_route') continue
    // WordPress matches the route as given; a second decoding only makes the check stricter.
    routes.push(segmentsOf(value)?.join('/') ?? null)
  }
  return routes
}

/**
 * One route of the REST API (`wp/v2/posts/12`). The denied list of the MCP policy holds, except
 * two reads the block editor needs: the signed-in user's own record (`users/me`, its rights and
 * name) and the active theme (`themes?status=active`: whether it shows the Featured image panel).
 */
function routeDenied(route: string | null, request: SiteRequest): boolean {
  if (route === null) return true
  const read = READS.has(request.method)
  if (read && route === 'wp/v2/users/me') return false
  if (read && route === 'wp/v2/themes') {
    const statuses = valuesOf(request.fields, 'status')
    if (statuses.length > 0 && statuses.every((status) => status === 'active')) return false
  }
  if (isRestRouteDenied(`/${route}`)) return true
  if (CLOSED_ROUTES.some((prefix) => startsWithRoute(route, prefix))) return true
  if (!read && LOOK_ROUTES.some((prefix) => startsWithRoute(route, prefix))) return true
  // `POST /wp/v2/posts/12` with no text body is how the block editor sends DELETE (in a header
  // this check does not see); an update carries its JSON. A new upload of media may be binary.
  return request.method === 'POST' && request.bodyless && route !== 'wp/v2/media'
}

/**
 * The one `_embed` the block editor sends that embeds nothing of anyone: an upload of media
 * (`POST /wp/v2/media`) asks for the featured image of the new attachment, never its author.
 */
function featuredMediaOfUpload(request: SiteRequest, routes: readonly (string | null)[]): boolean {
  const embeds = valuesOf(request.fields, '_embed')
  return (
    request.method === 'POST' &&
    routes.length > 0 &&
    routes.every((route) => route === 'wp/v2/media') &&
    embeds.length > 0 &&
    embeds.every((value) => value === 'wp:featuredmedia')
  )
}

/**
 * A request of the REST API: `_method` and `_embed` (another method; users and comments embedded
 * into an allowed answer — the featured image of a media upload aside), `force` (deletion past the
 * trash) and a status of `trash` close it whatever the route.
 */
function restDenied(request: SiteRequest): boolean | null {
  const routes = restRoutes(request)
  if (routes.length === 0) return null
  const { fields } = request
  if (['_method', 'force'].some((name) => has(fields, name))) return true
  if (has(fields, '_embed') && !featuredMediaOfUpload(request, routes)) return true
  if (valuesOf(fields, 'status').includes('trash')) return true
  return routes.some((route) => routeDenied(route, request))
}

// ---------------------------------------------------------------------------------------------
// The client at the controls (Б37)
// ---------------------------------------------------------------------------------------------

/** A post or a page of the REST API by its number: what the block editor moves to the trash. */
const TRASHABLE_ROUTE = /^wp\/v2\/(?:posts|pages)\/\d{1,19}$/
/** The fields the block editor sends with its trash: nothing that asks for more than that. */
const TRASH_REST_FIELDS = new Set(['_locale', '_wpnonce', 'rest_route'])

/**
 * What the client at the controls may do that the agent may not (owner's decision of 28.10.2026,
 * Б37): move a post or a page to the trash and take it back — from its list, one or those marked
 * (`edit.php`, `post.php` with `action=trash` or `untrash`), or from the block editor (`DELETE`
 * of the post without `force`, or the editor's own POST without a body that carries it). Deleting
 * past the trash, emptying it, a closed kind of content and a plugin's screen stay closed; a post
 * the list does not name by its kind (a template trashed by its number) is not told apart.
 */
function clientTrash(read: SiteRequest): boolean {
  const { fields } = read
  const admin = read.segments.indexOf('wp-admin')
  if (admin !== -1) {
    const page = adminScriptPath(read.segments.slice(admin + 1))
    if (page !== 'post.php' && page !== 'edit.php') return false
    if (CLOSED_FIELDS.some((name) => has(fields, name)) || has(fields, 'page')) return false
    if (valuesOf(fields, 'post_type').some((type) => CLOSED_POST_TYPES.has(type))) return false
    const actions = [...valuesOf(fields, 'action'), ...valuesOf(fields, 'action2')].filter(
      (action) => action !== '-1',
    )
    return (
      actions.length > 0 && actions.every((action) => action === 'trash' || action === 'untrash')
    )
  }
  const routes = restRoutes(read)
  return (
    routes.length > 0 &&
    routes.every((route) => route !== null && TRASHABLE_ROUTE.test(route)) &&
    (read.method === 'DELETE' || (read.method === 'POST' && read.bodyless)) &&
    fields.every(([name]) => TRASH_REST_FIELDS.has(name))
  )
}

/**
 * Every request a page of the task's browser makes, and every address it opens (`pageDenied` is
 * this for a GET): any DELETE; the admin pages and actions above and those of the MCP policy; the
 * media library's documents; closed scripts; the REST routes above. Uploading media — the REST
 * `POST /wp/v2/media`, `async-upload.php`, `media-new.php` — passes, unlike on a preview. The
 * client at the controls may besides move a post or a page to the trash and back (`clientTrash`).
 */
export function wordpressBrowserTaskRequestDenied(
  request: SiteBrowserRequest,
  by: BrowserController = 'agent',
): boolean {
  const read = readRequest(request)
  if (read === null) return true
  if (by === 'user' && clientTrash(read) && !isAdminUrlDenied(request.path)) return false
  if (read.method === 'DELETE') return true
  if (isAdminUrlDenied(request.path)) return true
  if (uploadDenied(read.segments) || siteScriptDenied(read.segments, read.fields)) return true
  const admin = read.segments.indexOf('wp-admin')
  if (admin !== -1 && adminDenied(read.segments.slice(admin + 1), read.fields)) return true
  return restDenied(read) ?? false
}

/**
 * `…/wp-login.php`, `…/wp-login.php?redirect_to=…&reauth=1`, `…?action=login`: the form for a
 * login and a password. Another `action` (`lostpassword`, `rp`, a two-factor plugin's own) is
 * another form, never filled with the saved sign-in.
 */
export function isWordpressSignInPage(path: string): boolean {
  const url = URL.parse(path, BASE)
  if (url === null || plainSegment(url.pathname.split('/').at(-1)) !== 'wp-login.php') return false
  const action = lastValue(url.searchParams, 'action')
  return action === undefined || action === '' || action === 'login'
}

/** The fields of WordPress's own login form, the same in every language and since 2.x (Б36). */
const SIGN_IN_FORM: BrowserSignInForm = Object.freeze({
  isSignInPage: isWordpressSignInPage,
  login: '#loginform #user_login',
  password: '#loginform #user_pass',
  submit: '#loginform #wp-submit',
})

export function wordpressBrowserTaskPolicy(site: BrowserTaskSite): BrowserTaskPolicy {
  return Object.freeze({
    startPath: startPathOf(site),
    extraHosts: EXTRA_HOSTS,
    requestDenied: wordpressBrowserTaskRequestDenied,
    pageDenied: (path: string, by?: BrowserController) =>
      wordpressBrowserTaskRequestDenied({ path, method: 'GET', postData: null }, by),
    signIn: SIGN_IN_FORM,
  })
}

// ---------------------------------------------------------------------------------------------
// Checkpoints and commit buttons (Б22)
// ---------------------------------------------------------------------------------------------

/** WordPress reads `post` as a whole number: leading zeros are dropped, nothing else is taken. */
const POST_NUMBER = /^0*([1-9]\d{0,18})$/
const EDITOR_PAGE = 'post.php'

/** The last value of a query field, as PHP keeps it. */
const lastValue = (params: URLSearchParams, name: string) => params.getAll(name).at(-1)

/** A raw segment of a path, decoded and lower-cased; null when it does not decode. */
function plainSegment(segment: string | undefined): string | null {
  if (segment === undefined) return null
  try {
    return decodeURIComponent(segment).toLowerCase()
  } catch {
    return null
  }
}

/**
 * `…/wp-admin/post.php?post=12&action=edit` — the editor of an existing post or page (the block
 * editor and the Classic Editor alike) — with the same address, without the rest of its query, to
 * open it again. `post-new.php` is no object yet: the editor moves to `post.php` once it saves.
 */
export function wordpressBrowserCheckpointOf(address: string): BrowserCheckpointRef | null {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return null
  }
  const raw = url.pathname.split('/')
  if (plainSegment(raw.at(-1)) !== EDITOR_PAGE || plainSegment(raw.at(-2)) !== 'wp-admin')
    return null
  const id = POST_NUMBER.exec(lastValue(url.searchParams, 'post') ?? '')?.[1]
  if (id === undefined || lastValue(url.searchParams, 'action') !== 'edit') return null
  const editUrl = new URL(`${EDITOR_PAGE}?post=${id}&action=edit`, url).href
  const ref = browserCheckpointRefSchema.safeParse({ kind: 'post', objectId: id, editUrl })
  return ref.success ? ref.data : null
}

/**
 * The buttons that save or publish what the editor shows, in English and Russian, in the block
 * editor and the Classic Editor; compared without case, spacing and a closing ellipsis («Опубли-
 * ковать…» opens the pre-publish panel, and with its checks turned off publishes at once). An
 * update of a published post is a save: repeating it leaves no second object.
 */
const COMMIT_BUTTONS: ReadonlyMap<string, BrowserCommitAction> = new Map([
  ...[
    'publish',
    'опубликовать',
    'schedule',
    'запланировать',
    // A contributor's account publishes for review (status `pending`).
    'submit for review',
    'отправить на утверждение',
    'на утверждение',
  ].map((name) => [name, 'publish'] as const),
  ...[
    'update',
    'обновить',
    'save',
    'сохранить',
    'save draft',
    'сохранить черновик',
    'save as pending',
    'сохранить как ожидающее',
    'сохранить как ожидающую',
    'switch to draft',
    'перевести в черновики',
    'перевести в черновик',
  ].map((name) => [name, 'save'] as const),
])

const commitName = (name: string) =>
  name
    // `\s` takes the no-break space too.
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*(?:…|\.\.\.)$/, '')
    .toLowerCase()

export function wordpressBrowserCommitAction(
  role: string,
  name: string,
): BrowserCommitAction | null {
  return role === 'button' ? (COMMIT_BUTTONS.get(commitName(name)) ?? null) : null
}

// ---------------------------------------------------------------------------------------------
// The trusted read of an object (Б22)
// ---------------------------------------------------------------------------------------------

const UNREADABLE: BrowserVerificationReading = Object.freeze({ state: 'unreadable' })

/** A plan of no steps is never run: what a ref WordPress never makes reads as. */
const NOTHING_TO_READ: BrowserVerificationPlan = Object.freeze({
  steps: [],
  read: () => UNREADABLE,
})

/** The folder of the site's address in an editor address: `/` of `/wp-admin/post.php`. */
function siteFolderOf(editUrl: string): string {
  const path = new URL(editUrl).pathname
  const at = path.toLowerCase().lastIndexOf(`/${ADMIN_DIR}`)
  return at === -1 ? '/' : path.slice(0, at + 1)
}

/** The kinds of object the editor address may stand for, in the order they are read. */
const OBJECT_ROUTES = [
  { id: 'post', route: 'wp/v2/posts' },
  { id: 'page', route: 'wp/v2/pages' },
] as const
const OBJECT_FIELDS = 'id,status,title,link,featured_media,content'

const objectReplySchema = z.object({
  id: z.number().int(),
  status: z.string(),
  title: z.object({ raw: z.string() }),
  link: z.string().optional(),
  // Absent for a type without featured images.
  featured_media: z.number().int().optional(),
  content: z.object({ raw: z.string() }),
})

const STATUSES: ReadonlySet<string> = new Set(browserObjectStatuses)
const statusOf = (status: string): BrowserObjectStatus =>
  STATUSES.has(status) ? (status as BrowserObjectStatus) : 'unknown'

/** Cut to `max` UTF-16 units without leaving half of a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

/** The public address of a published or private object; a draft's `?p=12` is no address yet. */
function publicAddress(status: BrowserObjectStatus, link: string | undefined): string | undefined {
  if ((status !== 'publish' && status !== 'private') || link === undefined) return undefined
  if (link.length > browserSessionLimits.urlChars || /[\s\p{Cc}]/u.test(link)) return undefined
  try {
    const url = new URL(link)
    const web = url.protocol === 'https:' || url.protocol === 'http:'
    return web && url.username === '' && url.password === '' ? link : undefined
  } catch {
    return undefined
  }
}

const IMAGE_FILE = /\.(?:avif|bmp|gif|heic|ico|jpe?g|png|svg|tiff?|webp)$/
const UPLOADS = '/wp-content/uploads/'

/** A link's address without its query and fragment, lower-case, `&amp;` read. */
const linkKey = (href: string) =>
  href
    .replace(/&amp;/gi, '&')
    .replace(/[?#].*$/s, '')
    .trim()
    .toLowerCase()

const hrefsOf = (html: string) =>
  [...html.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gis)].map((match) => linkKey(match[2] ?? ''))

/**
 * The images in the content (`<img>` of image, gallery, cover or media blocks and of the Classic
 * Editor), and the files it links to: each File block's file and every other link to a document
 * of the media library, each address once (a File block links its file twice).
 */
function attachmentsOf(content: string): { images: number; files: number } {
  const images = content.match(/<img\b/gi)?.length ?? 0
  const files = new Set<string>()
  for (const block of content.matchAll(/<!--\s*wp:file\b[\s\S]*?<!--\s*\/wp:file\s*-->/g))
    for (const href of hrefsOf(block[0])) if (href !== '') files.add(href)
  for (const href of hrefsOf(content))
    if (href.includes(UPLOADS) && !IMAGE_FILE.test(href)) files.add(href)
  const most = browserCheckpointLimits.attachments
  return { images: Math.min(images, most), files: Math.min(files.size, most) }
}

function objectOf(ref: BrowserCheckpointRef, body: unknown): BrowserVerificationReading {
  const reply = objectReplySchema.safeParse(body)
  if (!reply.success || String(reply.data.id) !== ref.objectId) return UNREADABLE
  const { status: raw, title, link, featured_media, content } = reply.data
  const status = statusOf(raw)
  const object = browserVerifiedObjectSchema.safeParse({
    kind: ref.kind,
    objectId: ref.objectId,
    title: clip(title.raw, browserCheckpointLimits.titleChars),
    status,
    url: publicAddress(status, link),
    editUrl: ref.editUrl,
    ...attachmentsOf(content.raw),
    featuredImage: (featured_media ?? 0) > 0,
  })
  return object.success ? { state: 'verified', object: object.data } : UNREADABLE
}

/**
 * What the site says now: the first of the post and the page reads that finds the object. Not
 * signed in, no rights to the object (401, 403) or any other answer — unreadable, the checkpoint
 * keeps what it knew; not found by either (404 both) — missing. An object of a type of its own
 * (a theme's «News») is found by neither and reads as missing too (the guide tells the agent not
 * to make it again).
 */
function readObject(
  ref: BrowserCheckpointRef,
  replies: readonly BrowserVerificationReply[],
): BrowserVerificationReading {
  for (const { id } of OBJECT_ROUTES) {
    const reply = replies.find((candidate) => candidate.id === id)
    if (reply === undefined) return UNREADABLE
    if (reply.status === 404) continue
    return reply.status === 200 ? objectOf(ref, reply.body) : UNREADABLE
  }
  return { state: 'missing' }
}

/**
 * Reads the object through the session's own sign-in, GET only: a nonce of the REST API from
 * admin-ajax.php (the one the block editor gets), then the post and the page of that number in
 * the `edit` context — the raw title, the status, the address, the featured image and the content
 * whose images and files are counted. The route goes as `?rest_route=`, which a site without
 * pretty permalinks answers too. A site whose REST API is closed (a security plugin) reads as
 * unreadable: there is no reading of its HTML instead, and the task asks the client to check.
 */
export function wordpressBrowserVerification(ref: BrowserCheckpointRef): BrowserVerificationPlan {
  const parsed = browserCheckpointRefSchema.safeParse(ref)
  if (!parsed.success || !/^[1-9]\d{0,18}$/.test(ref.objectId)) return NOTHING_TO_READ
  const folder = siteFolderOf(parsed.data.editUrl)
  return {
    steps: [
      {
        id: 'nonce',
        method: 'GET',
        path: `${folder}${ADMIN_DIR}admin-ajax.php?action=rest-nonce`,
        readAs: 'text',
      },
      ...OBJECT_ROUTES.map(({ id, route }) => ({
        id,
        method: 'GET' as const,
        path: `${folder}?rest_route=/${route}/${ref.objectId}&context=edit&_fields=${OBJECT_FIELDS}`,
        headers: { 'X-WP-Nonce': { fromStep: 'nonce' } },
        readAs: 'json' as const,
      })),
    ],
    read: (replies) => readObject(parsed.data, replies),
  }
}

// ---------------------------------------------------------------------------------------------
// The guide (Б20)
// ---------------------------------------------------------------------------------------------

/** What the agent is told of working in WordPress's admin pages with the `web` tools. */
export function wordpressBrowserGuide(): string {
  return `- The site runs WordPress; its admin pages are under \`/wp-admin/\`. Interface names come in
  the site's language: Russian or English (Записи / Posts, Добавить запись / Add New Post).
- Sign-in: when the client saved the site's sign-in, the platform fills the WordPress login form
  itself before your actions, so you usually start signed in. A login form you still see
  (Имя пользователя / Username, Пароль / Password, Войти / Log In) — none was saved or it was
  refused —, a CAPTCHA or a two-factor code is the client's. Never type or guess a login or a
  password: call \`web_help\` (reason \`login\` or \`captcha\`) with a short request in Russian and end
  the turn. The client signs in in the same browser; the next turn continues from there.
- A new post: open \`/wp-admin/post-new.php\` once per object. Not the dashboard's Quick Draft.
- Block editor: a welcome or pattern window over it closes with «Закрыть» / «Close». The title
  field is «Добавить заголовок» / «Add title»; below it, click the empty block («Введите / для
  выбора блока» / «Type / to choose a block») and \`web_type\` the text; Enter starts a new
  paragraph block. \`/\` and a block name (\`/image\`, \`/file\`) then Enter inserts a block; the «+»
  button («Добавить блок» / «Add block») opens the inserter.
- Images: an Image block's «Загрузить» / «Upload» button opens a file chooser — \`web_upload\` with
  the attachment ids of the task (on the button's ref, or with none for the chooser that waits).
  In the media window («Медиатека» / «Media Library») use «Загрузить файлы» / «Upload files», then
  «Выбрать» / «Select». A PDF or another document goes into a File block («Файл» / «File»).
- Featured image: the «Запись» / «Post» tab of the settings sidebar, panel «Изображение записи» /
  «Featured image», «Установить изображение записи» / «Set featured image». Categories and tags
  are panels of the same tab.
- Publish: «Опубликовать» / «Publish» opens the pre-publish panel; confirm with its own
  «Опубликовать» / «Publish». Save a draft with «Сохранить черновик» / «Save draft». Publish only
  when the client asked to; otherwise leave a draft. Save with the buttons, not with a shortcut.
- Classic Editor: the same title field; the text in the «Визуально» / «Visual» field; «Добавить
  медиафайл» / «Add Media» opens the media window, then «Вставить в запись» / «Insert into post»;
  the «Изображение записи» / «Featured image» box; categories as checkboxes, tags with «Добавить» /
  «Add»; «Опубликовать» / «Publish» publishes at once, «Сохранить» / «Save Draft» keeps a draft.
- Notices: «autosave … more recent» — keep the version on the screen unless the client asked
  otherwise; a post being edited by someone else («заблокирована» / «locked») — do not take it
  over: ask the client with \`web_help\` (reason \`confirm\`).
- Deleting is closed to you: you never move a post or a page to the trash nor delete one, and
  never offer to. When the client asks for it, say plainly that you cannot, and that they can do
  it themselves: «Взять управление» in the browser panel, then «Удалить» under the post in the
  list of posts (it goes to the trash, from where it can be restored).
- Rights: the main button «Отправить на утверждение» / «Submit for Review» means the account
  cannot publish; submit only what the client asked for and tell the client plainly that the post
  waits for review. A page or action refused with \`BROWSER_ACTION_DENIED\` stays closed: tell the
  client, do not look for a way around it.
- Checkpoint: after any click on Save, Publish, Update or Schedule — and whenever the result of
  one is unclear (a timeout, a reload, an error) — call \`web_verify\` before you click it again.
  While an object of the task exists, never start a second one: open its editor again. If
  \`web_verify\` reports an object missing right after you saved it, do not make it again — ask the
  client with \`web_help\`. A click refused with \`BROWSER_CHECKPOINT_UNVERIFIED\`: call \`web_verify\`,
  then repeat the click once if it is still needed.
- Finish with \`web_verify\` (\`expect\` \`publish\` or \`draft\`, as the client asked) and give the
  client the title, the status and the address it reports.
- A screenshot the client asks for: open the page — a public page of the site by its path (\`/\` is
  the main page), or an admin page — wait until it has loaded (\`web_wait\` until \`load\`) and call
  \`web_screenshot\`; tell the client the screenshot is attached. Asked only to look, you save
  nothing and need no \`web_verify\`.
`
}
