// The scenarios of the release stand (docs/plan/53-chat-preview-release.md, R12): S1 a dialog
// changes the site in its preview, S2 the preview as the owner and the agent see it and what it
// cannot reach, S3 a clarification, S4a a dialog opened before a release, S4 `/release`, S5a/S6a
// two more dialogs side by side, S5 a release that breaks the site and is rolled back, S6 a
// release refused by a conflict before `main` moves, S8 a database plan of every kind released,
// repeated, refused for a taken address and rolled back, S9 «Отменить выпуск», S10 a pass that
// fails for a reason of the platform keeps the candidate and «Попробовать ещё» repeats it, S7 the
// tags that deploy nothing, a turn that waits for a deploy and what core leaves behind. Every
// PASS line is a fact read from the product's own state, the pages it serves or what Gitea,
// OpenBao, S3, Docker and the hosting hold; a NOTE line is a precondition of the stand or what it
// cannot prove on this machine, never a check.
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { localVaultRequest } from '../../vault/bootstrap.mjs'
import { roundOf } from './fake-model.mjs'
import { isolationOf } from './isolation.mjs'
import { productionTitle, repositoryReader } from './setup.mjs'
import { CheckFailed, exchange, pageText } from './runtime.mjs'
import {
  BOOKINGS,
  FOOTER_PATH,
  MODEL_TURNS,
  NOTICE_PATH,
  PREVIEW_ROOT_QUERY,
  STYLE_PATH,
  TEXT,
  expectedCharge,
  themeFiles,
  undoTrap,
  undoTrapPath,
  versionAbove,
} from './stand.mjs'

