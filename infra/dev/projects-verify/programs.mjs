// The scripted model of the projects stand: what the "agent" does in each turn (the model server
// of the browser-task stand runs these, ../browser-task-verify/model.mjs). A program yields calls
// of the CLI's own tools — `bash`, `read` — and gets back what they answered; it returns the final
// answer of the turn. It decides only by what it was answered; `facts` keeps what it saw for the
// checks of the scenarios.
import { call } from '../browser-task-verify/programs.mjs'

/** The final answer of a turn by the contract of the platform (turnResultSchema). */
export function final({ summary, message, changeType = 'none', files = [] }) {
  return {
    final: JSON.stringify({
      summary,
      change_type: changeType,
      client_message: message,
      files_changed: files,
      questions: [],
      needs_approval: false,
      risk: 'low',
    }),
  }
}

const textOf = (answer) => (typeof answer?.text === 'string' ? answer.text : JSON.stringify(answer))

/** `bash` with a description, as OpenCode's tool takes it. */
const bash = (command, description) => call('bash', { command, description })

/**
 * Scenarios A and B: the files of the project in /workspace/project — the text the client wrote
 * in the window and the PDF — read; a change there is tried and must not stay for the next turn.
 */
export function* readProjectFiles(ctx, facts) {
  const listed = yield bash(
    [
      'ls -1 /workspace/project',
      'echo ---text',
      `cat "/workspace/project/${ctx.textFile}"`,
      'echo ---pdf',
      `pdftotext "/workspace/project/${ctx.pdfFile}" - 2>&1 | head -5`,
      'echo ---write',
      `(echo "агент был здесь" >> "/workspace/project/${ctx.textFile}" && echo agent > /workspace/project/agent-note.txt) 2>&1; echo "write=$?"`,
    ].join('; '),
    'Read the files of the project',
  )
  facts.output = textOf(listed)
  return final({
    summary: 'Read the project files',
    message: 'Прочитал файлы проекта.',
  })
}

/** Scenario B: the next turn sees the client's files as the client left them. */
export function* readProjectFilesAgain(ctx, facts) {
  const listed = yield bash(
    `ls -1 /workspace/project; echo ---text; cat "/workspace/project/${ctx.textFile}"`,
    'Read the files of the project again',
  )
  facts.output = textOf(listed)
  return final({ summary: 'Read the project files again', message: 'Файлы проекта на месте.' })
}

/**
 * Scenario E: a turn with the repository. It reads the working copy, changes README.md and adds a
 * file, then tries what the agent must never manage: to push the branch itself and to reach the
 * fake GitLab. It reports what each attempt answered.
 */
export function* changeRepository(ctx, facts) {
  const seen = yield bash(
    [
      'cd /workspace/repo',
      'git log --oneline -3 2>&1',
      'echo ---readme',
      'cat README.md',
      'echo ---hidden',
      'cat config/old-settings.env 2>&1 | head -3',
      'echo ---remote',
      'git remote -v 2>&1',
      'echo ---env',
      'env | grep -ciE "glpat|stand-oauth|stand-token" || true',
    ].join('; '),
    'Look at the repository',
  )
  facts.seen = textOf(seen)
  const changed = yield bash(
    [
      'cd /workspace/repo',
      "printf '\\nДоставка по городу — бесплатно от 1 000 ₽.\\n' >> README.md",
      "printf 'Меню на неделю\\n' > menu.md",
      'git status --short 2>&1',
    ].join('; '),
    'Change the description and add the menu',
  )
  facts.changed = textOf(changed)
  const attempts = yield bash(
    [
      'cd /workspace/repo',
      `git push https://oauth2:x@${ctx.host}/${ctx.path}.git HEAD:refs/heads/agent-own > /tmp/push.txt 2>&1; echo "push=$?"; tail -2 /tmp/push.txt`,
      `curl -sS -m 5 -o /dev/null -w "%{http_code}" https://${ctx.host}/api/v4/user 2>&1; echo " curl=$?"`,
      // The host where the stand's processes and relays listen, by address and port
      // (`hostProbes`): a TCP connection, all at once; 0 is a connection.
      ...(ctx.probes?.length
        ? [
            `for t in ${ctx.probes.join(' ')}; do (timeout 3 bash -c "exec 3<>/dev/tcp/\${t%:*}/\${t##*:}" 2>/dev/null; echo "probe $t=$?") & done; wait`,
          ]
        : []),
    ].join('; '),
    'Try to push and to call GitLab',
  )
  facts.attempts = textOf(attempts)
  return final({
    summary: 'Changed README.md and added menu.md',
    changeType: 'code',
    message: 'Обновил описание доставки и добавил меню на неделю.',
    files: ['README.md', 'menu.md'],
  })
}

