// The turns of the scripted model for the group `release` of the stand of the site stacks
// (scenarios-release.mjs; docs/plan/62-slices/e3.md, Э3.12): built of what the record of a stack
// says it edits (`edit(build)`, `outsideWorkingSet`, `breakOnProduction(build)`), in the form of
// MODEL_TURNS of the release stand — `scenario: 'tools'`, rounds of calls, a result of the turn.
// Commands of `bash` and the tools of the agent's browser only: no tool of content, since a new
// stack carries no plan of its database (Т36, Т43). Pure: nothing here runs a command.
import { dirname } from 'node:path'

import { LARGE_USAGE, turnResult } from '../release-verify/stand.mjs'

/** What the mark of R1 is found by in the agent's browser and on the pages. */
export const MARK_SELECTOR = '.stack-mark'

/** One argument of a shell, quoted: what it holds reaches the command as it is. */
export function shellQuote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`
}

const plainLine = (text, what) => {
  if (typeof text !== 'string' || text.length === 0 || /[|\n\r]/.test(text))
    throw new Error(`${what} holds neither a bar nor a line break, and is not empty`)
  return text
}

/**
 * `sed` that puts `line` right before the first `before` of each line of `path`, both matched and
 * written as they are: the expression is cut by `|`, so neither may hold one. R1 checks on the tree
 * of the archive that the tag stands in the file once.
 */
export function insertBefore(path, before, line) {
  plainLine(before, 'The tag')
  plainLine(line, 'The line')
  const pattern = before.replace(/[.*^$[\]\\]/g, '\\$&')
  const replacement = `${line}${before}`.replace(/[\\&]/g, '\\$&')
  return `sed -i ${shellQuote(`s|${pattern}|${replacement}|`)} ${shellQuote(path)}`
}

/** A line appended to `path`, the file and its folder made when the supply has none. */
export function appendLine(path, line) {
  plainLine(line, 'The line')
  return `mkdir -p ${shellQuote(dirname(path))} && printf '%s\\n' ${shellQuote(line)} >> ${shellQuote(path)}`
}

/**
 * The text of the mark R1 and R3 look for: the one the template line of `edit` shows, or — for a
 * stack whose edit has no template (`template: null`, Э5.8) — the text of `shown` (`shownAt`),
 * when that is a plain text.
 */
export function markOf(edit, shown = null) {
  const text =
    /class="stack-mark"[^>]*>([^<]+)</.exec(edit?.template?.line ?? '')?.[1] ??
    (typeof shown?.text === 'string' && shown.text.length > 0 && !/[<>]/.test(shown.text)
      ? shown.text
      : null)
  if (!text) throw new Error('Neither the template line of the edit nor its shownAt carries a mark')
  return { text }
}

/**
 * The part of `edit` R6 changes and the owner then edits on the hosting: a file of the installed
 * version after the undo of R5. The style, when the supply has it; else the template — a style the
 * release added (`created`, `user.css` of Cassiopeia) is gone again after the undo, and the owner
 * would make a new file rather than change one.
 */
export function conflictPart(edit) {
  const part = edit.style && !edit.style.created ? edit.style : edit.template
  if (!part) throw new Error('The edit names no file of the installed version for R6')
  return part
}

/** The line the owner adds by hand on the hosting in R6: a comment in the language of the file. */
export function ownerLine(path) {
  return path.endsWith('.css')
    ? '/* Правка владельца на хостинге */'
    : '<!-- Правка владельца на хостинге -->'
}

const bash = (command, description) => ({ name: 'bash', arguments: { command, description } })
const tool = (name, args) => ({ name: `raditi_${name}`, arguments: args })

/** The parts of an edit a turn writes, in order: the template, its style, the texts. */
const partsOf = (edit) => [edit.template, edit.style, edit.texts].filter(Boolean)

/**
 * R1: the mark into the template, a line of its style, an override of the texts, then the agent's
 * browser on the home page of the preview and its check of the mark. Every answer reports a large
 * usage (LARGE_USAGE of the release stand): the charge of the pass then stands above the minimum of
 * a task, and R1 tells a charge by usage from the minimum. `shown` — `shownAt(build)` of a stack
 * whose edit has no template.
 */
export function editTurn(edit, shown = null) {
  const rounds = []
  if (edit.template)
    rounds.push([
      bash(
        insertBefore(edit.template.path, edit.template.before, edit.template.line),
        'Add the mark to the template',
      ),
    ])
  if (edit.style)
    rounds.push([bash(appendLine(edit.style.path, edit.style.line), 'Style the mark')])
  if (edit.texts)
    rounds.push([bash(appendLine(edit.texts.path, edit.texts.line), 'Override a text of the site')])
  rounds.push([tool('browser_navigate', { path: '/' })])
  rounds.push([
    tool('browser_run_checks', {
      checks: [{ path: '/', selector: MARK_SELECTOR, ...markOf(edit, shown) }],
    }),
  ])
  return {
    scenario: 'tools',
    rounds,
    usage: LARGE_USAGE,
    text: turnResult({
      summary: 'A mark in the footer of the template, its style and a text',
      changeType: 'code',
      message: 'Добавили строку в подвал шаблона, её стиль и перевод. Проверьте предпросмотр.',
      files: partsOf(edit).map((part) => part.path),
    }),
  }
}

/** R2: a file outside the working set of the agent — the publication refuses it. */
export function forbiddenTurn(path) {
  return {
    scenario: 'tools',
    rounds: [[bash(appendLine(path, '<?php // stack-verify'), 'Add a library file')]],
    text: turnResult({
      summary: 'A file of the libraries',
      changeType: 'code',
      message: 'Добавили файл в библиотеки сайта.',
      files: [path],
    }),
  }
}

/**
 * R4: what breaks production only — `code` (breakOnProduction) right before the tag of the
 * template, or at the end of the style when the stack edits no template; the preview stays whole.
 */
export function breakingTurn(edit, code) {
  const command = edit.template
    ? insertBefore(edit.template.path, edit.template.before, code)
    : appendLine(edit.style.path, code)
  const path = edit.template?.path ?? edit.style.path
  return {
    scenario: 'tools',
    rounds: [[bash(command, 'Add a call to the template')]],
    text: turnResult({
      summary: 'A call in the template',
      changeType: 'code',
      message: 'Добавили вызов в шаблон.',
      files: [path],
    }),
  }
}

/**
 * R6: the mark in bold, in the file of `conflictPart` — a line of the style, or a rule of style
 * right before the tag of the template; the owner then changes the same file on the hosting.
 */
export function conflictTurn(edit) {
  const part = conflictPart(edit)
  const rule = '.stack-mark { font-weight: bold; }'
  const command =
    part === edit.template
      ? insertBefore(part.path, part.before, `<style>${rule}</style>`)
      : appendLine(part.path, rule)
  return {
    scenario: 'tools',
    rounds: [[bash(command, 'Bold the mark')]],
    text: turnResult({
      summary: 'The mark in bold',
      changeType: 'code',
      message: 'Сделали строку подвала жирной.',
      files: [part.path],
    }),
  }
}
