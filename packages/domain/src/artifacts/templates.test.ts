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

describe('`@artifact:<id>` in the words of the client (Ар47)', () => {
  it('names each artifact once, in order, lower case, and nothing else', async () => {
    const { artifactMention, artifactMentionsOf } = await import('./section.ts')
    const a = '019F1A21-1800-7F00-8ABC-000000000001'
    const b = '019f1a21-1800-7f00-8abc-000000000002'
    expect(
      artifactMentionsOf(`Допиши @artifact:${a} и @artifact:${b}, ещё @artifact:${a}`),
    ).toEqual([a.toLowerCase(), b])
    expect(artifactMentionsOf('почта info@artifact.ru и @artifact:не-id')).toEqual([])
    expect(artifactMention(a)).toBe(`@artifact:${a.toLowerCase()}`)
  })
})
