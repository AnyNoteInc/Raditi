import { describe, expect, it } from 'vitest'

import { releaseText } from './chat-texts'

describe('the words of the release window', () => {
  it('agrees the number of changes of a bulk plan with its noun', () => {
    expect(releaseText.reviewBulk(21)).toBe(
      'Это массовое изменение: 21 изменение базы данных. Посмотрите их все перед выпуском.',
    )
    expect(releaseText.reviewBulk(22)).toContain('22 изменения базы данных')
    expect(releaseText.reviewBulk(25)).toContain('25 изменений базы данных')
    expect(releaseText.reviewBulk(111)).toContain('111 изменений базы данных')
  })
})
