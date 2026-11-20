import { tokenReasonOf } from '../pages/content-check.ts'
import { codeLooksLikeSecret, hasVisibleText, looksLikeSecret } from '../tasks/client-feed-text.ts'
import {
  projectGoalTooLong,
  projectInstructionsTooLong,
  projectNameInvalid,
  projectTextHasSecret,
} from './errors.ts'
import { projectLimits } from './limits.ts'

// The words of a project (docs/plan/84-projects.md, ПР5, ПР7, ПР8): what the client writes is
// checked here before it is stored, and what goes into the instructions of a pass is made safe
// for its section here.

/** The tags of the data sections of the instructions of a pass (ПР7). */
export const sectionTagNames = [
  'project-instructions',
  'project-context',
  'project-memory',
  'client-instructions',
  // The data sections of artifacts (docs/plan/88-artifacts.md, Ар26).
  'project-artifacts',
  'chat-artifacts',
  'artifact-comment',
  'artifact-view',
] as const

const sectionTag = new RegExp(
  String.raw`<\s*\/?\s*(?:${sectionTagNames.join('|')})(?![\w-])[^<>]*>`,
  'giu',
)
const lineBreaks = /[\r\n\v\f\u0085\u2028\u2029]+/gu

/**
 * A value made fit for a data section of the instructions of a pass (ПР7): the opening and closing
 * tags of every section are taken out — again, until none is left, so `<proj<project-memory>ect-memory>`
 * leaves nothing either — and, for a value of one line (a name, a path, a branch), its line breaks
 * become spaces. Every value that goes into a section goes through it: the client's text, the
 * names of files, the entries of memory, the branch, the path of the repository.
 */
export function sectionValue(value: string, shape: 'line' | 'text' = 'text'): string {
  let text = value
  for (;;) {
    const next = text.replace(sectionTag, '')
    if (next === text) break
    text = next
  }
  return shape === 'line' ? text.replace(lineBreaks, ' ').trim() : text
}

/**
 * The text cut at whitespace into pieces of at most `size` characters, joined by spaces; a piece
 * after the first begins with the last few words of the one before, so that «Пароль:» and its value
 * are read together wherever the cut falls. A word longer than a piece is cut where it must be.
 */
export function textPieces(text: string, size: number, overlap = 8): string[] {
  const words = text
    .split(/\s+/u)
    .filter((word) => word !== '')
    .flatMap((word) => {
      if (word.length <= size) return [word]
      const parts: string[] = []
      for (let at = 0; at < word.length; at += size) parts.push(word.slice(at, at + size))
      return parts
    })
  const pieces: string[] = []
  let at = 0
  while (at < words.length) {
    const piece: string[] = []
    let length = 0
    // The words of the piece before, as many of them as leave room for a new one.
    if (pieces.length > 0) {
      for (const word of words.slice(Math.max(0, at - overlap), at)) {
        if (length + word.length + 1 + (words[at]?.length ?? 0) >= size) break
        piece.push(word)
        length += word.length + 1
      }
    }
    while (at < words.length && length + words[at]!.length <= size) {
      piece.push(words[at]!)
      length += words[at]!.length + 1
      at += 1
    }
    pieces.push(piece.join(' '))
  }
  return pieces
}

/**
 * True when long instructions look like a password or a key (ПР7): looksLikeSecret() over pieces
 * of at most its own limit — on the whole text it would answer «yes» to anything longer.
 */
export function instructionsLookLikeSecret(text: string): boolean {
  return textPieces(text, projectLimits.secretCheckChars).some(looksLikeSecret)
}

/**
 * True when a file or a text of the context holds a secret (ПР8). looksLikeSecret() refuses what
 * is longer than 4000 characters and the ordinary names of code (`getElementById(id)`), so this
 * one looks for the forms a secret is known by: the prefixes of keys, a private key block, a signed
 * token, the keys of a turn and of other services — and a word of a secret near a value that is not
 * a word of code («Пароль: Qwerty123», `DB_PASSWORD=Xk9#mP2$vL`; `codeLooksLikeSecret`). A
 * password nothing names is let through. Any length: the text is read in pieces.
 */
export function secretInContent(text: string): boolean {
  if (tokenReasonOf(text) !== null) return true
  return textPieces(text, projectLimits.secretCheckChars).some(codeLooksLikeSecret)
}

/** The name of a project, one line; PROJECT_NAME_INVALID when empty or longer than 80. */
export function projectNameOf(raw: string): string {
  const name = raw.replace(/\s+/gu, ' ').trim()
  if (!hasVisibleText(name) || name.length > projectLimits.nameChars) throw projectNameInvalid()
  if (looksLikeSecret(name)) throw projectTextHasSecret()
  return name
}

/** The goal of a project, one line; null — none. */
export function projectGoalOf(raw: string | null | undefined): string | null {
  const goal = (raw ?? '').replace(/\s+/gu, ' ').trim()
  if (!hasVisibleText(goal)) return null
  if (goal.length > projectLimits.goalChars) throw projectGoalTooLong()
  if (looksLikeSecret(goal)) throw projectTextHasSecret()
  return goal
}

/** The instructions of a project (ПР7); null — the client took them away. */
export function projectInstructionsOf(raw: string): string | null {
  const text = raw.trim()
  if (!hasVisibleText(text)) return null
  if (text.length > projectLimits.instructionsChars) throw projectInstructionsTooLong()
  if (instructionsLookLikeSecret(text)) throw projectTextHasSecret()
  return text
}
