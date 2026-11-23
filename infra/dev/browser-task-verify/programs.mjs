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

/** Scenario P: a chat without a project: words alone, no tool, no browser. */
export function* plainAnswer() {
  yield* []
  return final({
    summary: 'Answered in a chat without a project',
    changeType: 'none',
    message: 'Здравствуйте! Слушаю вас.',
  })
}

/**
 * Scenario P: the file the client sent before the first words. The driver names its path in the
 * words of the turn; the CLI's own tool reads it, outside the working copy, and the answer is what
 * the file holds.
 */
export function* readClientFile(ctx, facts) {
  const path = /"(\/workspace\/inbox\/[^"]+)"/.exec(ctx.prompt ?? '')?.[1]
  if (!path) throw new ScriptBroken('the turn names no file of the client')
  const answer = yield call('read', { filePath: path })
  const word = /raditi-chat-file-[0-9a-f]+/.exec(answer?.text ?? '')?.[0]
  facts.word = word ?? null
  if (!word) throw new ScriptBroken('the file of the client was not read')
  return final({
    summary: 'Read the file of the client',
    changeType: 'none',
    message: `В файле написано: ${word}`,
  })
}

/**
 * Scenario P: the browser of a chat without a project: where it starts, the addresses it refuses,
 * a public site it reads and types on. No object of the task is on any of them.
 */
export function* openTheWeb(ctx, facts) {
  // A chat without a project has no site to start on: the first look is at an empty page.
  const start = yield call('web_observe', {})
  facts.start = refusalOf(start) ?? start?.page?.url ?? null
  facts.refused = {}
  for (const [name, url] of Object.entries(ctx.refused))
    facts.refused[name] = refusalOf(yield call('web_open', { url })) ?? 'taken'
  const example = yield* openAndObserve('https://example.com/')
  // The site answers in the language of the browser: its English line stands on both versions.
  facts.example = example.url === 'https://example.com/' && example.has('This domain')
  // Typing is a write of the browser (`browser_sessions.wrote_at`): the page has no field to take it.
  facts.typed = refusalOf(yield call('web_type', { text: 'stand' }))
  const verified = yield call('web_verify', {})
  facts.objects = verified?.objects?.length ?? null
  return final({
    summary: 'Opened the pages',
    changeType: 'none',
    message: 'Посмотрел страницы.',
  })
}

/**
 * Scenario P: a pass that fails after the agent acted in the browser of a chat without a project:
 * a public page typed on, then an answer that is no result — the product ends the pass as a failure.
 */
export function* failAfterWriting(ctx, facts) {
  yield* openAndObserve('https://example.com/')
  yield* act('web_type', { text: 'stand' })
  facts.wrote = true
  return { final: 'Синтетическая модель: это не итог хода.' }
}

/** Scenario P: a chat that holds a browser, or is refused one. */
export function* holdTheBrowser(ctx, facts) {
  facts.code = refusalOf(yield call('web_open', { url: 'https://example.com/' }))
  return final({
    summary: 'Opened a page',
    changeType: 'none',
    message: facts.code ? 'Браузер сейчас занят.' : 'Страница открыта.',
  })
}

/**
 * Scenario K: the files of another client and of another chat, named by the stand, are refused
 * by mcp before the worker is asked; then a public page holds the browser for the probes.
 */
export function* holdWithForeignFiles(ctx, facts) {
  yield* probeForeignFile(ctx, facts)
  return yield* holdTheBrowser(ctx, facts)
}

// ─── Sites of pages (docs/plan/73-pages-sites.md, scenario R) ───────────────────

/** The answer of a tool that must not be a refusal; its code breaks the program otherwise. */
function accepted(answer, what) {
  // A tool of the pages refuses with `{code, message}` and nothing else (pages-service.ts).
  if (answer && typeof answer.code === 'string' && typeof answer.message === 'string')
    throw new ScriptBroken(`${what} was refused: ${answer.code}`)
  return answer
}

