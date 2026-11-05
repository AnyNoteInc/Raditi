// S12, `verify:release --browser` (docs/plan/61-chats-first.md, §8): one chat holds both ways of
// changing a site — a candidate in the preview and, through `web_*`, a post on the live site — and
// `/release`, `/rollback`, `/cancel` and `/undo` each tell them apart. A run of its own: S1–S11, S13
// and S14 prove `{true,false}`, and here the project is `{true,true}`. The turns that change files
// are the scripts of the release stand; the turns in the browser are the programs of the
// browser-task stand, which read the pages they are given. Each PASS line is a fact of the product,
// of production or of the cabinet in a real Chromium with the real core behind it.
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { signIn, streamOperatorOf } from '../browser-task-verify/scenarios.mjs'
import { streamTools } from '../browser-task-verify/stream.mjs'
import { CheckFailed, exchange } from './runtime.mjs'
import { MODEL_TURNS, STYLE_PATH, TEXT, trpcProcedures } from './stand.mjs'

const MINUTE = 60_000
const PLUS = /^Инструменты/
const CHAT_PANEL = 'Инструменты чата'

/** The rows of one type of a chat, oldest first. */
const rowsOf = async (db, taskId, type) =>
  (await db.taskEvent.findMany({ where: { taskId, type }, orderBy: { id: 'asc' } })).map(
    (row) => row.payload,
  )

/** A page of the cabinet in Chromium, with the session of the owner. */
async function cabinet(stand) {
  const require = createRequire(join(stand.copy, 'packages/browser-providers/package.json'))
  const { chromium } = require('playwright-core')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'ru-RU',
  })
  await context.addCookies(
    stand.owner
      .cookie()
      .split('; ')
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf('=')
        return { name: pair.slice(0, at), value: pair.slice(at + 1), url: stand.webUrl }
      }),
  )
  const page = await context.newPage()
  const calls = []
  page.on('request', (request) => calls.push(...trpcProcedures(request.url())))
  return { browser, page, calls }
}

