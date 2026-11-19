// The scenarios of the second queue of plan 84 (Э10; README.md, «Сценарии»): W — the hook of the
// GitLab repository of the project (84.26): made by core, its deliveries signed, a repeat and a
// forgery; the cards that rerun and stop a build and revert a merge; the paths of the repository
// for `@`. P — Raditi's GitHub App on the fake GitHub (84.25): the installation and the sign-in of
// its user with state and PKCE, a forged installation, a member who may only read, a turn, the
// push, the pull request, «Принять, когда сборка пройдёт» by the platform's own wait, the deploy
// by `workflow_dispatch`, a change of `.github/workflows` that needs its card and a token with
// `workflows` only then, the webhook of the app. Every PASS is read from the product or the fakes.
import { randomBytes } from 'node:crypto'

import { CheckFailed, exchange } from '../browser-task-verify/runtime.mjs'
import { actionDone, actionEnded, newChat } from './scenarios.mjs'

/** The rows of the outbox that hint core to read a repository again (`git.refresh`). */
const refreshRows = (stand, repositoryId) =>
  stand.db.outboxEvent.count({
    where: { type: 'git.refresh', dedupeKey: { startsWith: `git.refresh:${repositoryId}:` } },
  })

// ─── W: the hook of the GitLab repository and the cards of the second queue ───

