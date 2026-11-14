'use client'

import {
  chatDocumentsOf,
  compareFeedIds,
  type ChatFileRow,
} from '@repo/domain/tasks/chat-documents'
import { useEffect, useEffectEvent, useRef } from 'react'

// The documents that come while the client looks at the chat (docs/plan/67-agent-documents.md,
// Д4): the rows of the first answer are the base — what the history held — and a document whose
// latest version has a row after it came live. Each arrival is told once, with every name it
// brought.

/** The newest row of a document in `rows`; null — none. */
export function latestDocumentRow(rows: readonly ChatFileRow[]): string | null {
  let latest: string | null = null
  for (const document of chatDocumentsOf(rows))
    for (const version of document.versions)
      if (latest === null || compareFeedIds(version.rowId, latest) > 0) latest = version.rowId
  return latest
}

/** The names of the documents with a version after `base`. */
export function arrivedSince(rows: readonly ChatFileRow[], base: string | null): string[] {
  return chatDocumentsOf(rows)
    .filter((document) =>
      document.versions.some((version) => base === null || compareFeedIds(version.rowId, base) > 0),
    )
    .map((document) => document.name)
}

export function useDocumentArrivals(
  rows: readonly ChatFileRow[],
  ready: boolean,
  onArrive: (names: string[]) => void,
) {
  // undefined — the first answer is not in: nothing is measured yet.
  const base = useRef<string | null | undefined>(undefined)
  const arrive = useEffectEvent(onArrive)
  useEffect(() => {
    if (!ready) return
    if (base.current === undefined) {
      base.current = latestDocumentRow(rows)
      return
    }
    const names = arrivedSince(rows, base.current)
    if (names.length === 0) return
    base.current = latestDocumentRow(rows)
    arrive(names)
  }, [rows, ready])
}
