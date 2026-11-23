import { describe, expect, it } from 'vitest'

import { canonicalMarkdown, documentToMarkdown, markdownToDocument } from './bridge.ts'
import { canonicalSection, sectionToDocument } from './section.ts'
import { constructs, corpus, editorCases, newConstructs } from './testing/index.ts'

// The condition of slice 88.10 (docs/plan/88-artifacts.md, §10, Э4; spike 4 of Э0а): on the corpus
// of the spike — 30 documents, 109 and 52 constructs, the cases a person leaves — the round
// «Markdown → the editor → Markdown» gives the canonical text back byte for byte, a second round
// changes nothing, and an edit of one word changes only its line.

/** The round of the editor without an editor: what it loads, and what it saves. */
const round = (markdown: string) => documentToMarkdown(markdownToDocument(markdown))

function holds(markdown: string) {
  const canonical = canonicalMarkdown(markdown)
  expect(round(canonical)).toBe(canonical)
  // The document the editor shows is the same after the round.
  expect(markdownToDocument(round(canonical))).toEqual(markdownToDocument(canonical))
  return canonical
}

describe('the bridge between Markdown and the editor (§7.7)', () => {
  it.each(Object.entries(corpus))('keeps the document %s byte for byte', (_name, markdown) => {
    holds(markdown)
  })

  it.each(constructs.map(([id, , markdown]) => [id, markdown]))(
    'keeps the construct %s',
    (_id, markdown) => {
      holds(markdown)
    },
  )

  it.each(newConstructs.map(([id, markdown]) => [id, markdown]))(
    'keeps the construct of the check %s',
    (_id, markdown) => {
      holds(markdown)
    },
  )

  it.each(editorCases.filter(([, , each]) => each.json).map(([id, , each]) => [id, each.json]))(
    'brings what a person leaves (%s) to a fixed point',
    (_id, json) => {
      const first = documentToMarkdown(json)
      expect(round(first)).toBe(first)
    },
  )

  it('keeps quotes, dashes, no-break spaces and «ё», in tables too', () => {
    const text =
      '«ёлочки», „лапки“ — тире, цена 1 990 ₽\n\n| Услуга | Цена |\n| --- | --- |\n| Стрижка | 1 990 ₽ |'
    const canonical = holds(text)
    expect(canonical).toContain('«ёлочки», „лапки“ — тире')
    expect(canonical).toContain('| Стрижка | 1 990 ₽ |')
  })

  it('writes one form: «-» lists, «*» emphasis, tables without padding, no raw HTML', () => {
    expect(canonicalMarkdown('* один\n* два\n\n_курсив_ и __жирный__')).toBe(
      '- один\n- два\n\n*курсив* и **жирный**\n',
    )
    expect(canonicalMarkdown('| a   | b |\n|:----|--:|\n| 1 | 2 |')).toBe(
      '| a | b |\n| :- | -: |\n| 1 | 2 |\n',
    )
    expect(canonicalMarkdown('строка<br>вторая <span>текст</span>')).toBe(
      'строка\\\nвторая текст\n',
    )
  })

  it.each(Object.entries(corpus))(
    'changes only its line when one word of %s is edited',
    (_name, markdown) => {
      const canonical = canonicalMarkdown(markdown)
      const doc = markdownToDocument(canonical)
      // The last word of the first paragraph is replaced, as the editor would.
      const paragraph = doc.content.find(
        (node) => node.type === 'paragraph' && node.content?.some((each) => each.type === 'text'),
      )
      if (!paragraph) return
      const text = [...(paragraph.content ?? [])].reverse().find((each) => each.type === 'text')!
      const words = text.text!.split(' ')
      if (words.length < 2) return
      text.text = [...words.slice(0, -1), 'слово'].join(' ')
      const after = documentToMarkdown(doc).split('\n')
      const before = canonical.split('\n')
      expect(after).toHaveLength(before.length)
      expect(after.filter((line, index) => line !== before[index])).toHaveLength(1)
    },
  )
})

describe('a section (§7.7)', () => {
  it('lifts the headings of the first two levels, setext ones too, to the third', () => {
    expect(canonicalSection('# Один\n\nтекст\n\nДва\n---\n\n#### Четыре')).toBe(
      '### Один\n\nтекст\n\n### Два\n\n#### Четыре\n',
    )
    const doc = sectionToDocument('## Цены')
    expect(doc.content[0]).toMatchObject({ type: 'heading', attrs: { level: 3 } })
  })

  it('is a fixed point', () => {
    for (const markdown of Object.values(corpus)) {
      const canonical = canonicalSection(markdown)
      expect(canonicalSection(canonical)).toBe(canonical)
    }
  })
})
