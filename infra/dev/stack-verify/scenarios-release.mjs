// The group `release` of the stand of the site stacks (verify-stack.mjs; docs/plan/62-site-stacks.md,
// Т36, Т43, М4; docs/plan/62-slices/e3.md, Э3.12): on the site `import` made of each build, after
// `preview` closed its dialog — a turn of the scripted model edits the template of the stack, its
// style and a text, and the candidate is released by `/release` through the real deploy job over
// SFTP (R1, R3); a file outside the working set is refused (R2); a change that breaks production
// only is rolled back (R4); «Отменить выпуск» is a new release (R5); a file the owner changed on
// the hosting refuses the release before any write (R6). No plan of the database: a new stack
// releases files only. The stack is named only by its record of STACK_STANDS; every PASS line is a
// fact read from the product's state, the pages it serves, or what Gitea, OpenBao, S3, Docker and
// the hosting hold.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { localVaultRequest } from '../../vault/bootstrap.mjs'
import { CheckFailed, exchange } from '../release-verify/runtime.mjs'
import { repositoryReader } from '../release-verify/setup.mjs'
import { expectedCharge, versionAbove } from '../release-verify/stand.mjs'
import { dockerOfSite, previewVisit } from './scenarios-preview.mjs'
import { PRODUCTION_ROOT, uuid7 } from './stand.mjs'
import {
  breakingTurn,
  conflictPart,
  conflictTurn,
  editTurn,
  forbiddenTurn,
  markOf,
  ownerLine,
} from './turns.mjs'

const MINUTE = 60_000
const sum = (rows) => rows.reduce((total, row) => total + Number(row.amount), 0)
const TERMINAL_RELEASE = ['installed', 'rolled_back', 'failed', 'unknown']
/** The secret of the repository the release arms for its job (DEPLOY_WRAP_SECRET_NAME). */
const WRAP_SECRET = 'RADITI_DEPLOY_WRAP'
/** The first bytes of a sealed deploy envelope (deploy-step/envelope.ts). */
const ENVELOPE_MAGIC = 'RDE1'
/** The tag of the first import: what `main` held before any release. */
const IMPORT_TAG = 'v0.0.0'

/** The parts of an edit, in the order a turn writes them. */
const partsOf = (edit) => [edit.template, edit.style, edit.texts].filter(Boolean)

/** What a release did, step by step, as the job reported it. */
async function stepsOf(db, releaseId) {
  return (await db.releaseStep.findMany({ where: { releaseId }, orderBy: { id: 'asc' } })).map(
    (row) => `${row.step} ${row.state}${row.detail?.code ? ` ${row.detail.code}` : ''}`,
  )
}

/** The object of a backup as raditi-backups holds it, through S3 with the stand's identity. */
async function readBackup(ctx, key) {
  if (!key) throw new CheckFailed('the release names no backup object')
  const require = createRequire(join(ctx.copy, 'packages/storage/package.json'))
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')
  const client = new S3Client({
    endpoint: ctx.s3.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: ctx.s3.accessKey, secretAccessKey: ctx.s3.secretKey },
  })
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: 'raditi-backups', Key: key }))
    return Buffer.from(await object.Body.transformToByteArray())
  } finally {
    client.destroy()
  }
}

/** The readers of one site: its dialogs, its releases, its repository and its hosting. */
function siteOf(rt, ctx, entry) {
  const { db, gitea } = ctx
  const { siteId, production } = entry
  const repo = `site-${siteId}`
  const admin = { token: gitea.tokens.admin }
  const api = (method, path, options = {}) =>
    gitea.api(method, `/repos/sites/${repo}${path}`, { as: admin, ...options })
  const encoded = (path) => path.split('/').map(encodeURIComponent).join('/')
  const reader = repositoryReader(rt, {
    gitea,
    repoName: repo,
    directory: production.directory,
    certificates: ctx.certificates,
  })
  const site = {
    repo,
    api,
    tree: (sha) => reader.tree(sha),
    /** A file of the repository at a reference, or null where it has none. */
    gitFile: async (ref, path) => {
      const answer = await api('GET', `/raw/${encoded(path)}?ref=${encodeURIComponent(ref)}`, {
        expect: [200, 404],
      })
      return answer.status === 200 ? answer.text : null
    },
    // From the refs of git itself: Gitea fills its table of branches after a push on its own time.
    head: async () => {
      const refs = (await api('GET', '/git/refs/heads/main', { expect: 200 })).json
      return [refs].flat().find((ref) => ref.ref === 'refs/heads/main').object.sha
    },
    deployRuns: async () => {
      const list = await api('GET', '/actions/runs?limit=50', { expect: 200 })
      return (list.json.workflow_runs ?? []).filter((run) => run.path?.startsWith('deploy.yml@'))
    },
    /** A file of the hosting, as SFTP and the web server see it; null where there is none. */
    hostingFile: async (path) => {
      const answer = await production.exec([
        'sh',
        '-c',
        'if [ -f "$1" ]; then printf F; cat "$1"; else printf M; fi',
        'sh',
        `${PRODUCTION_ROOT}/${path}`,
      ])
      return answer.startsWith('F') ? answer.slice(1) : null
    },
    /**
     * The owner changes a file of the hosting by hand: a line appended to a file that is there —
     * its owner, the web server's user, stays; a file that is not there fails the command.
     */
    ownerAppends: (path, line) =>
      production.exec([
        'sh',
        '-c',
        'test -f "$1" && printf "%s\\n" "$2" >> "$1"',
        'sh',
        `${PRODUCTION_ROOT}/${path}`,
        line,
      ]),
    /** A page of production as a visitor gets it: its status and its HTML. */
    page: async (path = '/') => {
      const answer = await exchange(`${production.origin}${path}`, { signal: rt.signal })
      return { status: answer.status, text: answer.text }
    },
    holdsOf: (taskId) => db.creditHold.findMany({ where: { taskId } }),
    chargesOf: (taskId) => db.creditLedger.findMany({ where: { taskId, kind: 'charge' } }),
    currentCandidate: (taskId) =>
      db.taskCandidate.findFirst({ where: { taskId, status: 'current' } }),
    release: (releaseId) => db.siteRelease.findUniqueOrThrow({ where: { id: releaseId } }),
    row: () => db.site.findUniqueOrThrow({ where: { id: siteId } }),
  }
  return site
}

