// The group `preview` of the stand of the site stacks (verify-stack.mjs; docs/plan/62-site-stacks.md,
// Т33, Т35, Т48, М2к, М3; docs/plan/62-slices/e3.md, Э3.11): on the site the group `import` made of
// each build, a dialog of the owner (`task.create`) whose first turn the scripted model holds until
// the preview of the dialog is ready, then the preview as core built it — its record, the shop
// window through the gateway and a ticket, its database by SQL as root, the agent's browser in the
// turn — and the panel of the stack signed in to inside the cabinet's frame, in Chromium and in
// WebKit. The stack is named only by its record of STACK_STANDS: the scenarios read what it says.
import { randomBytes } from 'node:crypto'

import { CheckFailed, exchange } from '../release-verify/runtime.mjs'
import { PREVIEW_ROOT_QUERY } from '../release-verify/stand.mjs'
import { frameEnginesOn, openCabinetFrame, startSecureForwarder } from './frame.mjs'
import {
  browserTurn,
  canonicalLinks,
  navigationStatus,
  pageProblems,
  refusalCode,
  toolCallsOf,
  uuid7,
} from './stand.mjs'

const MINUTE = 60_000

/** The preview of a dialog ready at revision 0, untouched by a browser that writes. */
function previewReady(rt, ctx, taskId) {
  return rt.until(
    `the preview of ${taskId} ready at revision 0`,
    async () => {
      const row = await ctx.db.previewEnvironment.findUnique({ where: { taskId } })
      if (['failed', 'unavailable', 'destroyed'].includes(row?.status))
        throw new CheckFailed(
          `the preview of ${taskId} is ${row.status}: ${row.errorCode ?? row.unavailableReason}`,
        )
      return row?.status === 'ready' && row.revision === 0 && !row.dirty ? row : null
    },
    { timeoutMs: 10 * MINUTE, intervalMs: 500, service: ctx.processes.core },
  )
}

/** The dialog in one of `statuses`; one that ended elsewhere fails at once. */
function dialogReaches(rt, ctx, taskId, statuses) {
  return rt.until(
    `dialog ${taskId} in ${statuses.join('|')}`,
    async () => {
      const task = await ctx.db.task.findUniqueOrThrow({ where: { id: taskId } })
      if (statuses.includes(task.status)) return task
      if (['failed', 'cancelled', 'done', 'rolled_back'].includes(task.status))
        throw new CheckFailed(`dialog ${taskId} ended ${task.status}`)
      return null
    },
    { timeoutMs: 12 * MINUTE, intervalMs: 1000, service: ctx.processes.core },
  )
}

/** A query of the preview's own database as root on its socket, its answer as text. */
function previewSql(rt, previewId) {
  return async (query) => {
    const listed = await rt.docker([
      'ps',
      '-q',
      '--filter',
      `label=io.raditi.preview.id=${previewId}`,
      '--filter',
      'label=io.raditi.preview.role=preview',
    ])
    const container = listed.output.split('\n').find(Boolean)
    if (!container) throw new CheckFailed(`the container of preview ${previewId} is not running`)
    const answer = await rt.docker([
      'exec',
      '-u',
      '0:0',
      container,
      'sh',
      '-c',
      PREVIEW_ROOT_QUERY,
      'sh',
      query,
    ])
    return answer.output
  }
}

/**
 * The preview as the owner opens it: a ticket of `preview.ticket`, the entry of the gateway that
 * makes it the session cookie, then the pages — every request to the gateway on the loopback with
 * the preview's own Host.
 */
export async function previewVisit(rt, ctx, taskId, paths) {
  const { url } = await ctx.owner.mutate('preview.ticket', { taskId })
  const entry = new URL(url)
  const gateway = (path) => `http://127.0.0.1:${ctx.ports.preview}${path}`
  const enter = await exchange(gateway(`${entry.pathname}${entry.search}`), {
    headers: { host: entry.host },
    signal: rt.signal,
  })
  if (enter.status !== 303)
    throw new CheckFailed(`the gateway answered ${enter.status} to the ticket`)
  const cookie = (enter.headers['set-cookie'] ?? []).map((line) => line.split(';')[0]).join('; ')
  const pages = {}
  for (const path of paths) {
    const page = await exchange(gateway(path), {
      headers: { host: entry.host, cookie },
      signal: rt.signal,
    })
    pages[path] = page
  }
  return { origin: `${entry.protocol}//${entry.host}`, pages }
}

