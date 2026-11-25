import { z } from 'zod'

import { artifactRenderLimits } from './limits.ts'

// The diagrams of chat answers (docs/plan/91-chat-diagrams.md; first made for the «Схема» artifact of
// plan 88, §7.13, removed in plan 93, АТ3; spike 7): Mermaid text rendered on the server by one engine — Mermaid 12 in a Chromium of `apps/browser` — cleaned by DOMPurify and shown
// as `<img>`. Pure: the text before the engine, the error for people, the contract of the route.

/**
 * Formatting tags Mermaid shows as text with `htmlLabels: false`; `<br>` stays. `<<choice>>` and
 * `<|--` are no tags. A tag is cut whole, within one label — never across a line (spike 7).
 */
const FORMAT_TAGS =
  /(?<!<)<\/?(?:b|i|u|em|strong|span|font|small|big|sup|sub|mark|code|s|strike|del|ins|p|div)\b[^<>\n]*>/gi
const FENCE = /^\s*(`{3,}|~{3,})[ \t]*(?:mermaid)?[ \t]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/i
/** `%%{init: …}%%` and its kin: a directive would change the labels, the font or the CSS. */
const DIRECTIVE = /%%\{[\s\S]*?\}%%/g
const NO_BREAK = /[\u00a0\u2007\u202f]/g

/**
 * The text the engine sees (§7.13): no fence, no no-break space, no directive, no `config` of the
 * frontmatter (its `title` stays), formatting tags cut. Nothing else is rewritten: a parse error goes
 * back to its author instead.
 */
export function normalizeDiagramSource(source: string): string {
  let text = source.replace(/\r\n?/g, '\n')
  const fence = FENCE.exec(text)
  if (fence) text = fence[2]!
  text = text.replace(NO_BREAK, ' ').replace(DIRECTIVE, '')
  text = frontmatterTitleOnly(text)
  return text.replace(FORMAT_TAGS, '')
}

/** A frontmatter keeps only its `title`: `config` there is a directive by another name. */
function frontmatterTitleOnly(text: string): string {
  const start = /^\s*---[ \t]*\n/.exec(text)
  if (!start) return text
  const rest = text.slice(start[0].length)
  const end = /^---[ \t]*$/m.exec(rest)
  if (!end) return text
  const head = rest.slice(0, end.index)
  const body = rest.slice(end.index + end[0].length).replace(/^\n/, '')
  const title = head.split('\n').find((line) => /^title:\s*\S/.test(line))
  return title ? `---\n${title}\n---\n${body}` : body
}

/** The line Mermaid named in its error, when it named one: «Parse error on line 3». */
export function diagramErrorLine(message: string): number | null {
  const found = /\bline\s+(\d{1,6})\b/i.exec(message)
  if (!found) return null
  const line = Number(found[1])
  return line > 0 ? line : null
}

/** The words for people: Mermaid's English goes to the agent only (§7.5, §7.7). */
export function diagramErrorRu(line: number | null): string {
  return line === null
    ? 'Схема не нарисована: в тексте ошибка'
    : `Схема не нарисована: ошибка в строке ${line}`
}

export const ARTIFACT_DIAGRAM_PATH = '/v1/diagram'

/** `POST /v1/diagram` of `apps/browser`: one text, drawn on the page of its workspace. */
export const artifactDiagramRenderRequestSchema = z.strictObject({
  /** The page is one a workspace (§7.13): a script that ever ran draws no other client's diagram. */
  workspaceId: z.uuid(),
  source: z.string().min(1).max(artifactRenderLimits.diagramChars),
})
export type ArtifactDiagramRenderRequest = z.infer<typeof artifactDiagramRenderRequestSchema>

export const artifactDiagramRenderResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    /** Clean XML of an SVG with its own width and height, for `<img>`. */
    svg: z.string().max(artifactRenderLimits.diagramSvgBytes),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** Mermaid's name of the kind of the diagram: flowchart-v2, sequence, gantt… */
    type: z.string().max(40),
  }),
  z.strictObject({
    ok: z.literal(false),
    /** `parse` — the text; `timeout`, `too_large`, `render` — the engine or the picture. */
    reason: z.enum(['parse', 'render', 'timeout', 'too_large']),
    line: z.number().int().positive().nullable(),
    /** The engine's words, for the agent: never shown to a person. */
    message: z.string().max(300),
  }),
])
export type ArtifactDiagramRenderResponse = z.infer<typeof artifactDiagramRenderResponseSchema>
