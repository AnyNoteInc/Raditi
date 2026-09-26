import { describe, expect, it } from 'vitest'
import { defaultSandboxLimits } from './limits.ts'

describe('defaultSandboxLimits', () => {
  it('matches CLAUDE.md rule 5', () => {
    expect(defaultSandboxLimits).toEqual({
      resources: { cpu: 2, memoryMiB: 4096, pids: 512 },
      user: { uid: 10001, gid: 10001 },
      hardTimeoutMs: 1_200_000,
    })
  })

  it('never runs as root', () => {
    expect(defaultSandboxLimits.user.uid).toBeGreaterThan(0)
    expect(defaultSandboxLimits.user.gid).toBeGreaterThan(0)
  })

  it('cannot be changed at runtime', () => {
    expect(Object.isFrozen(defaultSandboxLimits)).toBe(true)
    expect(Object.isFrozen(defaultSandboxLimits.resources)).toBe(true)
    expect(Object.isFrozen(defaultSandboxLimits.user)).toBe(true)
  })
})