const MINUTE = 60_000
/** A UUID v7, as the browser invents the ids of a dialog and of a press. */
function uuid7() {
  const bytes = randomBytes(16)
  const now = BigInt(Date.now())
  for (let index = 0; index < 6; index++)
    bytes[index] = Number((now >> BigInt(8 * (5 - index))) & 0xffn)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const sum = (rows) => rows.reduce((total, row) => total + Number(row.amount), 0)
const TERMINAL_RELEASE = ['installed', 'rolled_back', 'failed', 'unknown']
/** The secret of the repository the release arms for its job (DEPLOY_WRAP_SECRET_NAME). */
const WRAP_SECRET = 'RADITI_DEPLOY_WRAP'
/** The first bytes of a sealed deploy envelope (deploy-step/envelope.ts). */
const ENVELOPE_MAGIC = 'RDE1'

export async function runScenarios(stand) {
  const { rt, db, owner, gitea, site, siteUrl, siteId, model, ports, content, names } = stand
  const repo = stand.repo.name
  const api = (method, path, options = {}) =>
    gitea.api(method, `/repos/sites/${repo}${path}`, { as: gitea.as('bot'), ...options })
  const iso = isolationOf(stand)

  // ── Readers ──────────────────────────────────────────────────────────────────

  const feedText = async (taskId) => {
    const events = await db.taskEvent.findMany({ where: { taskId }, orderBy: { id: 'asc' } })
    return events
      .map((event) => `${event.id} ${event.type} ${JSON.stringify(event.payload).slice(0, 300)}`)
      .join('\n')
  }
  /** Waits for the task to stand in one of `statuses`; a dialog that ended elsewhere fails at once. */
  const taskReaches = async (taskId, statuses, { timeoutMs = 12 * MINUTE, what } = {}) => {
    const wanted = [statuses].flat()
    try {
      return await rt.until(
        what ?? `dialog ${taskId} in ${wanted.join('|')}`,
        async () => {
          const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
          if (wanted.includes(task.status)) return task
          if (
            ['failed', 'cancelled', 'done', 'rolled_back'].includes(task.status) &&
            !wanted.includes(task.status)
          )
            throw new CheckFailed(`dialog ${taskId} ended ${task.status}`)
          return null
        },
        { timeoutMs, intervalMs: 1000, service: stand.processes.core },
      )
    } catch (error) {
      console.error(`--- the feed and journal of ${taskId}\n${rt.redact(await feedText(taskId))}`)
      throw error
    }
  }
  const previewOf = (taskId) => db.previewEnvironment.findUnique({ where: { taskId } })
  const previewReady = (taskId, revision, timeoutMs = 8 * MINUTE) =>
    rt.until(
      `the preview of ${taskId} ready at revision ${revision}`,
      async () => {
        const row = await previewOf(taskId)
        if (
          row?.status === 'failed' ||
          row?.status === 'unavailable' ||
          row?.status === 'destroyed'
        )
          throw new CheckFailed(
            `the preview of ${taskId} is ${row.status}: ${row.errorCode ?? row.unavailableReason}`,
          )
        return row?.status === 'ready' && row.revision === revision && !row.dirty ? row : null
      },
      { timeoutMs, intervalMs: 500, service: stand.processes.core },
    )
  const originOf = (preview) => `http://${preview.hostname}:${ports.preview}`
  const currentCandidate = (taskId) =>
    db.taskCandidate.findFirst({ where: { taskId, status: 'current' } })
  const checksSettled = (candidateId, kinds, revision) =>
    rt.until(
      `checks ${kinds.join(', ')} of candidate ${candidateId}`,
      async () => {
        const checks = await db.candidateCheck.findMany({ where: { candidateId } })
        const done = kinds.every((kind) =>
          checks.some(
            (check) =>
              check.kind === kind &&
              check.status !== 'pending' &&
              (revision === undefined || check.revision === revision),
          ),
        )
        return done ? checks : null
      },
      { timeoutMs: 8 * MINUTE, intervalMs: 1000 },
    )
  const passedAt = (checks, kind, revision) =>
    checks.some(
      (check) => check.kind === kind && check.revision === revision && check.status === 'passed',
    )
  const holdsOf = (taskId) => db.creditHold.findMany({ where: { taskId } })
  const chargesOf = (taskId) => db.creditLedger.findMany({ where: { taskId, kind: 'charge' } })
  /** A page of production as a visitor gets it. */
  const productionPage = async (path = '/') => {
    const answer = await exchange(`${siteUrl}${path}`, { signal: rt.signal })
    return { status: answer.status, text: pageText(answer.text) }
  }
  /** The file of the hosting, as SFTP and the web server see it (the reader trims its end). */
  const productionFile = (path) => site.files.read(path)
  /** A title of production's database, read by SQL: quick enough for the window of a release. */
  const productionTitleBySql = (id) =>
    site.sql(`SELECT post_title FROM wp_posts WHERE ID = ${Number(id)}`)
  const sameText = (left, right) =>
    typeof left === 'string' && typeof right === 'string' && left.trimEnd() === right.trimEnd()
  const gitFile = async (ref, path) => {
    const answer = await api('GET', `/raw/${path}?ref=${ref}`)
    return answer.status === 200 ? answer.text : null
  }
  // From the refs of the repository itself: Gitea updates its table of branches after a push
  // in the background, so `/branches/main` may name the commit before it for a moment.
  const branchHead = async () => {
    const refs = (await api('GET', '/git/refs/heads/main', { expect: 200 })).json
    return [refs].flat().find((ref) => ref.ref === 'refs/heads/main').object.sha
  }
  const reader = repositoryReader(rt, {
    gitea,
    repoName: repo,
    directory: stand.directory,
    certificates: stand.certificates,
  })
  const treeOf = (sha) => reader.tree(sha)
  const deployRuns = async () => {
    const list = await api('GET', '/actions/runs?limit=50', { expect: 200 })
    return (list.json.workflow_runs ?? []).filter((run) => run.path?.startsWith('deploy.yml@'))
  }
  const runsOf = async (tag) =>
    (await deployRuns()).filter((run) => run.path === `deploy.yml@refs/tags/${tag}`)
  const jobsOf = async (runId) =>
    (await api('GET', `/actions/runs/${runId}/jobs`, { expect: 200 })).json.jobs ?? []
  const jobLog = async (jobId) =>
    (await api('GET', `/actions/jobs/${jobId}/logs`, { expect: 200 })).text
  const stepLines = (log) =>
    log
      .split('\n')
      .map((line) => line.replace(/^\S+Z /, ''))
      .filter((line) => line.startsWith('deploy-step: '))
  const completedRuns = (tag, timeoutMs = 5 * MINUTE) =>
    rt.until(
      `the run of ${tag} completed`,
      async () => {
        const list = await runsOf(tag)
        return list.length > 0 && list.every((run) => run.status === 'completed') ? list : null
      },
      { timeoutMs },
    )

  /**
   * The preview of a dialog as the owner opens it: a ticket of `preview.ticket`, the entry of the
   * gateway that turns it into the session cookie, then the page — every request to the
   * gateway on loopback with the preview's own Host.
   */
  const previewVisit = async (taskId, paths) => {
    const { url } = await owner.mutate('preview.ticket', { taskId })
    const entry = new URL(url)
    const host = entry.host
    const gatewayUrl = (path) => `http://127.0.0.1:${ports.preview}${path}`
    const enter = await exchange(gatewayUrl(`${entry.pathname}${entry.search}`), {
      headers: { host },
      signal: rt.signal,
    })
    if (enter.status !== 303)
      throw new CheckFailed(`the gateway answered ${enter.status} to the ticket`)
    const cookie = (enter.headers['set-cookie'] ?? []).map((line) => line.split(';')[0]).join('; ')
    const pages = {}
    for (const path of paths) {
      const page = await exchange(gatewayUrl(path), {
        headers: { host, cookie },
        signal: rt.signal,
      })
      pages[path] = { status: page.status, text: pageText(page.text), headers: page.headers }
    }
    return { host, origin: `${entry.protocol}//${entry.host}`, pages, cookie }
  }
  /** A query of a preview's own database, as root on its socket (the copy of Р15). */
  const previewSql = async (previewId, query) => {
    const container = await iso.previewContainer(previewId, 'db')
    return (
      await rt.docker(['exec', container, 'sh', '-c', PREVIEW_ROOT_QUERY, 'sh', query])
    ).output.trim()
  }

  const createDialog = async (text) => {
    const taskId = uuid7()
    const created = await owner.mutate('task.create', { siteId, taskId, text })
    return { taskId, alias: created.alias }
  }
  const releaseOf = (taskId) =>
    db.siteRelease.findFirst({ where: { taskId }, orderBy: { createdAt: 'desc' } })
  const releaseEnds = (releaseId, timeoutMs = 15 * MINUTE) =>
    rt.until(
      `release ${releaseId} ends`,
      async () => {
        const row = await db.siteRelease.findUniqueOrThrow({ where: { id: releaseId } })
        return TERMINAL_RELEASE.includes(row.status) ? row : null
      },
      { timeoutMs, intervalMs: 2000, service: stand.processes.core },
    )
  const revertOf = (releaseId) =>
    rt.until(`the revert commit of release ${releaseId}`, async () => {
      const row = await db.siteRelease.findUniqueOrThrow({ where: { id: releaseId } })
      return row.revertSha ? row : null
    })
  const stepsOf = async (releaseId) =>
    (await db.releaseStep.findMany({ where: { releaseId }, orderBy: { id: 'asc' } })).map(
      (row) => `${row.step} ${row.state}${row.detail?.code ? ` ${row.detail.code}` : ''}`,
    )
  /**
   * Р31: once a release ended, its way to the site is closed — the secret of the repository is
   * gone (read as the release account, the only one Gitea shows it to) and its wrapping is no
   * token OpenBao knows.
   */
  const wayInClosed = async (releaseId, label) => {
    const row = await db.siteRelease.findUniqueOrThrow({ where: { id: releaseId } })
    const secrets = await rt.until(`the deploy secret of ${label} deleted`, async () => {
      const answer = await gitea.api('GET', `/repos/sites/${repo}/actions/secrets`, {
        as: gitea.as('owner'),
        expect: 200,
      })
      const list = [answer.json].flat().map((secret) => secret?.name)
      return list.includes(WRAP_SECRET) ? null : list
    })
    const lookup = row.wrapAccessor
      ? await localVaultRequest(stand.vault.root, 'auth/token/lookup-accessor', {
          method: 'POST',
          body: { accessor: row.wrapAccessor },
        })
      : null
    rt.check(
      !secrets.includes(WRAP_SECRET) && row.wrapAccessor !== null && lookup.status !== 200,
      `${label}: the repository holds no ${WRAP_SECRET} and OpenBao knows no token of its wrapping (lookup ${lookup?.status})`,
    )
  }

  /**
   * A release refused before anything was armed: no attempt, no wrapping, and the repository
   * holds no secret of a deploy.
   */
  const wayNeverOpened = async (releaseId, label) => {
    const row = await db.siteRelease.findUniqueOrThrow({ where: { id: releaseId } })
    const answer = await gitea.api('GET', `/repos/sites/${repo}/actions/secrets`, {
      as: gitea.as('owner'),
      expect: 200,
    })
    const list = [answer.json].flat().map((secret) => secret?.name)
    rt.check(
      row.wrapAccessor === null && row.deployAttempt === 0 && !list.includes(WRAP_SECRET),
      `${label}: no attempt was armed — no wrapping, no ${WRAP_SECRET} in the repository`,
      { attempt: row.deployAttempt, secrets: list },
    )
  }

  const footer0 = themeFiles()[FOOTER_PATH]
  const contactsPath = `/?page_id=${content.contactsId}`
  const postPath = `/?p=${content.postId}`

  // ── S1 ───────────────────────────────────────────────────────────────────────
  rt.begin('S1', 'chat → turn → candidate')
  const overview = await owner.query('billing.overview')
  rt.check(
    overview.credits.newTask.allowed && overview.credits.spendable >= 45,
    `the owner sees ${overview.credits.spendable} credits to spend and a new task allowed (billing.overview over HTTP with the session cookie)`,
    overview.credits,
  )
  const adminRow = (
    await site.sql("SELECT ID, user_pass FROM wp_users WHERE user_login = 'stand-admin'")
  ).split('\t')
  const dialogA = { taskId: uuid7() }
  // The first answer of the model waits until the preview the turn writes into is built at
  // revision 0, and the stand looks into it then: what the preview was before the agent wrote.
  const rev0 = {}
  rt.note(
    'the first answer of the scripted model in dialog A waits until its preview is ready at revision 0: a precondition of the stand; S6a calls the preview before it is ready',
  )
  model.script(MODEL_TURNS.first({ contactsId: content.contactsId }), {
    gates: {
      0: async () => {
        try {
          const row = await previewReady(dialogA.taskId, 0, 6 * MINUTE)
          rev0.visit = await previewVisit(dialogA.taskId, ['/', contactsPath])
          rev0.copy = (
            await previewSql(
              row.id,
              `SELECT (SELECT COUNT(*) FROM wp_users), (SELECT COUNT(*) FROM wp_users WHERE user_email NOT LIKE '%@preview.invalid'), (SELECT COUNT(*) FROM wp_usermeta WHERE user_id = ${Number(adminRow[0])} AND meta_key = '_application_passwords'), (SELECT user_pass FROM wp_users WHERE ID = ${Number(adminRow[0])}), (SELECT option_value FROM wp_options WHERE option_name = 'raditi_content_epoch')`,
            )
          ).split('\t')
        } catch (error) {
          rev0.error = error
        }
      },
    },
  })
  const createdA = await owner.mutate('task.create', {
    siteId,
    taskId: dialogA.taskId,
    text: 'Поменяйте текст в подвале, добавьте объявление о бесплатной доставке и назовите страницу «Контакты» «Контакты и реквизиты».',
  })
  dialogA.alias = createdA.alias
  const heldBefore = await holdsOf(dialogA.taskId)
  const requestA = await db.taskEvent.findFirst({
    where: { taskId: dialogA.taskId, type: 'feed.request' },
  })
  const passJob = requestA
    ? await db.outboxEvent.findUnique({
        where: { dedupeKey: `turn.run:${dialogA.taskId}:1:${requestA.id}` },
      })
    : null
  rt.check(
    createdA.created === true &&
      heldBefore.length > 0 &&
      heldBefore.every((hold) => hold.status === 'active' && hold.attempt === 1) &&
      requestA?.payload?.kind === 'first' &&
      passJob?.topic === 'agent-turns',
    `task.create wrote the dialog, its reserve of attempt 1 (${sum(heldBefore)} credits), its request in the feed and the job of its pass in the outbox`,
    { heldBefore, request: requestA?.payload?.kind, job: passJob?.topic },
  )
  const taskA = await taskReaches(dialogA.taskId, 'awaiting_approval')
  if (rev0.error) throw rev0.error
  rt.check(
    rev0.visit.pages['/'].status === 200 &&
      rev0.visit.pages['/'].text.includes(TEXT.footer(0)) &&
      !rev0.visit.pages['/'].text.includes(TEXT.notice) &&
      rev0.visit.pages[contactsPath].text.includes(TEXT.contacts) &&
      !rev0.visit.pages[contactsPath].text.includes(TEXT.contactsAfter),
    'before the agent wrote, the preview at revision 0 showed what production holds: the footer of the repository and «Контакты» of the copy of its database',
  )
  const [users, realUsers, adminPasswords, adminPass, epoch] = rev0.copy
  rt.check(
    Number(users) >= 2 &&
      Number(realUsers) === 0 &&
      Number(adminPasswords) === 0 &&
      adminPass !== adminRow[1] &&
      adminPass.length > 0 &&
      epoch === '0',
    `the copy of production's database (Р15): ${users} synthetic users (…@preview.invalid), no application password of the site's administrator, another hash of the password, raditi_content_epoch = 0`,
    { users, realUsers, adminPasswords, epoch },
  )
  rt.check(
    taskA.turnNo === 1 && taskA.attempt === 1,
    'the pass ended in awaiting_approval after one turn of the real OpenCode CLI',
    taskA,
  )
  const candidateA1 = await currentCandidate(dialogA.taskId)
  rt.check(candidateA1?.revision === 1, 'the candidate of the dialog is revision 1', candidateA1)
  const files1 = candidateA1.files.map((file) => `${file.change} ${file.path}`).sort()
  rt.check(
    JSON.stringify(files1) === JSON.stringify([`added ${NOTICE_PATH}`, `modified ${FOOTER_PATH}`]),
    'its files: the footer modified and the template part added',
    files1,
  )
  const plan1 = candidateA1.dbPlan
  rt.check(
    plan1.length === 1 &&
      plan1[0].kind === 'content_update' &&
      plan1[0].objectRef === `page:${content.contactsId}`,
    'its database plan: one content_update of the page «Контакты»',
    plan1,
  )
  const checks1 = await checksSettled(
    candidateA1.id,
    ['php_lint', 'preview_smoke', 'agent_browser'],
    1,
  )
  rt.check(
    ['php_lint', 'preview_smoke', 'agent_browser'].every((kind) => passedAt(checks1, kind, 1)),
    'checks of revision 1: php_lint and preview_smoke on the rebuilt preview, agent_browser of the turn — all passed',
    checks1.map((check) => [check.kind, check.status, check.revision, check.summary]),
  )
  const browserRun = checks1.find((check) => check.kind === 'agent_browser' && check.revision === 1)
  rt.check(
    browserRun.summary.total === 3 && browserRun.summary.passed === 3,
    'the agent ran its 3 browser checks on the preview (browser_navigate, browser_run_checks) and all passed: the footer it edited was compiled at revision 0 before',
    browserRun.summary,
  )
  const heldA = await holdsOf(dialogA.taskId)
  rt.check(
    heldA.every((hold) => hold.status === 'active') &&
      (await chargesOf(dialogA.taskId)).length === 0,
    `credits still held (${sum(heldA)}), nothing charged`,
  )
  rt.check(
    sameText(await productionFile(FOOTER_PATH), footer0),
    'production files unchanged: the footer is as imported',
  )
  rt.check(
    (await productionFile(NOTICE_PATH)) === null,
    'production files unchanged: no template part',
  )
  rt.check(
    (await productionTitle(site, content.contactsId)) === TEXT.contacts,
    'production database unchanged: «Контакты» keeps its title',
  )
  const feedA = await owner.query('task.feed', { taskId: dialogA.taskId })
  rt.check(
    feedA.candidate?.revision === 1 &&
      feedA.events.some((event) => event.type === 'feed.candidate'),
    'the feed of the dialog shows the candidate (feed.candidate) and the head names revision 1',
    { candidate: feedA.candidate, types: feedA.events.map((event) => event.type) },
  )
  rt.end()

  // ── S2 ───────────────────────────────────────────────────────────────────────
  rt.begin('S2', 'the preview')
  const previewA = await previewReady(dialogA.taskId, 1)
  rt.check(
    previewA.status === 'ready' && previewA.revision === 1,
    'the preview is ready at revision 1 of the candidate',
  )
  const visit = await previewVisit(dialogA.taskId, ['/', contactsPath])
  rt.check(
    visit.host ===
      `site-${(await db.site.findUniqueOrThrow({ where: { id: siteId } })).alias}-chat-${dialogA.alias}.localhost:${ports.preview}`,
    `the ticket names the preview's own address ${visit.host}`,
  )
  const front = visit.pages['/']
  rt.check(
    front.status === 200 && front.text.includes(TEXT.footer(1)) && front.text.includes(TEXT.notice),
    'through the ticket and the session of the gateway the preview shows the new footer and the delivery notice',
    front.text.slice(0, 400),
  )
  rt.check(
    visit.pages[contactsPath].status === 200 &&
      visit.pages[contactsPath].text.includes(TEXT.contactsAfter),
    'the preview shows the new title of «Контакты»',
    visit.pages[contactsPath].text.slice(0, 300),
  )
  const prodFront = await productionPage('/')
  const prodContacts = await productionPage(contactsPath)
  rt.check(
    prodFront.text.includes(TEXT.footer(0)) &&
      !prodFront.text.includes(TEXT.notice) &&
      prodContacts.text.includes(TEXT.contacts) &&
      !prodContacts.text.includes(TEXT.contactsAfter),
    'production still shows the old footer and the old title',
  )
  const bare = await exchange(`http://127.0.0.1:${ports.preview}/`, {
    headers: { host: visit.host },
    signal: rt.signal,
  })
  rt.check(
    bare.status === 303 &&
      String(bare.headers.location).startsWith(`${stand.webUrl}/preview/open?`),
    'a request to the preview without a session is sent to the cabinet (/preview/open)',
    { status: bare.status, location: bare.headers.location },
  )
  await browserOfCabinet(stand, dialogA, visit)
  await iso.attacks({
    preview: previewA,
    origin: originOf(previewA),
    siteWeb: names.containers['site-web'],
    hostPorts: {
      core: ports.core,
      mcp: ports.mcp,
      llm: ports.llm,
      web: ports.web,
      'release API': ports.releaseApi,
      'preview gateway': ports.preview,
      vault: ports.vault,
      gitea: ports.gitea,
      S3: ports.s3,
      'site database': stand.site.dbPort,
      'site web server': ports.site,
    },
  })
  rt.end()

  // ── S3 ───────────────────────────────────────────────────────────────────────
  rt.begin('S3', 'a clarification in the same dialog')
  model.script(MODEL_TURNS.clarification())
  const posted = await owner.mutate('task.message', {
    taskId: dialogA.taskId,
    requestId: uuid7(),
    text: 'И в подвале напишите «версия 2».',
  })
  rt.check(
    posted.repeated === false,
    'task.message wrote the words: a new pass on top of the candidate',
  )
  const taskA2 = await taskReaches(dialogA.taskId, 'awaiting_approval', {
    what: 'the second pass of dialog A',
    timeoutMs: 12 * MINUTE,
  }).then(async (row) =>
    row.turnNo === 2 ? row : taskReaches(dialogA.taskId, 'awaiting_approval'),
  )
  rt.check(taskA2.turnNo === 2 && taskA2.attempt === 1, 'the same task and attempt: turn 2', taskA2)
  const heldA2 = await holdsOf(dialogA.taskId)
  rt.check(
    heldA2.length === heldA.length &&
      sum(heldA2) === sum(heldA) &&
      heldA2.every((hold) => hold.attempt === 1),
    `the reserve is not doubled: ${sum(heldA2)} credits of attempt 1`,
    heldA2,
  )
  const candidateA2 = await currentCandidate(dialogA.taskId)
  const superseded = await db.taskCandidate.findFirst({
    where: { taskId: dialogA.taskId, revision: 1 },
  })
  rt.check(
    candidateA2?.revision === 2 && superseded.status === 'superseded',
    'revision 2 is current, revision 1 superseded',
  )
  await previewReady(dialogA.taskId, 2)
  const visit2 = await previewVisit(dialogA.taskId, ['/', contactsPath])
  rt.check(
    visit2.pages['/'].text.includes(TEXT.footer(2)) &&
      visit2.pages[contactsPath].text.includes(TEXT.contactsAfter),
    'the preview is rebuilt to revision 2: the footer of the clarification, the title kept from the plan',
  )
  const checks2 = await checksSettled(
    candidateA2.id,
    ['php_lint', 'preview_smoke', 'agent_browser'],
    2,
  )
  const browserRun2 = checks2.find(
    (check) => check.kind === 'agent_browser' && check.revision === 2,
  )
  rt.check(
    passedAt(checks2, 'php_lint', 2) &&
      passedAt(checks2, 'preview_smoke', 2) &&
      passedAt(checks2, 'agent_browser', 2) &&
      browserRun2.summary.total === 1 &&
      browserRun2.summary.passed === 1,
    'the agent opened the page, edited the footer and checked it at once: the preview runs what the sync wrote (no 2 s of the old code), and the checks of revision 2 passed',
    checks2.map((check) => [check.kind, check.status, check.revision, check.summary]),
  )
  rt.end()

  // ── S4a ──────────────────────────────────────────────────────────────────────
  rt.begin('S4a', 'a dialog opened before the release')
  model.script(MODEL_TURNS.stale())
  const dialogE = await createDialog('Сделайте подвал зелёным.')
  await taskReaches(dialogE.taskId, 'awaiting_approval')
  const candidateE = await currentCandidate(dialogE.taskId)
  rt.check(
    candidateE?.revision === 1 &&
      candidateE.files.length === 1 &&
      candidateE.files[0].path === STYLE_PATH,
    'dialog E waits with a current candidate of the style of the theme, on the main of v0.0.0',
  )
  model.script(MODEL_TURNS.footerConflict())
  const dialogF = await createDialog('Поменяйте подпись в подвале.')
  await taskReaches(dialogF.taskId, 'awaiting_approval')
  const candidateF = await currentCandidate(dialogF.taskId)
  rt.check(
    candidateF?.revision === 1 &&
      candidateF.files.length === 1 &&
      candidateF.files[0].path === FOOTER_PATH,
    'dialog F waits with a current candidate of the line of the footer the release changes too',
  )
  rt.end()

  // ── S4 ───────────────────────────────────────────────────────────────────────
  rt.begin('S4', '/release')
  const prepared = await owner.query('release.prepare', { taskId: dialogA.taskId })
  rt.check(
    prepared.proposal.version === 'v0.1.0' &&
      prepared.proposal.bump === 'minor' &&
      prepared.installedVersion === 'v0.0.0',
    'release.prepare proposes v0.1.0 (minor: a new file) over the installed v0.0.0',
    prepared.proposal,
  )
  rt.check(
    prepared.counts?.files.added === 1 &&
      prepared.counts?.files.modified === 1 &&
      prepared.counts?.records === 1 &&
      prepared.revision === 2,
    'and describes the release: 1 file added, 1 modified, 1 record of the site, revision 2',
    prepared.counts,
  )
  const choice = prepared.choices.find((option) => option.version === 'v0.1.0')
  const runsBefore = (await deployRuns()).length
  const confirmed = await owner.mutate('release.confirm', {
    taskId: dialogA.taskId,
    confirmToken: choice.confirmToken,
    version: 'v0.1.0',
  })
  rt.check(confirmed.repeated === false, `release.confirm wrote release ${confirmed.releaseId}`)
  const installed = await releaseEnds(confirmed.releaseId)
  const stepsA = await stepsOf(installed.id)
  rt.check(installed.status === 'installed', 'the release is installed', {
    status: installed.status,
    error: installed.errorCode,
    steps: stepsA,
  })
  rt.check(
    JSON.stringify(stepsA) ===
      JSON.stringify([
        'conflicts started',
        'conflicts succeeded',
        'backup started',
        'backup succeeded',
        'files started',
        'files succeeded',
        'db started',
        'db succeeded',
        'verify started',
        'verify succeeded',
      ]),
    'deploy-step reported conflicts → backup → files over SFTP → the record through the plugin → verify',
    stepsA,
  )
  // The backup as raditi-backups holds it, read with the stand's S3 identity.
  const backup = await readBackup(stand, installed.backupObjectKey)
  const plaintext = [TEXT.footer(0), TEXT.contacts, 'backup.json', 'records/0.json'].filter(
    (text) => backup.includes(Buffer.from(text)),
  )
  let unpacked = true
  try {
    zstdDecompressSync(backup.subarray(32))
  } catch {
    unpacked = false
  }
  rt.check(
    installed.backupVerifiedAt !== null &&
      backup.byteLength === Number(installed.backupBytes) &&
      createHash('sha256').update(backup).digest('hex') === installed.backupSha256 &&
      backup.subarray(0, 4).toString('latin1') === ENVELOPE_MAGIC &&
      plaintext.length === 0 &&
      !unpacked,
    `the backup in raditi-backups is the one core verified (${backup.byteLength} bytes, SHA-256) and sealed: no text of the site in it, no archive without the key`,
    { plaintext, unpacked },
  )
  const tagA = await api('GET', '/tags/v0.1.0', { expect: 200 })
  rt.check(
    tagA.json.commit.sha === installed.approvedSha,
    'the tag v0.1.0 points at the approved commit of the release',
  )
  rt.check((await branchHead()) === installed.approvedSha, 'main is the release commit')
  const runsA = await completedRuns('v0.1.0')
  rt.check(
    runsA.length === 1 && runsA[0].event === 'push',
    'exactly one run of deploy.yml from platform/ci, by the tag (event push)',
    runsA.map((run) => [run.event, run.status]),
  )
  const linesA = stepLines(await jobLog((await jobsOf(runsA[0].id))[0].id))
  rt.check(
    linesA.includes('deploy-step: code cache on, file times every 2 s, refreshed by the plugin') &&
      linesA.includes('deploy-step: code cache refreshed for 2 of 2 files'),
    "the job read the code cache of production's PHP through the plugin and dropped the 2 PHP files it wrote from it before the check",
    linesA,
  )
  // The release reports `installed` first; core records it on the site in the next step.
  const siteA = await rt.until('the site records the installed release', async () => {
    const row = await db.site.findUniqueOrThrow({ where: { id: siteId } })
    return row.installedReleaseId === installed.id ? row : null
  })
  rt.check(
    siteA.installedVersion === 'v0.1.0' &&
      siteA.installedSha === installed.approvedSha &&
      siteA.installedReleaseId === installed.id,
    'sites.installed_* name v0.1.0 and the approved commit',
  )
  await wayInClosed(installed.id, 'the release v0.1.0')
  const doneA = await taskReaches(dialogA.taskId, 'done', { timeoutMs: 5 * MINUTE })
  const chargedA = await rt.until('the charge of dialog A', async () => {
    const rows = await chargesOf(dialogA.taskId)
    return rows.length > 0 ? rows : null
  })
  const charge = -sum(chargedA)
  const calls = await db.tokenUsage.findMany({
    where: { taskId: dialogA.taskId, taskAttempt: 1, billable: true },
  })
  const expected = expectedCharge(calls, sum(heldA2))
  rt.check(
    doneA.status === 'done' && charge === expected.credits && charge > 5,
    `the dialog is done and charged by its token usage: ${charge} credits = ${expected.costRub.toFixed(4)} ₽ of ${calls.length} calls at the stand rates ÷ 6 ₽, above the minimum of 5 and within the ${sum(heldA2)} held`,
    { charge, expected },
  )
  const prodAfter = await productionPage('/')
  rt.check(
    prodAfter.text.includes(TEXT.footer(2)) && prodAfter.text.includes(TEXT.notice),
    'production shows the new footer and the delivery notice',
  )
  rt.check(
    (await productionTitle(site, content.contactsId)) === TEXT.contactsAfter,
    'production has the new title of «Контакты»',
  )
  rt.check(
    sameText(await productionFile(FOOTER_PATH), await gitFile('v0.1.0', FOOTER_PATH)),
    'the footer on the hosting is the file of the tag',
  )
  const again = await owner.mutate('release.confirm', {
    taskId: dialogA.taskId,
    confirmToken: choice.confirmToken,
    version: 'v0.1.0',
  })
  await rt.pause(5000)
  rt.check(
    again.releaseId === confirmed.releaseId &&
      again.repeated === true &&
      (await runsOf('v0.1.0')).length === 1,
    'a repeated release.confirm with the same token returns the same release and starts no second run',
  )
  rt.check(
    (await deployRuns()).length === runsBefore + 1,
    'the release added exactly one deploy run to the repository',
  )
  // Р15: the install makes the candidates of the other dialogs stand on an old main.
  const staleE = await rt.until('the candidate of dialog E is stale', async () => {
    const row = await db.taskCandidate.findUniqueOrThrow({ where: { id: candidateE.id } })
    return row.status === 'stale' ? row : null
  })
  const refusedE = await owner.call('query', 'release.prepare', { taskId: dialogE.taskId })
  rt.check(
    staleE.status === 'stale' && !refusedE.ok && refusedE.domainCode === 'CHAT_COMMAND_UNAVAILABLE',
    'the candidate of dialog E, opened before the release, is stale now, and release.prepare refuses it',
    refusedE,
  )
  rt.end()

  // ── S4b ──────────────────────────────────────────────────────────────────────
  rt.begin('S4b', '«Обновить»: a stale candidate carried onto the release, and one that conflicts')
  const installedSha = (await db.site.findUniqueOrThrow({ where: { id: siteId } })).installedSha
  await owner.mutate('candidate.update', { taskId: dialogE.taskId, requestId: uuid7() })
  const carriedE = await rt.until(
    'the candidate of dialog E is carried onto the release',
    async () => {
      const row = await db.taskCandidate.findFirst({
        where: { taskId: dialogE.taskId, status: 'current' },
        orderBy: { revision: 'desc' },
      })
      return row && row.revision === 2 ? row : null
    },
    { timeoutMs: 3 * MINUTE, service: stand.processes.core },
  )
  const headE = carriedE.headSha
  rt.check(
    carriedE.baseSha === installedSha &&
      carriedE.baseSha === (await branchHead()) &&
      carriedE.files.length === 1 &&
      carriedE.files[0].path === STYLE_PATH &&
      sameText(await gitFile(headE, FOOTER_PATH), await gitFile(installedSha, FOOTER_PATH)) &&
      (await gitFile(headE, STYLE_PATH))?.includes('.site-footer { color: green; }'),
    'dialog E: «Обновить» carried its change onto the main of v0.1.0 as revision 2 — the style of the theme alone, the footer of the release kept',
    { baseSha: carriedE.baseSha, installedSha, files: carriedE.files },
  )
  const feedE = await owner.query('task.feed', { taskId: dialogE.taskId })
  const preparedE = await owner.call('query', 'release.prepare', { taskId: dialogE.taskId })
  rt.check(
    feedE.candidate?.revision === 2 &&
      !feedE.events.some((event) => event.type === 'feed.update') &&
      preparedE.ok,
    'the feed of dialog E names revision 2, and release.prepare takes it again',
    { candidate: feedE.candidate, prepare: preparedE.ok ? 'ok' : preparedE },
  )
  await owner.mutate('candidate.update', { taskId: dialogF.taskId, requestId: uuid7() })
  const toldF = await rt.until(
    'dialog F is told what came of «Обновить»',
    async () => {
      const feed = await owner.query('task.feed', { taskId: dialogF.taskId })
      return feed.events.find((event) => event.type === 'feed.update') ?? null
    },
    { timeoutMs: 3 * MINUTE, service: stand.processes.core },
  )
  const rowsF = await db.taskCandidate.findMany({
    where: { taskId: dialogF.taskId },
    orderBy: { revision: 'asc' },
  })
  rt.check(
    toldF.outcome === 'conflict' &&
      toldF.conflicts === 1 &&
      rowsF.length === 1 &&
      rowsF[0].status === 'stale' &&
      rowsF[0].headSha === candidateF.headSha,
    'dialog F: the release changed the same line, «Обновить» carries nothing — the client is told of the conflict in its feed, and the candidate stays as it was',
    { told: toldF, candidates: rowsF.map((row) => [row.revision, row.status]) },
  )
  rt.end()

  // ── S5 and S6: two dialogs at once, then their releases ─────────────────────
  rt.begin('S5a', 'a second dialog: a candidate that breaks production only')
  const dialogB = { taskId: uuid7() }
  model.script(MODEL_TURNS.breaking({ postId: content.postId }), {
    waitFor: async () => {
      await previewReady(dialogB.taskId, 0, 6 * MINUTE).catch(() => null)
    },
  })
  await owner.mutate('task.create', {
    siteId,
    taskId: dialogB.taskId,
    text: 'Добавьте вызов в подвал и переименуйте новость.',
  })
  await taskReaches(dialogB.taskId, 'awaiting_approval')
  const candidateB = await currentCandidate(dialogB.taskId)
  rt.check(
    candidateB.files.length === 1 &&
      candidateB.dbPlan.length === 1 &&
      candidateB.dbPlan[0].objectRef === `post:${content.postId}`,
    'dialog B: a candidate with the footer and the title of the post',
  )
  const checksB = await checksSettled(
    candidateB.id,
    ['php_lint', 'preview_smoke'],
    candidateB.revision,
  )
  const previewB = await previewReady(dialogB.taskId, candidateB.revision)
  const visitB = await previewVisit(dialogB.taskId, ['/', postPath])
  const footerB = await rt.docker([
    'exec',
    await iso.previewContainer(previewB.id, 'web'),
    'cat',
    `/var/www/html/${FOOTER_PATH}`,
  ])
  rt.check(
    passedAt(checksB, 'php_lint', candidateB.revision) &&
      passedAt(checksB, 'preview_smoke', candidateB.revision) &&
      visitB.pages['/'].status === 200 &&
      visitB.pages['/'].text.includes(TEXT.footer(2)) &&
      visitB.pages[postPath].text.includes(TEXT.postBroken) &&
      footerB.output.includes('raditi_release_verify_missing'),
    `its preview holds the call in the footer and the new title of the post, answers 200 and passes php_lint and preview_smoke of revision ${candidateB.revision}: the fault shows only where the preview constant is absent`,
    checksB.map((check) => [check.kind, check.status, check.revision]),
  )
  rt.end()

  rt.begin('S6a', 'a third dialog beside the second; neighbouring previews')
  const dialogC = { taskId: uuid7() }
  const requestsBefore = model.state.requests.length
  // No wait for the first call: it comes while the preview is still being built.
  model.script(MODEL_TURNS.conflicting({ contactsId: content.contactsId }), {
    gates: {
      0: async () => {
        await rt
          .until('the preview row of dialog C', () => previewOf(dialogC.taskId))
          .catch(() => null)
      },
      1: async () => {
        await previewReady(dialogC.taskId, 0, 6 * MINUTE).catch(() => null)
      },
    },
  })
  await owner.mutate('task.create', {
    siteId,
    taskId: dialogC.taskId,
    text: 'Назовите страницу «Контакты» иначе.',
  })
  await taskReaches(dialogC.taskId, 'awaiting_approval')
  const retried = model.state.requests
    .slice(requestsBefore)
    .find(
      (request) =>
        request.method === 'POST' &&
        Array.isArray(request.body?.tools) &&
        request.body.tools.length > 0 &&
        roundOf(request.body) === 1,
    )
  const firstAnswer = JSON.stringify(retried?.body?.messages?.at(-1) ?? null)
  rt.check(
    retried?.body?.messages?.at(-1)?.role === 'tool' &&
      firstAnswer.includes('CONTENT_PREVIEW_NOT_READY'),
    'the first wp_rest of dialog C came before its preview was built: the agent got CONTENT_PREVIEW_NOT_READY (a turn does not wait for its preview)',
    firstAnswer.slice(0, 300),
  )
  const candidateC = await currentCandidate(dialogC.taskId)
  rt.check(
    candidateC.files.length === 0 &&
      candidateC.dbPlan.length === 1 &&
      candidateC.dbPlan[0].objectRef === `page:${content.contactsId}`,
    'its retry once the preview was ready went through: a candidate of one record and no file',
  )
  const previewB1 = await previewReady(dialogB.taskId, candidateB.revision)
  const previewC = await previewReady(dialogC.taskId, candidateC.revision)
  await iso.neighbours({
    previewB: previewB1,
    previewC,
    originB: originOf(previewB1),
    originC: originOf(previewC),
    paths: { contacts: contactsPath },
  })
  rt.end()

  rt.begin('S5', 'its release breaks the site and is rolled back')
  const preparedB = await owner.query('release.prepare', { taskId: dialogB.taskId })
  const choiceB = preparedB.choices.find((option) => option.version === preparedB.proposal.version)
  const installedBefore = await db.site.findUniqueOrThrow({ where: { id: siteId } })
  const confirmedB = await owner.mutate('release.confirm', {
    taskId: dialogB.taskId,
    confirmToken: choiceB.confirmToken,
    version: preparedB.proposal.version,
  })
  // S7: while this release holds the site, a turn of another dialog comes and waits.
  await rt.until('the release of B holds the site', async () => {
    const lease = await db.siteLease.findUnique({ where: { siteId } })
    return lease?.operation === 'deploy' && lease.holderTaskId === dialogB.taskId
  })
  model.script(MODEL_TURNS.question())
  const dialogD = await createDialog('На каком движке работает сайт?')
  const watched = await watchRelease({
    db,
    rt,
    siteId,
    releaseId: confirmedB.releaseId,
    holderTaskId: dialogB.taskId,
    waiterTaskId: dialogD.taskId,
    // The release wrote the footer and the record and checks the site: production is broken.
    onWritten: async () => ({
      title: await productionTitleBySql(content.postId),
      page: await productionPage('/'),
      footer: await productionFile(FOOTER_PATH),
    }),
    service: stand.processes.core,
  })
  const broken = watched.written
  rt.check(
    broken !== null &&
      broken.title === TEXT.postBroken &&
      (broken.page.status >= 500 || /critical error|Fatal error/i.test(broken.page.text)) &&
      !broken.page.text.includes(TEXT.footer(2)) &&
      String(broken.footer).includes('raditi_release_verify_missing'),
    `while the release checked the site, production was what it wrote: the footer with the call on the hosting, the new title of the post in its database, the front page ${broken?.page.status}`,
    broken && { title: broken.title, status: broken.page.status },
  )
  const rolled = await releaseEnds(confirmedB.releaseId)
  const stepsB = await stepsOf(rolled.id)
  rt.check(rolled.status === 'rolled_back', 'the release is rolled back', {
    status: rolled.status,
    error: rolled.errorCode,
    steps: stepsB,
  })
  rt.check(
    stepsB.includes('files succeeded') &&
      stepsB.includes('db succeeded') &&
      stepsB.includes('verify failed site_broken') &&
      stepsB.includes('rollback succeeded') &&
      stepsB.includes('reverify succeeded'),
    'the job reported the files and the record written, the check of the site failed, the rollback restored both and the check passed again',
    stepsB,
  )
  const siteB = await db.site.findUniqueOrThrow({ where: { id: siteId } })
  rt.check(
    siteB.installedVersion === 'v0.1.0' && siteB.installedSha === installedBefore.installedSha,
    'the installed version is still v0.1.0',
  )
  // The job reports the rollback; core pushes the revert commit in its next step.
  const reverted = await revertOf(rolled.id)
  const mainB = await branchHead()
  const treesB = { main: await treeOf(mainB), installed: await treeOf(siteB.installedSha) }
  rt.check(
    reverted.revertSha === mainB && treesB.main === treesB.installed,
    'main is the revert commit and its tree is the tree of the installed version',
    { revert: reverted.revertSha, head: mainB, ...treesB },
  )
  const tagB = await api('GET', `/tags/${rolled.version}`)
  rt.check(
    tagB.status === 200 && tagB.json.commit.sha === rolled.approvedSha,
    `the number ${rolled.version} is burnt: its tag stays on the release commit it was given (Р26)`,
  )
  const taskB = await taskReaches(dialogB.taskId, 'rolled_back', { timeoutMs: 3 * MINUTE })
  const holdsB = await holdsOf(dialogB.taskId)
  rt.check(
    taskB.status === 'rolled_back' &&
      holdsB.every((hold) => hold.status === 'released') &&
      (await chargesOf(dialogB.taskId)).length === 0,
    'the dialog is rolled_back and its reserve returned, nothing charged',
    holdsB.map((hold) => hold.status),
  )
  const prodB = await productionPage('/')
  rt.check(
    prodB.status === 200 &&
      prodB.text.includes(TEXT.footer(2)) &&
      sameText(await productionFile(FOOTER_PATH), await gitFile('v0.1.0', FOOTER_PATH)),
    'production serves v0.1.0 again: the footer of the tag, the page answers 200',
  )
  rt.check(
    (await productionTitle(site, content.postId)) === TEXT.post,
    'the title of the post is back on production',
  )
  await wayInClosed(rolled.id, `the release ${rolled.version}`)
  rt.end()

  // ── S6 ───────────────────────────────────────────────────────────────────────
  rt.begin('S6', 'a conflict refuses the release without a write')
  await site.wp([
    'post',
    'update',
    String(content.contactsId),
    `--post_title=${TEXT.contactsManual}`,
  ])
  const preparedC = await owner.query('release.prepare', { taskId: dialogC.taskId })
  rt.check(
    versionAbove(preparedC.proposal.version, rolled.version),
    `release.prepare proposes ${preparedC.proposal.version}, past the burnt ${rolled.version}`,
  )
  const choiceC = preparedC.choices.find((option) => option.version === preparedC.proposal.version)
  const confirmedC = await owner.mutate('release.confirm', {
    taskId: dialogC.taskId,
    confirmToken: choiceC.confirmToken,
    version: preparedC.proposal.version,
  })
  const refused = await releaseEnds(confirmedC.releaseId)
  const stepsC = await stepsOf(refused.id)
  // «Операции БД и миграции»: the readiness asks production before `main` moves — the record
  // no longer holds the base of the plan, so nothing of the release happens at all.
  rt.check(
    refused.status === 'failed' &&
      refused.errorCode === 'db_conflict' &&
      refused.mainPushedAt === null,
    'the release is refused by the conflict before main moved (db_conflict)',
    { status: refused.status, error: refused.errorCode, steps: stepsC },
  )
  rt.check(
    stepsC.length === 0 &&
      refused.deployAttempt === 0 &&
      (await api('GET', `/tags/${refused.version}`)).status === 404 &&
      (await runsOf(refused.version)).length === 0,
    'no deploy attempt, no job, no tag: nothing was written',
    stepsC,
  )
  rt.check(
    (await treeOf(await branchHead())) === (await treeOf(siteB.installedSha)),
    'main holds the installed tree: it never moved',
  )
  const taskC = await taskReaches(dialogC.taskId, 'awaiting_approval', { timeoutMs: 3 * MINUTE })
  rt.check(
    taskC.status === 'awaiting_approval' &&
      (await holdsOf(dialogC.taskId)).every((hold) => hold.status === 'active'),
    'the dialog is back in awaiting_approval with its reserve',
  )
  rt.check(
    (await productionTitle(site, content.contactsId)) === TEXT.contactsManual,
    'production keeps the manual edit of the owner',
  )
  await wayNeverOpened(refused.id, `the release ${refused.version}`)
  rt.end()

  // ── S8: the database plan of every kind (docs/plan/53, «Операции БД и миграции») ─────────
  rt.begin('S8a', 'a database plan of every kind: a table, a setting, a new page, a text')
  // The turn of dialog D (S5) runs once the release of B let the site go, on the script of a
  // question; the scripted model answers one turn at a time, so the next script waits for it.
  await taskReaches(dialogD.taskId, 'done', { timeoutMs: 8 * MINUTE })
  rt.note(
    'S8a scripts its turn once the waiting turn of dialog D is over: a precondition of the scripted model, which answers one turn at a time',
  )
  const dialogG = { taskId: uuid7() }
  model.script(MODEL_TURNS.allKinds({ postId: content.postId }), {
    waitFor: async () => {
      await previewReady(dialogG.taskId, 0, 6 * MINUTE).catch(() => null)
    },
  })
  await owner.mutate('task.create', {
    siteId,
    taskId: dialogG.taskId,
    text: 'Добавьте страницу цен, таблицу для записей, новое описание сайта и заголовок новости.',
  })
  await taskReaches(dialogG.taskId, 'awaiting_approval')
  const candidateG = await currentCandidate(dialogG.taskId)
  const planG = candidateG.dbPlan
  const createdG = planG.find((operation) => operation.kind === 'post_create')?.objectRef ?? ''
  rt.check(
    JSON.stringify(planG.map((operation) => operation.kind)) ===
      JSON.stringify(['schema_migration', 'option_update', 'post_create', 'content_update']) &&
      /^page:1\d{9}$/.test(createdG) &&
      planG[0].objectRef === `table:${BOOKINGS.table}` &&
      planG[1].objectRef === 'option:blogdescription' &&
      planG[3].objectRef === `post:${content.postId}`,
    `the candidate holds four operations in the one order of a plan; the new page is ${createdG}, a number from the base of the platform`,
    planG.map((operation) => [operation.kind, operation.objectRef]),
  )
  const shownG = await owner.query('candidate.get', { taskId: dialogG.taskId })
  const cardsG = shownG.databaseView?.operations ?? []
  rt.check(
    cardsG.length === 4 &&
      cardsG[0].kind === 'schema_migration' &&
      cardsG[0].created === true &&
      cardsG[0].columns.map((column) => column.name).join(',') === 'name,starts_at' &&
      cardsG[1].after === TEXT.description &&
      cardsG[2].slug === 'prices' &&
      cardsG[2].title === TEXT.prices &&
      cardsG[2].contentText.includes(TEXT.pricesText) &&
      cardsG[3].title?.after === TEXT.postDb &&
      cardsG[3].title?.before === TEXT.post &&
      shownG.databaseReview === false,
    'candidate.get gives the description core stored with the revision: the columns, the setting before and after, the new page with its address and text, the old and the new title',
    cardsG,
  )
  const previewG = await previewReady(dialogG.taskId, candidateG.revision)
  const createdPath = `/?page_id=${createdG.slice('page:'.length)}`
  const visitG = await previewVisit(dialogG.taskId, [createdPath])
  rt.check(
    visitG.pages[createdPath].status === 200 &&
      visitG.pages[createdPath].text.includes(TEXT.pricesText) &&
      (await previewSql(previewG.id, `SHOW COLUMNS FROM wp_raditi_${BOOKINGS.table}`)).includes(
        'starts_at',
      ),
    `the preview shows the new page under its number (${createdPath}) and holds the table`,
  )
  // The panel of the cabinet shows the values as text.
  // The page keeps short words with the next one by non-breaking spaces: read as plain text.
  const panelText = (
    await databasePanelText(stand, dialogG).catch((error) => `failed: ${error.message}`)
  ).replaceAll('\u00a0', ' ')
  rt.check(
    panelText.includes(TEXT.description) &&
      panelText.includes('/prices/') &&
      panelText.includes('starts_at'),
    'the panel «База данных» of the cabinet shows the values: the new description, the address of the page, the columns',
    panelText.slice(0, 400),
  )
  const preparedG = await owner.query('release.prepare', { taskId: dialogG.taskId })
  const choiceG = preparedG.choices.find((option) => option.version === preparedG.proposal.version)
  rt.check(
    preparedG.proposal.bump === 'minor' && preparedG.review === false,
    `release.prepare proposes ${preparedG.proposal.version} (minor: a new table), no review needed for four changes`,
    preparedG.proposal,
  )
  const descriptionBefore = await site.sql(
    "SELECT option_value FROM wp_options WHERE option_name = 'blogdescription'",
  )
  const runsBeforeG = (await deployRuns()).length
  const confirmedG = await owner.mutate('release.confirm', {
    taskId: dialogG.taskId,
    confirmToken: choiceG.confirmToken,
    version: choiceG.version,
  })
  // S8d: the same confirmation again while the release goes on.
  const repeatedG = await owner.mutate('release.confirm', {
    taskId: dialogG.taskId,
    confirmToken: choiceG.confirmToken,
    version: choiceG.version,
  })
  const installedG = await releaseEnds(confirmedG.releaseId)
  const stepsG = await stepsOf(installedG.id)
  rt.check(
    installedG.status === 'installed' &&
      stepsG.includes('db succeeded') &&
      stepsG.includes('verify succeeded'),
    `the release ${installedG.version} is installed: the job wrote the plan in its step db`,
    { status: installedG.status, error: installedG.errorCode, steps: stepsG },
  )
  const verifiedG = await db.releaseStep.findFirst({
    where: { releaseId: installedG.id, step: 'verify', state: 'succeeded' },
  })
  rt.check(
    verifiedG?.detail?.pages === 2,
    'the check after the writes asked for 2 pages: the front page and the new published page by the number production gave it (critique S9)',
    verifiedG?.detail,
  )
  const pricesRows = (
    await site.sql(
      "SELECT ID, post_status FROM wp_posts WHERE post_name = 'prices' AND post_type = 'page'",
    )
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
  const pricesId = Number(pricesRows[0]?.[0])
  const mark = await site.sql(
    `SELECT meta_value FROM wp_postmeta WHERE post_id = ${pricesId} AND meta_key = '_raditi_create'`,
  )
  rt.check(
    pricesRows.length === 1 &&
      pricesRows[0][1] === 'publish' &&
      pricesId > 0 &&
      pricesId < 1_000_000_000 &&
      /^[0-9a-f-]{36}$/.test(mark),
    `production gave the new page its own number ${pricesId}, published, with the mark of the call that created it`,
    pricesRows,
  )
  const pricesPage = await productionPage(`/?page_id=${pricesId}`)
  rt.check(
    pricesPage.status === 200 && pricesPage.text.includes(TEXT.pricesText),
    'production serves the new page with the text of the plan',
  )
  rt.check(
    (await site.sql(
      "SELECT option_value FROM wp_options WHERE option_name = 'blogdescription'",
    )) === TEXT.description && descriptionBefore !== TEXT.description,
    'the description of the site is the new one',
  )
  const tableInfo = await site.sql(
    `SELECT TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wp_raditi_${BOOKINGS.table}'`,
  )
  const columnsG = await site.sql(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wp_raditi_${BOOKINGS.table}' ORDER BY ORDINAL_POSITION`,
  )
  rt.check(
    tableInfo === 'raditi-managed' && columnsG.split('\n').join(',') === 'id,name,starts_at',
    `production holds the table wp_raditi_${BOOKINGS.table} of the platform with the columns of the plan`,
    { tableInfo, columnsG },
  )
  rt.check(
    (await productionTitle(site, content.postId)) === TEXT.postDb,
    'the title of the news post is the new one',
  )
  rt.end()

  rt.begin('S8d', 'a repeated /release returns the same release')
  await rt.pause(3000)
  const againG = await owner.mutate('release.confirm', {
    taskId: dialogG.taskId,
    confirmToken: choiceG.confirmToken,
    version: choiceG.version,
  })
  rt.check(
    repeatedG.releaseId === confirmedG.releaseId &&
      repeatedG.repeated === true &&
      againG.releaseId === confirmedG.releaseId &&
      againG.repeated === true,
    'release.confirm repeated during the release and after it returns the same release',
  )
  rt.check(
    (await runsOf(installedG.version)).length === 1 &&
      (await deployRuns()).length === runsBeforeG + 1 &&
      Number(
        await site.sql(
          "SELECT COUNT(*) FROM wp_posts WHERE post_name = 'prices' AND post_type = 'page'",
        ),
      ) === 1 &&
      (await db.siteRelease.count({ where: { taskId: dialogG.taskId } })) === 1,
    'one release, one run of deploy.yml, one new page on production',
  )
  rt.end()

  rt.begin('S8b', 'a new page whose address production took meanwhile: refused before main moves')
  const dialogH = { taskId: uuid7() }
  model.script(MODEL_TURNS.team(), {
    waitFor: async () => {
      await previewReady(dialogH.taskId, 0, 6 * MINUTE).catch(() => null)
    },
  })
  await owner.mutate('task.create', {
    siteId,
    taskId: dialogH.taskId,
    text: 'Добавьте страницу «Команда».',
  })
  await taskReaches(dialogH.taskId, 'awaiting_approval')
  // The owner makes a page at the same address by hand on production.
  await site.wp([
    'post',
    'create',
    '--post_type=page',
    '--post_status=publish',
    `--post_title=${TEXT.teamOwner}`,
    '--post_name=team',
  ])
  const headBeforeH = await branchHead()
  const preparedH = await owner.query('release.prepare', { taskId: dialogH.taskId })
  const choiceH = preparedH.choices.find((option) => option.version === preparedH.proposal.version)
  const confirmedH = await owner.mutate('release.confirm', {
    taskId: dialogH.taskId,
    confirmToken: choiceH.confirmToken,
    version: choiceH.version,
  })
  const refusedH = await releaseEnds(confirmedH.releaseId)
  rt.check(
    refusedH.status === 'failed' &&
      refusedH.errorCode === 'slug_taken' &&
      refusedH.mainPushedAt === null,
    'the release is refused before main moved: the address of the new page is taken (slug_taken)',
    { status: refusedH.status, error: refusedH.errorCode },
  )
  rt.check(
    (await branchHead()) === headBeforeH &&
      (await stepsOf(refusedH.id)).length === 0 &&
      (await api('GET', `/tags/${refusedH.version}`)).status === 404 &&
      (await runsOf(refusedH.version)).length === 0,
    'main is where it was; no tag, no run, no step: nothing was written',
  )
  await wayNeverOpened(refusedH.id, `the release ${refusedH.version}`)
  const taskH = await taskReaches(dialogH.taskId, 'awaiting_approval', { timeoutMs: 3 * MINUTE })
  const feedH = (
    await db.taskEvent.findMany({ where: { taskId: dialogH.taskId, type: 'feed.release' } })
  ).map((row) => row.payload)
  rt.check(
    taskH.status === 'awaiting_approval' &&
      (await holdsOf(dialogH.taskId)).every((hold) => hold.status === 'active') &&
      feedH.at(-1)?.outcome === 'refused' &&
      feedH.at(-1)?.reason === 'slug_taken',
    'the dialog waits again with its reserve; the feed names the taken address as the reason',
    feedH,
  )
  rt.check(
    Number(
      await site.sql(
        "SELECT COUNT(*) FROM wp_posts WHERE post_name = 'team' AND post_type = 'page' AND post_status = 'publish'",
      ),
    ) === 1 &&
      (await site.sql(
        "SELECT post_title FROM wp_posts WHERE post_name = 'team' AND post_type = 'page'",
      )) === TEXT.teamOwner,
    "production has one page at /team/: the owner's",
  )
  rt.end()

  rt.begin(
    'S8c',
    'a release that breaks the site returns every kind: the setting, the page, not the table',
  )
  const dialogI = { taskId: uuid7() }
  model.script(MODEL_TURNS.breakingDb(), {
    waitFor: async () => {
      await previewReady(dialogI.taskId, 0, 6 * MINUTE).catch(() => null)
    },
  })
  await owner.mutate('task.create', {
    siteId,
    taskId: dialogI.taskId,
    text: 'Добавьте вызов в подвал, страницу акций, поле заметок и новое название сайта.',
  })
  await taskReaches(dialogI.taskId, 'awaiting_approval')
  const candidateI = await currentCandidate(dialogI.taskId)
  rt.check(
    JSON.stringify(candidateI.dbPlan.map((operation) => operation.kind)) ===
      JSON.stringify(['schema_migration', 'option_update', 'post_create']) &&
      candidateI.files.length === 1,
    'dialog I: the footer, a column added to the table of the platform, the name of the site, a new page',
    candidateI.dbPlan.map((operation) => [operation.kind, operation.objectRef]),
  )
  const nameBefore = await site.sql(
    "SELECT option_value FROM wp_options WHERE option_name = 'blogname'",
  )
  const installedBeforeI = await db.site.findUniqueOrThrow({ where: { id: siteId } })
  const preparedI = await owner.query('release.prepare', { taskId: dialogI.taskId })
  const choiceI = preparedI.choices.find((option) => option.version === preparedI.proposal.version)
  const confirmedI = await owner.mutate('release.confirm', {
    taskId: dialogI.taskId,
    confirmToken: choiceI.confirmToken,
    version: choiceI.version,
  })
  const rolledI = await releaseEnds(confirmedI.releaseId)
  const stepsI = await stepsOf(rolledI.id)
  rt.check(
    rolledI.status === 'rolled_back' &&
      stepsI.includes('db succeeded') &&
      stepsI.includes('verify failed site_broken') &&
      stepsI.includes('rollback succeeded') &&
      stepsI.includes('reverify succeeded'),
    'the job wrote the files and the plan, the check of the site failed, the rollback put everything back and the check passed again',
    stepsI,
  )
  const rollbackI = await db.releaseStep.findFirst({
    where: { releaseId: rolledI.id, step: 'rollback', state: 'succeeded' },
  })
  rt.check(
    rollbackI?.detail?.keptTables === 1 && (rollbackI?.detail?.keptRecords ?? 0) === 0,
    'the rollback reports the table kept and no new page left',
    rollbackI?.detail,
  )
  rt.check(
    (await site.sql("SELECT option_value FROM wp_options WHERE option_name = 'blogname'")) ===
      nameBefore && nameBefore !== TEXT.siteNameOffers,
    'the name of the site is the one before the release',
  )
  const offers = (
    await site.sql(
      "SELECT post_status, post_name FROM wp_posts WHERE post_type = 'page' AND post_title = 'Акции'",
    )
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
  rt.check(
    offers.length === 1 && offers[0][0] === 'trash' && offers[0][1] === 'offers__trashed',
    'the new page of the release went to the trash of WordPress (offers__trashed): production keeps it for the owner',
    offers,
  )
  const columnsI = await site.sql(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wp_raditi_${BOOKINGS.table}' ORDER BY ORDINAL_POSITION`,
  )
  rt.check(
    columnsI.split('\n').join(',') === 'id,name,starts_at,note',
    'the column the release added stays: a migration is never undone',
    columnsI,
  )
  const siteI = await db.site.findUniqueOrThrow({ where: { id: siteId } })
  const prodI = await productionPage('/')
  rt.check(
    siteI.installedVersion === installedBeforeI.installedVersion &&
      prodI.status === 200 &&
      sameText(
        await productionFile(FOOTER_PATH),
        await gitFile(siteI.installedVersion, FOOTER_PATH),
      ),
    `production serves ${siteI.installedVersion} again: the footer of its tag, the page answers 200`,
  )
  const taskI = await taskReaches(dialogI.taskId, 'rolled_back', { timeoutMs: 3 * MINUTE })
  const feedI = (
    await db.taskEvent.findMany({ where: { taskId: dialogI.taskId, type: 'feed.release' } })
  ).map((row) => row.payload)
  rt.check(
    taskI.status === 'rolled_back' &&
      feedI.at(-1)?.outcome === 'rolled_back' &&
      feedI.at(-1)?.kept?.tables === 1 &&
      (feedI.at(-1)?.kept?.records ?? 0) === 0,
    'the dialog is rolled back; the feed says the table stayed',
    feedI.at(-1),
  )
  await wayInClosed(rolledI.id, `the release ${rolledI.version}`)
  rt.end()

  // ── S9: «Отменить выпуск» (docs/plan/53, «Отмена выпуска») ──────────────────────
  /** The plan of the undo of `release` of `dialog`, asked as the window asks and waited for. */
  const undoPlan = async (dialog, release) => {
    const prepare = async () =>
      (
        await owner.mutate('release.undoPrepare', {
          taskId: dialog.taskId,
          releaseId: release.id,
        })
      ).planId
    let planId = await prepare()
    let renewed = 0
    return rt.until(
      `the plan of the undo of ${release.version}`,
      async () => {
        const answer = await owner.query('release.undoPlan', {
          taskId: dialog.taskId,
          releaseId: release.id,
          planId,
        })
        // A plan made while the end of the release before still held the site: asked again, as
        // the window does.
        if (answer.state === 'expired' && renewed < 3) {
          renewed += 1
          planId = await prepare()
          return null
        }
        if (answer.state === 'failed' || answer.state === 'expired')
          throw new CheckFailed(`the plan of the undo is ${answer.state}: ${answer.reason ?? ''}`)
        return answer.state === 'ready' ? answer : null
      },
      { timeoutMs: 3 * MINUTE, intervalMs: 1000, service: stand.processes.core },
    )
  }
  const undoFeed = async (taskId) =>
    (
      await db.taskEvent.findMany({ where: { taskId, type: 'feed.undo' }, orderBy: { id: 'asc' } })
    ).map((row) => row.payload)
  const descriptionNow = () =>
    site.sql("SELECT option_value FROM wp_options WHERE option_name = 'blogdescription'")
  const pricesState = async () =>
    (
      await site.sql(`SELECT post_status, post_name FROM wp_posts WHERE ID = ${Number(pricesId)}`)
    ).split('\t')
  /** The number an undo is offered under: a patch above every version the site has had. */
  const nextPatch = async () => {
    const versions = (
      await db.siteRelease.findMany({ where: { siteId }, select: { version: true } })
    )
      .map((row) => row.version)
      .reduce((highest, version) => (versionAbove(version, highest) ? version : highest), 'v0.0.0')
    const [major, minor, patch] = /^v(\d+)\.(\d+)\.(\d+)$/.exec(versions).slice(1).map(Number)
    return `v${major}.${minor}.${patch + 1}`
  }
  const undoVerdict = async (taskId) =>
    (await owner.query('task.commands', { taskId })).find((command) => command.id === 'undo')
  const ledgerG = await db.creditLedger.count({ where: { taskId: dialogG.taskId } })
  const holdsBeforeUndo = JSON.stringify(await holdsOf(dialogG.taskId))

  rt.begin(
    'S9a',
    '«Отменить выпуск» that fails its check returns to the release: the new page back',
  )
  const siteG = await db.site.findUniqueOrThrow({ where: { id: siteId } })
  rt.check(
    siteG.installedReleaseId === installedG.id &&
      (await undoVerdict(dialogG.taskId))?.available === true,
    `the site runs ${installedG.version} of dialog G (S8b refused, S8c rolled back): «Отменить выпуск» is offered in its closed dialog`,
    { installed: siteG.installedVersion, verdict: await undoVerdict(dialogG.taskId) },
  )
  // A page of the theme fails while the description of the site is the one before G again.
  await site.files.write(undoTrapPath('a'), undoTrap(descriptionBefore))
  const planG1 = await undoPlan(dialogG, installedG)
  rt.check(
    JSON.stringify(planG1.records.map((record) => record.verdict)) ===
      JSON.stringify(['stays', 'return', 'return', 'return']) &&
      planG1.records[2].text === `Страница ${pricesId}, которую добавил выпуск, уйдёт в корзину` &&
      planG1.undoneVersion === installedG.version &&
      planG1.version === (await nextPatch()) &&
      planG1.nothingToUndo === false,
    `core made the plan from production: the table stays, the setting and the title go back, the new page — under production's id ${pricesId} — goes to the trash; the undo comes out as ${planG1.version}`,
    planG1.records,
  )
  const confirmedG1 = await owner.mutate('release.undoConfirm', {
    taskId: dialogG.taskId,
    releaseId: installedG.id,
    confirmToken: planG1.confirmToken,
    version: planG1.version,
  })
  const undoG1 = await releaseEnds(confirmedG1.undoId)
  const stepsG1 = await stepsOf(undoG1.id)
  rt.check(
    undoG1.kind === 'undo' &&
      undoG1.status === 'rolled_back' &&
      stepsG1.includes('db succeeded') &&
      stepsG1.includes('verify failed site_broken') &&
      stepsG1.includes('rollback succeeded') &&
      stepsG1.includes('reverify succeeded'),
    'the undo wrote the plan in the mode restore, the site failed its check, the job brought the release back and the check passed again',
    stepsG1,
  )
  rt.check(
    (await descriptionNow()) === TEXT.description &&
      (await productionTitle(site, content.postId)) === TEXT.postDb &&
      JSON.stringify(await pricesState()) === JSON.stringify(['publish', 'prices']),
    'production holds the release again: its description, its title, and the new page out of the trash at its address',
    { description: await descriptionNow(), prices: await pricesState() },
  )
  const revertedG1 = await revertOf(undoG1.id)
  const siteG1 = await db.site.findUniqueOrThrow({ where: { id: siteId } })
  rt.check(
    siteG1.installedReleaseId === installedG.id &&
      (await branchHead()) === revertedG1.revertSha &&
      (await treeOf(revertedG1.revertSha)) === (await treeOf(installedG.approvedSha)) &&
      (await gitFile(undoG1.version, FOOTER_PATH)) !== null,
    `the site runs ${installedG.version} still; main got the revert commit with its tree; the tag ${undoG1.version} stays, its number spent`,
  )
  await wayInClosed(undoG1.id, `the undo ${undoG1.version}`)
  await site.files.remove(undoTrapPath('a'))
  rt.check(
    (await taskReaches(dialogG.taskId, 'done', { timeoutMs: MINUTE })).status === 'done' &&
      (await undoFeed(dialogG.taskId)).at(-1)?.stage === 'rolled_back' &&
      (await undoFeed(dialogG.taskId)).at(-1)?.reason === 'site_check' &&
      (await undoVerdict(dialogG.taskId))?.available === true,
    'the dialog stays done; its feed says the undo did not pass the check; «Отменить выпуск» is offered again',
    await undoFeed(dialogG.taskId),
  )
  rt.end()

  rt.begin(
    'S9b',
    '«Отменить выпуск» of a site broken under the release: the undo mends it, and keeps what the owner changed',
  )
  // The owner edits the title of the news post by hand: the undo must leave it.
  await site.sql(
    `UPDATE wp_posts SET post_title = '${TEXT.postOwner}' WHERE ID = ${Number(content.postId)}`,
  )
  // A page of the theme fails while the description is the release's: the site is broken now.
  await site.files.write(undoTrapPath('b'), undoTrap(TEXT.description))
  const brokenG = await rt
    .until(
      'production broken under the release',
      async () => {
        const page = await productionPage('/')
        return page.status >= 500 || /critical error|Fatal error/i.test(page.text) ? page : null
      },
      { timeoutMs: 30_000, intervalMs: 1000 },
    )
    .catch(() => null)
  rt.check(brokenG !== null, 'production is broken under the release (a page of the theme fails)', {
    status: brokenG?.status,
  })
  const planG2 = await undoPlan(dialogG, installedG)
  rt.check(
    JSON.stringify(planG2.records.map((record) => record.verdict)) ===
      JSON.stringify(['stays', 'return', 'return', 'changed']) &&
      planG2.records[3].text ===
        `Запись ${content.postId}: не вернём — её изменили на сайте после выпуска` &&
      planG2.version === (await nextPatch()) &&
      versionAbove(planG2.version, undoG1.version),
    `the plan leaves the title the owner changed and names it; the next number is ${planG2.version}, above the spent one`,
    planG2.records,
  )
  const runsBeforeG2 = (await deployRuns()).length
  const confirmedG2 = await owner.mutate('release.undoConfirm', {
    taskId: dialogG.taskId,
    releaseId: installedG.id,
    confirmToken: planG2.confirmToken,
    version: planG2.version,
  })
  const repeatedG2 = await owner.mutate('release.undoConfirm', {
    taskId: dialogG.taskId,
    releaseId: installedG.id,
    confirmToken: planG2.confirmToken,
    version: planG2.version,
  })
  const undoG2 = await releaseEnds(confirmedG2.undoId)
  const stepsG2 = await stepsOf(undoG2.id)
  const conflictsG2 = await db.releaseStep.findFirst({
    where: { releaseId: undoG2.id, step: 'conflicts', state: 'succeeded' },
  })
  rt.check(
    undoG2.status === 'installed' &&
      conflictsG2?.detail?.brokenBefore === true &&
      stepsG2.includes('db succeeded') &&
      stepsG2.includes('verify succeeded'),
    'the job went on past the broken site, wrote the plan, and the site passed its check after it: installed',
    { status: undoG2.status, error: undoG2.errorCode, steps: stepsG2 },
  )
  rt.check(
    (await descriptionNow()) === descriptionBefore &&
      (await productionTitle(site, content.postId)) === TEXT.postOwner &&
      JSON.stringify(await pricesState()) === JSON.stringify(['trash', 'prices__trashed']) &&
      (await productionPage('/')).status === 200,
    "production: the description before the release, the owner's title kept, the new page in the trash of WordPress, the site answers 200",
    { description: await descriptionNow(), prices: await pricesState() },
  )
  rt.check(
    (await site.sql(
      `SELECT TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wp_raditi_${BOOKINGS.table}'`,
    )) === 'raditi-managed',
    'the table the release made stays: a migration is never undone',
  )
  const siteG2 = await db.site.findUniqueOrThrow({ where: { id: siteId } })
  const parentsG2 = await reader.parents(undoG2.approvedSha)
  rt.check(
    siteG2.installedReleaseId === undoG2.id &&
      siteG2.installedVersion === undoG2.version &&
      (await branchHead()) === undoG2.approvedSha &&
      (await treeOf(undoG2.approvedSha)) === (await treeOf(installedG.installedBeforeSha)) &&
      parentsG2.length === 1 &&
      parentsG2[0] === revertedG1.revertSha,
    `the site runs the undo ${undoG2.version}: a new commit on main with the tree of the version before ${installedG.version}`,
    { parents: parentsG2 },
  )
  const tagG = (await api('GET', `/tags/${installedG.version}`, { expect: 200 })).json
  const tagG2 = (await api('GET', `/tags/${undoG2.version}`, { expect: 200 })).json
  rt.check(
    tagG.commit?.sha === installedG.approvedSha && tagG2.commit?.sha === undoG2.approvedSha,
    `the tag ${installedG.version} did not move; the tag ${undoG2.version} names the undo commit`,
  )
  await wayInClosed(undoG2.id, `the undo ${undoG2.version}`)
  const feedG = await undoFeed(dialogG.taskId)
  rt.check(
    (await db.task.findUniqueOrThrow({ where: { id: dialogG.taskId } })).status === 'done' &&
      (await db.creditLedger.count({ where: { taskId: dialogG.taskId } })) === ledgerG &&
      JSON.stringify(await holdsOf(dialogG.taskId)) === holdsBeforeUndo &&
      feedG.at(-1)?.stage === 'installed' &&
      feedG.at(-1)?.records?.returned === 2 &&
      feedG.at(-1)?.records?.kept === 1,
    'dialog G stays done with its charge; the undos reserved and charged nothing; the feed says two records came back and one stayed',
    feedG.at(-1),
  )
  rt.end()

  rt.begin('S9c', 'a repeated confirmation is the same undo; an undo is not undone')
  await rt.pause(3000)
  const againG2 = await owner.mutate('release.undoConfirm', {
    taskId: dialogG.taskId,
    releaseId: installedG.id,
    confirmToken: planG2.confirmToken,
    version: planG2.version,
  })
  rt.check(
    repeatedG2.undoId === undoG2.id &&
      repeatedG2.repeated === true &&
      againG2.undoId === undoG2.id &&
      againG2.repeated === true &&
      (await runsOf(undoG2.version)).length === 1 &&
      (await deployRuns()).length === runsBeforeG2 + 1,
    'release.undoConfirm repeated during and after the undo returns the same undo: one run of deploy.yml',
  )
  const againPrepare = await owner.call('mutation', 'release.undoPrepare', {
    taskId: dialogG.taskId,
    releaseId: installedG.id,
  })
  const releaseA = await db.siteRelease.findFirst({
    where: { taskId: dialogA.taskId, kind: 'release', status: 'installed' },
    orderBy: { createdAt: 'desc' },
  })
  const olderPrepare = releaseA
    ? await owner.call('mutation', 'release.undoPrepare', {
        taskId: dialogA.taskId,
        releaseId: releaseA.id,
      })
    : null
  rt.check(
    !againPrepare.ok &&
      againPrepare.domainCode === 'CHAT_COMMAND_UNAVAILABLE' &&
      againPrepare.message === 'Этот выпуск уже отменён' &&
      (await undoVerdict(dialogG.taskId))?.refusal === 'already_undone' &&
      releaseA !== null &&
      !olderPrepare.ok &&
      olderPrepare.message?.startsWith('После этой версии на сайт установили другую'),
    'an undone release is not undone again, and a version the site no longer runs is not undone: the reasons in the client words',
    { again: againPrepare, older: olderPrepare },
  )
  await site.files.remove(undoTrapPath('b'))
  rt.end()

  // ── S10 ──────────────────────────────────────────────────────────────────────
  // The owner's answer 1 of 18.10.2026 (docs/plan/53, «Попробовать ещё (18.10)»): a pass of a
  // dialog that already has a candidate fails for a reason of the platform; the candidate and
  // the preview stay, «Попробовать ещё» repeats the pass as a new attempt in `heavy` with a
  // reserve of its own, the reserve of the failed one comes back, and `/release` charges, from
  // the reserve of the retry, the turns that made what it installs: turn 1, on which the retry
  // built, and turn 3 of the retry — not the pass that failed.
  rt.begin('S10', 'a failed pass keeps the candidate; «Попробовать ещё»; /release')
  const dialogJ = { taskId: uuid7() }
  const styleUrl = `/${STYLE_PATH}`
  model.script(MODEL_TURNS.retryBase())
  dialogJ.alias = (
    await owner.mutate('task.create', {
      siteId,
      taskId: dialogJ.taskId,
      text: 'Добавьте отметку в стили темы.',
    })
  ).alias
  await taskReaches(dialogJ.taskId, 'awaiting_approval')
  const candidateJ1 = await currentCandidate(dialogJ.taskId)
  const previewJ1 = await previewReady(dialogJ.taskId, 1)
  const heldJ1 = await holdsOf(dialogJ.taskId)
  rt.check(
    candidateJ1?.revision === 1 &&
      heldJ1.length > 0 &&
      heldJ1.every((hold) => hold.attempt === 1 && hold.status === 'active'),
    `dialog J waits with revision 1 of its first pass and the reserve of attempt 1 (${sum(heldJ1)} credits)`,
    heldJ1.map((hold) => [hold.attempt, hold.status, Number(hold.amount)]),
  )

  // The second pass: its container is killed while the first answer of the model is held.
  const killed = {}
  model.script(MODEL_TURNS.retryKilled(), {
    gates: {
      0: async () => {
        try {
          const listed = await rt.docker([
            'ps',
            '-q',
            '--filter',
            `label=io.raditi.sandbox.taskId=${dialogJ.taskId}`,
            '--filter',
            'label=io.raditi.sandbox.turn=2',
          ])
          killed.ids = listed.output
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
          if (killed.ids.length > 0) await rt.docker(['kill', ...killed.ids])
        } catch (error) {
          killed.error = error
        }
      },
    },
  })
  const chatsBeforeKill = model.chats().length
  await owner.mutate('task.message', {
    taskId: dialogJ.taskId,
    requestId: uuid7(),
    text: TEXT.retryWords,
  })
  const failedJ = await rt.until(
    'the failure of the second pass of dialog J',
    async () => {
      const task = await db.task.findUniqueOrThrow({ where: { id: dialogJ.taskId } })
      if (['failed', 'cancelled', 'done', 'rolled_back'].includes(task.status))
        throw new CheckFailed(`dialog J ended ${task.status}`)
      const row = await db.taskEvent.findFirst({
        where: { taskId: dialogJ.taskId, type: 'feed.failure' },
        orderBy: { id: 'desc' },
      })
      return task.status === 'awaiting_approval' && row ? { task, row } : null
    },
    { timeoutMs: 12 * MINUTE, intervalMs: 1000, service: stand.processes.core },
  )
  if (killed.error) throw killed.error
  const failureAt = failedJ.row.createdAt.getTime()
  rt.check(
    killed.ids?.length === 1,
    'the stand killed the container of turn 2 while its first answer was held: a failure of the platform, not of the model',
    killed.ids,
  )
  const failureJ = failedJ.row.payload
  rt.check(
    failedJ.task.attempt === 1 &&
      failedJ.task.turnNo === 2 &&
      failureJ.turn === 2 &&
      failureJ.code === 'technical' &&
      failureJ.site === 'unchanged' &&
      failureJ.credits === null &&
      failureJ.next === 'awaiting_approval',
    'dialog J waits in awaiting_approval, not failed: the feed says technical, nothing about credits, next awaiting_approval',
    { task: failedJ.task, failure: failureJ },
  )
  const candidatesJ = await db.taskCandidate.findMany({ where: { taskId: dialogJ.taskId } })
  const previewJ2 = await previewReady(dialogJ.taskId, 1)
  const visitJ1 = await previewVisit(dialogJ.taskId, [styleUrl])
  rt.check(
    candidatesJ.length === 1 &&
      candidatesJ[0].status === 'current' &&
      previewJ2.id === previewJ1.id &&
      visitJ1.pages[styleUrl].status === 200 &&
      visitJ1.pages[styleUrl].text.includes(TEXT.retryMark(1)),
    'the candidate of revision 1 stays current, and the same preview is ready at revision 1 and serves its mark',
    { candidates: candidatesJ.map((row) => [row.revision, row.status]), preview: previewJ2.status },
  )
  const heldJ2 = await holdsOf(dialogJ.taskId)
  const turnJ2 = await db.taskTurn.findUnique({
    where: { taskId_turnNo: { taskId: dialogJ.taskId, turnNo: 2 } },
  })
  rt.check(
    heldJ2.every(
      (hold) =>
        hold.attempt === 1 &&
        hold.status === 'active' &&
        hold.expiresAt.getTime() >= failureAt + 72 * 3_600_000 - 5 * MINUTE,
    ) &&
      sum(heldJ2) === sum(heldJ1) &&
      turnJ2?.rejectedAt !== null,
    'the reserve of attempt 1 stays held and lives as long as a waiting dialog; turn 2 is marked refused (task_turns.rejected_at)',
    heldJ2.map((hold) => [hold.attempt, hold.status, hold.expiresAt]),
  )
  const headJ = await owner.query('task.feed', { taskId: dialogJ.taskId })
  const verdictJ = (id) => headJ.commands.find((command) => command.id === id)
  const preparedJ1 = await owner.call('query', 'release.prepare', { taskId: dialogJ.taskId })
  rt.check(
    headJ.task.canRetry === true &&
      verdictJ('retry')?.available === true &&
      verdictJ('release')?.available === true &&
      preparedJ1.ok &&
      preparedJ1.data?.revision === 1,
    'task.feed offers «Попробовать ещё» (canRetry, /retry), and /release of revision 1 stays open',
    { canRetry: headJ.task.canRetry, retry: verdictJ('retry'), prepared: preparedJ1.ok },
  )
  const killedChats = model.chats().slice(chatsBeforeKill)
  rt.check(
    killedChats.length >= 1 && killedChats.every((chat) => chat.body?.reasoning_effort === 'high'),
    'the pass that failed asked the model in the standard class (reasoning high)',
    killedChats.map((chat) => chat.body?.reasoning_effort),
  )

  // «Попробовать ещё», pressed on the card of the failure in the cabinet.
  model.script(MODEL_TURNS.retryDone())
  const chatsBeforeRetry = model.chats().length
  const failureJId = String(failedJ.row.id)
  await retryInCabinet(stand, dialogJ)
  const pressJ = await rt.until('the press of «Попробовать ещё»', () =>
    db.taskEvent.findFirst({
      where: {
        taskId: dialogJ.taskId,
        type: 'feed.request',
        payload: { path: ['kind'], equals: 'retry' },
      },
    }),
  )
  const taskJ = await db.task.findUniqueOrThrow({ where: { id: dialogJ.taskId } })
  const holdsJ = await holdsOf(dialogJ.taskId)
  const jobJ = await db.outboxEvent.findUnique({
    where: { dedupeKey: `turn.run:${dialogJ.taskId}:2:${pressJ.id}` },
  })
  rt.check(
    pressJ.payload.failureEventId === failureJId &&
      taskJ.attempt === 2 &&
      taskJ.modelClass === 'heavy' &&
      jobJ?.topic === 'agent-turns',
    'task.retry wrote the press for that failure, attempt 2 in the class heavy, and the job of its pass',
    { press: pressJ.payload, attempt: taskJ.attempt, modelClass: taskJ.modelClass },
  )
  const releasedJ = holdsJ.filter((hold) => hold.attempt === 1)
  const placedJ = holdsJ.filter((hold) => hold.attempt === 2)
  rt.check(
    releasedJ.length > 0 &&
      releasedJ.every((hold) => hold.status === 'released') &&
      placedJ.length > 0 &&
      placedJ.every((hold) => hold.status === 'active') &&
      sum(placedJ) === 120,
    'the reserve of the failed attempt came back, and attempt 2 holds the step of heavy: 120 credits',
    holdsJ.map((hold) => [hold.attempt, hold.status, Number(hold.amount)]),
  )
  const repeatJ = await owner.mutate('task.retry', {
    taskId: dialogJ.taskId,
    requestId: pressJ.payload.requestId,
    failureEventId: failureJId,
  })
  const otherJ = await owner.call('mutation', 'task.retry', {
    taskId: dialogJ.taskId,
    requestId: uuid7(),
    failureEventId: failureJId,
  })
  rt.check(
    repeatJ.repeated === true &&
      repeatJ.requestEventId === String(pressJ.id) &&
      !otherJ.ok &&
      ['TASK_BUSY', 'TASK_NOTHING_TO_RETRY'].includes(otherJ.domainCode) &&
      (await holdsOf(dialogJ.taskId)).length === holdsJ.length,
    'the same press again is the same row; another press is refused: no second reserve, no second pass',
    { repeat: repeatJ, other: otherJ.domainCode },
  )
  const retriedJ = await rt.until(
    'the retried pass of dialog J',
    async () => {
      const task = await db.task.findUniqueOrThrow({ where: { id: dialogJ.taskId } })
      if (['failed', 'cancelled', 'done', 'rolled_back'].includes(task.status))
        throw new CheckFailed(`dialog J ended ${task.status}`)
      return task.status === 'awaiting_approval' && task.turnNo === 3 ? task : null
    },
    { timeoutMs: 12 * MINUTE, intervalMs: 1000, service: stand.processes.core },
  )
  const assignmentJ3 = await db.turnAssignment.findFirst({
    where: { taskId: dialogJ.taskId, turnNo: 3 },
  })
  const planJ3 = assignmentJ3?.plan ?? {}
  rt.check(
    retriedJ.attempt === 2 &&
      planJ3.replacesTurn === 2 &&
      planJ3.previous?.turn === 1 &&
      planJ3.workspace?.expectedBaseSha === candidateJ1.headSha,
    'turn 3 replaced the failed turn 2 from the checkpoint of turn 1, on the head of revision 1',
    { replaces: planJ3.replacesTurn, previous: planJ3.previous?.turn },
  )
  const keyJ3 = await db.llmKey.findFirst({
    where: { taskId: dialogJ.taskId, turnNo: 3 },
    select: { taskAttempt: true, model: { select: { slug: true } } },
  })
  const retryChats = model.chats().slice(chatsBeforeRetry)
  const lastWords = (chat) =>
    JSON.stringify(
      (chat.body?.messages ?? []).filter((message) => message?.role === 'user').at(-1) ?? null,
    )
  rt.check(
    keyJ3?.model.slug === 'glm-5.3-heavy' &&
      keyJ3.taskAttempt === 2 &&
      retryChats.length >= 1 &&
      retryChats.every((chat) => chat.body?.reasoning_effort === 'max') &&
      lastWords(retryChats[0]).includes(TEXT.retryWords),
    'the key of turn 3 is of glm-5.3-heavy, every request of it to the synthetic Z.ai carries reasoning max and the words of the pass that failed',
    { model: keyJ3?.model.slug, efforts: retryChats.map((chat) => chat.body?.reasoning_effort) },
  )
  const candidateJ2 = await currentCandidate(dialogJ.taskId)
  const previewJ3 = await previewReady(dialogJ.taskId, 2)
  const visitJ2 = await previewVisit(dialogJ.taskId, [styleUrl])
  rt.check(
    candidateJ2?.revision === 2 &&
      (await db.taskCandidate.findFirst({ where: { taskId: dialogJ.taskId, revision: 1 } }))
        ?.status === 'superseded' &&
      previewJ3.id === previewJ1.id &&
      visitJ2.pages[styleUrl].text.includes(TEXT.retryMark(2)) &&
      !visitJ2.pages[styleUrl].text.includes(TEXT.retryMark(1)),
    'revision 2 is current over revision 1, and the same preview serves the mark of version 2',
  )
  rt.check(
    (await owner.query('task.feed', { taskId: dialogJ.taskId })).task.canRetry === false,
    'nothing waits for a retry any more',
  )
  await checksSettled(candidateJ2.id, ['php_lint', 'preview_smoke'], 2)

  const preparedJ = await owner.query('release.prepare', { taskId: dialogJ.taskId })
  const choiceJ = preparedJ.choices.find((option) => option.version === preparedJ.proposal.version)
  const confirmedJ = await owner.mutate('release.confirm', {
    taskId: dialogJ.taskId,
    confirmToken: choiceJ.confirmToken,
    version: choiceJ.version,
  })
  const installedJ = await releaseEnds(confirmedJ.releaseId)
  rt.check(
    installedJ.status === 'installed' &&
      sameText(await productionFile(STYLE_PATH), await gitFile(installedJ.version, STYLE_PATH)) &&
      (await productionFile(STYLE_PATH)).includes(TEXT.retryMark(2)),
    `/release installed ${installedJ.version} of revision 2: the style on the hosting is the file of the tag, with the mark of version 2`,
    { status: installedJ.status, error: installedJ.errorCode },
  )
  await wayInClosed(installedJ.id, `the release ${installedJ.version}`)
  const doneJ = await taskReaches(dialogJ.taskId, 'done', { timeoutMs: 5 * MINUTE })
  const chargedJ = await rt.until('the charge of dialog J', async () => {
    const rows = await chargesOf(dialogJ.taskId)
    return rows.length > 0 ? rows : null
  })
  const chargeJ = -sum(chargedJ)
  const usageJ = await db.tokenUsage.findMany({
    where: { taskId: dialogJ.taskId, billable: true },
    include: { key: { select: { turnNo: true } } },
  })
  // The calls of turn 1 (attempt 1, the candidate the retry built on) and of turn 3 (attempt 2);
  // turn 2 — the pass that failed — is not the client's to pay.
  const callsJ = usageJ.filter((call) => [1, 3].includes(call.key.turnNo))
  const failedCallsJ = usageJ.filter((call) => call.key.turnNo === 2)
  const expectedJ = expectedCharge(callsJ, sum(placedJ))
  const auditJ = await db.auditLog.findFirst({
    where: { action: 'billing.task.charge', targetId: dialogJ.taskId },
  })
  rt.check(
    doneJ.status === 'done' &&
      chargeJ === expectedJ.credits &&
      usageJ.length === callsJ.length + failedCallsJ.length &&
      callsJ.some((call) => call.taskAttempt === 1) &&
      callsJ.some((call) => call.taskAttempt === 2) &&
      auditJ?.meta?.attempts === 2 &&
      auditJ.meta.givenBack === 1 &&
      auditJ.meta.firstAttempt === 1 &&
      auditJ.meta.lastAttempt === 2 &&
      Math.abs(
        Number(auditJ.meta.costRub) -
          callsJ.reduce((total, call) => total + Number(call.costRub), 0),
      ) < 1e-6,
    `the dialog is done and charged ${chargeJ} credits for the token usage of turns 1 and 3 (${callsJ.length} calls, ${expectedJ.costRub.toFixed(4)} ₽) from the reserve of the retry: the work of the kept candidate is in the charge, the ${failedCallsJ.length} calls of the failed turn 2 are not`,
    { charge: chargeJ, expected: expectedJ, audit: auditJ?.meta },
  )
  const holdsAfterJ = await holdsOf(dialogJ.taskId)
  rt.check(
    holdsAfterJ.filter((hold) => hold.attempt === 1).every((hold) => hold.status === 'released') &&
      holdsAfterJ.filter((hold) => hold.attempt === 2).every((hold) => hold.status === 'captured'),
    'the rows of attempt 1 stay released; those of attempt 2 are captured by the charge',
    holdsAfterJ.map((hold) => [hold.attempt, hold.status]),
  )
  rt.end()

  // ── S7 ───────────────────────────────────────────────────────────────────────
  rt.begin('S7', 'tags that deploy nothing; the waiting turn; what core leaves')
  const zero = await runsOf('v0.0.0')
  const zeroJobs = zero.length === 1 ? await jobsOf(zero[0].id) : []
  rt.check(
    zero.length === 1 && zeroJobs.length === 1 && zeroJobs[0].conclusion === 'skipped',
    'the tag v0.0.0 of the import started one run whose job was skipped',
    { runs: zero.length, jobs: zeroJobs.map((job) => job.conclusion) },
  )
  const head = await branchHead()
  await gitea.api('POST', `/repos/sites/${repo}/tags`, {
    as: gitea.as('owner'),
    body: { tag_name: 'v9.9.9', target: head },
    expect: 201,
  })
  const foreign = await completedRuns('v9.9.9')
  const foreignJobs = await jobsOf(foreign[0].id)
  const foreignLines = stepLines(await jobLog(foreignJobs[0].id))
  rt.check(
    foreign.length === 1 &&
      foreignJobs[0].conclusion === 'success' &&
      foreignLines.some((line) => line.includes('the repository has no deploy secret')) &&
      !foreignLines.some((line) => /unwrap|installed/.test(line)) &&
      (await db.siteRelease.count({ where: { siteId, version: 'v9.9.9' } })) === 0,
    'an arbitrary tag v9.9.9 starts one run that finds no deploy secret and stops: nothing unwrapped, no release, nothing written',
    foreignLines,
  )
  rt.check(
    watched.waiting !== null &&
      watched.waiting.lease.operation === 'deploy' &&
      watched.waiting.lease.holderTaskId === dialogB.taskId,
    'a turn of dialog D met the site held by the release of B (SITE_BUSY): it waited in the queue (waiting = site) under the lease `deploy`',
    watched.waiting?.lease,
  )
  const wake = await db.outboxEvent.findFirst({
    where: {
      dedupeKey: {
        startsWith: `turn.run:${dialogD.taskId}:`,
        endsWith: `:retry:release-${confirmedB.releaseId}`,
      },
    },
  })
  rt.check(
    watched.left !== null &&
      watched.freed !== null &&
      watched.left - watched.freed <= 45_000 &&
      wake?.topic === 'agent-turns',
    `the end of the release woke it: it left the queue ${watched.left === null || watched.freed === null ? '—' : Math.round((watched.left - watched.freed) / 1000)} s after the release let the site go (its own retry is at most 2 min away)`,
    { freed: watched.freed, left: watched.left, wake: wake?.dedupeKey },
  )
  const doneD = await taskReaches(dialogD.taskId, 'done', { timeoutMs: 8 * MINUTE })
  rt.check(
    doneD.status === 'done' && doneD.waiting === null,
    'the waiting turn ran after the release let the site go: the dialog is done',
  )
  for (const [label, dialog] of [
    ['C', dialogC],
    ['E', dialogE],
    ['F', dialogF],
    ['H', dialogH],
  ]) {
    const cancelled = await owner.mutate('task.cancel', {
      taskId: dialog.taskId,
      requestId: uuid7(),
    })
    rt.check(cancelled.state === 'cancelled', `the open dialog ${label} is cancelled by /cancel`)
  }
  await rt.until(
    'the previews of the closed dialogs are destroyed',
    async () => {
      const left = await db.previewEnvironment.count({
        where: { siteId, status: { not: 'destroyed' } },
      })
      return left === 0
    },
    { timeoutMs: 5 * MINUTE },
  )
  const leftOfSite = await rt
    .until(
      'Docker holds nothing of the previews, sandboxes and gateways of the site',
      async () => ((await iso.leftOfSite()).length === 0 ? [] : null),
      { timeoutMs: 3 * MINUTE, intervalMs: 2000 },
    )
    .catch(async () => iso.leftOfSite())
  rt.check(
    leftOfSite.length === 0,
    'core destroyed the preview of every closed dialog and the sandbox of every turn: Docker holds no container, network or volume with the labels of the site (io.raditi.preview.site, io.raditi.sandbox.siteId, io.raditi.gateway.siteId)',
    leftOfSite,
  )
  rt.end()
}

/**
 * Follows a release while it holds the site, every 200 ms: when another dialog's turn waits for
 * the site under it, what production holds once the job wrote (`onWritten`, after `db
 * succeeded` and before the rollback can start: the check waits 5 s), when the release let the
 * site go and when the waiting turn left the queue.
 */
async function watchRelease({
  db,
  rt,
  siteId,
  releaseId,
  holderTaskId,
  waiterTaskId,
  onWritten,
  service,
}) {
  const seen = { waiting: null, written: null, freed: null, left: null }
  const deadline = Date.now() + 20 * MINUTE
  let tried = false
  for (;;) {
    if (Date.now() > deadline) throw new Error(`release ${releaseId} still holds the site`)
    if (!service.running()) throw new Error('core exited while the stand followed a release')
    const [release, lease, waiter] = await Promise.all([
      db.siteRelease.findUniqueOrThrow({ where: { id: releaseId } }),
      db.siteLease.findUnique({ where: { siteId } }),
      db.task.findUniqueOrThrow({ where: { id: waiterTaskId } }),
    ])
    if (
      seen.waiting === null &&
      waiter.status === 'queued' &&
      waiter.waiting === 'site' &&
      lease?.holderTaskId === holderTaskId
    )
      seen.waiting = { lease: { operation: lease.operation, holderTaskId: lease.holderTaskId } }
    if (!tried && !TERMINAL_RELEASE.includes(release.status)) {
      const steps = await db.releaseStep.findMany({ where: { releaseId } })
      if (steps.some((step) => step.step === 'db' && step.state === 'succeeded')) {
        tried = true
        const rollbackBefore = steps.some((step) => step.step === 'rollback')
        const written = await onWritten()
        const rollbackAfter = await db.releaseStep.count({
          where: { releaseId, step: 'rollback' },
        })
        // Read before the rollback began, or it proves nothing about the write.
        seen.written = !rollbackBefore && rollbackAfter === 0 ? written : null
      }
    }
    const terminal = TERMINAL_RELEASE.includes(release.status)
    if (seen.freed === null && terminal && lease?.inflightReleaseId !== releaseId)
      seen.freed = Date.now()
    // Only once the site is free: a retry of its own before that is no wake.
    if (
      seen.waiting !== null &&
      seen.freed !== null &&
      seen.left === null &&
      !(waiter.status === 'queued' && waiter.waiting === 'site')
    )
      seen.left = Date.now()
    if (seen.freed !== null && (seen.left !== null || Date.now() - seen.freed > 3 * MINUTE))
      return seen
    await rt.pause(200)
  }
}

/** The object of a backup as raditi-backups holds it, through S3 with the stand's identity. */
async function readBackup(stand, key) {
  if (!key) throw new CheckFailed('the release names no backup object')
  const require = createRequire(join(stand.copy, 'packages/storage/package.json'))
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')
  const client = new S3Client({
    endpoint: stand.s3.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: stand.s3.accessKey, secretAccessKey: stand.s3.secretKey },
  })
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: 'raditi-backups', Key: key }))
    return Buffer.from(await object.Body.transformToByteArray())
  } finally {
    client.destroy()
  }
}

