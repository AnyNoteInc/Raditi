import { describe, expect, it } from 'vitest'

import { uuidv7 } from './uuid'

describe('uuidv7', () => {
  it('writes the time first, then the version and the variant', () => {
    const id = uuidv7(Date.parse('2026-10-17T09:00:00.000Z'), new Uint8Array(16).fill(0xff))
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(
      Date.parse('2026-10-17T09:00:00.000Z'),
    )
  })

  it('orders ids by their time', () => {
    const random = new Uint8Array(16).fill(0x80)
    expect(uuidv7(1_000, random) < uuidv7(2_000, random)).toBe(true)
  })

  it('is what the procedures take as an id: a UUID of the browser', () => {
    const id = uuidv7()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(uuidv7()).not.toBe(id)
  })
})
