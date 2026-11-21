import { getSchema } from '@tiptap/core'
import { canonicalSection, documentToMarkdown, sectionToDocument } from '@repo/doc-bridge'
import { constructs, corpus, newConstructs } from '@repo/doc-bridge/testing'
import { describe, expect, it } from 'vitest'

import { sectionExtensions } from './extensions'

// The documents of the bridge are documents of the editor (docs/plan/88-artifacts.md, §10, 88.10;
// spike 4 of Э0а): the schema accepts every one — code inside a link and bold too — and what it
// holds goes back to the same Markdown.

const schema = getSchema(sectionExtensions())

const all = [
  ...Object.entries(corpus),
  ...constructs.map(([id, , markdown]) => [id, markdown] as const),
  ...newConstructs.map(([id, markdown]) => [id, markdown] as const),
]

describe('the schema of the editor of a section', () => {
  it.each(all)('holds %s', (_id, markdown) => {
    const canonical = canonicalSection(markdown)
    const doc = sectionToDocument(canonical)
    const node = schema.nodeFromJSON(doc)
    expect(() => node.check()).not.toThrow()
    expect(documentToMarkdown(node.toJSON() as typeof doc)).toBe(canonical)
  })
})