/** P1–P4 of one build: the dialog, its turn, the preview it was held for. */
async function previewOfBuild(rt, ctx, entry) {
  const { db, owner, model } = ctx
  const { stand, build, production, siteId } = entry
  const taskId = uuid7()
  entry.taskId = taskId
  const chatsBefore = model.chats().length
  rt.note(
    `the first answer of the scripted model in the dialog of ${build.archive} waits until its preview is ready: a precondition of the stand`,
  )
  model.script(browserTurn(stand.browserPaths), {
    waitFor: async () => {
      await previewReady(rt, ctx, taskId).catch(() => null)
      // The sandbox of the turn lives only while the turn does (SANDBOX_WARM_MINUTES 0): its
      // runtime is read now, while the turn waits for this answer, and checked in P4.
      entry.turnRuntimes = await containerRuntimes(rt, [
        `label=io.raditi.sandbox.siteId=${siteId}`,
      ]).catch((error) => ({ error: error.message }))
    },
  })
  await owner.mutate('task.create', {
    siteId,
    taskId,
    text: 'Посмотрите, как выглядит сайт, ничего не меняйте.',
  })
  const task = await dialogReaches(rt, ctx, taskId, ['awaiting_user'])

  rt.begin(`P1 ${build.archive}`, 'предпросмотр готов')
  const row = await previewReady(rt, ctx, taskId)
  rt.check(
    row.status === 'ready' && row.revision === 0 && row.candidateId === null,
    'preview_environments: ready at revision 0, the base of the dialog',
    { status: row.status, revision: row.revision },
  )
  const record = row.runtime ?? {}
  rt.check(
    record.web === ctx.siteImages[build.php],
    `record.web is the image site of PHP ${build.php}`,
    { web: record.web },
  )
  rt.check(row.unavailableReason === null, 'unavailable_reason is empty', {
    reason: row.unavailableReason,
  })
  rt.check(
    record.seedTablesLeftOut === 0 && record.seedColumnsEmptied === 0,
    'the record counts the tables left out and the columns emptied: none on a clean release',
    { tables: record.seedTablesLeftOut, columns: record.seedColumnsEmptied },
  )
  rt.end()

  rt.begin(`P2 ${build.archive}`, 'витрина')
  const page = stand.page(build)
  const visit = await previewVisit(rt, ctx, taskId, ['/', page.path])
  const home = visit.pages['/']
  rt.check(
    home.status === 200 && home.headers['x-raditi-preview'] === '1',
    'the home page answers 200 with x-raditi-preview, through the gateway and its ticket',
    { status: home.status, header: home.headers['x-raditi-preview'] ?? null },
  )
  const article = visit.pages[page.path]
  rt.check(
    article.status === 200 && article.text.includes(page.text),
    `the page ${page.path} answers 200 at its friendly address with its text`,
    { status: article.status },
  )
  const facts = { productionOrigin: production.origin, previewOrigin: visit.origin }
  for (const [path, answer] of Object.entries(visit.pages))
    rt.check(
      pageProblems(answer.text, facts).length === 0,
      `${path}: no error of PHP, no link to ${new URL(production.origin).host}, no canonical link off the preview`,
      pageProblems(answer.text, facts),
    )
  // The control: production names itself in the canonical links its SEF settings make, so a
  // page of the preview without them is the copy's doing, not a page that never had one.
  const named = []
  for (const path of ['/', page.path]) {
    const answer = await exchange(`${production.origin}${path}`, { signal: rt.signal })
    named.push(...canonicalLinks(answer.text).filter((link) => link.startsWith(production.origin)))
  }
  rt.check(
    named.length >= 2,
    'control: production gives both pages a canonical link on its own address',
    { links: named.length },
  )
  if (stand.scannerFinds?.(build))
    rt.note(
      'the scanner dropped files of this build at the import (I2): the shop window above stands without them (Т48)',
    )
  rt.end()

  rt.begin(`P3 ${build.archive}`, 'копия базы')
  for (const check of await stand.copyChecks(previewSql(rt, row.id)))
    rt.check(check.ok, check.name, check.found)
  rt.end()

  rt.begin(`P4 ${build.archive}`, 'браузер агента')
  const asked = model
    .chats()
    .slice(chatsBefore)
    .map((request) => request.body)
    .filter((body) => Array.isArray(body?.messages))
  const calls = toolCallsOf(asked.at(-1)).filter((call) =>
    String(call.name).endsWith('browser_navigate'),
  )
  const resultOf = (path) => calls.find((call) => call.args?.path === path)?.result ?? null
  const { closed, open } = stand.browserPaths
  rt.check(
    calls.length === closed.length + 2,
    `the turn called browser_navigate ${closed.length + 2} times and got an answer to each`,
    calls.map((call) => ({ path: call.args?.path, answered: call.result !== null })),
  )
  rt.check(
    refusalCode(resultOf('/')) === null && navigationStatus(resultOf('/')) === 200,
    'browser_navigate / opens the home page of the preview (200)',
    { refusal: refusalCode(resultOf('/')) },
  )
  for (const path of closed)
    rt.check(
      refusalCode(resultOf(path)) === 'BROWSER_PATH_DENIED',
      `browser_navigate ${path} is refused BROWSER_PATH_DENIED by the policy of the stack`,
      { refusal: refusalCode(resultOf(path)) },
    )
  rt.check(
    refusalCode(resultOf(open)) === null && navigationStatus(resultOf(open)) === 200,
    `control: browser_navigate ${open} opens an image of the media library (200)`,
    { refusal: refusalCode(resultOf(open)) },
  )
  rt.check(
    task.status === 'awaiting_user',
    'the turn did not fail on the refusals: the dialog waits for the owner',
    { status: task.status },
  )
  // What the run says of its runtime is what Docker ran (Э3.16): a run under runsc that went
  // under runc would look like a proof of О2.
  const turn = Object.values(entry.turnRuntimes ?? {})
  rt.check(
    turn.length > 0 && turn.every((runtime) => runtime === ctx.runtime),
    `docker inspect: the sandbox of the turn ran under ${ctx.runtime} (HostConfig.Runtime)`,
    entry.turnRuntimes ?? null,
  )
  for (const role of ['preview', 'browser']) {
    const found = await containerRuntimes(rt, [
      `label=io.raditi.preview.site=${siteId}`,
      `label=io.raditi.preview.role=${role}`,
    ])
    rt.check(
      Object.keys(found).length > 0 &&
        Object.values(found).every((runtime) => runtime === ctx.runtime),
      `docker inspect: the ${role === 'preview' ? 'container of the preview' : "agent's browser of the preview"} runs under ${ctx.runtime} (HostConfig.Runtime)`,
      found,
    )
  }
  rt.end()
  return row
}

