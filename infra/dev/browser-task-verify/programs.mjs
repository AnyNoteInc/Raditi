// The scripted model of the browser-task stand: what the "agent" does in each turn, written as a
// program that reads the pages the way a model reads them — the text of an observation, elements
// found by their role and accessible name — and acts on the references it found there. A program
// is a generator: it yields a call of a platform tool and gets back what the tool answered; it
// returns the final answer of the turn. The model (model.mjs) runs a program again from the start
// for every request of the CLI, feeding it the answers the request carries, and sends its next
// call; so a program must decide only by what it was answered. `facts` collects what a program
// saw for the stand's checks (a refusal it was meant to meet, the address it read).

/** A call of a platform tool, by its name without the `raditi_` the CLI adds. */
export const call = (tool, args = {}) => ({ tool, args })

/** The final answer of a turn by the contract of the platform (turnResultSchema). */
export function final({ summary, message, changeType = 'content', risk = 'low', questions = [] }) {
  return {
    final: JSON.stringify({
      summary,
      change_type: changeType,
      client_message: message,
      files_changed: [],
      questions,
      needs_approval: false,
      risk,
    }),
  }
}

// ─── Reading an observation ───────────────────────────────────────────────────

const REF = /\[ref=((?:f\d+)?e\d+)\]/
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One line of Playwright's `ai` tree: its indent, role, accessible name, reference and value. */
export function treeLines(tree) {
  const out = []
  for (const raw of String(tree ?? '').split('\n')) {
    const match = /^( *)- '?([a-z]+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/.exec(raw)
    if (!match) continue
    const [, indent, role, quoted, rest] = match
    let name = ''
    if (quoted !== undefined) {
      try {
        name = JSON.parse(`"${quoted}"`)
      } catch {
        name = quoted
      }
    }
    const ref = REF.exec(rest)?.[1] ?? null
    const colon = rest.indexOf(': ')
    const value = colon >= 0 ? rest.slice(colon + 2).replace(/^'|'$/g, '') : ''
    out.push({ indent: indent.length, role, name, ref, value, line: raw, rest })
  }
  return out
}

/**
 * An observation as a program reads it: the tree, the elements by role and name (or by the text
 * of a button that has no name of its own), the part of the tree under an element.
 */
export class Page {
  constructor(answer) {
    this.answer = answer
    this.tree = typeof answer?.tree === 'string' ? answer.tree : ''
    this.observation = answer?.observation ?? null
    this.url = answer?.page?.url ?? ''
    this.lines = treeLines(this.tree)
  }

  has(text) {
    return this.tree.includes(text)
  }

  /** The lines under the first element of `role` named `name` (inclusive); this page if none. */
  within(role, name) {
    const at = this.lines.findIndex((line) => line.role === role && matches(line.name, name))
    if (at < 0) return null
    const lines = [this.lines[at]]
    for (const line of this.lines.slice(at + 1)) {
      if (line.indent <= this.lines[at].indent) break
      lines.push(line)
    }
    const part = Object.create(Page.prototype)
    Object.assign(part, { answer: this.answer, observation: this.observation, url: this.url })
    part.lines = lines
    part.tree = lines.map((line) => line.line).join('\n')
    return part
  }

  /**
   * The reference of the first element of `role` named `name`; only when none is, the first one
   * without a name whose text matches (an element under a modal window loses its name). Disabled
   * ones are passed over unless `enabled` is false.
   */
  find(role, name, { enabled = true } = {}) {
    const usable = (item) =>
      item.role === role && item.ref !== null && (!enabled || !item.rest.includes('[disabled]'))
    const named = this.lines.find((item) => usable(item) && matches(item.name, name))
    const texted = named
      ? undefined
      : this.lines.find((item) => usable(item) && item.name === '' && matches(item.value, name))
    return (named ?? texted)?.ref ?? null
  }

  /** The modal window of the page (a dialog that hides the rest), or null. */
  modal() {
    return this.within('dialog', /[\s\S]*/)
  }

  /** Like `find`, and a missing element is a broken script. */
  ref(role, name, options) {
    const ref = this.find(role, name, options)
    if (ref === null) throw new ScriptBroken(`no ${role} «${String(name)}» on ${this.url}`)
    return ref
  }

  /** The element by reference with its observation: what web_click and the others take. */
  at(role, name, options) {
    return { observation: this.observation, ref: this.ref(role, name, options) }
  }
}

const matches = (value, name) =>
  name instanceof RegExp ? name.test(value) : value.trim() === String(name)

