import { describe, expect, it } from 'vitest'

import { artifactsSection } from './section.ts'
import {
  artifactFrameViewsOf,
  artifactSlidesOf,
  newSlideHtml,
  slideLayouts,
  slideSize,
  slidesThemeCss,
  slidesThemeKey,
} from './slides.ts'
import { artifactTemplateOf, artifactTemplates } from './templates.ts'

// «Презентация» (docs/plan/88-artifacts.md, §7.13, 88.25; docs/plan/93-artifacts-trim.md, АТ8):
// slides of 1280×720 on the canvas, on the deck theme.

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

  it('offers «Новая презентация» on the theme and gives its rules once the kind is released', () => {
    const deck = artifactTemplateOf('company-deck')!
    expect(deck).toMatchObject({ kind: 'slides', title: 'Новая презентация' })
    const frames = deck.blocks.filter((each) => each.kind === 'frame')
    expect(frames.length).toBeGreaterThanOrEqual(5)
    expect(frames.length).toBeLessThanOrEqual(7)
    expect(deck.blocks.filter((each) => each.kind === 'note')).toHaveLength(frames.length)
    // The theme is the one common style, first; every slide takes a layout of it.
    expect(deck.blocks[0]).toMatchObject({
      kind: 'style',
      key: slidesThemeKey,
      content: slidesThemeCss,
    })
    const htmls = deck.blocks.filter((each) => each.kind === 'html').map((each) => each.content)
    for (const html of htmls) expect(html).toMatch(/^<section class="slide s-[a-z]+">/)
    const used = new Set(htmls.map((html) => /class="slide (s-[a-z]+)"/.exec(html)![1]))
    expect([...used].toSorted()).toEqual(Object.keys(slideLayouts).toSorted())
    expect(artifactTemplates.filter((each) => each.kind === 'slides')).toHaveLength(1)
    expect(artifactsSection([], ['document'])).not.toContain('1280×720')
    expect(artifactsSection([], ['document', 'slides'])).toContain('slides of 1280×720')
  })

  it('keeps every slide of the template short: one idea, at most 30 words', () => {
    const deck = artifactTemplateOf('company-deck')!
    for (const block of deck.blocks.filter((each) => each.kind === 'html')) {
      const words = block.content
        .replace(/<[^>]+>/g, ' ')
        .split(/\s+/)
        .filter((word) => /[\p{L}\p{N}]/u.test(word))
      expect(words.length).toBeLessThanOrEqual(30)
    }
    expect(newSlideHtml).toContain('class="slide s-points"')
  })

  it('is a light theme of 1280×720 on Golos Text with a layout class each', () => {
    expect(slidesThemeCss).toContain('--deck-bg:#fff')
    expect(slidesThemeCss).toContain("--deck-font:'Golos Text'")
    expect(slidesThemeCss).toContain('--deck-pad:80px')
    expect(slidesThemeCss).toContain('width:1280px;height:720px')
    expect(slidesThemeCss).toMatch(/\.slide h1\{font-size:72px;line-height:1\.05;font-weight:600/)
    expect(slidesThemeCss).toContain('.slide h2{font-size:48px')
    expect(slidesThemeCss).toContain('.slide p,.slide li{font-size:28px;line-height:1.4')
    for (const layout of Object.keys(slideLayouts)) expect(slidesThemeCss).toContain(`.${layout}`)
    // No text closes its <style> early, and it fits a block.
    expect(slidesThemeCss).not.toMatch(/<\/style/i)
    expect(new TextEncoder().encode(slidesThemeCss).byteLength).toBeLessThan(8 * 1024)
  })

  it('tells the agent to keep the theme and use its layouts, briefly', () => {
    const section = artifactsSection([], ['slides'])
    expect(section).toContain(slidesThemeKey)
    for (const layout of Object.keys(slideLayouts)) expect(section).toContain(layout)
    expect(section).toContain('at most 30 words')
    expect(section).toContain('raditi_artifact_file_put')
    expect(section).toContain('`note`')
    // No CSS of the theme in the instructions.
    expect(section).not.toContain('--deck-pad:80px')
  })
})

describe('the pictures of «Изображение» (88.26)', () => {
  it('draws a picture once in the size of its place, a post by default', async () => {
    const { artifactFrameSizeOf, artifactImageSizes } = await import('./slides.ts')
    expect(artifactFrameSizeOf('image', { size: 'story' })).toMatchObject({
      width: 1080,
      height: 1920,
    })
    expect(artifactFrameSizeOf('image', {})).toMatchObject({ width: 1080, height: 1080 })
    expect(artifactFrameSizeOf('image', { size: 'giant' })).toMatchObject({
      width: 1080,
      height: 1080,
    })
    expect(artifactFrameSizeOf('slides')).toMatchObject({ width: 1280, height: 720 })
    expect(artifactFrameSizeOf('canvas')).toBeNull()
    expect(artifactFrameViewsOf('image', { size: 'banner' }).map((view) => view.width)).toEqual([
      1200,
    ])
    expect(artifactImageSizes['vk-cover']).toMatchObject({ width: 1920, height: 768 })
    // The schema of a frame takes exactly the sizes the registry knows.
    const { artifactBlockValuePropsSchemas } = await import('./blocks.ts')
    for (const size of Object.keys(artifactImageSizes))
      expect(artifactBlockValuePropsSchemas.frame.safeParse({ size }).success).toBe(true)
    expect(artifactBlockValuePropsSchemas.frame.safeParse({ size: 'giant' }).success).toBe(false)
  })

  it('gives its thumbnail a new key when its size changes', async () => {
    const { canvasThumbKey } = await import('./canvas.ts')
    const blocks = (size: string) => [
      block('p', 'frame', null, '', { size }),
      block('p-html', 'html', 'p', '<section></section>'),
    ]
    const key = (size: string) =>
      canvasThumbKey({ blocks: blocks(size), frame: 'p', title: 'Пост' })
    expect(key('post')).not.toBe(key('story'))
  })
})
