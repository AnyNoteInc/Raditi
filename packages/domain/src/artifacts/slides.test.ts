import { describe, expect, it } from 'vitest'

import { artifactsSection } from './section.ts'
import { artifactFrameViewsOf, artifactSlidesOf, slideSize } from './slides.ts'
import { artifactTemplateOf, artifactTemplates } from './templates.ts'

// «Презентация» (docs/plan/88-artifacts.md, §7.13, 88.25): slides of 1280×720 on the canvas.

const block = (
  key: string,
  kind: string,
  parent: string | null,
  content: string | null,
  props: Record<string, unknown> = {},
) => ({ key, kind, parent, rev: 1, content, props })

describe('the slides of a presentation', () => {
  it('reads the slides in the order of the frames, each with its notes', () => {
    const slides = artifactSlidesOf([
      block('deck-style', 'style', null, 'body{}'),
      block('a', 'frame', null, '', { name: 'Обложка' }),
      block('a-html', 'html', 'a', '<section></section>'),
      block('a-note', 'note', 'a', 'Поздоровайтесь.'),
      block('b', 'frame', null, ''),
      block('b-html', 'html', 'b', '<section></section>'),
    ])
    expect(slides).toEqual([
      { key: 'a', name: 'Обложка', notes: 'Поздоровайтесь.', noteKey: 'a-note' },
      { key: 'b', name: 'Слайд 2', notes: '', noteKey: null },
    ])
  })

  it('draws a slide once at 1280×720, a screen of a canvas at two widths', () => {
    expect(slideSize).toEqual({ width: 1280, height: 720 })
    expect(artifactFrameViewsOf('slides').map((view) => view.width)).toEqual([1280])
    expect(artifactFrameViewsOf('canvas').map((view) => view.width)).toEqual([1440, 390])
  })

  it('offers its template and gives its rules once the kind is released (88.25б)', () => {
    expect(artifactTemplates.some((template) => template.id === 'company-deck')).toBe(true)
    const deck = artifactTemplates.find((template) => template.id === 'company-deck')!
    expect(deck.blocks.filter((each) => each.kind === 'frame')).toHaveLength(5)
    expect(deck.blocks.filter((each) => each.kind === 'note')).toHaveLength(5)
    expect(artifactTemplateOf('company-deck')?.kind).toBe('slides')
    expect(artifactsSection([], ['document'])).not.toContain('1280×720')
    expect(artifactsSection([], ['document', 'slides'])).toContain('slides of 1280×720')
  })
})
