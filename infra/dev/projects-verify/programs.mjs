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

export const PROGRAMS = Object.freeze({
  readProjectFiles,
  readProjectFilesAgain,
  changeRepository,
  changeBuildSettings,
  plainAnswer,
  rememberAsked,
  rememberAfterCommand,
})