/**
 * The runtime Docker runs each live container of `filters` under (`HostConfig.Runtime`), by name.
 * Docker writes the daemon's default there when a container named none.
 */
export async function containerRuntimes(rt, filters) {
  const listed = await rt.docker(['ps', '-q', ...filters.flatMap((filter) => ['--filter', filter])])
  const ids = listed.output.split('\n').filter(Boolean)
  if (ids.length === 0) return {}
  const inspected = await rt.docker([
    'inspect',
    '--format',
    '{{.Name}} {{.HostConfig.Runtime}}',
    ...ids,
  ])
  return parseRuntimes(inspected.output)
}

/** `/<name> <runtime>` lines of `docker inspect` → `{ name: runtime }`. */
export function parseRuntimes(output) {
  const runtimes = {}
  for (const line of output.split('\n')) {
    const match = /^\/?(\S+) (\S+)$/.exec(line.trim())
    if (match) runtimes[match[1]] = match[2]
  }
  return runtimes
}

/**
 * P5 of one build in one engine: the cabinet's page on APP_URL holds the preview in its frame
 * through the real gateway and a ticket of `preview.ticket`, and the owner signs in to the panel of
 * the stack inside it. The control of a cross-site frame first: a cookie of a script without
 * attributes does not live in the frame and lives in a tab — otherwise the row does not count.
 */