/**
 * The dialog page of web in a real Chromium: the session cookie of the owner, `/` in the field
 * opens the list of commands, and the preview's iframe opens the preview through a ticket.
 */
async function browserOfCabinet(stand, dialog, visit) {
  const { rt } = stand
  const require = createRequire(join(stand.copy, 'packages/browser-providers/package.json'))
  const { chromium } = require('playwright-core')
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const cookies = stand.owner
      .cookie()
      .split('; ')
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf('=')
        return { name: pair.slice(0, at), value: pair.slice(at + 1), url: stand.webUrl }
      })
    await context.addCookies(cookies)
    const page = await context.newPage()
    await page.goto(`${stand.webUrl}/projects/${stand.siteId}/chat/${dialog.taskId}`, {
      waitUntil: 'domcontentloaded',
    })
    const field = page.getByRole('textbox').first()
    await field.waitFor({ timeout: 60_000 })
    await field.click()
    await field.type('/')
    const listbox = page.getByRole('listbox')
    await listbox.waitFor({ timeout: 15_000 })
    const options = await listbox.getByRole('option').allTextContents()
    rt.check(
      options.some((text) => text.includes('/release') && text.includes('Выпустить новую версию')),
      `the dialog page of web: «/» in the field opens the list of commands (${options.length} commands, /release among them)`,
      options,
    )
    await page.keyboard.press('Escape')
    const frame = await rt.until(
      'the preview iframe of the dialog page',
      async () => page.frames().find((one) => one.url().startsWith(visit.origin)) ?? null,
      { timeoutMs: 90_000 },
    )
    await rt.until(
      'the preview iframe shows the candidate',
      async () => (await frame.content()).includes(TEXT.footer(1)),
      { timeoutMs: 60_000 },
    )
    rt.passed(
      'the iframe of the dialog page entered the preview with a ticket and shows the new footer',
    )
    await context.close()
  } finally {
    await browser.close()
  }
}