/** The preview of a dialog ready at `revision`; a preview that failed fails at once. */
function previewReady(rt, ctx, taskId, revision) {
  return rt.until(
    `the preview of ${taskId} ready at revision ${revision}`,
    async () => {
      const row = await ctx.db.previewEnvironment.findUnique({ where: { taskId } })
      if (['failed', 'unavailable', 'destroyed'].includes(row?.status))
        throw new CheckFailed(
          `the preview of ${taskId} is ${row.status}: ${row.errorCode ?? row.unavailableReason}`,
        )
      return row?.status === 'ready' && row.revision === revision && !row.dirty ? row : null
    },
    { timeoutMs: 10 * MINUTE, intervalMs: 500, service: ctx.processes.core },
  )
}

/** The dialog in one of `statuses`; one that ended elsewhere fails at once. */
function dialogReaches(rt, ctx, taskId, statuses, timeoutMs = 12 * MINUTE) {
  return rt.until(
    `dialog ${taskId} in ${statuses.join('|')}`,
    async () => {
      const task = await ctx.db.task.findUniqueOrThrow({ where: { id: taskId } })
      if (statuses.includes(task.status)) return task
      if (['failed', 'cancelled', 'done', 'rolled_back'].includes(task.status))
        throw new CheckFailed(`dialog ${taskId} ended ${task.status}`)
      return null
    },
    { timeoutMs, intervalMs: 1000, service: ctx.processes.core },
  )
}

/** The checks of `kinds` of a candidate settled at its revision. */
function checksSettled(rt, ctx, candidate, kinds) {
  return rt.until(
    `checks ${kinds.join(', ')} of candidate ${candidate.id}`,
    async () => {
      const checks = await ctx.db.candidateCheck.findMany({ where: { candidateId: candidate.id } })
      const settled = kinds.every((kind) =>
        checks.some(
          (check) =>
            check.kind === kind &&
            check.status !== 'pending' &&
            check.revision === candidate.revision,
        ),
      )
      return settled ? checks : null
    },
    { timeoutMs: 8 * MINUTE, intervalMs: 1000, service: ctx.processes.core },
  )
}

const passedAt = (checks, kind, revision) =>
  checks.some(
    (check) => check.kind === kind && check.revision === revision && check.status === 'passed',
  )

/** A release followed to its end. */
function releaseEnds(rt, ctx, releaseId) {
  return rt.until(
    `release ${releaseId} ends`,
    async () => {
      const row = await ctx.db.siteRelease.findUniqueOrThrow({ where: { id: releaseId } })
      return TERMINAL_RELEASE.includes(row.status) ? row : null
    },
    { timeoutMs: 15 * MINUTE, intervalMs: 2000, service: ctx.processes.core },
  )
}

/** A release confirmed as the window confirms it: the proposed version of `release.prepare`. */
async function confirmRelease(ctx, taskId) {
  const prepared = await ctx.owner.query('release.prepare', { taskId })
  const choice = prepared.choices.find((option) => option.version === prepared.proposal.version)
  const confirmed = await ctx.owner.mutate('release.confirm', {
    taskId,
    confirmToken: choice.confirmToken,
    version: choice.version,
  })
  return { prepared, confirmed }
}

/**
 * Р31: once a release ended, its way to the site is closed — the secret of the repository is gone
 * (read as the release account, the only one Gitea shows it to) and its wrapping is no token
 * OpenBao knows.
 */