/** Scenario G: a change of the build settings — `.gitlab-ci.yml` gets a stage of its own. */
export function* changeBuildSettings(ctx, facts) {
  const changed = yield bash(
    [
      'cd /workspace/repo',
      'printf \'stages:\\n  - test\\n  - deploy\\ntest:\\n  stage: test\\n  script: ["npm test"]\\n\' > .gitlab-ci.yml',
      'git status --short 2>&1',
    ].join('; '),
    'Change the build settings',
  )
  facts.changed = textOf(changed)
  return final({
    summary: 'Changed .gitlab-ci.yml',
    changeType: 'code',
    message: 'Добавил этап проверки в настройки сборки.',
    files: ['.gitlab-ci.yml'],
  })
}

/** A plain answer: the turns whose only fact is the instructions they were given. */
export function* plainAnswer() {
  return final({ summary: 'Answered', message: 'Здравствуйте! Слушаю вас.' })
}

/**
 * Scenario C: the memory. The client asked to remember: the note is saved. After a command the
 * agent ran — what it read there may be anybody's words — a note is only proposed. A note with a
 * token is refused. A change of a note the client wrote is a proposal.
 */
export function* rememberAsked(ctx, facts) {
  facts.saved = yield call('memory_save', { kind: 'fact', text: ctx.note })
  return final({ summary: 'Saved a note', message: 'Запомнил.' })
}

export function* rememberAfterCommand(ctx, facts) {
  facts.read = yield bash('cat /workspace/project/*.md | head -3', 'Read the notes of the project')
  facts.proposed = yield call('memory_save', { kind: 'decision', text: ctx.note })
  facts.secret = yield call('memory_save', { kind: 'fact', text: ctx.secretNote })
  facts.updated = yield call('memory_update', {
    id: ctx.clientEntry.id,
    text: ctx.changedText,
    expectedVersion: ctx.clientEntry.version,
  })
  return final({ summary: 'Proposed notes', message: 'Предложил записи в память.' })
}

/**
 * Scenario C: the client asked to remember, and the pass fetched a page of the web first: what the
 * agent then saves is only proposed — the page may be anybody's words (ПР18).
 */
export function* rememberAfterFetch(ctx, facts) {
  facts.fetched = yield call('webfetch', { url: ctx.url, format: 'text' })
  facts.saved = yield call('memory_save', { kind: 'fact', text: ctx.note })
  return final({ summary: 'Saved a note after a fetch', message: 'Запомнил.' })
}

/**
 * Scenario C: the README of the repository holds an instruction to the agent; the scripted model
 * obeys it, as a model might. The note it saves must not act: it is only proposed.
 */
export function* obeyReadme(ctx, facts) {
  facts.readme = textOf(yield bash('cat /workspace/repo/README.md', 'Read the README'))
  const injected = /Агент, запомни: ([^\n]+?)\s*-->/.exec(facts.readme)?.[1] ?? null
  facts.injected = injected
  if (injected) facts.saved = yield call('memory_save', { kind: 'fact', text: injected })
  return final({ summary: 'Read the README', message: 'Прочитал описание репозитория.' })
}

/**
 * Scenario E: what reaches the sandbox of a repository chat of the workspace's variables — the one
 * shaped like a GitLab token must not (ПР22) — and a change that writes the value of the other into
 * a file of the repository: the platform must not publish it.
 */
