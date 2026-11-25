import { z } from 'zod'

import { artifactRenderLimits } from './limits.ts'

// «Схема» (docs/plan/88-artifacts.md, §7.13, Э11, slice 88.24; spike 7): Mermaid text rendered on the
// server by one engine — Mermaid 12 in a Chromium of `apps/browser` — cleaned by DOMPurify and shown
// as `<img>`. Pure: the text before the engine, the error for people, the contract of the route.

/**
 * Formatting tags Mermaid shows as text with `htmlLabels: false`; `<br>` stays. `<<choice>>` and
 * `<|--` are no tags. A tag is cut whole, within one label — never across a line (spike 7).
 */
const FORMAT_TAGS =
  /(?<!<)<\/?(?:b|i|u|em|strong|span|font|small|big|sup|sub|mark|code|s|strike|del|ins|p|div)\b[^<>\n]*>/gi
/** A whole text in one fence of one of the languages, or of none: group 2 is its body. */
const fenceOf = (languages: string) =>
  new RegExp(
    String.raw`^\s*(\x60{3,}|~{3,})[ \t]*(?:${languages})?[ \t]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$`,
    'i',
  )
const FENCE = fenceOf('mermaid')
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

/**
 * The engines of a diagram (docs/plan/91-chat-diagrams.md, Д2): Mermaid 12 and PlantUML of
 * `@plantuml/core` (TeaVM), both in the Chromium of the render pool, never in the cabinet.
 */
export const diagramEngines = ['mermaid', 'plantuml'] as const
export type DiagramEngine = (typeof diagramEngines)[number]
export const diagramEngineSchema = z.enum(diagramEngines)

/** The languages of a fenced block PlantUML draws. */
const PLANTUML_LANGUAGES = ['plantuml', 'puml', 'uml']

/** The engine the language of a fenced block names; null — the block is code, not a diagram. */
export function diagramEngineOf(language: string): DiagramEngine | null {
  const name = language.trim().toLowerCase()
  if (name === 'mermaid') return 'mermaid'
  if (PLANTUML_LANGUAGES.includes(name)) return 'plantuml'
  return null
}

const PLANTUML_FENCE = fenceOf(PLANTUML_LANGUAGES.join('|'))
const PLANTUML_START = /^\s*@start\w+/m
const PLANTUML_BOUND = /^\s*@(?:start|end)\w+.*$/gm

/** The text an engine sees, the lines the platform added before the author's, and its emptiness. */
export interface DiagramSource {
  text: string
  /** Lines before the author's first: an error's line minus these is the author's line. */
  addedLines: number
  /** Nothing to draw: the engine is not asked. */
  empty: boolean
}

/**
 * The text PlantUML sees: no fence, no no-break space; a text without `@start…` is wrapped in
 * `@startuml`/`@enduml`. Leading blank lines stay: PlantUML counts them. `!include` and `!theme`
 * stay: the page has no network and no files, so they fail and the error goes back to the author
 * (Д2).
 */
function plantUmlSource(source: string): DiagramSource {
  let text = source.replace(/\r\n?/g, '\n')
  const fence = PLANTUML_FENCE.exec(text)
  if (fence) text = fence[2]!
  text = text.replace(NO_BREAK, ' ').replace(/\s+$/, '')
  const empty = text.replace(PLANTUML_BOUND, '').trim() === ''
  return PLANTUML_START.test(text)
    ? { text, addedLines: 0, empty }
    : { text: `@startuml\n${text}\n@enduml`, addedLines: 1, empty }
}

/** What an engine is given of a text (docs/plan/91-chat-diagrams.md, Д2). */
export function diagramSourceFor(engine: DiagramEngine, source: string): DiagramSource {
  if (engine === 'plantuml') return plantUmlSource(source)
  const text = normalizeDiagramSource(source)
  return { text, addedLines: 0, empty: text.trim() === '' }
}

/** The text an engine sees. */
export function normalizeDiagramFor(engine: DiagramEngine, source: string): string {
  return diagramSourceFor(engine, source).text
}

export interface MessageDiagram {
  engine: DiagramEngine
  /** The text of the block as Markdown gives it: the lines between the fences, unindented. */
  source: string
}

const OPEN_FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/

/**
 * The diagrams of an answer of the agent, in their order (docs/plan/91-chat-diagrams.md, Д4): the
 * fenced blocks of `mermaid`, `plantuml`, `puml` or `uml`, as CommonMark reads a fence — an opening
 * of three or more backticks or tildes indented by at most three spaces, a closing of the same
 * character at least as long, the indent of the opening taken off every line. A fence in a list or
 * a quote is not seen: its text then stays code in the chat.
 */
export function messageDiagrams(text: string): MessageDiagram[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const found: MessageDiagram[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN_FENCE.exec(lines[i]!)
    if (!open) continue
    const [, indent, fence, language] = open
    const mark = fence![0]!
    const close = new RegExp(`^ {0,3}\\${mark}{${fence!.length},}[ \\t]*$`)
    let end = i + 1
    while (end < lines.length && !close.test(lines[end]!)) end++
    const engine = diagramEngineOf(language ?? '')
    if (engine) {
      const strip = new RegExp(`^ {0,${indent!.length}}`)
      const body = lines.slice(i + 1, end).map((line) => line.replace(strip, ''))
      found.push({ engine, source: body.join('\n') })
    }
    i = end
  }
  return found
}

/**
 * What a person is shown of a diagram the server draws (§7.7; plan 91, Д1): drawing, the clean
 * picture, or only the line of an error. The artifact adds its `empty`.
 */
export const diagramViewSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('drawing') }),
  z.strictObject({
    state: z.literal('drawn'),
    svg: z.string().max(artifactRenderLimits.diagramSvgBytes),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.strictObject({ state: z.literal('failed'), line: z.number().int().positive().nullable() }),
])
export type DiagramView = z.infer<typeof diagramViewSchema>

export const ARTIFACT_DIAGRAM_PATH = '/v1/diagram'

/** `POST /v1/diagram` of `apps/browser`: one text, drawn on the page of its workspace. */
export const artifactDiagramRenderRequestSchema = z.strictObject({
  /** The page is one a workspace (§7.13): a script that ever ran draws no other client's diagram. */
  workspaceId: z.uuid(),
  source: z.string().min(1).max(artifactRenderLimits.diagramChars),
  /** The engine; none — Mermaid, as the artifacts of «Схема» send it (plan 91, Д2). */
  engine: diagramEngineSchema.optional(),
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
