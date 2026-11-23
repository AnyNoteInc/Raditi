import { describe, expect, it } from 'vitest'

import {
  artifactDiagramRenderResponseSchema,
  diagramErrorLine,
  diagramErrorRu,
  normalizeDiagramSource,
} from './diagram.ts'

// The text of a diagram before the engine, and its error (docs/plan/88-artifacts.md, §7.13, 88.24).

describe('the text of a diagram before Mermaid', () => {
  it('drops a fence, no-break spaces and formatting tags, keeps <br> and arrows', () => {
    expect(
      normalizeDiagramSource(
        '```mermaid\nflowchart LR\n  A[<b>Заказ</b> клиента<br>сайт] --> B{{<i>Оплата</i>}}\n  C <|-- D\n```',
      ),
    ).toBe('flowchart LR\n  A[Заказ клиента<br>сайт] --> B{{Оплата}}\n  C <|-- D')
  })

  it('cuts every directive: it would change the labels, the font and the CSS', () => {
    expect(
      normalizeDiagramSource(
        '%%{init: {"htmlLabels": true, "themeCSS": "@import url(//x)"}}%%\nflowchart LR\n  A --> B %%{wrap}%%',
      ),
    ).toBe('\nflowchart LR\n  A --> B ')
  })

  it('keeps only the title of a frontmatter, never its config', () => {
    expect(
      normalizeDiagramSource(
        '---\ntitle: Путь клиента\nconfig:\n  theme: dark\n  fontFamily: Comic\n---\nflowchart LR\n  A --> B',
      ),
    ).toBe('---\ntitle: Путь клиента\n---\nflowchart LR\n  A --> B')
    expect(normalizeDiagramSource('---\nconfig:\n  look: handDrawn\n---\nflowchart LR\n  A')).toBe(
      'flowchart LR\n  A',
    )
  })

  it('never cuts a tag across lines', () => {
    expect(normalizeDiagramSource('flowchart LR\n  A[a <span\n  B]')).toBe(
      'flowchart LR\n  A[a <span\n  B]',
    )
  })
})

describe('the error of a diagram', () => {
  it('names the line when Mermaid named one, and says it in Russian for people', () => {
    expect(diagramErrorLine('Parse error on line 3:\n...A -->\n---^')).toBe(3)
    expect(
      diagramErrorLine('Edge limit exceeded. 201 edges found, but the limit is 200.'),
    ).toBeNull()
    expect(diagramErrorRu(3)).toBe('Схема не нарисована: ошибка в строке 3')
    expect(diagramErrorRu(null)).toBe('Схема не нарисована: в тексте ошибка')
  })

  it('bounds what the route answers', () => {
    expect(
      artifactDiagramRenderResponseSchema.safeParse({
        ok: false,
        reason: 'parse',
        line: 2,
        message: 'Parse error on line 2',
      }).success,
    ).toBe(true)
    expect(
      artifactDiagramRenderResponseSchema.safeParse({
        ok: true,
        svg: '<svg/>',
        width: 0,
        height: 1,
        type: 'x',
      }).success,
    ).toBe(false)
  })
})