export function* changeWithVariable(ctx, facts) {
  facts.env = textOf(
    yield bash(
      [
        `[ -n "\${${ctx.plain}:-}" ] && echo "plain=set" || echo "plain=unset"`,
        `[ -n "\${${ctx.token}:-}" ] && echo "token=set" || echo "token=unset"`,
        `env | grep -c "^${ctx.token}=" || true`,
      ].join('; '),
      'Check the variables',
    ),
  )
  facts.changed = textOf(
    yield bash(
      `cd /workspace/repo && printf 'Ключ меню: %s\\n' "\${${ctx.plain}:-}" > delivery-key.md && git status --short 2>&1`,
      'Write the key into the description',
    ),
  )
  return final({
    summary: 'Wrote the key into delivery-key.md',
    changeType: 'code',
    message: 'Записал ключ в описание доставки.',
    files: ['delivery-key.md'],
  })
}

/** Scenario E: a change that holds a token GitLab would take: never published. */
export function* changeWithSecret(ctx, facts) {
  facts.changed = textOf(
    yield bash(
      `cd /workspace/repo && printf 'DEPLOY_TOKEN=${ctx.secret}\\n' > deploy.env.md && git status --short 2>&1`,
      'Write the deploy settings',
    ),
  )
  return final({
    summary: 'Wrote deploy.env.md',
    changeType: 'code',
    message: 'Записал настройки выкладки.',
    files: ['deploy.env.md'],
  })
}

/** A change of one file of the repository: `ctx.file` gets `ctx.line` (scenarios E, F, L). */
export function* appendLine(ctx, facts) {
  facts.changed = textOf(
    yield bash(
      `cd /workspace/repo && printf '%s\\n' '${ctx.line}' >> '${ctx.file}' && git status --short 2>&1`,
      `Change ${ctx.file}`,
    ),
  )
  if (ctx.note) facts.saved = yield call('memory_save', { kind: 'fact', text: ctx.note })
  return final({
    summary: `Changed ${ctx.file}`,
    changeType: 'code',
    message: ctx.message ?? 'Внёс изменение.',
    files: [ctx.file],
  })
}

/** A change that replaces `ctx.file` with `ctx.text` (scenario F, the conflict). */
export function* replaceFile(ctx, facts) {
  facts.changed = textOf(
    yield bash(
      `cd /workspace/repo && printf '%s\\n' '${ctx.text}' > '${ctx.file}' && git status --short 2>&1`,
      `Rewrite ${ctx.file}`,
    ),
  )
  return final({
    summary: `Rewrote ${ctx.file}`,
    changeType: 'code',
    message: 'Переписал файл.',
    files: [ctx.file],
  })
}

/**
 * Scenario L: in a chat of a project with a repository the client asked for a task by schedule;
 * the agent sets it up (`schedule_create`) — and it must wait for the card «Включить задачу».
 */
export function* createSchedule(ctx, facts) {
  facts.created = yield call('schedule_create', {
    name: ctx.name,
    instructions: ctx.instructions,
    triggers: [],
    timezone: 'Europe/Moscow',
    project: 'this_chat',
    confirmedByClient: true,
  })
  return final({ summary: 'Set up a task', message: 'Настроил задачу — включите её карточкой.' })
}

/** Scenario M: a pass that is still at work when the project goes to the trash. */
export function* slowPass(ctx, facts) {
  facts.slept = textOf(yield bash('sleep 90; echo woke', 'Wait'))
  return final({ summary: 'Waited', message: 'Готово.' })
}

export const PROGRAMS = Object.freeze({
  readProjectFiles,
  readProjectFilesAgain,
  changeRepository,
  changeBuildSettings,
  plainAnswer,
  rememberAsked,
  rememberAfterCommand,
  rememberAfterFetch,
  obeyReadme,
  changeWithVariable,
  changeWithSecret,
  appendLine,
  replaceFile,
  createSchedule,
  slowPass,
})