const openChat = async (stand, page, taskId) => {
  await page.goto(`${stand.webUrl}/chats/${taskId}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: PLUS }).waitFor({ timeout: 60_000 })
}

const field = (page) => page.getByRole('textbox', { name: 'Сообщение' })
const commands = (page) => page.getByRole('listbox', { name: 'Команды' })
const feed = (page) => page.getByRole('list', { name: 'Сообщения чата' })

/** A command of the list, as the client gives it: its slash in the field, then Enter. */
async function command(page, slash) {
  await field(page).fill(slash)
  await commands(page).waitFor({ timeout: 15_000 })
  await page.keyboard.press('Enter')
}

export async function runBrowserScenario(stand, tools) {
  const { rt, db, owner, site, siteUrl, siteId, model, content } = stand
  const {
    agentHead,
    currentCandidate,
    previewReady,
    redoneRow,
    releaseEnds,
    rewoundRow,
    taskReaches,
    turnReaches,
    undoPlan,
    uuid7,
  } = tools
  const full = { ...stand, streamTools: streamTools(stand.copy, stand.modules.domain) }
  const programmed = () => {
    const current = model.current()
    if (current?.broken) throw new CheckFailed(`the scripted model stopped: ${current.broken}`)
    return current?.facts ?? {}
  }
  const finished = async (reach) => {
    const task = await reach
    if (model.current() && !model.current().finished)
      throw new CheckFailed(`the program ${model.current().name} did not finish`)
    programmed()
    return task
  }

  // The account of the client: an editor with a password of the run, typed into the panel only.
  const password = rt.secret(`Synth-${randomBytes(12).toString('base64url')}`)
  await site.wp(['user', 'create', 'stand-editor', 'editor@example.test', '--role=editor'])
  await site.wp(['user', 'update', 'stand-editor', '--skip-email', '--prompt=user_pass'], {
    input: `${password}\n`,
  })
  const editor = { login: 'stand-editor', password }
  const newChat = async (text, turn, { inPreview = false } = {}) => {
    const taskId = uuid7()
    // A turn that writes into the preview waits until it is built: a precondition of the stand.
    const waitFor = inPreview ? () => previewReady(taskId, 0, 6 * MINUTE).catch(() => {}) : null
    model.script(turn, { waitFor })
    await owner.mutate('task.create', { siteId, taskId, text })
    return taskId
  }
  /** Next words, the program of the turn they start. */
  const askProgram = async (taskId, text, program, ctx) => {
    model.program(program, ctx)
    await owner.mutate('task.message', { taskId, requestId: uuid7(), text })
  }
  /** The agent asks for a sign-in; the client signs in over the stream of the same browser. */
  const signedIn = async (taskId, turn, words) => {
    await askProgram(taskId, words, 'askToSignIn')
    await finished(turnReaches(taskId, turn, 'awaiting_user'))
    const facts = programmed()
    const operator = await streamOperatorOf(full, owner, taskId)
    await signIn(full, operator, editor, siteUrl)
    return { facts, operator }
  }
  /** «Продолжить работу агента»: the client lets go, and the program of the next turn starts. */
  const resumed = async (taskId, operator, program, ctx) => {
    model.program(program, ctx)
    await owner.mutate('task.resumeAgent', { taskId, requestId: uuid7() })
    await rt.until(
      'the next turn to take the browser back',
      async () => operator.state()?.controller === 'agent',
      { timeoutMs: 2 * MINUTE, intervalMs: 100 },
    )
    operator.close()
  }

  // ── S12a ─────────────────────────────────────────────────────────────────────
  rt.begin('S12a', 'a candidate and a post through `web_*` in one chat; the panel of the browser')
  const chat = await newChat('Добавьте отметку отмены в стили темы.', MODEL_TURNS.undoMark(1))
  await taskReaches(chat, 'awaiting_approval')
  const row = await db.task.findUniqueOrThrow({ where: { id: chat } })
  const candidate = await currentCandidate(chat)
  await previewReady(chat, 1)
  rt.check(
    row.needsRepository === true &&
      row.needsBrowser === true &&
      candidate?.revision === 1 &&
      (await db.browserSession.count({ where: { taskId: chat } })) === 0,
    'a project with files and the browser: `{true,true}`, the candidate of the first turn, no browser started by a turn without `web_*`',
    { repository: row.needsRepository, browser: row.needsBrowser, revision: candidate?.revision },
  )
  const { facts: asked, operator } = await signedIn(chat, 2, TEXT.browserAskWords)
  const question = (await rowsOf(db, chat, 'feed.question')).at(-1)
  const candidateAsked = await currentCandidate(chat)
  rt.check(
    asked.help === 'requested' &&
      asked.loginPage === true &&
      JSON.stringify(question ?? null).includes('login') &&
      candidateAsked?.id === candidate.id,
    'the agent found the sign-in form and asked the client to sign in; the candidate stands',
    { help: asked.help, question },
  )
  const session = await db.browserSession.findFirstOrThrow({ where: { taskId: chat } })
  rt.check(
    session.siteId === siteId && session.closedAt === null && operator.holds(),
    'the client signed in over the stream of the same browser (the list of posts opened), a session of the site',
    { controller: operator.state()?.controller },
  )
  {
    const { browser, page } = await cabinet(stand)
    try {
      await openChat(stand, page, chat)
      await page.getByRole('button', { name: PLUS }).click()
      const menu = page.getByRole('menu', { name: 'Инструменты' })
      await menu.getByRole('menuitem', { name: /^Браузер/ }).waitFor({ timeout: 30_000 })
      const tiles = await menu.getByRole('menuitem').allTextContents()
      await menu.getByRole('menuitem', { name: /^Браузер/ }).click()
      const panel = page.getByRole('complementary', { name: CHAT_PANEL })
      await panel.getByRole('tab', { name: 'Браузер', selected: true }).waitFor({ timeout: 30_000 })
      await panel.locator('canvas').waitFor({ timeout: 30_000 })
      rt.check(
        tiles.some((tile) => tile.includes('изменения')) &&
          tiles.some((tile) => tile.includes('Предпросмотр')),
        'the tools of one chat: the preview, the changes and the browser, whose panel shows the canvas of the stream',
        tiles,
      )
    } finally {
      await browser.close()
    }
  }
  await resumed(chat, operator, 'publishPlainNews', { words: TEXT.browserNews })
  await finished(turnReaches(chat, 3, 'awaiting_approval'))
  const news = programmed().published
  const written = (await rowsOf(db, chat, 'feed.result')).at(-1)
  const postId = Number(new URL(news.object.editUrl).searchParams.get('post'))
  const liveStatus = () => site.sql(`SELECT post_status FROM wp_posts WHERE ID = ${postId}`)
  rt.check(
    (await liveStatus()) === 'publish' &&
      written?.site === 'changed' &&
      written.objects?.length === 1,
    'the post is published on the live site at once, and the row of the pass names it: `site: changed`',
    { site: written?.site, objects: written?.objects },
  )
  rt.check(
    (await currentCandidate(chat))?.id === candidate.id,
    'the post went past the candidate: its revision is the same',
  )
  // The password the client typed (the sign-in let them in, the agent then published as them)
  // reached neither the model nor what the platform keeps of the chat (rule 2, Б19).
  const asked4 = model.chats()
  const kept = JSON.stringify(
    [
      await db.taskEvent.findMany({ where: { taskId: chat } }),
      await db.browserSession.findMany({ where: { taskId: chat } }),
    ],
    (_, value) => (typeof value === 'bigint' ? value.toString() : value),
  )
  rt.check(
    asked4.length > 0 &&
      asked4.every((request) => !JSON.stringify(request.body ?? null).includes(password)) &&
      !kept.includes(password),
    `the password typed in the panel is in none of ${asked4.length} requests to the model, the events of the chat or its browser sessions`,
  )
  model.script(MODEL_TURNS.undoNothing())
  await owner.mutate('task.message', {
    taskId: chat,
    requestId: uuid7(),
    text: 'Что сейчас в стилях темы?',
  })
  await turnReaches(chat, 4, 'awaiting_approval')
  const answer = (await rowsOf(db, chat, 'feed.result')).at(-1)
  rt.check(
    !['changed', 'check'].includes(answer?.site) && !answer?.objects?.length,
    'an answer about the code after the post has no line of the site: the row is of this pass alone',
    answer,
  )
  rt.end()

  // ── S12b ─────────────────────────────────────────────────────────────────────
  rt.begin('S12b', '/release of the chat, /rollback: the files go back, the post stays')
  const prepared = await owner.query('release.prepare', { taskId: chat })
  const choice = prepared.choices.find((option) => option.version === prepared.proposal.version)
  const confirmed = await owner.mutate('release.confirm', {
    taskId: chat,
    confirmToken: choice.confirmToken,
    version: prepared.proposal.version,
  })
  const installed = await releaseEnds(confirmed.releaseId)
  rt.check(
    installed.status === 'installed' &&
      (await site.files.read(STYLE_PATH)).includes(TEXT.undoMark(1)) &&
      (await liveStatus()) === 'publish',
    `/release of a chat that also wrote on the site: ${installed.version} is installed, the file of the candidate and the post are both on the site`,
    { status: installed.status },
  )
  {
    const { browser, page } = await cabinet(stand)
    try {
      await openChat(stand, page, chat)
      // The chat ended with the release: `/rollback` is its button, the field takes no words.
      await feed(page).getByRole('button', { name: 'Отменить выпуск' }).click({ timeout: 60_000 })
      const window = page.getByRole('dialog').first()
      await window.waitFor({ timeout: 60_000 })
      // The plan comes from production: the window says what it found once it has it.
      const textOf = async () => (await window.innerText()).replaceAll('\u00a0', ' ')
      await rt
        .until('the plan in the window', async () => /Файлы/.test(await textOf()), {
          timeoutMs: 2 * MINUTE,
          intervalMs: 500,
        })
        .catch(() => {})
      const said = await textOf()
      rt.check(
        said.includes('То, что агент сделал на сайте через браузер, останется.'),
        'the window of /rollback says that what the agent did on the site through the browser stays',
        said,
      )
    } finally {
      await browser.close()
    }
  }
  const plan = await undoPlan({ taskId: chat }, installed)
  const undone = await owner.mutate('release.undoConfirm', {
    taskId: chat,
    releaseId: installed.id,
    confirmToken: plan.confirmToken,
    version: plan.version,
  })
  const rolled = await releaseEnds(undone.undoId)
  rt.check(
    rolled.kind === 'undo' &&
      rolled.status === 'installed' &&
      !(await site.files.read(STYLE_PATH)).includes(TEXT.undoMark(1)) &&
      (await liveStatus()) === 'publish',
    `/rollback came out as ${rolled.version}: the file went back, the post of the browser stays published`,
    { status: rolled.status },
  )
  rt.end()

  // ── S12c ─────────────────────────────────────────────────────────────────────
  rt.begin('S12c', 'one object both ways: refused; /undo and /cancel say to check the site')
  const route = `/wp/v2/pages/${content.contactsId}`
  const conflict = await newChat(
    'Назовите страницу контактов иначе.',
    MODEL_TURNS.retitleInPreview({ route, title: TEXT.browserConflict }),
    { inPreview: true },
  )
  await taskReaches(conflict, 'awaiting_approval')
  await previewReady(conflict, 1)
  const liveFirst = await signedIn(conflict, 2, 'И на самом сайте назовите её по-другому.')
  await resumed(conflict, liveFirst.operator, 'retitlePage', {
    pageId: content.contactsId,
    title: TEXT.browserLive,
  })
  await finished(turnReaches(conflict, 3, 'awaiting_approval'))
  const titled = await site.sql(
    `SELECT post_title FROM wp_posts WHERE ID = ${Number(content.contactsId)}`,
  )
  rt.check(
    titled === TEXT.browserLive,
    'the agent changed the page on the live site through the browser; the plan of the candidate holds the same page',
    { title: titled },
  )
  const preparedConflict = await owner.query('release.prepare', { taskId: conflict })
  const confirmedConflict = await owner.mutate('release.confirm', {
    taskId: conflict,
    confirmToken: preparedConflict.choices.find(
      (option) => option.version === preparedConflict.proposal.version,
    ).confirmToken,
    version: preparedConflict.proposal.version,
  })
  const refused = await releaseEnds(confirmedConflict.releaseId)
  rt.check(
    refused.status === 'failed' &&
      refused.errorCode === 'db_conflict' &&
      refused.mainPushedAt === null,
    'the second line holds: the release of one object changed both ways is refused `db_conflict` before main moves',
    { status: refused.status, error: refused.errorCode },
  )
  await taskReaches(conflict, 'awaiting_approval', { timeoutMs: 3 * MINUTE })
  const undoneTurn = await owner.mutate('task.undoTurn', {
    taskId: conflict,
    requestId: uuid7(),
  })
  const rewind = await rewoundRow(conflict)
  rt.check(
    undoneTurn.repeated === false &&
      rewind.payload.site === 'check' &&
      (await site.sql(
        `SELECT post_title FROM wp_posts WHERE ID = ${Number(content.contactsId)}`,
      )) === TEXT.browserLive,
    '/undo of the turn in the browser takes the request back and says to check the site: what it did there stays',
    rewind.payload,
  )
  await owner.mutate('task.cancel', { taskId: conflict, requestId: uuid7() })
  await taskReaches(conflict, 'cancelled', { timeoutMs: 2 * MINUTE })
  const ended = (await rowsOf(db, conflict, 'feed.cancelled')).at(-1)
  rt.check(
    ended?.site === 'check' && ended.objects?.length > 0,
    '/cancel names what the chat left on the site and says `check`',
    ended,
  )
  const closed = await owner.call('query', 'release.prepare', { taskId: conflict })
  const releaseRefusal = (await owner.query('task.feed', { taskId: conflict })).commands.find(
    (item) => item.id === 'release',
  )?.refusal
  rt.check(
    !closed.ok &&
      closed.domainCode === 'CHAT_COMMAND_UNAVAILABLE' &&
      typeof releaseRefusal === 'string',
    `/release after /cancel is refused as an unavailable command (${releaseRefusal})`,
    closed,
  )
  const sessionsLeft = await rt.until(
    'the browsers of the chats to close',
    async () => {
      const rows = await db.browserSession.findMany({
        where: { taskId: { in: [chat, conflict] }, closedAt: null },
      })
      return rows.length === 0 ? rows : null
    },
    { timeoutMs: 2 * MINUTE, intervalMs: 1000, service: stand.processes.core },
  )
  rt.check(sessionsLeft.length === 0, 'the browsers of both chats closed with them')
  rt.end()

  // ── S12d ─────────────────────────────────────────────────────────────────────
  // The cabinet with the real core (`test:site` runs without it): `/undo` and `/redo` of a turn
  // with files, from the field of the page to the branch (the preview of a rewind is S11's).
  rt.begin('S12d', 'the cabinet with core: /undo and /redo of a turn with files')
  const withFiles = await newChat('Добавьте отметку отмены в стили темы.', MODEL_TURNS.undoMark(1))
  await taskReaches(withFiles, 'awaiting_approval')
  await previewReady(withFiles, 1)
  const first = await currentCandidate(withFiles)
  model.script(MODEL_TURNS.undoMark(2))
  await owner.mutate('task.message', {
    taskId: withFiles,
    requestId: uuid7(),
    text: TEXT.browserUndoWords,
  })
  await turnReaches(withFiles, 2, 'awaiting_approval')
  await previewReady(withFiles, 2)
  const second = await currentCandidate(withFiles)
  {
    const { browser, page } = await cabinet(stand)
    try {
      await openChat(stand, page, withFiles)
      await command(page, '/undo')
      await feed(page)
        .getByText('Переписка и файлы возвращены.')
        .waitFor({ timeout: 2 * MINUTE })
      await rewoundRow(withFiles)
      rt.check(
        (await field(page).inputValue()) === TEXT.browserUndoWords &&
          (await agentHead(withFiles)) === first.headSha,
        '/undo in the cabinet: the page says the conversation and the files are back, the words stand in the field, the branch is on the head of turn 1',
        { words: await field(page).inputValue() },
      )
      await page.getByRole('button', { name: 'Команды' }).click()
      await commands(page)
        .getByRole('option', { name: /Вернуть отменённый запрос/ })
        .click()
      await feed(page)
        .getByText('Отменённый запрос и его файлы возвращены.')
        .waitFor({ timeout: 2 * MINUTE })
      await redoneRow(withFiles)
      rt.check(
        (await field(page).inputValue()) === '' && (await agentHead(withFiles)) === second.headSha,
        '/redo in the cabinet: the request and its files are back, the field is empty, the branch is on the head of turn 2',
        { head: await agentHead(withFiles) },
      )
    } finally {
      await browser.close()
    }
  }
  await owner.mutate('task.cancel', { taskId: withFiles, requestId: uuid7() })
  await taskReaches(withFiles, 'cancelled', { timeoutMs: 2 * MINUTE })
  const worker = await exchange(`${stand.workerUrl}/v1/sessions`, {
    headers: { authorization: `Bearer ${stand.workerToken}` },
  })
  rt.check(
    worker.status === 200 && worker.json.sessions.length === 0,
    'the worker holds no session at the end of the run',
    worker.json,
  )
  rt.end()
}
