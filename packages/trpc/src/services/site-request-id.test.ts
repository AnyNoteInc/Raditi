import { randomUUID } from 'node:crypto'

import { siteAccessPath } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { siteIdForRequest } from './site-request-id.ts'

describe('siteIdForRequest', () => {
  const userId = '0199a000-0000-7000-8000-000000000001'
  const requestKey = '0199a000-0000-4000-8000-0000000000aa'

  it('derives the same lower-case UUID version 8 from the same user and key', () => {
    const id = siteIdForRequest(userId, requestKey)
    expect(id).toBe(siteIdForRequest(userId, requestKey))
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // Every place that reads the id back accepts it.
    expect(z.uuid().safeParse(id).success).toBe(true)
    expect(siteAccessPath(id, 'ssh')).toBe(`kv/sites/${id}/ssh`)
  })

  it('ignores the letter case of the ids it is given', () => {
    expect(siteIdForRequest(userId.toUpperCase(), requestKey.toUpperCase())).toBe(
      siteIdForRequest(userId, requestKey),
    )
  })

  it('gives another user or another key another site', () => {
    const id = siteIdForRequest(userId, requestKey)
    expect(siteIdForRequest('0199a000-0000-7000-8000-000000000002', requestKey)).not.toBe(id)
    expect(siteIdForRequest(userId, randomUUID())).not.toBe(id)
    // The two ids are not interchangeable.
    expect(siteIdForRequest(requestKey, userId)).not.toBe(id)
  })

  it('pins the derivation: a changed prefix would give every repeated request a second site', () => {
    expect(siteIdForRequest(userId, requestKey)).toBe('76c5c3c3-23ef-8dd3-8802-50c71b5b7581')
  })
})