/** A page did not hold what the script expects of it: the model stops answering this turn. */
export class ScriptBroken extends Error {}

// ─── The answers of the tools ─────────────────────────────────────────────────

/** A refused call of a web tool (`{code, message}`), or null for an answer of the tool. */
export const refusalOf = (answer) =>
  answer && typeof answer.code === 'string' && answer.code.startsWith('BROWSER_')
    ? answer.code
    : null

/** The objects `web_verify` reported, with the state and the status read on the site. */
export function verified(answer, status) {
  const objects = Array.isArray(answer?.objects) ? answer.objects : []
  return objects.filter(
    (item) => item.state === 'verified' && (status === undefined || item.object?.status === status),
  )
}

/** The files of the task the platform named in the request: `- <id>: <name>, <type>, <size>`. */
export function attachmentsOf(prompt) {
  const files = []
  for (const match of String(prompt ?? '').matchAll(
    /^- ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}): ([^,\n]+), ([^,\n]+), /gm,
  ))
    files.push({ id: match[1], name: match[2].trim(), type: match[3].trim() })
  return files
}

// ─── Steps the programs share ─────────────────────────────────────────────────

function* observe(args = {}) {
  const answer = yield call('web_observe', args)
  const code = refusalOf(answer)
  if (code) throw new ScriptBroken(`web_observe was refused ${code}`)
  return new Page(answer)
}

/** An action whose refusal breaks the script: the page was not what the script expects. */
function* act(tool, args) {
  const answer = yield call(tool, args)
  const code = refusalOf(answer)
  if (code) throw new ScriptBroken(`${tool} was refused ${code}`)
  return answer
}

/**
 * Opens a page and reads it. A save of the task still unconfirmed holds a new page back
 * (BROWSER_CHECKPOINT_UNVERIFIED, Б22): the guide says to check the site and try once more.
 */
function* openAndObserve(url) {
  let code = refusalOf(yield call('web_open', { url }))
  if (code === 'BROWSER_CHECKPOINT_UNVERIFIED') {
    yield call('web_verify', {})
    code = refusalOf(yield call('web_open', { url }))
  }
  // A heavy page (the block editor) may load longer than an action waits: it goes on loading.
  if (code === 'BROWSER_TIMEOUT') {
    yield call('web_wait', { ms: 15000, until: 'load' })
    code = null
  }
  if (code) throw new ScriptBroken(`web_open ${url} was refused ${code}`)
  return yield* observe()
}

/**
 * Files that are not this task's — another client's, another task's of the same client — named
 * by the stand: mcp must refuse each before the worker is asked (BROWSER_ATTACHMENT_UNKNOWN).
 * `facts.foreign` — the refusal of the first, `facts.foreignAll` — of each.
 */
function* probeForeignFile(ctx, facts) {
  const ids = ctx.foreignAttachments ?? (ctx.foreignAttachment ? [ctx.foreignAttachment] : [])
  if (ids.length === 0) return
  facts.foreignAll = []
  for (const id of ids)
    facts.foreignAll.push(refusalOf(yield call('web_upload', { attachmentIds: [id] })) ?? 'taken')
  facts.foreign = facts.foreignAll[0]
}

/** Waits for the page to settle, then reads it again until `ready(page)` or the tries run out. */
function* observeUntil(ready, { tries = 6, ms = 1500 } = {}) {
  let page = yield* observe()
  for (let left = tries; left > 0 && !ready(page); left -= 1) {
    yield call('web_wait', { ms })
    page = yield* observe()
  }
  return page
}

/**
 * The block editor of a new post with its title and first paragraph: the welcome guide closed if
 * it shows, the title filled, the text typed into the first block.
 */
function* newPost({ title, text }) {
  yield* openAndObserve('/wp-admin/post-new.php')
  // The editor loads its canvas, then — for a user who has not closed it for good — the welcome
  // guide over it: wait for the title, give the guide its moment, close it when it shows.
  let page = yield* observeUntil((current) => current.find('textbox', 'Add title') !== null)
  yield call('web_wait', { ms: 2000 })
  page = yield* observe()
  if (page.has('Welcome to the editor') && page.modal()?.find('button', 'Close')) {
    yield* act('web_click', page.modal().at('button', 'Close'))
    page = yield* observeUntil((current) => current.modal() === null)
  }
  yield* act('web_fill', { ...page.at('textbox', 'Add title'), text: title })
  page = yield* observe()
  yield* act('web_click', page.at('button', 'Add default block'))
  yield* act('web_type', { text })
  return yield* observe()
}

