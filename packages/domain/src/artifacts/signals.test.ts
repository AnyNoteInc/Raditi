import { describe, expect, it } from 'vitest'

import {
  artifactPresenceKey,
  artifactSignalChannel,
  parseArtifactSignal,
  readArtifactPresenceMark,
  readArtifactSignal,
} from './signals.ts'

const ID = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'

describe('the signals of artifacts (88.5)', () => {
  it('reads the id the trigger notifies, and nothing else', () => {
    expect(parseArtifactSignal(ID.toUpperCase())).toBe(ID)
    expect(parseArtifactSignal(`${ID}:feed`)).toBeNull()
    expect(parseArtifactSignal('')).toBeNull()
  })

  it('names one channel and one key of presence per artifact', () => {
    expect(artifactSignalChannel(ID.toUpperCase())).toBe(`raditi:artifact:${ID}`)
    expect(artifactPresenceKey(ID)).toBe(`raditi:artifact:${ID}:presence`)
    expect(readArtifactSignal('changes')).toBe('changes')
    expect(readArtifactSignal('presence')).toBe('presence')
    expect(readArtifactSignal('resync')).toBeNull()
  })

  it('reads a mark of presence back, and refuses what is not one', () => {
    expect(readArtifactPresenceMark('{"block":"a","until":5}')).toEqual({ block: 'a', until: 5 })
    expect(readArtifactPresenceMark('{"block":null,"until":5}')).toEqual({ block: null, until: 5 })
    expect(readArtifactPresenceMark('{"block":1,"until":5}')).toBeNull()
    expect(readArtifactPresenceMark('{"until":"5"}')).toBeNull()
    expect(readArtifactPresenceMark('nope')).toBeNull()
  })
})
