import {
  browserCheckpointLimits,
  browserCheckpointRefSchema,
  browserObjectStatuses,
  browserSessionLimits,
  browserVerifiedObjectSchema,
  type BrowserCheckpointRef,
  type BrowserCommitAction,
  type BrowserObjectStatus,
  type BrowserSignInForm,
  type BrowserTaskPolicy,
  type BrowserTaskSite,
  type BrowserVerificationPlan,
  type BrowserVerificationReading,
  type BrowserVerificationReply,
} from '@repo/domain'
import { z } from 'zod'

import { wordpressBrowserRequestDenied } from './wordpress-browser.ts'

const BASE = 'https://site.invalid'

// ---------------------------------------------------------------------------------------------
// Where the browser starts and what else it loads
// ---------------------------------------------------------------------------------------------

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
    requestDenied: wordpressBrowserRequestDenied,
    pageDenied: (path: string) =>
      wordpressBrowserRequestDenied({ path, method: 'GET', postData: null }),
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
  pageUrl?: string,
): BrowserCommitAction | null {
  if (role !== 'button') return null
  if (pageUrl !== undefined) {
    const path = URL.parse(pageUrl)?.pathname.split('/') ?? []
    const script = plainSegment(path.at(-1))
    if (plainSegment(path.at(-2)) !== 'wp-admin') return null
    if (script !== EDITOR_PAGE && script !== 'post-new.php') return null
  }
  return COMMIT_BUTTONS.get(commitName(name)) ?? null
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
- When the client explicitly asks, use the relevant WordPress admin screens to manage users,
  plugins and themes, change WooCommerce payment settings, issue refunds or delete items.
- Rights: the main button «Отправить на утверждение» / «Submit for Review» means the account
  cannot publish; submit only what the client asked for and tell the client plainly that the post
  waits for review. A page or action refused with \`BROWSER_ACTION_DENIED\` stays closed: tell the
  client, do not look for a way around it.
- Form entries — «заявки» — are the client's own data (the owner's decision of 09.11.2026): their
  lists are under each form plugin's menu (Fluent Forms: «Записи» / «Entries»; Contact Form 7
  with Flamingo: «Входящие»; WPForms, Gravity Forms, Elementor, CFDB7 and the like have their
  own). Orders and customers of the shop (WooCommerce) are the client's own data as well. When
  the client asks to collect them, read the list page by page, or use the export of the plugin
  or of the core («Экспорт» / «Export»; in Fluent Forms: «Экспорт», «Экспортировать как Excel
  (xlsx)», then «Экспорт» in the window of fields) and read the file with \`web_download\`;
  then build what the client asked for in the outbox.
- In the post or page editor, after any click on Save, Publish, Update or Schedule, call \`web_verify\` before you click it again, including after a timeout, reload or error.
  While an object of the task exists, never start a second one: open its editor again. If
  \`web_verify\` reports an object missing right after you saved it, do not make it again — ask the
  client with \`web_help\`. A click refused with \`BROWSER_CHECKPOINT_UNVERIFIED\`: call \`web_verify\`,
  then repeat the click once if it is still needed.
- Finish editing a post or page with \`web_verify\` (\`expect\` \`publish\` or \`draft\`, as requested).
  Give the client the title, status and address it reports. For other admin actions, verify the
  result on the relevant screen with \`web_observe\`.
- A screenshot the client asks for: open the page — a public page of the site by its path (\`/\` is
  the main page), or an admin page — wait until it has loaded (\`web_wait\` until \`load\`) and call
  \`web_screenshot\`; tell the client the screenshot is attached. Asked only to look, you save
  nothing and need no \`web_verify\`.
`
}