/** A new block after the focused one: Enter, `/<name>`, Enter (the inserter of the editor). */
function* insertBlock(name) {
  yield* act('web_press', { key: 'Enter' })
  yield* act('web_type', { text: `/${name}` })
  yield call('web_wait', { ms: 800 })
  yield* act('web_press', { key: 'Enter' })
  return yield* observe()
}

/** A file of the task into the «Upload» button of a block placeholder; the block when it shows. */
function* uploadIntoBlock(page, block, attachment, shown) {
  const placeholder = page.within('document', block)
  if (placeholder === null) throw new ScriptBroken(`no ${block} on the page`)
  const upload = yield call('web_upload', {
    ...placeholder.at('button', 'Upload'),
    attachmentIds: [attachment.id],
  })
  const code = refusalOf(upload)
  if (code) return { refused: code, page: yield* observe() }
  const after = yield* observeUntil((current) => {
    const part = current.within('document', block)
    return part !== null && shown(part, current)
  })
  return { refused: null, page: after }
}

/**
 * Clicks a button that saves or publishes, once more after `web_verify` when the platform holds
 * it back (`BROWSER_CHECKPOINT_UNVERIFIED`, Б22); `facts.held` counts how often that happened.
 */
function* commit(where, facts) {
  const clicked = yield call('web_click', where)
  const code = refusalOf(clicked)
  if (code !== 'BROWSER_CHECKPOINT_UNVERIFIED') return code
  facts.held = (facts.held ?? 0) + 1
  yield call('web_verify', {})
  return refusalOf(yield call('web_click', where))
}

/** `web_verify` until an object of the task has `status` or the tries run out. */
function* verifyUntil(status, { tries = 6, ms = 2000 } = {}) {
  // The tool expects `publish` or `draft`; any other status is read from the objects themselves.
  const args = status === 'publish' || status === 'draft' ? { expect: status } : {}
  let answer = yield call('web_verify', args)
  for (let left = tries; left > 0 && verified(answer, status).length === 0; left -= 1) {
    yield call('web_wait', { ms })
    answer = yield call('web_verify', args)
  }
  return answer
}

/** «Save draft» of the editor, then the check of the draft on the site. */
function* saveDraft(facts) {
  let page = yield* observe()
  const code = yield* commit(page.at('button', 'Save draft'), facts)
  if (code) throw new ScriptBroken(`Save draft was refused ${code}`)
  yield call('web_wait', { ms: 1500 })
  const answer = yield* verifyUntil('draft')
  facts.draft = verified(answer, 'draft')[0] ?? null
  page = yield* observe()
  return page
}

/** The publish button of the header, then the confirmation in the pre-publish panel. */
function* publish(facts, { confirmName = 'Publish' } = {}) {
  let page = yield* observe()
  let code = yield* commit(page.at('button', confirmName), facts)
  if (code) throw new ScriptBroken(`${confirmName} was refused ${code}`)
  // The region of the panel is always on the page; its confirmation shows once the panel opens.
  const confirmIn = (current) =>
    current.within('region', 'Editor publish')?.find('button', confirmName) ?? null
  page = yield* observeUntil((current) => confirmIn(current) !== null)
  const panel = page.within('region', 'Editor publish')
  if (panel === null || confirmIn(page) === null) throw new ScriptBroken('no pre-publish panel')
  code = yield* commit(panel.at('button', confirmName), facts)
  if (code) throw new ScriptBroken(`the confirmation ${confirmName} was refused ${code}`)
  return page
}

// ─── The programs ─────────────────────────────────────────────────────────────

/**
 * The first turn of every task: the dashboard is closed to the agent (Б31), the list of posts
 * leads to the sign-in page of WordPress, and the agent asks the client to sign in (`web_help`,
 * reason `login`) and ends the turn without touching the form.
 */
export function* askToSignIn(ctx, facts) {
  yield* probeForeignFile(ctx, facts)
  const dashboard = yield call('web_open', { url: '/wp-admin/' })
  facts.dashboard = refusalOf(dashboard)
  const page = yield* openAndObserve('/wp-admin/edit.php')
  facts.loginPage =
    page.find('textbox', 'Username or Email Address') !== null &&
    page.find('textbox', 'Password') !== null &&
    page.url.includes('/wp-login.php')
  if (!facts.loginPage) {
    facts.signedIn = true
    return final({
      summary: 'The site is signed in already',
      changeType: 'none',
      message: 'Вход на сайт уже выполнен. Напишите, что сделать дальше.',
    })
  }
  const help = yield call('web_help', {
    reason: 'login',
    message: 'Войдите, пожалуйста, в админку сайта в окне браузера справа и верните управление.',
  })
  facts.help = refusalOf(help) ?? 'requested'
  return final({
    summary: 'Asked the client to sign in to the admin pages',
    changeType: 'none',
    message:
      'Чтобы продолжить, войдите в админку сайта прямо в окне браузера. Пароль в чат не пишите. Потом нажмите «Продолжить работу агента».',
  })
}

