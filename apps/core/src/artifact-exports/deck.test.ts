import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'

import { deckPdf, deckPptx } from './deck.ts'

// The PDF and the PPTX of «Презентация» (docs/plan/88-artifacts.md, 88.25в).

/** A real 1×1 JPEG. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
)
const slides = [
  { picture: new Uint8Array(JPEG), notes: 'Поздоровайтесь.' },
  { picture: new Uint8Array(JPEG), notes: '' },
]

describe('the files of a presentation', () => {
  it('makes a PDF of 16:9 pages, one a slide', async () => {
    const bytes = await deckPdf({ title: 'Презентация компании', slides })
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBe(2)
    expect(pdf.getPage(0).getSize()).toEqual({ width: 960, height: 540 })
    expect(pdf.getTitle()).toBe('Презентация компании')
  })

  it('makes a PPTX of 16:9 slides with the speaker notes', async () => {
    const bytes = await deckPptx({ title: 'Презентация компании', slides })
    // A PPTX is a ZIP: its parts are named in the clear.
    const text = Buffer.from(bytes).toString('latin1')
    expect(text.startsWith('PK')).toBe(true)
    expect(text).toContain('ppt/slides/slide1.xml')
    expect(text).toContain('ppt/slides/slide2.xml')
    expect(text).toContain('ppt/notesSlides/notesSlide1.xml')
  })
})
