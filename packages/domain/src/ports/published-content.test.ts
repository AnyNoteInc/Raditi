import { describe, expect, it } from 'vitest'

import {
  contentNoWriteProofSchema,
  contentOperationRefSchema,
  contentTimeLeftSchema,
  type ContentOperationRequest,
  type ContentWriteOutcome,
  type ContentWriteRequest,
} from './published-content.ts'

describe('ContentWriteOutcome', () => {
  it('lets a site say why it refused a value: its markup, its size or its storage', () => {
    // Checked by the type checker: the gateway gives the agent a fixed error per reason.
    const refusals: ContentWriteOutcome[] = (['markup', 'size', 'storage'] as const).map(
      (reason) => ({ version: 1, kind: 'rejected', code: 'invalid', reason }),
    )
    const reasons = refusals.map((outcome) => (outcome.kind === 'rejected' ? outcome.reason : null))
    expect(reasons).toEqual(['markup', 'size', 'storage'])
  })
})

describe('the time a write has left', () => {
  const ref = {
    callId: '01960000-0000-7000-8000-000000000001',
    siteId: '01960000-0000-7000-8000-000000000002',
    epoch: 1,
    requestHash: 'a'.repeat(64),
    objectRef: 'page:42',
    deadlineAt: 1_800_000_000_000,
  }

  it('is a whole number of milliseconds, zero or less once the deadline has passed', () => {
    for (const ttlMs of [15_000, 1, 0, -1, -86_400_000])
      expect(contentTimeLeftSchema.safeParse(ttlMs).success).toBe(true)
    for (const ttlMs of [
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      '100',
      null,
      undefined,
    ])
      expect(contentTimeLeftSchema.safeParse(ttlMs).success).toBe(false)
  })

  it('travels with every request to a site and stays out of the identity and its proofs', () => {
    // Checked by the type checker: a request without the time left does not compile.
    const operation: ContentOperationRequest = { ...ref, ttlMs: -250 }
    const write: ContentWriteRequest = {
      ...ref,
      ttlMs: 12_345,
      expectedStateHash: 'b'.repeat(64),
      mode: 'edit',
      fields: { title: 'После' },
    }
    expect([operation.ttlMs, write.ttlMs]).toEqual([-250, 12_345])
    expect(contentOperationRefSchema.safeParse(operation).success).toBe(false)
    expect(
      contentNoWriteProofSchema.safeParse({ ...operation, version: 1, kind: 'not_committed' })
        .success,
    ).toBe(false)
    expect(
      contentNoWriteProofSchema.safeParse({ ...ref, version: 1, kind: 'not_committed' }).success,
    ).toBe(true)
  })
})
