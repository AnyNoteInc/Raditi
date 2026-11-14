import {
  insertFeedEvent,
  settleTurnSections,
  uncheckedSectionsOfTurn,
  type PrismaClient,
} from '@repo/db'
import { checkSectionText, isDomainError, type PageRefusalReason } from '@repo/domain'

import type { PagePublications } from './page-publications.ts'

// The end of a turn for the documents of its chat (docs/plan/69-pages.md, Ст19, Ст22): every section
// the chat wrote and core has not checked yet — this turn's and those a failed turn left — is read
// against the keys of the turn and the values of the client's variables, which only the turn holds
// (`CompletedTurn.refusesText`), and against what the role checks too; so are the title and the
// intents of the chat's documents, which the client sees at once. A passed section becomes
// visible, a refused one a placeholder again, a refused title or intent neutral, a `doc_finish`
// waiting becomes the next version; the card is told by `feed.doc_touch`, what was sent back by
// `feed.doc_left` — never why. Then the chat's publications of documents (`page_publish({ docId })`)
// come true or are told, by `PagePublications.publishDocuments`.

export interface DocSectionsDependencies {
  db: Pick<
    PrismaClient,
    '$transaction' | 'chatDocument' | 'chatDocumentSection' | 'taskEvent' | 'taskTurn'
  >
  pages?: Pick<PagePublications, 'publishDocuments'>
  logger?: { log(message: string): void; warn(message: string): void }
}

type Refuses = (text: string) => 'turn_key' | 'client_value' | null

/** The refusal of a text, by the turn's own check first, then by the role's checks of each part. */
function refusalOf(refuses: Refuses, parts: readonly string[]): PageRefusalReason | null {
  const turn = refuses(parts.join('\n'))
  if (turn) return turn
  for (const part of parts) {
    const own = checkSectionText(part)
    if (!own.ok) return own.reason
  }
  return null
}

export class DocSections {
  readonly #deps: DocSectionsDependencies

  constructor(deps: DocSectionsDependencies) {
    this.#deps = deps
  }

  /** Never throws: what is not settled now stays unchecked for the next end of a turn. */
  async settle(taskId: string, turn: number, refusesText: Refuses): Promise<void> {
    const { db, logger } = this.#deps
    try {
      const sections = await uncheckedSectionsOfTurn(db, taskId, turn)
      const documents = await db.chatDocument.findMany({
        where: {
          OR: [{ taskId }, { id: { in: [...new Set(sections.map((each) => each.documentId))] } }],
        },
        select: { id: true, title: true, sections: { select: { id: true, intent: true } } },
      })
      const labels = documents
        .map((document) => ({
          documentId: document.id,
          title: refusalOf(refusesText, [document.title]) !== null,
          intents: document.sections
            .filter((section) => refusalOf(refusesText, [section.intent]) !== null)
            .map((section) => section.id),
        }))
        .filter((each) => each.title || each.intents.length > 0)
      const settled = await settleTurnSections(db, {
        taskId,
        turnNo: turn,
        labels,
        sections: sections.map((section) => ({
          sectionId: section.id,
          digest: section.digest,
          refusal: refusalOf(refusesText, [section.heading ?? '', section.markdown ?? '']),
        })),
      })
      const turnRow = await db.taskTurn.findFirst({
        where: { taskId, turnNo: turn },
        select: { id: true },
      })
      const turnId = turnRow?.id ?? null
      const refusedDocuments = new Set(
        settled.filter((document) => document.refused > 0).map((document) => document.documentId),
      )
      if (settled.length === 0) {
        await this.#deps.pages?.publishDocuments(taskId, turnId, refusedDocuments)
        return
      }
      for (const document of settled) {
        await insertFeedEvent(db, {
          taskId,
          turnId,
          row: {
            type: 'feed.doc_touch',
            payload: { v: 1, docId: document.documentId, revision: document.revision },
          },
        })
        if (document.refused > 0)
          await insertFeedEvent(db, {
            taskId,
            turnId,
            row: {
              type: 'feed.doc_left',
              payload: {
                v: 1,
                docId: document.documentId,
                sections: document.refused,
                reason: 'refused',
              },
            },
          })
      }
      const refused = settled.reduce((sum, document) => sum + document.refused, 0)
      const versions = settled.filter((document) => document.version !== null).length
      logger?.log(
        `doc_sections_settled task=${taskId} turn=${turn} documents=${settled.length} refused=${refused} versions=${versions}`,
      )
      await this.#deps.pages?.publishDocuments(taskId, turnId, refusedDocuments)
    } catch (error) {
      logger?.warn(
        `doc_sections_failed task=${taskId} turn=${turn} reason=${isDomainError(error) ? error.code : 'unknown'}`,
      )
    }
  }
}
