import { Logger } from '@nestjs/common'
import { chatDiagramOf, chatDiagramSource, saveChatDiagram, type PrismaClient } from '@repo/db'
import type { ChatDiagramJob } from '@repo/domain'

import type { DiagramDraw } from './artifact-diagram.ts'

// A diagram of an answer in the chat the cabinet asked for (docs/plan/91-chat-diagrams.md, Д3–Д5):
// the text of the row of the feed drawn by the browser worker on the page of the chat's workspace,
// by its engine, and kept by the hash of the engine and the text. A picture kept already, or a row
// gone, is nothing to do; a worker that did not answer fails the job, and the queue tries again.

export interface ChatDiagramDeps {
  db: Pick<PrismaClient, 'taskEvent' | 'chatDiagramRender'>
  /** The browser worker; null — not configured: the chat keeps saying «рисуем». */
  draw: DiagramDraw | null
}

/** Plain class: the stand loads it from its sources. */
export class ChatDiagram {
  readonly #logger = new Logger('ChatDiagram')
  readonly #deps: ChatDiagramDeps

  constructor(deps: ChatDiagramDeps) {
    this.#deps = deps
  }

  async run(job: ChatDiagramJob): Promise<void> {
    const { db, draw } = this.#deps
    if (draw === null) {
      this.#logger.warn('A diagram of the chat was asked for, and no browser worker draws it')
      return
    }
    const diagram = await chatDiagramSource(db, job)
    if (diagram === null) return
    if (await chatDiagramOf(db, diagram)) return
    const result = await draw({
      workspaceId: diagram.workspaceId,
      source: diagram.source,
      engine: diagram.engine,
    })
    await saveChatDiagram(db, { ...diagram, result })
  }
}