async function signInInFrame(rt, ctx, entry, { engine, forwarder, login, password }) {
  const { stand, build, taskId } = entry
  const sign = stand.signIn(build)
  rt.begin(`P5 ${build.archive} ${engine}`, 'вход в панель в кадре')
  const ticket = async (to) => (await ctx.owner.mutate('preview.ticket', { taskId, to })).url
  const cabinet = await openCabinetFrame({
    engine,
    appOrigin: ctx.webUrl,
    enterUrl: await ticket(sign.path),
    forwarder: engine === 'webkit' ? forwarder : null,
  })
  try {
    const form = await cabinet.frame
      .locator(sign.fields.login)
      .waitFor({ state: 'visible', timeout: MINUTE })
      .then(
        () => null,
        async () => await cabinet.whereIsFrame(),
      )
    if (form !== null)
      throw new CheckFailed(
        `the frame shows no form of sign-in at ${sign.path}: ${JSON.stringify(form)}`,
      )
    const inFrame = await cabinet.frameOf()
    const frameKeeps = await cabinet.keepsPlainCookie(inFrame)
    const tab = await cabinet.tab(await ticket('/'))
    const tabKeeps = await cabinet.keepsPlainCookie(tab)
    const tabOrigin = new URL(tab.url()).origin
    await tab.close()
    rt.check(
      !frameKeeps && tabKeeps && new URL(inFrame.url()).origin === tabOrigin,
      `control: the frame is cross-site — a cookie of a script without attributes does not live in it and lives in a tab of the preview (${engine} ${cabinet.version})`,
      { frame: frameKeeps, tab: tabKeeps },
    )
    const field = (selector) => cabinet.frame.locator(selector)
    const shows = async (selector) => (await field(selector).count()) > 0
    const submit = async (secret) => {
      await field(sign.fields.login).fill(login)
      await field(sign.fields.password).fill(secret)
      await field(sign.submit).click()
    }
    const failedWords = async () => {
      const frame = await cabinet.frameOf()
      const text = frame ? await frame.evaluate(() => document.body?.innerText ?? '') : ''
      return sign.lostCookie.filter((words) => text.includes(words))
    }
    // The controls of the reading below: the form has no mark of the panel, and a wrong password
    // leaves the form and a text of a failed sign-in — what a sign-in that did not hold shows.
    rt.check(
      !(await shows(sign.signedIn)),
      `control: the form of sign-in shows no ${sign.signedIn}`,
    )
    await submit(`${password}-wrong`)
    const refused = await rt
      .until(
        'a text of a failed sign-in in the frame',
        async () => {
          const words = await failedWords()
          return words.length > 0 ? words : null
        },
        { timeoutMs: MINUTE, intervalMs: 500 },
      )
      .catch(() => [])
    rt.check(
      refused.length > 0 && (await shows(sign.fields.login)) && !(await shows(sign.signedIn)),
      'control: a wrong password leaves the form and a text of a failed sign-in, no mark of the panel',
      { refused, form: await shows(sign.fields.login), panel: await shows(sign.signedIn) },
    )
    await field(sign.fields.login).waitFor({ state: 'visible', timeout: MINUTE })
    await submit(password)
    // Signed in: the form is gone from the frame and the mark only the panel has is there.
    const signedIn = await field(sign.fields.login)
      .waitFor({ state: 'detached', timeout: MINUTE })
      .then(() => field(sign.signedIn).first().waitFor({ state: 'attached', timeout: MINUTE }))
      .then(
        () => true,
        () => false,
      )
    const frame = await cabinet.frameOf()
    const lost = await failedWords()
    rt.check(
      signedIn && lost.length === 0,
      `the panel of the stack is signed in to inside the frame: the form is gone, ${sign.signedIn} is there, no text of a failed sign-in`,
      { signedIn, lost, at: frame ? new URL(frame.url()).pathname : null },
    )
    rt.check(
      new URL(frame.url()).pathname.startsWith(sign.path),
      `the frame stands on the panel (${sign.path})`,
      { at: new URL(frame.url()).pathname },
    )
    rt.note(
      `cookies of the preview in ${engine}: ${(await cabinet.cookieNames(inFrame.url())).join(', ')}`,
    )
  } finally {
    await cabinet.close()
  }
  rt.end()
}

