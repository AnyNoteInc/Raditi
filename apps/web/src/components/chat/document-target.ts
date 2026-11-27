// What opens a document of the chat in its tab, and where it opens in a tab of its own: light,
// so that the feed links to the window without the code of the tab (docs/plan/96, P33.1).

/** A document asked for from outside the tab: an arrival, «Открыть» of a card, a new tab. */
export interface DocumentTarget {
  name: string
  /** A version; null — the latest. */
  fileId: string | null
  /** A new value opens it again, the same document too. */
  seq: number
}

/** Where a document opens in a tab of its own: the window of the cabinet (Д4). */
export const documentWindowHref = (taskId: string, fileId: string): string =>
  `/chats/${encodeURIComponent(taskId)}/documents/${encodeURIComponent(fileId)}`
