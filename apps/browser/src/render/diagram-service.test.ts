import type { DiagramRawResult, FrameRenderer } from '@repo/browser-providers/render'
import { describe, expect, it, vi } from 'vitest'

import { DiagramService } from './diagram-service.ts'

// The route of diagrams (docs/plan/88-artifacts.md, §7.13, 88.24а): the text normalised before
// the engine, its error with a line, the picture cleaned and bounded.

const workspaceId = '0193f8a2-6c1e-7000-8000-000000000001'

function serviceWith(raw: DiagramRawResult) {
  const diagram = vi.fn(async () => raw)
  const pool = {
    run: async <T>(work: (renderer: FrameRenderer) => Promise<T>) =>
      work({ diagram } as unknown as FrameRenderer),
  }
  return { service: new DiagramService(pool), diagram }
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><text>Заказ</text></svg>'

describe('the route of diagrams', () => {
  it('gives the engine the normalised text and answers a clean picture', async () => {
    const { service, diagram } = serviceWith({ ok: true, svg, type: 'flowchart-v2' })
    const out = await service.render({
      workspaceId,
      source: '%%{init: {"htmlLabels": true}}%%\nflowchart LR\n  A[<b>Заказ</b>] --> B',
    })
    expect(diagram).toHaveBeenCalledWith({
      workspaceId,
      source: '\nflowchart LR\n  A[Заказ] --> B',
      engine: 'mermaid',
    })
    expect(out).toMatchObject({ ok: true, width: 200, height: 80, type: 'flowchart-v2' })
  })

  it('names the line of a parse error and keeps the engine’s words for the agent', async () => {
    const { service } = serviceWith({
      ok: false,
      reason: 'parse',
      message: 'Parse error on line 4:\n...B --> ((\n',
    })
    expect(await service.render({ workspaceId, source: 'flowchart LR\n  A' })).toEqual({
      ok: false,
      reason: 'parse',
      line: 4,
      message: 'Parse error on line 4:\n...B --> ((\n',
    })
  })

  it('refuses an empty text without the engine, and a picture over 512 KiB', async () => {
    const empty = serviceWith({ ok: true, svg, type: 'x' })
    expect(await empty.service.render({ workspaceId, source: '```mermaid\n\n```' })).toMatchObject({
      ok: false,
      reason: 'parse',
    })
    expect(empty.diagram).not.toHaveBeenCalled()
    const huge = serviceWith({
      ok: true,
      svg: svg.replace('Заказ', 'Я'.repeat(300_000)),
      type: 'x',
    })
    expect(await huge.service.render({ workspaceId, source: 'flowchart LR\n  A' })).toMatchObject({
      ok: false,
      reason: 'too_large',
    })
  })

  // PlantUML in the answers of the chat (docs/plan/91-chat-diagrams.md, Д2).
  it('wraps a PlantUML text in @startuml and names the author’s line of its error', async () => {
    const { service, diagram } = serviceWith({
      ok: false,
      reason: 'parse',
      message: 'Error on line 3: Syntax Error? (Assumed diagram type: sequence)',
    })
    const out = await service.render({
      workspaceId,
      source: 'Alice -> Bob\nfoo (',
      engine: 'plantuml',
    })
    expect(diagram).toHaveBeenCalledWith({
      workspaceId,
      source: '@startuml\nAlice -> Bob\nfoo (\n@enduml',
      engine: 'plantuml',
    })
    expect(out).toMatchObject({ ok: false, reason: 'parse', line: 2 })
    const own = serviceWith({ ok: false, reason: 'parse', message: 'Error on line 3: x' })
    expect(
      await own.service.render({
        workspaceId,
        source: '@startuml\nA -> B\nfoo (\n@enduml',
        engine: 'plantuml',
      }),
    ).toMatchObject({ line: 3 })
    // Blank lines at the top of a block are the author's lines too.
    const blank = serviceWith({ ok: false, reason: 'parse', message: 'Error on line 4: x' })
    expect(
      await blank.service.render({ workspaceId, source: '\n\nfoo (', engine: 'plantuml' }),
    ).toMatchObject({ line: 3 })
  })

  it('refuses an empty PlantUML text without the engine', async () => {
    const { service, diagram } = serviceWith({ ok: true, svg, type: 'plantuml' })
    expect(
      await service.render({ workspaceId, source: '@startuml\n\n@enduml', engine: 'plantuml' }),
    ).toMatchObject({ ok: false, reason: 'parse' })
    expect(diagram).not.toHaveBeenCalled()
  })
})
