// The title and the description the agent wrote for a merge request, made harmless before the
// provider reads them (docs/plan/84-projects.md, ПР14): a line that starts with `/` is a GitLab
// quick action (`/merge`, `/approve`, `/target_branch`), `@name` notifies a person, and
// «Closes #12» closes an issue on merge. The client presses the button; the text stays readable.

/** U+200B ZERO WIDTH SPACE: invisible to the reader, breaks the parsers above. */
const ZERO_WIDTH = '​'

export const mergeRequestTitleMaxLength = 255
export const mergeRequestDescriptionMaxLength = 20_000

// Closing words of GitLab (default issue closing pattern) and of GitHub, followed by a reference:
// `#12`, `group/project#12`, `!3` or a link. Only the word goes; the reference stays.
const closingWords =
  '(?:clos(?:e|es|ed|ing)|fix(?:|es|ed|ing)|resolv(?:e|es|ed|ing)|implement(?:|s|ed|ing))'
const closingPattern = new RegExp(
  `\\b${closingWords}\\b:?[ \\t]+(?=(?:[\\w.\\/-]*[#!]\\d|https?:\\/\\/))`,
  'gi',
)
// The title of a draft is the platform's to set (`draft` of the request), not the agent's.
const draftPrefix = /^\s*(?:\[draft\]|\(draft\)|draft:|wip:|\[wip\])\s*/i

function neutraliseLine(line: string): string {
  let out = line.replace(closingPattern, '')
  // A quick action is a line whose first non-space character is `/`.
  out = out.replace(/^(\s*)\//, `$1${ZERO_WIDTH}/`)
  // `@name`, `@group/sub`, `@all`: the mention parser wants `@` right before the name.
  out = out.replace(/@(?=[\w.-])/g, `@${ZERO_WIDTH}`)
  return out
}

function cut(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

/** One line, no draft prefix, harmless; never empty. */
export function neutraliseMergeRequestTitle(title: string): string {
  let out = title.replace(/[\r\n\t]+/g, ' ').trim()
  while (draftPrefix.test(out)) out = out.replace(draftPrefix, '')
  out = neutraliseLine(out).trim()
  if (out.replaceAll(ZERO_WIDTH, '').trim() === '') out = 'Изменения агента'
  return cut(out, mergeRequestTitleMaxLength)
}

export function neutraliseMergeRequestDescription(description: string): string {
  const lines = description.replace(/\r\n?/g, '\n').split('\n')
  return cut(lines.map(neutraliseLine).join('\n'), mergeRequestDescriptionMaxLength)
}