export async function scenarioW(stand) {
  const { rt, state, gitlab, db, webUrl } = stand
  rt.begin('W', 'вебхуки GitLab, повтор и отмена сборок, отмена слиянием, пути для @')
  const owner = state.owner
  const projectId = state.projectId
  const project = state.ownProject
  const row = await db.projectRepository.findFirstOrThrow({ where: { projectId } })

  // The hook core made after the attach: signed, its secrets derived, none of them in the row.
  const hooked = await rt.until(
    'core to make the hook of the repository',
    async () => {
      const found = await db.projectRepository.findUniqueOrThrow({ where: { id: row.id } })
      return found.hookState === 'active' ? found : null
    },
    { timeoutMs: 120_000, intervalMs: 2000, service: stand.processes.core },
  )
  const hook = [...gitlab.hooks.values()].find((item) => item.projectId === project.id)
  rt.check(
    hook !== undefined &&
      hook.url === `https://raditi.localhost/api/webhooks/gitlab?r=${row.id}` &&
      hook.signingToken?.startsWith('whsec_') &&
      hook.token.length >= 32 &&
      hook.events.push &&
      hook.events.mergeRequests &&
      hook.events.pipelines &&
      hook.sslVerification,
    'core made a signed hook of push, merge request and pipeline events on the https address of web',
    hook && { ...hook, token: undefined, signingToken: undefined },
  )
  rt.secret(hook.token)
  rt.secret(hook.signingToken)
  state.hookSecrets = { hookToken: hook.token, hookSigning: hook.signingToken }
  const rowText = JSON.stringify(hooked)
  rt.check(
    hooked.hookSigned &&
      hooked.hookNonce !== null &&
      !rowText.includes(hook.token) &&
      !rowText.includes(hook.signingToken.slice(6)),
    'the row says the hook signs (hook_signed) and keeps neither its token nor its signing key',
  )

  // A delivery of a pipeline: taken once, a hint for core, and core reads it.
  await gitlab.commitAsClient(project, 'main', 'docs/hook.md', 'Вебхук\n', {
    newBranch: 'client/hook',
  })
  const pipeline = project.pipelines.findLast((item) => item.ref === 'client/hook')
  const before = await refreshRows(stand, row.id)
  const delivered = await gitlab.deliver(project, {
    origin: webUrl,
    kind: 'pipeline',
    body: { object_attributes: { id: pipeline.id, ref: 'client/hook', status: 'running' } },
  })
  const kept = await db.gitWebhookDelivery.count({
    where: { provider: 'gitlab', deliveryId: delivered.deliveryId },
  })
  rt.check(
    delivered.status === 202 && kept === 1 && (await refreshRows(stand, row.id)) === before + 1,
    `a signed delivery is taken (${delivered.status}): its id kept, one git.refresh for core`,
  )
  const read = await rt.until(
    'core to read the pipeline of the delivery',
    async () => {
      const runs = await owner.query('projectRepo.runs', { projectId })
      return runs.items.find((item) => item.id === String(pipeline.id)) ?? null
    },
    { timeoutMs: 120_000, intervalMs: 2000, service: stand.processes.core },
  )
  rt.check(read.ref === 'client/hook', `core read the pipeline the delivery named (#${read.id})`)
  const repeated = await gitlab.deliver(project, {
    origin: webUrl,
    kind: 'pipeline',
    body: { object_attributes: { id: pipeline.id } },
    deliveryId: delivered.deliveryId,
  })
  rt.check(
    repeated.status === 202 && (await refreshRows(stand, row.id)) === before + 1,
    'a repeated delivery is answered and puts no second job',
  )
  const forged = await gitlab.deliver(project, {
    origin: webUrl,
    kind: 'pipeline',
    body: { object_attributes: { id: pipeline.id } },
    forge: true,
  })
  rt.check(
    forged.status === 401 &&
      (await db.gitWebhookDelivery.count({ where: { deliveryId: forged.deliveryId } })) === 0 &&
      (await refreshRows(stand, row.id)) === before + 1,
    `a delivery with a forged signature is refused (${forged.status}), nothing kept`,
  )

  // «Запустить снова» of a finished build of a branch; «Остановить» of a running one; a stop of a
  // finished one is gone; a rerun of the main branch is a card of a deploy.
  const finished = await rt.until(
    'the build of the branch of the client to pass',
    async () => {
      const runs = await owner.query('projectRepo.runs', { projectId })
      const found = runs.items.find((item) => item.id === String(pipeline.id))
      return found?.status === 'success' ? found : null
    },
    { timeoutMs: 120_000, intervalMs: 3000, service: stand.processes.core },
  )
  const rerun = await owner.mutate('projectRepo.prepareRunAction', {
    projectId,
    runId: finished.id,
    kind: 'rerun',
  })
  rt.check(!rerun.deploy, 'the card of a rerun of a branch is a plain one, not a deploy')
  rt.check(
    rerun.repeats === true,
    'the plain card of a build that passed warns that every automatic job runs again',
  )
  const rerunPress = await owner.mutate('projectRepo.confirmRunAction', {
    confirmToken: rerun.confirmToken,
  })
  await actionDone(stand, projectId, rerunPress.actionId, 'the rerun to end')
  rt.check(
    gitlab.pipelineActions.some((item) => item.pipeline === pipeline.id && item.action === 'retry'),
    'the fake retried the pipeline of the card',
  )
  // It had passed: GitLab's retry ran nothing, and «Запустить снова» is a new pipeline of the
  // branch, its ref alone in the body (ПР36; GitLab CE 19.5.6, the live check of 17.11.2026).
  const asked = gitlab.createdPipelines.filter((item) => item.path === project.path)
  const rerunRow = await db.repoAction.findUniqueOrThrow({ where: { id: rerunPress.actionId } })
  const fresh = project.pipelines.findLast((item) => item.ref === 'client/hook')
  rt.check(
    asked.length === 1 &&
      JSON.stringify(asked[0].body) === JSON.stringify({ ref: 'client/hook' }) &&
      asked[0].query === '' &&
      fresh !== undefined &&
      fresh.id !== pipeline.id &&
      fresh.source === 'api' &&
      fresh.sha === pipeline.sha &&
      rerunRow.result?.runId === String(fresh.id) &&
      rerunRow.result?.rerunOf === finished.id,
    `a rerun of a passed build is a new pipeline #${fresh?.id} of its branch, asked with its ref alone`,
    { asked, result: rerunRow.result },
  )
  const replay = await owner.call('mutation', 'projectRepo.confirmRunAction', {
    confirmToken: rerun.confirmToken,
  })
  rt.check(!replay.ok, 'the token of the rerun works once', replay)
  // The new pipeline passes, and core reads it.
  const rerunRead = await rt.until(
    'the new pipeline to pass and core to read it',
    async () => {
      const runs = await owner.query('projectRepo.runs', { projectId })
      const found = runs.items.find((item) => item.id === String(fresh?.id))
      return found?.status === 'success' ? found : null
    },
    { timeoutMs: 120_000, intervalMs: 3000, service: stand.processes.core },
  )
  // Settings that leave a new pipeline no job: the press says so in words.
  project.pushOnly = true
  let emptyRow
  try {
    const empty = await owner.mutate('projectRepo.prepareRunAction', {
      projectId,
      runId: rerunRead.id,
      kind: 'rerun',
    })
    const emptyPress = await owner.mutate('projectRepo.confirmRunAction', {
      confirmToken: empty.confirmToken,
    })
    emptyRow = await actionEnded(stand, projectId, emptyPress.actionId, 'the empty rerun')
  } finally {
    project.pushOnly = false
  }
  rt.check(
    emptyRow.state === 'failed' && emptyRow.error === 'REPO_RUN_NOT_STARTED',
    `a new pipeline GitLab would not start is refused in words (${emptyRow.state} ${emptyRow.error})`,
  )

  project.slowRefs.set('client/slow', 120_000)
  await gitlab.commitAsClient(project, 'main', 'docs/slow.md', 'Долгая сборка\n', {
    newBranch: 'client/slow',
  })
  const slow = project.pipelines.findLast((item) => item.ref === 'client/slow')
  await gitlab.deliver(project, {
    origin: webUrl,
    kind: 'pipeline',
    body: { object_attributes: { id: slow.id, ref: 'client/slow', status: 'running' } },
  })
  const running = await rt.until(
    'core to read the running build',
    async () => {
      const runs = await owner.query('projectRepo.runs', { projectId })
      const found = runs.items.find((item) => item.id === String(slow.id))
      return found?.status === 'running' ? found : null
    },
    { timeoutMs: 120_000, intervalMs: 3000, service: stand.processes.core },
  )
  const stop = await owner.mutate('projectRepo.prepareRunAction', {
    projectId,
    runId: running.id,
    kind: 'cancel',
  })
  const stopPress = await owner.mutate('projectRepo.confirmRunAction', {
    confirmToken: stop.confirmToken,
  })
  await actionDone(stand, projectId, stopPress.actionId, 'the stop to end')
  rt.check(
    gitlab.pipelineActions.some((item) => item.pipeline === slow.id && item.action === 'cancel') &&
      slow.canceled === true,
    '«Остановить» canceled the running pipeline at the fake',
  )
  const cancels = gitlab.pipelineActions.filter((item) => item.action === 'cancel').length
  const late = await owner.call('mutation', 'projectRepo.prepareRunAction', {
    projectId,
    runId: finished.id,
    kind: 'cancel',
  })
  let lateState = late.ok ? null : (late.domainCode ?? late.code)
  if (late.ok) {
    const pressed = await owner.call('mutation', 'projectRepo.confirmRunAction', {
      confirmToken: late.data.confirmToken,
    })
    lateState = pressed.ok
      ? (await actionEnded(stand, projectId, pressed.data.actionId, 'the late stop')).error
      : (pressed.domainCode ?? pressed.code)
  }
  rt.check(
    /REPO_RUN_GONE/.test(String(lateState)) &&
      gitlab.pipelineActions.filter((item) => item.action === 'cancel').length === cancels,
    `a stop of a finished build is refused (${lateState}), nothing canceled`,
  )
  const mainRun = await rt.until(
    'a build of the main branch',
    async () => {
      const runs = await owner.query('projectRepo.runs', { projectId })
      return runs.items.find((item) => item.ref === 'main' && item.status !== 'running') ?? null
    },
    { timeoutMs: 60_000, intervalMs: 2000 },
  )
  const mainCard = await owner.mutate('projectRepo.prepareRunAction', {
    projectId,
    runId: mainRun.id,
    kind: 'rerun',
  })
  rt.check(mainCard.deploy === true, 'a rerun of a build of the main branch is a card of a deploy')
  rt.check(
    mainCard.repeats === false,
    'a card of a deploy says the new build its own way and does not warn twice',
  )

  // «Отменить» of the merged request !1: a new branch with the revert, a new request; main stays.
  const merged = project.mergeRequests[0]
  const mainBefore = (await gitlab.heads(project)).main
  const revert = await owner.mutate('projectRepo.prepareRevert', { projectId, number: 1 })
  rt.check(
    revert.mergeSha === merged.mergeSha && revert.target === 'main',
    'the card of the revert names the merge commit of !1 in main',
  )
  const requests = project.mergeRequests.length
  const revertPress = await owner.mutate('projectRepo.confirmRevert', {
    confirmToken: revert.confirmToken,
  })
  await actionDone(stand, projectId, revertPress.actionId, 'the revert to end')
  const opened = project.mergeRequests[requests]
  const heads = await gitlab.heads(project)
  rt.check(
    opened !== undefined &&
      /^raditi\/revert-1-[0-9a-f]{8}$/.test(opened.source) &&
      opened.target === 'main' &&
      /Отменить/.test(opened.title) &&
      heads.main === mainBefore,
    `a revert request is opened from ${opened?.source} into main («${opened?.title}»); main did not move`,
  )
  const readme = await gitlab.show(project, opened.source, 'README.md')
  const parents = await gitlab.parents(project, opened.source)
  rt.check(
    !/Доставка по городу/.test(readme ?? '') &&
      /Доставка по городу/.test((await gitlab.show(project, 'main', 'README.md')) ?? '') &&
      parents.length === 1 &&
      parents[0] === mainBefore,
    'the revert commit sits on the head of main and takes the change of !1 out',
  )
  const again = await owner.call('mutation', 'projectRepo.confirmRevert', {
    confirmToken: revert.confirmToken,
  })
  rt.check(
    !again.ok && project.mergeRequests.length === requests + 1,
    'the token of the revert works once',
  )

  // `@` in a chat of the project: the paths of the main branch, without the files that look like
  // a secret.
  const paths = await rt.until(
    'core to read the paths of the repository',
    async () => {
      const answer = await owner.query('projectRepo.paths', { projectId })
      return answer.state === 'ready' ? answer : null
    },
    { timeoutMs: 120_000, intervalMs: 2000, service: stand.processes.core },
  )
  const secretName = 'certs/site.key'
  rt.check(
    stand.modules.domain.isSecretFileName(secretName),
    'control: certs/site.key looks like a secret by its name',
  )
  rt.check(
    paths.paths.includes('README.md') &&
      paths.paths.includes('index.html') &&
      !paths.paths.includes(secretName) &&
      paths.sha ===
        (await db.projectRepository.findUniqueOrThrow({ where: { id: row.id } })).lastFetchedSha,
    `@ offers ${paths.paths.length} paths of the head of main core last fetched, certs/site.key left out`,
    paths.paths,
  )
  rt.end()
}