/** Every container, volume and network Docker holds with the labels of core for a site. */
export async function dockerOfSite(rt, siteId) {
  const left = []
  for (const label of [
    'io.raditi.preview.site',
    'io.raditi.sandbox.siteId',
    'io.raditi.gateway.siteId',
  ])
    for (const kind of [
      ['ps', '-aq'],
      ['volume', 'ls', '-q'],
      ['network', 'ls', '-q'],
    ])
      left.push(
        ...(await rt.docker([...kind, '--filter', `label=${label}=${siteId}`])).output
          .split('\n')
          .filter(Boolean)
          .map((id) => `${kind[0]} ${id}`),
      )
  return left
}

/**
 * The dialog of a build closed by `/cancel`, as the owner closes one: core destroys its preview and
 * the browser of its agent, and Docker holds nothing with the labels of the site — the stand never
 * has to remove what core owns (verify-stack.mjs, `cleanup`).
 */
async function closeDialog(rt, ctx, entry) {
  const { build, taskId, siteId } = entry
  rt.begin(`Pc ${build.archive}`, 'диалог закрыт, предпросмотр убран')
  const cancelled = await ctx.owner.mutate('task.cancel', { taskId, requestId: uuid7() })
  rt.check(cancelled.state === 'cancelled', 'the dialog is cancelled by /cancel', cancelled)
  await rt.until(
    `the preview of ${taskId} is destroyed`,
    async () =>
      (await ctx.db.previewEnvironment.count({
        where: { siteId, status: { not: 'destroyed' } },
      })) === 0,
    { timeoutMs: 5 * MINUTE, intervalMs: 1000, service: ctx.processes.core },
  )
  const leftOfSite = () => dockerOfSite(rt, siteId)
  const left = await rt
    .until(
      'Docker holds nothing of the site',
      async () => ((await leftOfSite()).length === 0 ? [] : null),
      {
        timeoutMs: 3 * MINUTE,
        intervalMs: 2000,
      },
    )
    .catch(() => leftOfSite())
  rt.check(
    left.length === 0,
    'core destroyed the preview, its browser and the sandbox of the turn: Docker holds no container, network or volume with the labels of the site',
    left,
  )
  rt.end()
}

/**
 * The group `preview` on the builds `import` made a site of: P1–P4, then P5 in the engines of the
 * host (`frameEnginesOn`: on Linux WebKit is a NOTE with its reason, О2б (а), the owner's answer). A
 * failed P5 is the failed row of its engine and nothing more: the sign-in in the cabinet's frame
 * gives the group `release` nothing it needs — the site, the preview and the closed dialog are there
 * after P1–P4 — so the dialog is still closed and `release` still runs (Э3.16: a P5 of WebKit on
 * Linux must not hide the answer to О2). Returns `{ failed, noted }`: the rows of P5 that failed —
 * the run fails on them after the other groups (verify-stack.mjs) — and the ids of P5 it only noted
 * (`frameRowProblems`, frame.mjs). Anything else that fails ends the group as before.
 */
export async function runPreviewGroup(rt, ctx, entries) {
  const failed = []
  const noted = []
  const forwarder = await startSecureForwarder({
    key: ctx.certificates.key,
    cert: ctx.certificates.cert,
    gatewayPort: ctx.ports.preview,
  })
  try {
    for (const entry of entries) {
      if (!entry.siteId) throw new Error(`The build ${entry.build.archive} has no site of import`)
      const row = await previewOfBuild(rt, ctx, entry)
      // The panel's password is the stand's: the copy keeps a random hash (stand.signIn).
      const password = rt.secret(randomBytes(12).toString('hex'))
      const login = await entry.stand
        .signIn(entry.build)
        .setPassword(previewSql(rt, row.id), password)
      const engines = frameEnginesOn(ctx.host.kind)
      for (const { engine, reason } of engines.noted) {
        const id = `P5 ${entry.build.archive} ${engine}`
        rt.note(`${id} does not run on a ${ctx.host.kind} host: ${reason}`)
        noted.push(id)
      }
      for (const engine of engines.signIn) {
        try {
          await signInInFrame(rt, ctx, entry, { engine, forwarder, login, password })
        } catch (error) {
          if (rt.signal.aborted) throw error
          const id = `P5 ${entry.build.archive} ${engine}`
          failed.push(id)
          console.error(`FAIL ${id}: ${rt.redact(error?.message ?? String(error)).slice(0, 1500)}`)
        }
      }
      await closeDialog(rt, ctx, entry)
    }
  } finally {
    await forwarder.close()
  }
  return { failed, noted }
}