/**
 * S10 in the cabinet: the card of the failure of dialog J says the changes were kept and offers
 * «Попробовать ещё» with its hint, the field stays open, `/` lists `/retry`; then the button is
 * pressed, as the owner presses it.
 */
async function retryInCabinet(stand, dialog) {
  const { rt } = stand
  const require = createRequire(join(stand.copy, 'packages/browser-providers/package.json'))
  const { chromium } = require('playwright-core')
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const cookies = stand.owner
      .cookie()
      .split('; ')
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf('=')
        return { name: pair.slice(0, at), value: pair.slice(at + 1), url: stand.webUrl }
      })
    await context.addCookies(cookies)
    const page = await context.newPage()
    await page.goto(`${stand.webUrl}/projects/${stand.siteId}/chat/${dialog.taskId}`, {
      waitUntil: 'domcontentloaded',
    })
    const button = page.getByRole('button', { name: 'Попробовать ещё' })
    await button.waitFor({ timeout: 60_000 })
    const card = page.getByRole('listitem').filter({ has: button })
    const text = (await card.innerText()).replaceAll('\u00a0', ' ')
    rt.check(
      text.includes('Не получилось выполнить задачу из-за технического сбоя.') &&
        text.includes('Изменения, готовые до этого, мы сохранили.') &&
        text.includes('Повторная попытка может стоить больше кредитов.'),
      'the dialog page of web: the card of the failure says the changes were kept and offers «Попробовать ещё» with its hint',
      text,
    )
    const field = page.getByRole('textbox').first()
    await field.click()
    await field.type('/')
    const listbox = page.getByRole('listbox')
    await listbox.waitFor({ timeout: 15_000 })
    const options = await listbox.getByRole('option').allTextContents()
    rt.check(
      options.some((option) => option.includes('/retry') && option.includes('Попробовать ещё')) &&
        options.some((option) => option.includes('/release')),
      'the field stays open, and «/» lists /retry «Попробовать ещё» beside /release',
      options,
    )
    await page.keyboard.press('Escape')
    await field.fill('')
    await button.click()
    await rt.until(
      'the press of the button reached the server',
      async () => (await button.count()) === 0,
      { timeoutMs: 30_000 },
    )
    await context.close()
  } finally {
    await browser.close()
  }
}

/**
 * The tab «База данных» of the panel beside a dialog, as its owner sees it in the cabinet: the
 * text of the panel once the description of the plan is shown.
 */
async function databasePanelText(stand, dialog) {
  const require = createRequire(join(stand.copy, 'packages/browser-providers/package.json'))
  const { chromium } = require('playwright-core')
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const cookies = stand.owner
      .cookie()
      .split('; ')
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf('=')
        return { name: pair.slice(0, at), value: pair.slice(at + 1), url: stand.webUrl }
      })
    await context.addCookies(cookies)
    const page = await context.newPage()
    await page.goto(`${stand.webUrl}/projects/${stand.siteId}/chat/${dialog.taskId}`, {
      waitUntil: 'domcontentloaded',
    })
    const tab = page.getByRole('tab', { name: 'База данных' })
    await tab.waitFor({ timeout: 60_000 })
    await tab.click()
    const panel = page.locator('#dialog-pane-panel-database')
    await panel.getByText('starts_at', { exact: false }).first().waitFor({ timeout: 30_000 })
    const text = await panel.innerText()
    await context.close()
    return text
  } finally {
    await browser.close()
  }
}