// ─── P: the GitHub App ────────────────────────────────────────────────────────

/**
 * «Подключить GitHub» of `client` for `projectId` as the browser goes: web's start, the page of the
 * installation (back to the Setup URL with `installationId`), the sign-in of `user`; the address web
 * sends the browser to at the end.
 */
async function githubSignIn(stand, client, { projectId, installationId, user }) {
  const { github, certificates, rt } = stand
  const started = await client.request(`/api/git/github/start?project=${projectId}`)
  const install = new URL(started.headers.get('location') ?? '')
  if (started.status !== 303 || install.origin !== github.origin)
    throw new CheckFailed(`the start of the GitHub App went to ${install.href} (${started.status})`)
  github.installs({ installationId })
  github.signsIn(user)
  const setup = await exchange(install.href, { ca: certificates.ca })
  const back = new URL(setup.headers.location)
  const toSignIn = await client.request(`${back.pathname}${back.search}`)
  const authorize = new URL(toSignIn.headers.get('location') ?? '')
  if (authorize.origin !== github.origin) return { location: authorize.href, install }
  const signedIn = await exchange(authorize.href, { ca: certificates.ca })
  const returned = new URL(signedIn.headers.location)
  const finished = await client.request(`${returned.pathname}${returned.search}`)
  rt.secret(returned.searchParams.get('code') ?? '')
  return { location: finished.headers.get('location') ?? '', install, authorize }
}