/** A page of a site as the agent writes it: links to its pages from the root (Дер20). */
const sitePage = (title, body) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><nav><a href="/">Главная</a> <a href="/uslugi">Услуги</a> ` +
  `<a href="/uslugi/remont">Ремонт</a></nav><h1>${title}</h1><p>${body}</p></body></html>`

/**
 * Scenario R, the first turn: a site of three pages — a home page, /uslugi and /uslugi/remont
 * under it — three files of the outbox and three publications, the second and the third into the
 * site the first one made; each page links to the others from the root.
 */
export function* publishSite(ctx, facts) {
  yield call('bash', { command: 'mkdir -p /workspace/out', description: 'Make the outbox' })
  const pages = [
    { file: 'glavnaya.html', title: 'Главная', path: null, body: ctx.word },
    { file: 'uslugi.html', title: 'Услуги', path: '/uslugi', body: 'Что мы делаем.' },
    { file: 'remont.html', title: 'Ремонт', path: '/uslugi/remont', body: 'Ремонт квартир.' },
  ]
  for (const page of pages)
    yield call('write', {
      filePath: `/workspace/out/${page.file}`,
      content: sitePage(page.title, page.body),
    })
  facts.published = []
  for (const page of pages) {
    const answer = accepted(
      yield call('page_publish', {
        file: page.file,
        title: page.title,
        ...(page.path ? { treeId: facts.treeId, path: page.path } : {}),
      }),
      `page_publish of ${page.file}`,
    )
    facts.treeId ??= answer.treeId
    facts.published.push({ pageId: answer.pageId, path: answer.path, url: answer.url })
  }
  return final({
    summary: 'Published a site of three pages',
    message: `Сайт опубликован: ${facts.published[0].url}`,
  })
}

/** The page of a site at a path, as `page_tree` names it. */
function* nodeAt(treeId, path) {
  const tree = accepted(yield call('page_tree', { treeId }), 'page_tree')
  const node = (tree.pages ?? []).find((page) => page.path === path)
  if (!node) throw new ScriptBroken(`the site has no page at ${path}`)
  return node
}

/** The one site of the chat's workspace, as `page_list` names it. */
function* onlySite() {
  const list = accepted(yield call('page_list', {}), 'page_list')
  const sites = (list.sites ?? []).filter((site) => !site.deleted)
  if (sites.length !== 1) throw new ScriptBroken(`page_list named ${sites.length} sites`)
  return sites[0]
}

/** Scenario R, the second turn: «Услуги» becomes «Цены» at /ceny, its page below goes with it. */
export function* renameServices(ctx, facts) {
  const site = yield* onlySite()
  const node = yield* nodeAt(site.treeId, '/uslugi')
  facts.pageId = node.pageId
  accepted(
    yield call('page_update', {
      pageId: node.pageId,
      expectedVersion: node.version,
      title: 'Цены',
      segment: 'ceny',
    }),
    'page_update',
  )
  return final({ summary: 'Renamed a page', message: 'Страница «Услуги» теперь «Цены».' })
}

/** Scenario R, the third turn: the client asked to delete «Ремонт»; it goes to the trash. */
export function* deleteRepair(ctx, facts) {
  const site = yield* onlySite()
  const node = yield* nodeAt(site.treeId, '/ceny/remont')
  facts.pageId = node.pageId
  facts.answer = accepted(
    yield call('page_delete', { pageIds: [node.pageId], confirmedByClient: true }),
    'page_delete',
  )
  return final({
    summary: 'Deleted a page to the trash',
    message: 'Страница «Ремонт» перенесена в корзину. 30 дней её можно вернуть.',
  })
}

// ─── Q: pages and documents of the agent ──────────────────────────────────────

/** Any refusal of a platform tool, by its code: the pages and documents refuse in their own. */
const codeOf = (answer) =>
  answer && typeof answer.code === 'string' && typeof answer.message === 'string'
    ? answer.code
    : null

/** The page scenario Q publishes: a file of the outbox, self-contained (docs/plan/69-pages.md, Ст6). */
export const STAND_PAGE = Object.freeze({
  file: 'prais.html',
  title: 'Прайс цветочной лавки',
  html: '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Прайс</title><style>h1{color:#a63d12}</style><h1>Прайс</h1><p>Букет — 1 500 ₽</p><script>document.body.dataset.ready = "1"</script></html>',
})

/** The document scenario Q writes by blocks (plan 88, §7.5), and its second words of a section. */
export const STAND_DOC = Object.freeze({
  title: 'Аудит скорости сайта',
  sections: [
    { id: 'summary', intent: 'Итог' },
    { id: 'steps', intent: 'Что сделать' },
  ],
  summary: 'Три причины медленной загрузки: большие картинки, лишние скрипты, нет кеша.',
  steps: '### По порядку\n\n1. Сжать картинки.\n2. Убрать лишние скрипты.',
  edited: 'Две причины медленной загрузки: большие картинки и нет кеша.',
  // The form of a JWT: the check of core sends back a write that carries one before anyone sees it.
  token:
    'Ключ доступа: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdGFuZCIsImlhdCI6MTc5MDAwMDAwMH0.c3RhbmQtc2lnbmF0dXJlLW9mLXRoZS1ydW4',
})

/** Scenario Q: a page of the outbox, published by its file — its address comes at once. */
export function* publishPage(ctx, facts) {
  // The file of the outbox, by the CLI's own shell: the one tool of files every turn declares.
  yield call('bash', {
    command: `cat > /workspace/out/${STAND_PAGE.file} <<'RADITI_PAGE'\n${STAND_PAGE.html}\nRADITI_PAGE`,
    description: 'Write the page',
  })
  const answer = yield call('page_publish', { file: STAND_PAGE.file, title: STAND_PAGE.title })
  facts.code = codeOf(answer)
  facts.url = typeof answer?.url === 'string' ? answer.url : null
  facts.version = answer?.version ?? null
  facts.live = answer?.live ?? null
  return final({
    summary: 'Published a page',
    changeType: 'none',
    message: facts.url ? `Страница готова: ${facts.url}` : 'Страницу опубликовать не получилось.',
  })
}

/**
 * Scenario Q: a document artifact with its skeleton (docs/plan/88-artifacts.md, Ар3, Ар4, §7.5), a
 * section written, a section with a JWT — taken by the role and sent back by the check of core,
 * the text before it stays — and a read that names the chat's own writes before the check.
 */
export function* writeDocument(ctx, facts) {
  // The view the client reads it in is the agent's choice since plan 74 (Д1): text, which
  // «Скачать .md» gives as Markdown; its link is the page to read all the same.
  const created = yield call('artifact_create', {
    kind: 'document',
    title: STAND_DOC.title,
    view: 'text',
    skeleton: STAND_DOC.sections,
  })
  facts.docId = typeof created?.artifactId === 'string' ? created.artifactId : null
  if (!facts.docId) throw new ScriptBroken(`artifact_create made nothing: ${codeOf(created)}`)
  const artifactId = facts.docId
  facts.written = codeOf(
    yield call('artifact_edit', {
      artifactId,
      opId: 'q-summary',
      ops: [
        {
          op: 'replace',
          block: 'summary',
          ifRev: 1,
          content: STAND_DOC.summary,
          props: { heading: 'Итог' },
        },
      ],
    }),
  )
  facts.token = codeOf(
    yield call('artifact_edit', {
      artifactId,
      opId: 'q-token',
      ops: [
        {
          op: 'replace',
          block: 'steps',
          ifRev: 1,
          content: STAND_DOC.token,
          props: { heading: 'Что сделать' },
        },
      ],
    }),
  )
  const read = yield call('artifact_read', { artifactId })
  facts.readOwn = Array.isArray(read?.blocks)
    ? read.blocks.map((block) => block.content ?? '').join('|')
    : null
  return final({
    summary: 'Started a document',
    changeType: 'none',
    message: 'Пишу документ: готов первый раздел.',
  })
}

/**
 * Scenario Q: the next turn reads which of its writes the check sent back, writes the last
 * section again under the revision it read, and asks for the link of the document (`page_publish`).
 */
export function* finishDocument(ctx, facts) {
  const artifactId = ctx.docId
  if (!artifactId) throw new ScriptBroken('the turn names no document')
  const read = yield call('artifact_read', { artifactId, part: 'outline' })
  facts.refused = Array.isArray(read?.refusedSinceYourRead) ? read.refusedSinceYourRead : null
  const steps = Array.isArray(read?.outline)
    ? read.outline.find((block) => block.id === 'steps')
    : null
  if (!steps) throw new ScriptBroken('the outline has no block steps')
  facts.written = codeOf(
    yield call('artifact_edit', {
      artifactId,
      opId: 'q-steps',
      ops: [
        {
          op: 'replace',
          block: 'steps',
          ifRev: steps.rev,
          content: STAND_DOC.steps,
          props: { heading: 'Что сделать' },
        },
      ],
    }),
  )
  const published = yield call('page_publish', { docId: artifactId })
  facts.code = codeOf(published)
  facts.url = typeof published?.url === 'string' ? published.url : null
  return final({
    summary: 'Finished the document',
    changeType: 'none',
    message: facts.url ? `Документ готов: ${facts.url}` : 'Документ готов.',
  })
}

/** Scenario Q: a section changed by a quote, and the next version of the document at the end. */
export function* editDocument(ctx, facts) {
  const artifactId = ctx.docId
  if (!artifactId) throw new ScriptBroken('the turn names no document')
  facts.written = codeOf(
    yield call('artifact_edit', {
      artifactId,
      opId: 'q-edit',
      ops: [{ op: 'edit', block: 'summary', find: STAND_DOC.summary, replace: STAND_DOC.edited }],
    }),
  )
  return final({
    summary: 'Edited the document',
    changeType: 'none',
    message: 'Поправил итог документа.',
  })
}

export const PROGRAMS = Object.freeze({
  publishSite,
  renameServices,
  deleteRepair,
  publishPage,
  writeDocument,
  finishDocument,
  editDocument,
  plainAnswer,
  readClientFile,
  openTheWeb,
  failAfterWriting,
  holdTheBrowser,
  holdWithForeignFiles,
})
