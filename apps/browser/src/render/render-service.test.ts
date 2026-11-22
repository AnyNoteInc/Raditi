import { describe, expect, it } from 'vitest'

import { withSlideHeight } from './render-service.ts'

// A slide of «Презентация» is 1280×720 (docs/plan/88-artifacts.md, 88.25): a taller one is cut in
// the show, and its report says so first.

const report = { text: 'No problems found.', ru: 'Замечаний нет', problems: 0 }

describe('the height of a slide in its report', () => {
  it('names a slide taller than 720 px to the agent and the client', () => {
    const told = withSlideHeight(report as never, 910)
    expect(told.problems).toBe(1)
    expect(told.text).toMatch(/^The slide is 910 px tall, over its 720/)
    expect(told.ru).toContain('Слайд не помещается: 910 px при высоте 720')
  })

  it('leaves a slide that fits, and anything that is not a slide, as it was', () => {
    expect(withSlideHeight(report as never, 720)).toBe(report)
    expect(withSlideHeight(report as never, null)).toBe(report)
  })
})
