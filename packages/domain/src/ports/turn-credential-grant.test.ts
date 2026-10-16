import { describe, expect, it } from 'vitest'

import { DomainError } from '../errors.ts'
import { TURN_FINALIZE_RESERVE_MS } from './turn-runner.ts'
import {
  turnCredentialExpiresAt,
  turnCredentialGrantSchema,
  turnCredentialPolicySchema,
  type TurnCredentialGrant,
} from './turn-credential-grant.ts'

const now = new Date('2026-09-29T00:00:00Z')
const grant = (): TurnCredentialGrant => ({
  driverId: 'opencode',
  backend: 'zai-coding',
  modelSlug: 'synthetic-model',
  modelClass: 'standard',
  reasoningEffort: 'high',
  ttlMs: 20 * 60_000,
  deadlineAt: new Date(now.getTime() + 20 * 60_000),
  budgetRub: '285.00',
  boundSource: '10.1.0.4',
})

describe('turn credential grant', () => {
  it('keeps deadline and VM binding under supervisor authority', () => {
    const { deadlineAt: _deadline, boundSource: _source, ...policy } = grant()
    expect(turnCredentialPolicySchema.parse(policy)).toEqual(policy)
    expect(turnCredentialPolicySchema.safeParse(grant()).success).toBe(false)
    expect(turnCredentialPolicySchema.safeParse({ ...policy, boundSource: null }).success).toBe(
      false,
    )
  })
  // A turn plan saved before the removal names them; no key is issued for it again.
  it.each([
    ['driverId', 'codex'],
    ['driverId', 'kimi'],
    ['driverId', 'qwen'],
    ['backend', 'openai-chatgpt'],
    ['backend', 'kimi-code'],
  ])('refuses the removed id in %s: %s', (field, id) => {
    const { deadlineAt: _deadline, boundSource: _source, ...policy } = grant()
    for (const [schema, value] of [
      [turnCredentialGrantSchema, { ...grant(), [field]: id }],
      [turnCredentialPolicySchema, { ...policy, [field]: id }],
    ] as const) {
      const result = schema.safeParse(value)
      expect(result.success).toBe(false)
      if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([[field]])
    }
    expect(() =>
      turnCredentialExpiresAt({ ...grant(), [field]: id } as TurnCredentialGrant, now),
    ).toThrow(DomainError)
  })
  it('reserves publication time and never extends a shorter TTL', () => {
    expect(turnCredentialExpiresAt(grant(), now).getTime()).toBe(
      now.getTime() + 20 * 60_000 - TURN_FINALIZE_RESERVE_MS,
    )
    expect(turnCredentialExpiresAt({ ...grant(), ttlMs: 1000 }, now).getTime()).toBe(
      now.getTime() + 1000,
    )
  })

  it('rejects issuance when no agent time remains', () => {
    for (const offset of [0, TURN_FINALIZE_RESERVE_MS - 1, TURN_FINALIZE_RESERVE_MS]) {
      expect(() =>
        turnCredentialExpiresAt({ ...grant(), deadlineAt: new Date(now.getTime() + offset) }, now),
      ).toThrow(DomainError)
    }
  })

  it.each(['0.00', '750.01', '-1.00', 'NaN', '1e2', '285', '0.001'])(
    'rejects invalid key budget %s',
    (budgetRub) => {
      expect(turnCredentialGrantSchema.safeParse({ ...grant(), budgetRub }).success).toBe(false)
    },
  )

  it('accepts exact positive boundaries and IPv6/local binding', () => {
    expect(
      turnCredentialGrantSchema.safeParse({ ...grant(), budgetRub: '0.01', boundSource: null })
        .success,
    ).toBe(true)
    expect(
      turnCredentialGrantSchema.safeParse({
        ...grant(),
        budgetRub: '750.00',
        boundSource: 'fd00::1',
      }).success,
    ).toBe(true)
  })

  it('rejects removed classes, hostnames, invalid dates and extra credential fields', () => {
    for (const extra of [
      { modelClass: 'service' },
      { boundSource: 'runner.example.invalid' },
      { deadlineAt: new Date('invalid') },
      { ttlMs: 20 * 60_000 + 1 },
      { accessToken: 'synthetic-not-allowed' },
    ]) {
      expect(turnCredentialGrantSchema.safeParse({ ...grant(), ...extra }).success).toBe(false)
    }
    expect(() => turnCredentialExpiresAt(grant(), new Date('invalid'))).toThrow(DomainError)
  })
})
