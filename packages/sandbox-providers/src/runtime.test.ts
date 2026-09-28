import { describe, expect, it } from 'vitest'

// The helper runs its command on import unless a unit test imports it for its pure checks.
Object.assign(globalThis, { raditiRuntimeUnderTest: true })
const { isKeepaliveRecord, isProcessStart, statIdentity } = await import('../runtime/runtime.mjs')

describe('sandbox helper process identity', () => {
  it('keeps the negative start time gVisor gives a keepalive when the clock stepped back at boot', () => {
    // /proc/2/stat of the keepalive in a runsc sandbox that booted while the VM's time sync
    // stepped the clock back by 190 ms. Bootstrap recorded -16, and every quiesce of the container
    // then failed: SANDBOX_COMMAND_FAILED after `resumed`, the container removed.
    const stat =
      '2 (sleep) S 1 2 1 0 0 0 0 0 0 0 1 0 0 0 20 0 1 0 -16 10964992 1105 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0'
    const identity = statIdentity(stat)
    expect(identity).toEqual({ state: 'S', ppid: 1, group: 2, started: '-16' })
    expect(isProcessStart(identity.started)).toBe(true)
  })

  it('reads the fields after the last parenthesis of a forged command name', () => {
    const stat = '41 (a) S 1 1 (b) R 40 41 7 0 0 0 0 0 0 0 1 0 0 0 20 0 11 0 5230 1225793536 37058'
    expect(statIdentity(stat)).toEqual({ state: 'R', ppid: 40, group: 41, started: '5230' })
  })

  it('accepts only a signed integer as a start time', () => {
    for (const value of ['0', '3', '5230', '-5', '-16', '18446744073709551615'])
      expect(isProcessStart(value)).toBe(true)
    for (const value of ['', '-', '--1', '+1', '1.5', '1e3', ' 1', '1\n', '0x1', 'abc', 3, null])
      expect(isProcessStart(value)).toBe(false)
    expect(isProcessStart(undefined)).toBe(false)
  })

  it('lets quiesce trust exactly the keepalive record bootstrap writes, negative start included', () => {
    // Bootstrap writes JSON.stringify({ pid, started }); quiesce reads it back with the same check.
    for (const started of ['-16', '0', '5230'])
      expect(isKeepaliveRecord(JSON.parse(JSON.stringify({ pid: 2, started })))).toBe(true)
    for (const record of [
      { pid: 1, started: '3' },
      { pid: '2', started: '3' },
      { pid: 2.5, started: '3' },
      { pid: 2, started: 3 },
      { pid: 2 },
      null,
      '2',
    ])
      expect(isKeepaliveRecord(record)).toBe(false)
  })
})