/**
 * Scenario F: a news post with its text, the first image in an Image block, the PDF in a File
 * block, the second image as the featured image; saved as a draft, then published, then checked.
 */
export function* publishNews(ctx, facts) {
  const files = ctx.attachments
  const images = files.filter((file) => file.type.startsWith('image/'))
  const pdf = files.find((file) => file.type === 'application/pdf')
  if (images.length < 2 || !pdf) throw new ScriptBroken('the task has not two images and a PDF')
  let page = yield* newPost({ title: ctx.words.title, text: ctx.words.text })

  page = yield* insertBlock('image')
  let upload = yield* uploadIntoBlock(page, 'Block: Image', images[0], (block) =>
    block.lines.some((line) => line.role === 'img'),
  )
  if (upload.refused) throw new ScriptBroken(`the image upload was refused ${upload.refused}`)
  page = upload.page

  // The File block after the text: back to the paragraph, its end, a new block.
  yield* act('web_click', page.at('document', 'Block: Paragraph'))
  yield* act('web_press', { key: 'End' })
  page = yield* insertBlock('file')
  upload = yield* uploadIntoBlock(page, 'Block: File', pdf, (block) =>
    block.lines.some((line) => /Embed of the selected PDF file|Write file name/.test(line.name)),
  )
  if (upload.refused) throw new ScriptBroken(`the PDF upload was refused ${upload.refused}`)
  page = upload.page

  // The featured image: the Post tab of the sidebar, its panel, the media window.
  if (page.find('tab', 'Post') !== null) {
    yield* act('web_click', page.at('tab', 'Post'))
    page = yield* observe()
  }
  yield* act('web_click', page.at('button', 'Set featured image'))
  const inModal = (current, role, name) => current.modal()?.find(role, name) ?? null
  page = yield* observeUntil(
    (current) =>
      inModal(current, 'button', 'Select Files') !== null ||
      inModal(current, 'tab', 'Upload files') !== null,
  )
  if (inModal(page, 'button', 'Select Files') === null) {
    yield* act('web_click', page.modal().at('tab', 'Upload files'))
    page = yield* observeUntil((current) => inModal(current, 'button', 'Select Files') !== null)
  }
  const chosen = yield call('web_upload', {
    ...page.modal().at('button', 'Select Files'),
    attachmentIds: [images[1].id],
  })
  if (refusalOf(chosen)) throw new ScriptBroken(`the featured image upload was refused`)
  page = yield* observeUntil((current) => inModal(current, 'button', 'Set featured image') !== null)
  yield* act('web_click', page.modal().at('button', 'Set featured image'))
  page = yield* observeUntil(
    (current) =>
      current.modal() === null &&
      current.find('button', 'Edit or replace the featured image') !== null,
  )
  facts.featured = page.find('button', 'Edit or replace the featured image') !== null

  yield* saveDraft(facts)
  yield* publish(facts)
  yield call('web_wait', { ms: 8000, text: 'Post published.' })
  const answer = yield* verifyUntil('publish')
  const post = verified(answer, 'publish')[0]
  facts.published = post ?? null
  if (!post)
    return final({
      summary: 'Publish not confirmed',
      message: 'Мы нажали «Опубликовать», но сайт пока не показывает запись опубликованной.',
    })
  return final({
    summary: 'Published a news post with two images and a PDF',
    message: `Опубликовали новость «${post.object.title}» с двумя фотографиями и PDF: ${post.object.url}`,
  })
}

/** Scenario G: a draft only — the client asked to keep it unpublished. */
export function* keepDraft(ctx, facts) {
  yield* probeForeignFile(ctx, facts)
  yield* newPost({ title: ctx.words.title, text: ctx.words.text })
  yield* saveDraft(facts)
  if (!facts.draft)
    return final({
      summary: 'Draft not confirmed',
      message: 'Сохранили черновик, но сайт пока не показывает его.',
    })
  return final({
    summary: 'Saved a draft',
    message: `Сохранили черновик «${facts.draft.object.title}». Опубликовать его можно в админке, когда будете готовы.`,
  })
}