async function wayInClosed(rt, ctx, site, releaseId, label) {
  const row = await site.release(releaseId)
  const secrets = await rt.until(`the deploy secret of ${label} deleted`, async () => {
    const answer = await ctx.gitea.api('GET', `/repos/sites/${site.repo}/actions/secrets`, {
      as: ctx.gitea.as('owner'),
      expect: 200,
    })
    const list = [answer.json].flat().map((secret) => secret?.name)
    return list.includes(WRAP_SECRET) ? null : list
  })
  const lookup = row.wrapAccessor
    ? await localVaultRequest(ctx.vault.root, 'auth/token/lookup-accessor', {
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
 * What production serves while a release that broke it checks the site: the home page read again
 * and again from the report of the files written to the first step of the rollback — the first
 * answer of 500 or more, else the last one read; null when that window passed unseen. A read that
 * a step of the rollback may have overtaken does not count: it proves nothing about the write.
 */
async function productionWhileChecked(rt, ctx, site, releaseId) {
  const deadline = Date.now() + 20 * MINUTE
  let last = null
  for (;;) {
    if (Date.now() > deadline) throw new Error(`release ${releaseId} still runs`)
    if (!ctx.processes.core.running()) throw new Error('core exited during a release')
    const release = await site.release(releaseId)
    if (TERMINAL_RELEASE.includes(release.status)) return last
    const steps = await ctx.db.releaseStep.findMany({ where: { releaseId } })
    if (steps.some((step) => step.step === 'rollback')) return last
    if (steps.some((step) => step.step === 'files' && step.state === 'succeeded')) {
      const page = await site.page('/')
      const rollback = await ctx.db.releaseStep.count({ where: { releaseId, step: 'rollback' } })
      if (rollback > 0) return last
      if (page.status >= 500) return page
      last = page
    }
    await rt.pause(200)
  }
}

/** A dialog closed by `/cancel` as the owner closes one, and its preview gone. */
async function cancelDialog(rt, ctx, taskId) {
  const cancelled = await ctx.owner.mutate('task.cancel', { taskId, requestId: uuid7() })
  await rt.until(
    `the preview of ${taskId} is destroyed`,
    async () => {
      const row = await ctx.db.previewEnvironment.findUnique({ where: { taskId } })
      return row === null || row.status === 'destroyed'
    },
    { timeoutMs: 5 * MINUTE, intervalMs: 1000, service: ctx.processes.core },
  )
  return cancelled
}

/** R1–R6 and the closing row of one build. */
async function releaseOfBuild(rt, ctx, entry) {
  const { db, owner, model } = ctx
  const { stand, build, siteId, tree } = entry
  const edit = stand.edit(build)
  const parts = partsOf(edit)
  const site = siteOf(rt, ctx, entry)
  // Where production shows the mark: `shownAt` of the record, else the home page and the line of
  // the template (`.stack-mark`). A record with neither cannot be released by this group.
  const shown =
    stand.shownAt?.(build) ?? (edit.template ? { path: '/', text: edit.template.line } : null)
  if (!shown) throw new Error(`The record of ${stand.stack} names no shownAt and no template`)
  const mark = markOf(edit, shown)

  // ── R1 ────────────────────────────────────────────────────────────────────────
  rt.begin(`R1 ${build.archive}`, 'ход и кандидат')
  // The record names the template by branch (TEMPLATE_PATHS): the tree of the archive says whether
  // the supply has it, with its tag once — a template that is not there fails here, in these words.
  // A template of a theme the stand installs beside the supply says so (`fromImport`; WordPress,
  // Э3.15: the block theme of the supply has no footer): the tree of the import is read instead, and
  // only for such a record.
  // The other parts are matched with the tree of the import (the tag v0.0.0): a file the stand puts
  // beside the supply (a theme of its own, Э4.7, Э5.8) is a file of the site all the same.
  const templateIn = edit.template?.fromImport ? IMPORT_TAG : 'the tree of the archive'
  const supplyProblems = []
  for (const part of parts) {
    if (part === edit.template) {
      const held = part.fromImport
        ? await site.gitFile(IMPORT_TAG, part.path)
        : await readFile(join(tree, part.path), 'utf8').catch(() => null)
      const tags = held === null ? 0 : held.split(part.before).length - 1
      const branch = build.generation === null ? '' : ` for ${build.generation}`
      if (held === null)
        supplyProblems.push(
          part.fromImport
            ? `the import of ${build.archive} (${IMPORT_TAG}) has no ${part.path}: the template the record names${branch} is not there`
            : `the supply of ${build.archive} has no ${part.path}: the template the record names${branch} is not there`,
        )
      else if (tags !== 1)
        supplyProblems.push(
          `${part.path} of ${build.archive} holds ${part.before} ${tags} times in ${templateIn}, not once: the mark has no one place`,
        )
      continue
    }
    const imported = await site.gitFile(IMPORT_TAG, part.path)
    if (part.created && imported !== null)
      supplyProblems.push(
        `the import of ${build.archive} holds ${part.path}, which the record says is new`,
      )
    else if (!part.created && imported === null)
      supplyProblems.push(
        `the import of ${build.archive} has no ${part.path}, which the record says the turn appends to`,
      )
  }
  rt.check(
    supplyProblems.length === 0,
    `the site holds what the record edits: ${parts
      .map((part) =>
        part === edit.template
          ? `${part.path} with one ${part.before} in ${templateIn}`
          : `${part.path} ${part.created ? 'absent (new)' : 'present (appended to)'} in ${IMPORT_TAG}`,
      )
      .join(', ')}`,
    supplyProblems,
  )
  const dialogA = uuid7()
  rt.note(
    `the first answer of the scripted model in the dialog of ${build.archive} waits until its preview is ready at revision 0: a precondition of the stand`,
  )
  model.script(editTurn(edit, shown), {
    waitFor: async () => {
      await previewReady(rt, ctx, dialogA, 0).catch(() => null)
    },
  })
  await owner.mutate('task.create', {
    siteId,
    taskId: dialogA,
    text: `Добавьте в подвал строку «${mark.text}», её стиль и перевод.`,
  })
  const taskA = await dialogReaches(rt, ctx, dialogA, ['awaiting_approval'])
  rt.check(
    taskA.status === 'awaiting_approval',
    'the dialog waits for /release (awaiting_approval)',
  )
  const candidateA = await site.currentCandidate(dialogA)
  rt.check(candidateA?.revision === 1, 'the candidate of the dialog is revision 1', {
    revision: candidateA?.revision,
  })
  const filesA = candidateA.files.map((file) => `${file.change} ${file.path}`).toSorted()
  const expectedA = parts
    .map((part) => `${part.created ? 'added' : 'modified'} ${part.path}`)
    .toSorted()
  rt.check(
    JSON.stringify(filesA) === JSON.stringify(expectedA),
    `its files are those of the working set the turn wrote: ${expectedA.join(', ')}`,
    filesA,
  )
  rt.check(candidateA.dbPlan.length === 0, 'its database plan is empty: a release of files only', {
    plan: candidateA.dbPlan.length,
  })
  const checksA = await checksSettled(rt, ctx, candidateA, [
    'php_lint',
    'preview_smoke',
    'agent_browser',
  ])
  rt.check(
    ['php_lint', 'preview_smoke', 'agent_browser'].every((kind) => passedAt(checksA, kind, 1)),
    'checks of revision 1: php_lint, preview_smoke and agent_browser passed',
    checksA.map((check) => [check.kind, check.status, check.revision]),
  )
  const browserA = checksA.find((check) => check.kind === 'agent_browser' && check.revision === 1)
  rt.check(
    browserA.summary?.total >= 1 && browserA.summary.passed === browserA.summary.total,
    `the agent's browser found ${mark.text} by ${'.stack-mark'} on the preview: every check passed`,
    browserA.summary,
  )
  await previewReady(rt, ctx, dialogA, 1)
  const visitA = await previewVisit(rt, ctx, dialogA, ['/'])
  rt.check(
    visitA.pages['/'].status === 200 &&
      visitA.pages['/'].text.includes(edit.template?.line ?? mark.text),
    'the preview of revision 1 shows the mark on its home page, through the gateway and a ticket',
    { status: visitA.pages['/'].status },
  )
  const chargedA = await rt.until(
    'the charge of the pass of the dialog',
    async () => {
      const holds = await site.holdsOf(dialogA)
      return holds.length > 0 && holds.every((hold) => hold.status === 'captured')
        ? site.chargesOf(dialogA)
        : null
    },
    { timeoutMs: 3 * MINUTE, intervalMs: 1000, service: ctx.processes.core },
  )
  const callsA = await db.tokenUsage.findMany({
    where: { taskId: dialogA, taskAttempt: 1, billable: true },
  })
  const heldA = sum(await site.holdsOf(dialogA))
  const expectedChargeA = expectedCharge(callsA, heldA)
  // The turn reports a large usage (editTurn): above the minimum of 5 and below the reserve, the
  // charge equals the usage — a filter that found no call, or a charge that took the minimum, fails.
  rt.check(
    callsA.length > 0 &&
      expectedChargeA.costRub > 0 &&
      expectedChargeA.used > 5 &&
      expectedChargeA.used < heldA &&
      -sum(chargedA) === expectedChargeA.used,
    `the pass is charged when it ends, by its token usage: ${-sum(chargedA)} credits = ${expectedChargeA.costRub.toFixed(4)} ₽ ÷ 6 ₽ of ${callsA.length} calls, above the minimum of 5, from the ${heldA} it held`,
    { charged: -sum(chargedA), calls: callsA.length, held: heldA, expected: expectedChargeA },
  )
  for (const part of parts)
    rt.check(
      (await site.hostingFile(part.path)) === (await site.gitFile(IMPORT_TAG, part.path)),
      `production unchanged: ${part.path} is ${part.created ? 'absent' : 'as imported'} on the hosting`,
    )
  const before = await site.page(shown.path)
  rt.check(
    before.status === 200 && !before.text.includes(shown.text),
    `production does not show the mark at ${shown.path}`,
    { status: before.status },
  )
  rt.end()

  // ── R2 ────────────────────────────────────────────────────────────────────────
  rt.begin(`R2 ${build.archive}`, 'запрет вне рабочего набора')
  const dialogF = uuid7()
  model.script(forbiddenTurn(stand.outsideWorkingSet))
  await owner.mutate('task.create', {
    siteId,
    taskId: dialogF,
    text: 'Добавьте файл в библиотеки сайта.',
  })
  const failureF = await rt.until(
    'the failure of the pass that wrote outside the working set',
    async () => {
      const task = await db.task.findUniqueOrThrow({ where: { id: dialogF } })
      if (['failed', 'cancelled', 'done', 'rolled_back'].includes(task.status))
        throw new CheckFailed(`dialog ${dialogF} ended ${task.status}`)
      const row = await db.taskEvent.findFirst({
        where: { taskId: dialogF, type: 'feed.failure' },
        orderBy: { id: 'desc' },
      })
      return row && task.status === 'awaiting_user' ? { task, row } : null
    },
    { timeoutMs: 12 * MINUTE, intervalMs: 1000, service: ctx.processes.core },
  )
  rt.check(
    failureF.row.payload?.code === 'forbidden_change',
    `the pass ends with the refusal forbidden_change: ${stand.outsideWorkingSet} is outside the working set`,
    failureF.row.payload,
  )
  rt.check(
    (await db.taskCandidate.count({ where: { taskId: dialogF } })) === 0,
    'no candidate of the dialog',
  )
  rt.check(
    failureF.task.status === 'awaiting_user',
    'the dialog stays open for the next words (awaiting_user)',
  )
  const returnedF = await rt.until(
    'the reserve of the refused pass returned',
    async () => {
      const holds = await site.holdsOf(dialogF)
      return holds.length > 0 && holds.every((hold) => hold.status === 'released') ? holds : null
    },
    { timeoutMs: 3 * MINUTE, intervalMs: 1000, service: ctx.processes.core },
  )
  rt.check(
    returnedF.length > 0 && (await site.chargesOf(dialogF)).length === 0,
    `the reserve is returned (${sum(returnedF)} credits) and nothing is charged`,
  )
  rt.check(
    (await site.hostingFile(stand.outsideWorkingSet)) === null,
    `production holds no ${stand.outsideWorkingSet}`,
  )
  const cancelledF = await cancelDialog(rt, ctx, dialogF)
  rt.check(cancelledF.state === 'cancelled', 'the dialog closed by /cancel, its preview gone')
  rt.end()

  // ── R3 ────────────────────────────────────────────────────────────────────────
  rt.begin(`R3 ${build.archive}`, 'выпуск')
  const runsBefore = (await site.deployRuns()).length
  const releaseA = await confirmRelease(ctx, dialogA)
  rt.check(
    releaseA.prepared.proposal.version === 'v0.1.0' &&
      releaseA.prepared.installedVersion === IMPORT_TAG,
    `release.prepare proposes v0.1.0 over the installed ${IMPORT_TAG}`,
    { proposal: releaseA.prepared.proposal, installed: releaseA.prepared.installedVersion },
  )
  const installedA = await releaseEnds(rt, ctx, releaseA.confirmed.releaseId)
  const stepsA = await stepsOf(db, installedA.id)
  rt.check(installedA.status === 'installed', 'the release is installed', {
    status: installedA.status,
    error: installedA.errorCode,
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
        'verify started',
        'verify succeeded',
      ]),
    'the job reported conflicts → backup → files over SFTP → verify: no step of the database',
    stepsA,
  )
  const backup = await readBackup(ctx, installedA.backupObjectKey)
  rt.check(
    installedA.backupVerifiedAt !== null &&
      backup.byteLength === Number(installedA.backupBytes) &&
      createHash('sha256').update(backup).digest('hex') === installedA.backupSha256 &&
      backup.subarray(0, 4).toString('latin1') === ENVELOPE_MAGIC,
    `the backup in raditi-backups is the one core verified (${backup.byteLength} bytes, SHA-256), sealed`,
  )
  const tagA = await site.api('GET', '/tags/v0.1.0', { expect: 200 })
  rt.check(
    tagA.json.commit.sha === installedA.approvedSha &&
      (await site.head()) === installedA.approvedSha,
    'the tag v0.1.0 and main name the approved commit of the release',
  )
  const runsA = await rt.until('the run of v0.1.0 completed', async () => {
    const list = (await site.deployRuns()).filter(
      (run) => run.path === 'deploy.yml@refs/tags/v0.1.0',
    )
    return list.length > 0 && list.every((run) => run.status === 'completed') ? list : null
  })
  rt.check(
    runsA.length === 1 &&
      runsA[0].event === 'push' &&
      (await site.deployRuns()).length === runsBefore + 1,
    'exactly one run of deploy.yml from platform/ci, by the tag (event push)',
    runsA.map((run) => [run.event, run.status]),
  )
  const siteA = await rt.until('the site records the installed release', async () => {
    const row = await site.row()
    return row.installedReleaseId === installedA.id ? row : null
  })
  rt.check(
    siteA.installedVersion === 'v0.1.0' && siteA.installedSha === installedA.approvedSha,
    'sites.installed_* name v0.1.0 and the approved commit',
  )
  await wayInClosed(rt, ctx, site, installedA.id, 'the release v0.1.0')
  const doneA = await dialogReaches(rt, ctx, dialogA, ['done'], 5 * MINUTE)
  const holdsA = await site.holdsOf(dialogA)
  rt.check(
    doneA.status === 'done' &&
      holdsA.every((hold) => hold.status === 'captured') &&
      -sum(await site.chargesOf(dialogA)) === expectedChargeA.credits,
    `the dialog is done; its pass stays charged by its usage (${expectedChargeA.credits} credits), the release charged nothing more`,
  )
  for (const part of parts)
    rt.check(
      (await site.hostingFile(part.path)) === (await site.gitFile('v0.1.0', part.path)),
      `${part.path} on the hosting is the file of the candidate (the tag v0.1.0)`,
    )
  const shownA = await site.page(shown.path)
  rt.check(
    shownA.status === 200 && shownA.text.includes(shown.text),
    `production shows the mark at ${shown.path}`,
    { status: shownA.status },
  )
  rt.end()

  // ── R4 ────────────────────────────────────────────────────────────────────────
  rt.begin(`R4 ${build.archive}`, 'возврат')
  const dialogB = uuid7()
  model.script(breakingTurn(edit, stand.breakOnProduction(build)), {
    waitFor: async () => {
      await previewReady(rt, ctx, dialogB, 0).catch(() => null)
    },
  })
  await owner.mutate('task.create', {
    siteId,
    taskId: dialogB,
    text: 'Добавьте вызов в шаблон.',
  })
  await dialogReaches(rt, ctx, dialogB, ['awaiting_approval'])
  const candidateB = await site.currentCandidate(dialogB)
  const checksB = await checksSettled(rt, ctx, candidateB, ['php_lint', 'preview_smoke'])
  await previewReady(rt, ctx, dialogB, candidateB.revision)
  const visitB = await previewVisit(rt, ctx, dialogB, ['/'])
  rt.check(
    passedAt(checksB, 'php_lint', candidateB.revision) &&
      passedAt(checksB, 'preview_smoke', candidateB.revision) &&
      visitB.pages['/'].status === 200 &&
      visitB.pages['/'].text.includes(edit.template?.line ?? mark.text),
    `the preview of the change answers 200 with the mark, php_lint and preview_smoke of revision ${candidateB.revision} passed: the fault shows only where the preview's constant is absent`,
    {
      status: visitB.pages['/'].status,
      checks: checksB.map((check) => [check.kind, check.status]),
    },
  )
  const chargedB = await rt.until(
    'the charge of the pass of the breaking dialog',
    async () => {
      const holds = await site.holdsOf(dialogB)
      return holds.length > 0 && holds.every((hold) => hold.status === 'captured')
        ? site.chargesOf(dialogB)
        : null
    },
    { timeoutMs: 3 * MINUTE, intervalMs: 1000, service: ctx.processes.core },
  )
  const installedBefore = await site.row()
  const releaseB = await confirmRelease(ctx, dialogB)
  const broken = await productionWhileChecked(rt, ctx, site, releaseB.confirmed.releaseId)
  const rolledB = await releaseEnds(rt, ctx, releaseB.confirmed.releaseId)
  const stepsB = await stepsOf(db, rolledB.id)
  rt.check(
    broken !== null && broken.status >= 500,
    `while the release checked the site, production answered ${broken?.status}: the file it wrote breaks production`,
    broken && { status: broken.status },
  )
  rt.check(
    rolledB.status === 'rolled_back' &&
      stepsB.includes('files succeeded') &&
      stepsB.includes('verify failed site_broken') &&
      stepsB.includes('rollback succeeded') &&
      stepsB.includes('reverify succeeded'),
    'the release wrote the file, its check found the site broken, the file was put back and the check passed again: rolled_back',
    { status: rolledB.status, error: rolledB.errorCode, steps: stepsB },
  )
  const siteB = await site.row()
  rt.check(
    siteB.installedVersion === 'v0.1.0' && siteB.installedSha === installedBefore.installedSha,
    'the installed version is still v0.1.0',
  )
  const revertedB = await rt.until(`the revert commit of ${rolledB.version}`, async () => {
    const row = await site.release(rolledB.id)
    return row.revertSha ? row : null
  })
  const mainB = await site.head()
  rt.check(
    revertedB.revertSha === mainB &&
      (await site.tree(mainB)) === (await site.tree(siteB.installedSha)),
    'main is the revert commit with the tree of v0.1.0',
    { revert: revertedB.revertSha, head: mainB },
  )
  const tagB = await site.api('GET', `/tags/${rolledB.version}`, { expect: [200, 404] })
  rt.check(
    tagB.status === 200 && tagB.json.commit.sha === rolledB.approvedSha,
    `the tag of the burnt number ${rolledB.version} stays on its release commit`,
  )
  const pathB = edit.template?.path ?? edit.style.path
  rt.check(
    (await site.hostingFile(pathB)) === (await site.gitFile('v0.1.0', pathB)),
    `${pathB} is put back on the hosting: the file of v0.1.0`,
  )
  const pageB = await site.page(shown.path)
  rt.check(
    pageB.status === 200 && pageB.text.includes(shown.text),
    'production serves v0.1.0 again: the page answers 200 with the mark',
    { status: pageB.status },
  )
  const taskB = await dialogReaches(rt, ctx, dialogB, ['rolled_back'], 3 * MINUTE)
  const holdsB = await site.holdsOf(dialogB)
  rt.check(
    taskB.status === 'rolled_back' &&
      holdsB.every((hold) => hold.status === 'captured') &&
      chargedB.length > 0 &&
      sum(await site.chargesOf(dialogB)) === sum(chargedB),
    'the dialog is rolled_back; the pass that made the candidate was charged when it ended, and the release gave nothing back and charged nothing more',
    holdsB.map((hold) => hold.status),
  )
  await wayInClosed(rt, ctx, site, rolledB.id, `the release ${rolledB.version}`)
  rt.end()

  // ── R5 ────────────────────────────────────────────────────────────────────────
  rt.begin(`R5 ${build.archive}`, 'отмена выпуска')
  const ledgerA = await db.creditLedger.count({ where: { taskId: dialogA } })
  const prepareUndo = async () =>
    (await owner.mutate('release.undoPrepare', { taskId: dialogA, releaseId: installedA.id }))
      .planId
  let planId = await prepareUndo()
  let renewed = 0
  const plan = await rt.until(
    'the plan of the undo of v0.1.0',
    async () => {
      const answer = await owner.query('release.undoPlan', {
        taskId: dialogA,
        releaseId: installedA.id,
        planId,
      })
      // A plan made while the end of the release before still held the site: asked again, as the
      // window does.
      if (answer.state === 'expired' && renewed < 3) {
        renewed += 1
        planId = await prepareUndo()
        return null
      }
      if (answer.state === 'failed' || answer.state === 'expired')
        throw new CheckFailed(`the plan of the undo is ${answer.state}: ${answer.reason ?? ''}`)
      return answer.state === 'ready' ? answer : null
    },
    { timeoutMs: 3 * MINUTE, intervalMs: 1000, service: ctx.processes.core },
  )
  rt.check(
    plan.undoneVersion === 'v0.1.0' &&
      plan.nothingToUndo === false &&
      plan.records.length === 0 &&
      versionAbove(plan.version, rolledB.version),
    `core offers «Отменить выпуск» v0.1.0 as ${plan.version}, past the burnt ${rolledB.version}: files only, no record of the database`,
    { version: plan.version, records: plan.records.length },
  )
  const confirmedUndo = await owner.mutate('release.undoConfirm', {
    taskId: dialogA,
    releaseId: installedA.id,
    confirmToken: plan.confirmToken,
    version: plan.version,
  })
  const undo = await releaseEnds(rt, ctx, confirmedUndo.undoId)
  const stepsUndo = await stepsOf(db, undo.id)
  rt.check(
    undo.kind === 'undo' && undo.status === 'installed',
    `the undo is a release of its own, installed: ${undo.version}`,
    { kind: undo.kind, status: undo.status, error: undo.errorCode, steps: stepsUndo },
  )
  for (const part of parts)
    rt.check(
      (await site.hostingFile(part.path)) ===
        (await site.gitFile(installedA.installedBeforeSha, part.path)),
      `${part.path} on the hosting is ${part.created ? 'gone again' : 'the file before v0.1.0'}`,
    )
  const pageUndo = await site.page(shown.path)
  rt.check(
    pageUndo.status === 200 && !pageUndo.text.includes(shown.text),
    'production answers 200 without the mark',
    { status: pageUndo.status },
  )
  // The undo reports `installed` first; core records it on the site in its next step.
  const siteUndo = await rt.until(
    'the site records the undo',
    async () => {
      const row = await site.row()
      return row.installedReleaseId === undo.id ? row : null
    },
    { timeoutMs: 3 * MINUTE, intervalMs: 1000, service: ctx.processes.core },
  )
  rt.check(
    siteUndo.installedReleaseId === undo.id &&
      siteUndo.installedVersion === undo.version &&
      (await site.head()) === undo.approvedSha &&
      (await site.tree(undo.approvedSha)) === (await site.tree(installedA.installedBeforeSha)),
    `the site runs ${undo.version}: a new commit on main with the tree before v0.1.0`,
  )
  rt.check(
    (await db.task.findUniqueOrThrow({ where: { id: dialogA } })).status === 'done' &&
      (await db.creditLedger.count({ where: { taskId: dialogA } })) === ledgerA,
    'the dialog stays done; the undo charged nothing',
  )
  await wayInClosed(rt, ctx, site, undo.id, `the undo ${undo.version}`)
  rt.end()

  // ── R6 ────────────────────────────────────────────────────────────────────────
  // Last of the build: the conflict leaves the site where only the owner gets it out (R8, Э6а.12).
  // The file is one of the installed version (conflictPart): the style where the supply has it,
  // the template where the style was new and the undo of R5 took it away again.
  rt.begin(`R6 ${build.archive}`, 'конфликт с правкой владельца')
  const partC = conflictPart(edit)
  const dialogC = uuid7()
  model.script(conflictTurn(edit), {
    waitFor: async () => {
      await previewReady(rt, ctx, dialogC, 0).catch(() => null)
    },
  })
  await owner.mutate('task.create', {
    siteId,
    taskId: dialogC,
    text: 'Сделайте строку подвала жирной.',
  })
  await dialogReaches(rt, ctx, dialogC, ['awaiting_approval'])
  const candidateC = await site.currentCandidate(dialogC)
  rt.check(
    candidateC.files.length === 1 &&
      candidateC.files[0].path === partC.path &&
      candidateC.files[0].change === 'modified',
    `the candidate changes ${partC.path} only, a file of the installed version (modified)`,
    candidateC.files,
  )
  const installedC = await site.row()
  const headC = await site.head()
  const hostedBefore = await site.hostingFile(partC.path)
  rt.check(
    hostedBefore !== null &&
      hostedBefore === (await site.gitFile(installedC.installedSha, partC.path)),
    `before the owner's change, ${partC.path} on the hosting is the file of the installed ${installedC.installedVersion}`,
  )
  const ownerText = ownerLine(partC.path)
  await site.ownerAppends(partC.path, ownerText)
  const ownerFile = await site.hostingFile(partC.path)
  rt.check(
    ownerFile === `${hostedBefore}${ownerText}\n`,
    `the owner changed ${partC.path} on the hosting: a line of his own appended to the installed file`,
  )
  const releaseC = await confirmRelease(ctx, dialogC)
  const refusedC = await releaseEnds(rt, ctx, releaseC.confirmed.releaseId)
  const stepsC = await stepsOf(db, refusedC.id)
  rt.check(
    refusedC.status === 'failed' &&
      refusedC.errorCode === 'conflict' &&
      stepsC.includes('conflicts failed conflict') &&
      !stepsC.some((step) => /^(backup|files|verify|rollback) /.test(step)),
    'the step of conflicts refuses the release before any write: conflict',
    { status: refusedC.status, error: refusedC.errorCode, steps: stepsC },
  )
  rt.check(
    (await site.hostingFile(partC.path)) === ownerFile,
    `${partC.path} on the hosting stays the owner's change`,
  )
  rt.note(
    "the stand does not tell the cause of the conflict: the job names no file of it, and R6 runs no release without the owner's change — a step of conflicts that compared the hosting with a version other than the installed one would refuse here too; the way out, and with it the control, is R8 (Э6а.12)",
  )
  // The job refused after `main` moved: core pushes the revert commit in its next step, after the
  // release ended (the invariant of main, spec §10).
  const mainC = await rt.until(
    'main settles after the refused release',
    async () => {
      const [row, head] = [await site.release(refusedC.id), await site.head()]
      return head === headC || (row.revertSha !== null && head === row.revertSha) ? head : null
    },
    { timeoutMs: 3 * MINUTE, intervalMs: 1000, service: ctx.processes.core },
  )
  const siteC = await site.row()
  rt.check(
    siteC.installedReleaseId === installedC.installedReleaseId &&
      (await site.tree(mainC)) === (await site.tree(installedC.installedSha)),
    `the installed version is still ${installedC.installedVersion}, and main holds its tree`,
  )
  rt.note(
    mainC === headC
      ? 'main is the commit it was before the release'
      : `main is the revert commit ${mainC.slice(0, 12)} of the release commit (the invariant of main, spec §10): its tree is the installed one`,
  )
  const taskC = await dialogReaches(rt, ctx, dialogC, ['awaiting_approval'], 3 * MINUTE)
  rt.check(
    taskC.status === 'awaiting_approval',
    'the dialog is back with its candidate (awaiting_approval)',
  )
  await wayInClosed(rt, ctx, site, refusedC.id, `the release ${refusedC.version}`)
  rt.end()

  // ── Rc ────────────────────────────────────────────────────────────────────────
  rt.begin(`Rc ${build.archive}`, 'диалоги закрыты, предпросмотры убраны')
  const cancelledC = await cancelDialog(rt, ctx, dialogC)
  rt.check(cancelledC.state === 'cancelled', 'the dialog of the conflict is closed by /cancel')
  await rt.until(
    'every preview of the site is destroyed',
    async () =>
      (await db.previewEnvironment.count({ where: { siteId, status: { not: 'destroyed' } } })) ===
      0,
    { timeoutMs: 5 * MINUTE, intervalMs: 1000, service: ctx.processes.core },
  )
  const left = await rt
    .until(
      'Docker holds nothing of the site',
      async () => ((await dockerOfSite(rt, siteId)).length === 0 ? [] : null),
      { timeoutMs: 3 * MINUTE, intervalMs: 2000 },
    )
    .catch(() => dockerOfSite(rt, siteId))
  rt.check(
    left.length === 0,
    'core destroyed the previews, their browsers and the sandboxes of the turns: Docker holds nothing with the labels of the site',
    left,
  )
  rt.end()
}

/** The group `release` on the builds `import` made a site of and `preview` looked at: R1–R6, Rc. */
export async function runReleaseGroup(rt, ctx, entries) {
  for (const entry of entries) {
    if (!entry.siteId) throw new Error(`The build ${entry.build.archive} has no site of import`)
    if (!entry.tree) throw new Error(`The build ${entry.build.archive} has no tree of its archive`)
    await releaseOfBuild(rt, ctx, entry)
  }
}
