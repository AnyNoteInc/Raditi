import { describe, expect, it } from 'vitest'

import { artifactBlockContentProblem, artifactTitleSchema } from './blocks.ts'
import { artifactReleasedKinds } from './kinds.ts'
import { artifactTemplateOf, artifactTemplates } from './templates.ts'

describe('the templates of the gallery (Ар50)', () => {
  it('are of kinds that may be created, with sections a document accepts', () => {
    const ids = new Set<string>()
    for (const template of artifactTemplates) {
      expect(ids.has(template.id)).toBe(false)
      ids.add(template.id)
      expect(artifactReleasedKinds).toContain(template.kind)
      expect(artifactTitleSchema.safeParse(template.title).success).toBe(true)
      expect(template.sections.length).toBeGreaterThan(0)
      for (const section of template.sections) {
        expect(artifactTitleSchema.safeParse(section.heading).success).toBe(true)
        expect(artifactBlockContentProblem('section', section.content)).toBeNull()
      }
    }
  })

  it('are found by their id', () => {
    expect(artifactTemplateOf('faq')?.title).toBe('Ответы на частые вопросы')
    expect(artifactTemplateOf('nothing')).toBeNull()
  })
})