export async function scenarioP(stand) {
  const { rt, state, github, db, webUrl } = stand
  rt.begin('P', 'GitHub App: установка, вход, выбор, ход, запрос, слияние, выкладка, вебхук')
  const owner = state.owner
  const anna = github.addUser('anna-gh')
  const boris = github.addUser('boris-read')
  const outsider = github.addUser('chuzhoi')
  const org = github.addInstallation({ account: 'zerno-org', members: [anna, boris] })
  const foreign = github.addInstallation({ account: 'chuzhaya-org', members: [outsider] })
  const repo = await github.addRepo(org, {
    name: 'sait',
    collaborators: [
      [anna, 'admin'],
      [boris, 'read'],
    ],
    protectedBranches: { main: ['test'] },
    files: {
      'README.md': '# Кофейня «Зерно» на GitHub\n',
      'index.html': '<h1>Зерно</h1>\n',
      '.github/workflows/ci.yml':
        'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
      '.github/workflows/deploy.yml':
        'name: Выкладка\non:\n  workflow_dispatch:\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n',
    },
  })
  await github.addRepo(org, {
    name: 'arhiv',
    collaborators: [[anna, 'read']],
    files: { 'README.md': 'Архив\n' },
  })
  await github.addRepo(foreign, {
    name: 'chuzhoi-sait',
    collaborators: [[outsider, 'admin']],
    files: { 'README.md': 'Чужой\n' },
  })
  const projectId = stand.modules.ids.uuidv7()
  await owner.mutate('project.create', { projectId, name: 'Сайт на GitHub' })
  state.githubProject = projectId

  // A return to the Setup URL without this browser's own start, and a forged installation.
  const bare = await exchange(
    `${webUrl}/api/git/github/callback?installation_id=${org.id}&setup_action=install`,
  )
  rt.check(
    bare.status === 303 && /git=expired/.test(bare.headers.location ?? ''),
    'a return without the cookie of a start of this browser is refused (git=expired)',
  )
  const forged = await githubSignIn(stand, owner, {
    projectId,
    installationId: foreign.id,
    user: anna,
  })
  const listedForged = await owner.query('gitConnection.list')
  rt.check(
    /git=github-refused/.test(forged.location) &&
      !listedForged.connections.some((item) => item.kind === 'github_app'),
    'an installation_id of an installation the user does not see is refused, no connection',
  )

  // The installation and the sign-in: state and PKCE, the token of the user never kept.
  const signIns = github.signIns.length
  const done = await githubSignIn(stand, owner, { projectId, installationId: org.id, user: anna })
  const connectionId = new URL(done.location, webUrl).searchParams.get('connection')
  rt.check(
    /git=connected/.test(done.location) && connectionId !== null,
    `the installation and the sign-in connect (${done.location.replace(webUrl, '')})`,
  )
  const state0 = done.install.searchParams.get('state')
  rt.check(
    state0?.length >= 32 &&
      done.authorize.searchParams.get('state') === state0 &&
      done.authorize.searchParams.get('code_challenge_method') === 'S256' &&
      github.signIns.slice(signIns).every((item) => item.pkce),
    'the sign-in carries the state of the start and a PKCE challenge; the code went with its verifier',
  )
  for (const item of github.signIns) if (item.token) rt.secret(item.token)
  const repos = await rt.until(
    'the repositories of the installation',
    async () => {
      const answer = await owner.query('gitConnection.repositories', { connectionId })
      return answer.state === 'ready' ? answer : null
    },
    { timeoutMs: 60_000, intervalMs: 1000 },
  )
  const offered = repos.items.map((item) => item.path)
  rt.check(
    offered.includes('zerno-org/sait') &&
      !offered.includes('zerno-org/arhiv') &&
      !offered.includes('chuzhaya-org/chuzhoi-sait'),
    `only the repositories where the user may push are offered (${offered.join(', ')})`,
  )
  const connection = (await owner.query('gitConnection.list')).connections.find(
    (item) => item.id === connectionId,
  )
  rt.check(
    connection?.kind === 'github_app' && connection.state === 'ok',
    `the connection of the App is ok (${connection?.login})`,
  )

  // A member who may only read connects the same installation: no repository to pick.
  const strangerProject = stand.modules.ids.uuidv7()
  await state.stranger.mutate('project.create', { projectId: strangerProject, name: 'Чужой' })
  const reader = await githubSignIn(stand, state.stranger, {
    projectId: strangerProject,
    installationId: org.id,
    user: boris,
  })
  const readerConnection = new URL(reader.location, webUrl).searchParams.get('connection')
  const readerRepos = readerConnection
    ? await owner.call('query', 'gitConnection.repositories', { connectionId: readerConnection })
    : null
  const own = readerConnection
    ? await state.stranger.query('gitConnection.repositories', { connectionId: readerConnection })
    : { items: [] }
  const sait = repos.items.find((item) => item.path === 'zerno-org/sait')
  const stolen = readerConnection
    ? await state.stranger.call('mutation', 'projectRepo.attach', {
        projectId: strangerProject,
        connectionId: readerConnection,
        providerRepoId: sait.providerRepoId,
        defaultBranch: 'main',
      })
    : { ok: false }
  rt.check(
    own.items.length === 0 && !stolen.ok && (readerRepos === null || !readerRepos.ok),
    `a member who may only read gets no repository, and attaching it is refused (${stolen.domainCode ?? stolen.code ?? 'no connection'})`,
  )

  // The repository attached: fetched by a token of the installation for this one repository, to read.
  await owner.mutate('projectRepo.attach', {
    projectId,
    connectionId,
    providerRepoId: sait.providerRepoId,
    defaultBranch: 'main',
  })
  await rt.until(
    'core to fetch the repository of GitHub',
    async () => {
      const row = await owner.query('projectRepo.get', { projectId })
      if (row?.refusal) throw new CheckFailed(`refused: ${JSON.stringify(row.refusal)}`)
      return row?.mirrorState === 'ready' ? row : null
    },
    { timeoutMs: 120_000, intervalMs: 1000, service: stand.processes.core },
  )
  const fetches = github.requests.filter((entry) => entry.git === 'git-upload-pack')
  rt.check(
    fetches.length > 0 && fetches.every((entry) => entry.auth),
    'core fetched github.com over git with a token of the installation, at the fake',
  )
  rt.check(
    github.issued.length > 0 &&
      github.issued.every(
        (item) => item.repositoryIds === null || item.repositoryIds.every((id) => id === repo.id),
      ) &&
      github.issued.every((item) => item.permissions.workflows === undefined) &&
      github.issued.every((item) => item.revoked),
    `the ${github.issued.length} tokens of the installation: of this repository only, without workflows, each revoked after its operation`,
  )

  // A turn, the push with a pull request, its build slow: «Принять, когда сборка пройдёт».
  const chat = await newChat(stand, {
    text: 'Добавьте часы работы в описание.',
    projectId,
    program: 'appendLine',
    ctx: { file: 'README.md', line: 'Часы: 8:00–22:00', message: 'Добавил часы работы.' },
  })
  state.githubChat = chat.taskId
  const card = await owner.mutate('projectRepo.preparePush', { taskId: chat.taskId })
  repo.slowRefs.set(card.branch, 25_000)
  const pushed = await owner.mutate('projectRepo.confirmPush', {
    confirmToken: card.confirmToken,
    mergeRequest: {
      title: 'Часы работы',
      description: 'Часы работы.',
      draft: false,
      reservedId: null,
    },
  })
  await actionDone(stand, projectId, pushed.actionId, 'the push to GitHub to end')
  const heads = await github.heads(repo)
  const pull = github.pulls.find((item) => item.repo === repo)
  rt.check(
    heads[card.branch] === card.headSha && pull?.head === card.branch && pull.base === 'main',
    `the branch is at GitHub at the head of the card and pull request #${pull?.number} goes into main`,
  )
  rt.check(
    github.pushes.length === 1 && github.pushes[0].permissions.workflows === undefined,
    'the push went with a token without workflows',
  )

  // The webhook of the App: signed — taken with a hint; forged — 401; an event of no repository.
  const githubRow = await db.projectRepository.findFirstOrThrow({ where: { projectId } })
  const before = await refreshRows(stand, githubRow.id)
  const hookUrl = `${webUrl}/api/webhooks/github`
  const delivery = await github.deliver(hookUrl, {
    event: 'pull_request',
    body: {
      action: 'opened',
      number: pull.number,
      pull_request: { number: pull.number },
      repository: { id: repo.id },
    },
  })
  rt.check(
    delivery.status === 202 &&
      (await db.gitWebhookDelivery.count({
        where: { provider: 'github', deliveryId: delivery.deliveryId },
      })) === 1 &&
      (await refreshRows(stand, githubRow.id)) === before + 1,
    `a delivery of the App signed by its secret is taken (${delivery.status}), one git.refresh`,
  )
  const forgedHook = await github.deliver(hookUrl, {
    event: 'push',
    body: { repository: { id: repo.id } },
    secret: randomBytes(16).toString('hex'),
  })
  const ping = await github.deliver(hookUrl, { event: 'installation', body: { action: 'deleted' } })
  rt.check(
    forgedHook.status === 401 &&
      ping.status === 202 &&
      (await db.gitWebhookDelivery.count({
        where: { deliveryId: { in: [forgedHook.deliveryId, ping.deliveryId] } },
      })) === 0 &&
      (await refreshRows(stand, githubRow.id)) === before + 1,
    `a forged X-Hub-Signature-256 is refused (${forgedHook.status}); an event of no repository is answered and kept nowhere`,
  )

  const mergeCard = await rt.until(
    'the card of the pull request with its build running',
    async () => {
      const answer = await owner.call('mutation', 'projectRepo.prepareMerge', {
        projectId,
        number: pull.number,
      })
      return answer.ok && answer.data.headSha === card.headSha ? answer.data : null
    },
    { timeoutMs: 60_000, intervalMs: 2000 },
  )
  rt.check(
    mergeCard.checks !== 'success' && mergeCard.whenGreen,
    `the card of #${pull.number}: checks ${mergeCard.checks}, «когда сборка пройдёт» offered`,
  )
  const waitPress = await owner.mutate('projectRepo.confirmMerge', {
    confirmToken: mergeCard.confirmToken,
    mode: 'when_green',
    deleteBranch: true,
  })
  const waiting = await rt.until(
    'the press to wait for the checks',
    async () => {
      const action = await owner.query('projectRepo.action', {
        projectId,
        actionId: waitPress.actionId,
      })
      if (action.state === 'failed') throw new CheckFailed(`the wait failed: ${action.error}`)
      return action.state === 'waiting' || action.state === 'done' ? action : null
    },
    { timeoutMs: 60_000, intervalMs: 500 },
  )
  rt.check(
    waiting.state === 'waiting' && github.mergeCalls.length === 0,
    `the press waits for the checks of GitHub (${waiting.state}), nothing merged yet`,
  )
  await rt.until(
    'the platform to merge after the checks passed',
    async () => {
      const action = await owner.query('projectRepo.action', {
        projectId,
        actionId: waitPress.actionId,
      })
      if (action.state === 'failed') throw new CheckFailed(`the wait failed: ${action.error}`)
      return action.state === 'done' ? action : null
    },
    { timeoutMs: 240_000, intervalMs: 3000, service: stand.processes.core },
  )
  const merged = await github.heads(repo)
  rt.check(
    github.mergeCalls.length === 1 &&
      github.mergeCalls[0].sha === card.headSha &&
      pull.state === 'merged' &&
      merged.main === pull.mergeSha &&
      merged[card.branch] === undefined &&
      (await github.parents(repo, 'main')).includes(card.headSha),
    'after the checks the pull request is merged once with the sha of the card, its branch removed',
  )

  // «Выкатить»: the workflow of the head of main that runs on workflow_dispatch.
  const deploy = await rt.until(
    'the workflows of the head of main',
    async () => {
      const answer = await owner.mutate('projectRepo.prepareDeploy', { projectId })
      return answer.state === 'ready' && answer.sha === merged.main && answer.actions.length > 0
        ? answer
        : null
    },
    { timeoutMs: 120_000, intervalMs: 3000 },
  )
  const action = deploy.actions.find((item) => item.kind === 'workflow_dispatch')
  rt.check(
    deploy.actions.length === 1 && action?.name === 'Выкладка',
    'the card offers the one workflow that runs on workflow_dispatch (Выкладка)',
    deploy.actions,
  )
  const deployPress = await owner.mutate('projectRepo.confirmDeploy', {
    confirmToken: action.confirmToken,
  })
  await actionDone(stand, projectId, deployPress.actionId, 'the deploy to start')
  rt.check(
    github.dispatches.length === 1 &&
      github.dispatches[0].ref === 'main' &&
      github.dispatches[0].sha === merged.main &&
      github.dispatches[0].workflow === '.github/workflows/deploy.yml',
    'the fake started the workflow of the head of main by workflow_dispatch, once',
  )
  const deployAgain = await owner.call('mutation', 'projectRepo.confirmDeploy', {
    confirmToken: action.confirmToken,
  })
  rt.check(!deployAgain.ok && github.dispatches.length === 1, 'the token of the deploy works once')

  // The log of a job: GitHub sends it to another host — not the storage of Actions: not followed.
  const runs = await rt.until(
    'core to read the runs of GitHub',
    async () => {
      const answer = await owner.query('projectRepo.runs', { projectId })
      return answer.items.find((item) => item.status === 'success') ?? null
    },
    { timeoutMs: 120_000, intervalMs: 3000, service: stand.processes.core },
  )
  const detail = await owner.query('projectRepo.run', { projectId, runId: runs.id })
  const log = await rt.until(
    'the log of the job of GitHub',
    async () => {
      const answer = await owner.query('projectRepo.jobLog', {
        projectId,
        runId: runs.id,
        jobId: detail.jobs[0].id,
      })
      return answer.state === 'loading' ? null : answer
    },
    { timeoutMs: 60_000, intervalMs: 1500 },
  )
  rt.check(
    github.blobRequests.length === 0 && (log.state === 'failed' || log.text === ''),
    `a redirect of a log to a host outside the storage of Actions is not followed (${log.state})`,
  )

  // `.github/workflows`: the card of build settings first; only its push carries `workflows`.
  const ci = await newChat(stand, {
    text: 'Добавьте в сборку проверку ссылок.',
    projectId,
    program: 'appendLine',
    ctx: {
      file: '.github/workflows/ci.yml',
      line: '# проверка ссылок',
      message: 'Изменил сборку.',
    },
  })
  const ciBranch = await rt.until(
    'the card of the build settings of GitHub',
    async () => {
      const row = await owner.query('projectRepo.branch', { taskId: ci.taskId })
      return row?.ciChange === 'needed' ? row : null
    },
    { timeoutMs: 60_000, intervalMs: 1000 },
  )
  const plainCard = await owner.call('mutation', 'projectRepo.preparePush', { taskId: ci.taskId })
  let plainState = plainCard.ok ? null : plainCard.domainCode
  if (plainCard.ok) {
    const plain = await owner.call('mutation', 'projectRepo.confirmPush', {
      confirmToken: plainCard.data.confirmToken,
    })
    plainState = plain.ok
      ? (await actionEnded(stand, projectId, plain.data.actionId, 'the plain push')).state
      : plain.domainCode
  }
  rt.check(
    plainState !== 'done' && (await github.heads(repo))[ciBranch.branch] === undefined,
    `a change of .github/workflows is not sent without its card (${plainState})`,
  )
  const ciCard = await rt.until(
    'the card of the build settings',
    async () => {
      const answer = await owner.mutate('projectRepo.prepareCiChange', { taskId: ci.taskId })
      return answer.state === 'ready' ? answer : null
    },
    { timeoutMs: 60_000, intervalMs: 2000 },
  )
  rt.check(
    ciCard.files.some((file) => file.path === '.github/workflows/ci.yml') && ciCard.lint === null,
    'the card shows the diff of the workflow (GitHub has no lint)',
  )
  const ciPress = await owner.mutate('projectRepo.confirmCiChange', {
    confirmToken: ciCard.confirmToken,
    // A branch without a request yet: the card opens one with it.
    ...(ciCard.opensMergeRequest
      ? {
          mergeRequest: ciCard.proposal ?? {
            title: 'Проверка ссылок',
            description: 'Проверка ссылок в сборке.',
            draft: false,
            reservedId: null,
          },
        }
      : {}),
  })
  await actionDone(stand, projectId, ciPress.actionId, 'the push of the build settings')
  const ciPush = github.pushes.at(-1)
  rt.check(
    (await github.heads(repo))[ciBranch.branch] === ciCard.headSha &&
      ciPush.permissions.workflows === 'write' &&
      github.pushes.slice(0, -1).every((item) => item.permissions.workflows === undefined) &&
      github.refusedPushes.length === 0 &&
      github.issued.filter((item) => item.permissions.workflows === 'write').length === 1,
    'after «Разрешить и отправить» the branch is at GitHub; only that token carried workflows',
  )
  state.githubSecrets = {
    githubClientSecret: stand.githubApp.clientSecret,
    githubWebhookSecret: stand.githubApp.webhookSecret,
    ...Object.fromEntries(github.issued.map((item, index) => [`installation${index}`, item.token])),
    ...Object.fromEntries(
      github.signIns
        .filter((item) => item.token)
        .map((item, index) => [`githubUser${index}`, item.token]),
    ),
  }
  rt.end()
}
