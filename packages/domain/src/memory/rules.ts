import { looksLikeSecret } from '../tasks/client-feed-text.ts'
import { secretInContent } from '../projects/text.ts'
import { memoryHasSecret, memoryTextInvalid } from './errors.ts'
import { memoryLimits } from './limits.ts'
import type { MemoryAuthor, MemoryStatus } from './schemas.ts'

// When a note of the agent takes effect at once and when the client decides (docs/plan/84-projects.md,
// ПР18; §4.6, «Отравление памяти»): a text a page, a file read by `cat` or an answer of `curl` put
// into the model is not told apart from the words of the client, and a note lives in every chat
// and run of its project. So a note of the agent is active at once only when everything at once
// says the client wanted it: their own words of this pass ask to remember, nothing of outside came
// into the pass, the chat has no repository, the text has no command, and someone
// watches the pass. Otherwise it is «Предложено» and waits for «Сохранить».

const letter = String.raw`\p{L}`
const word = (body: string) => new RegExp(`(?<![${letter}])(?:${body})(?![${letter}])`, 'iu')

/** «запомни», «запомните», «прошу запомнить», «запиши в память», «сохраните в памяти», «remember». */
const asks = [
  word(String.raw`(?<!не\s)запомн(?:и|ите|ить)`),
  word(
    String.raw`(?:запиши|запишите|сохрани|сохраните|занеси|занесите|добавь|добавьте|внеси|внесите)\s+(?:(?:это|себе|пожалуйста|у\s+себя)\s+){0,2}в\s+памят(?:ь|и)`,
  ),
  // A question — «do you remember…?», «remember?» — asks nothing (ревью, безопасность 3).
  word(String.raw`(?<!(?:do\s+not|don't|dont|you)\s)remember(?![^.!\n]*\?)`),
]

/**
 * Whether the client's own words of a pass ask the agent to remember something (ПР18). Only
 * their words: the instructions, the files and what tools brought are never read here.
 */
export function askedToRemember(words: string): boolean {
  const text = words.normalize('NFC').replace(/ё/gu, 'е').replace(/Ё/gu, 'Е')
  return asks.some((pattern) => pattern.test(text))
}

const command = [
  /`/u,
  /\$\(/u,
  /&&|\|\|/u,
  /(?:^|\s)\|\s*\S/u,
  /(?:^|[\s;])(?:sudo|curl|wget|rm|chmod|chown|ssh|scp|bash|sh|zsh|npm|npx|pnpm|yarn|pip3?|python3?|node|git|docker|kubectl|eval|exec)\s+[-\w./~$'"]/iu,
  /(?:^|\n)\s*[$#>]\s+\S/u,
]

/**
 * A command in the text of an entry: the client reads it first. A link and an address of e-mail
 * are saved like any other text (answer of the owner, 18.11.2026, ПР37): only a secret is never
 * saved (memoryTextOf).
 */
export function memoryTextNeedsReview(text: string): boolean {
  return command.some((pattern) => pattern.test(text))
}

/**
 * The text of an entry as it is stored: trimmed, 1 to 400 characters, never one that looks like a
 * password or a key (MEMORY_TEXT_INVALID, MEMORY_HAS_SECRET).
 */
export function memoryTextOf(raw: string): string {
  const text = raw.trim()
  if (text.length === 0 || text.length > memoryLimits.textChars) throw memoryTextInvalid()
  if (memoryTextHasSecret(text)) throw memoryHasSecret()
  return text
}

/** Whether a text of an entry looks like a password, a key or a token: refused, never proposed. */
export function memoryTextHasSecret(text: string): boolean {
  return looksLikeSecret(text) || secretInContent(text)
}

/** What core knows of a pass when it applies the notes the agent reserved in it (ПР18). */
export interface MemoryPassConditions {
  /** The client's own words of the pass ask to remember (askedToRemember). */
  asked: boolean
  /** A tool that brings text from outside ran in the pass (memoryPassEvidence). */
  outside: boolean
  /** A command of the shell ran in the pass. */
  commands: boolean
  /** The chat has a repository. */
  repository: boolean
  /** Nobody watches the pass: a run of a scheduled task (plan 82) — only proposals. */
  unattended: boolean
}

/** Everything of the pass lets a note of the agent take effect at once. */
export function passMayRemember(conditions: MemoryPassConditions): boolean {
  return (
    conditions.asked &&
    !conditions.outside &&
    !conditions.commands &&
    !conditions.repository &&
    !conditions.unattended
  )
}

/** The status a new note of the agent gets: `active` only when the pass and its text allow. */
export function savedMemoryStatus(text: string, conditions: MemoryPassConditions): MemoryStatus {
  return passMayRemember(conditions) && !memoryTextNeedsReview(text) ? 'active' : 'proposed'
}

/** An entry as the end of a pass reads it before it changes it. */
export interface MemoryEntryFacts {
  author: MemoryAuthor
  status: MemoryStatus
  confirmedAt: Date | null
}

/**
 * How a change of the agent goes to an entry (ПР18): `direct` — the entry changes now; `proposal`
 * — the entry keeps its text and stays active, and the client presses «Сохранить» for the new text
 * or «Удалить» to forget it. The agent changes at once only its own entries the client has not
 * confirmed, and then only as it may save: a proposal of its own is changed or dropped at once,
 * for it does nothing until the client saves it.
 */
export function memoryChangeMode(
  entry: MemoryEntryFacts,
  change: { kind: 'update'; text: string } | { kind: 'forget' },
  conditions: MemoryPassConditions,
): 'direct' | 'proposal' {
  const own = entry.author === 'agent' && entry.confirmedAt === null
  if (!own) return 'proposal'
  if (entry.status === 'proposed') return 'direct'
  if (!passMayRemember(conditions)) return 'proposal'
  if (change.kind === 'update' && memoryTextNeedsReview(change.text)) return 'proposal'
  return 'direct'
}

/** The status of an entry the agent changed at once: a proposal becomes active as a save would. */
export function updatedMemoryStatus(
  entry: MemoryEntryFacts,
  text: string,
  conditions: MemoryPassConditions,
): MemoryStatus {
  return entry.status === 'active' ? 'active' : savedMemoryStatus(text, conditions)
}