/**
 * Scenario H: an account that may not publish — the main button is «Submit for Review»; the
 * agent submits as the client asked and says plainly that the post waits for review.
 */
export function* submitForReview(ctx, facts) {
  let page = yield* newPost({ title: ctx.words.title, text: ctx.words.text })
  facts.publishButton = page.find('button', 'Publish') !== null
  facts.submitButton = page.find('button', 'Submit for Review') !== null
  if (!facts.submitButton) throw new ScriptBroken('no «Submit for Review» for a contributor')
  page = yield* publish(facts, { confirmName: 'Submit for Review' })
  yield call('web_wait', { ms: 3000 })
  const answer = yield* verifyUntil('pending')
  const post = verified(answer, 'pending')[0]
  facts.pending = post ?? null
  return final({
    summary: 'Submitted the post for review: the account cannot publish',
    message: post
      ? `Ваша учётная запись на сайте не может публиковать записи, поэтому мы отправили «${post.object.title}» на утверждение. Запись появится на сайте, когда её одобрит редактор.`
      : 'Ваша учётная запись на сайте не может публиковать записи; отправить запись на утверждение не получилось.',
  })
}

/**
 * Scenario I: the draft is saved, then the site refuses the PDF; the agent says so and asks the
 * client (`web_help`, reason `other`) instead of publishing a post without its file.
 */
export function* uploadRefused(ctx, facts) {
  const pdf = ctx.attachments.find((file) => file.type === 'application/pdf')
  if (!pdf) throw new ScriptBroken('the task has no PDF')
  let page = yield* newPost({ title: ctx.words.title, text: ctx.words.text })
  page = yield* saveDraft(facts)
  yield* act('web_click', page.at('document', 'Block: Paragraph'))
  yield* act('web_press', { key: 'End' })
  page = yield* insertBlock('file')
  const upload = yield* uploadIntoBlock(
    page,
    'Block: File',
    pdf,
    (block, whole) =>
      block.lines.some((line) =>
        /Embed of the selected PDF file|Write file name/.test(line.name),
      ) || whole.has(ctx.words.refusal),
  )
  facts.refusalShown = upload.page.has(ctx.words.refusal)
  facts.uploadCode = upload.refused
  if (!facts.refusalShown && !upload.refused)
    throw new ScriptBroken('the site took the file it was meant to refuse')
  const help = yield call('web_help', {
    reason: 'other',
    message:
      'Сайт не принял PDF-файл: он больше, чем разрешено. Пришлите файл поменьше или загрузите его сами.',
  })
  facts.help = refusalOf(help) ?? 'requested'
  return final({
    summary: 'The site refused the PDF; the post stays a draft',
    message:
      'Сайт не принял PDF-файл: он больше, чем разрешено на сайте. Запись сохранена черновиком и не опубликована. Пришлите файл поменьше или загрузите его сами.',
  })
}

/**
 * Scenario J: the site holds the publish longer than the agent waits. The agent, unsure, tries to
 * start the post again — the platform refuses a new object while the publish is unconfirmed —
 * and checks the site instead, until it shows the post published.
 */
export function* publishAfterTimeout(ctx, facts) {
  yield* newPost({ title: ctx.words.title, text: ctx.words.text })
  yield* saveDraft(facts)
  yield* publish(facts)
  const waited = yield call('web_wait', { ms: 10000, text: 'Post published.' })
  facts.waitMatched = waited?.matched ?? null
  // Unsure of the outcome, the agent publishes once more where a button still says so…
  const page = yield* observe()
  const button = page.find('button', 'Publish')
  facts.secondPublish =
    button === null
      ? 'none'
      : (refusalOf(yield call('web_click', { observation: page.observation, ref: button })) ??
        'clicked')
  // …and would start the post again: the platform refuses a new object meanwhile (Б22).
  const again = yield call('web_open', { url: '/wp-admin/post-new.php' })
  facts.newPostRefused = refusalOf(again)
  const answer = yield* verifyUntil('publish', { tries: 12, ms: 5000 })
  const post = verified(answer, 'publish')[0]
  facts.published = post ?? null
  return final({
    summary: post ? 'Published after a slow publish' : 'Publish not confirmed',
    message: post
      ? `Сайт долго публиковал запись, но она опубликована один раз: ${post.object.url}`
      : 'Сайт долго не отвечал на публикацию; проверьте запись в админке.',
  })
}

export const PROGRAMS = Object.freeze({
  askToSignIn,
  publishNews,
  keepDraft,
  submitForReview,
  uploadRefused,
  publishAfterTimeout,
})
