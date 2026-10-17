import { describe, expect, it } from 'vitest'

import {
  llmBackendIds,
  type LimitWindow,
  type LlmBackendId,
  type LlmCapacity,
} from '../ports/llm-backend.ts'
import { pickAccount, type PickAccountInput, type PoolAccountSnapshot } from './pool.ts'

const NOW = new Date('2026-09-29T12:00:00.000Z')
const MINUTE = 60_000
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE)
const window = (name: LimitWindow['name'], usedPct: number, minutes = 120): LimitWindow => ({
  name,
  usedPct,
  resetsAt: at(minutes),
})
function account(id = 'a', overrides: Partial<PoolAccountSnapshot> = {}): PoolAccountSnapshot {
  return {
    id,
    backend: 'zai-coding',
    enabled: true,
    status: 'active',
    health: 'ok',
    healthReason: null,
    healthChangedAt: null,
    retireRequestedAt: null,
    coolingUntil: null,
    breakerOpenUntil: null,
    limitWindows: [window('5h', 20), window('week', 40, 5_000)],
    activeTurns: 0,
    maxConcurrentTurns: 1,
    lastUsedAt: null,
    ...overrides,
  }
}
function input(overrides: Partial<PickAccountInput> = {}): PickAccountInput {
  return {
    backend: 'zai-coding',
    capacity: 'windows',
    providerEnabled: true,
    now: NOW,
    boundAccountId: null,
    rebinds: 0,
    policyFlagged: false,
    accounts: [account()],
    ...overrides,
  }
}
function bound(
  overrides: Partial<PoolAccountSnapshot> = {},
  alternatives: PoolAccountSnapshot[] = [],
): PickAccountInput {
  return input({ boundAccountId: 'a', accounts: [account('a', overrides), ...alternatives] })
}
const selected = (accountId = 'a', binding: 'initial' | 'keep' | 'rebind' = 'initial') => ({
  kind: 'selected',
  accountId,
  binding,
  rebinds: binding === 'rebind' ? 1 : 0,
})

// What each adapter declares (LlmBackend.capacity); the domain does not import adapters. A new
// id does not compile here until it says which policy its accounts follow.
const capacityOf: Record<LlmBackendId, LlmCapacity> = { 'zai-coding': 'windows', 'zai-api': 'none' }

describe('pickAccount: new tasks', () => {
  it.each(llmBackendIds)('uses the same policy for %s', (backend) => {
    expect(
      pickAccount(
        input({ backend, capacity: capacityOf[backend], accounts: [account('a', { backend })] }),
      ),
    ).toEqual(selected())
  })

  it('ranks by the minimum headroom across all reported windows', () => {
    expect(
      pickAccount(
        input({
          accounts: [
            account('large-5h', { limitWindows: [window('5h', 0), window('week', 80)] }),
            account('large-week', { limitWindows: [window('5h', 10), window('month', 90)] }),
            account('balanced', { limitWindows: [window('5h', 40), window('week', 50)] }),
          ],
        }),
      ),
    ).toEqual(selected('balanced'))
  })

  it('breaks ties by oldest use, never-used first, then id independently of row order', () => {
    const oldest = account('oldest', { lastUsedAt: at(-120) })
    const newest = account('newest', { lastUsedAt: at(-1) })
    expect(pickAccount(input({ accounts: [newest, oldest] }))).toEqual(selected('oldest'))
    expect(pickAccount(input({ accounts: [oldest, account('never')] }))).toEqual(selected('never'))
    const a = account('a')
    const b = account('b')
    expect(pickAccount(input({ accounts: [b, a] }))).toEqual(selected('a'))
    expect(pickAccount(input({ accounts: [a, b] }))).toEqual(selected('a'))
  })

  it.each([
    ['disabled', { enabled: false }],
    ['banned', { status: 'banned' }],
    ['retired', { status: 'retired' }],
    ['retire requested', { retireRequestedAt: at(-1) }],
    ['needs login', { health: 'needs_relogin' }],
    ['suspended', { health: 'suspended', healthChangedAt: at(-2_000) }],
    ['breaker open', { breakerOpenUntil: at(1) }],
    ['cooling', { coolingUntil: at(1) }],
    ['busy', { activeTurns: 1 }],
  ] satisfies [string, Partial<PoolAccountSnapshot>][])(
    'skips %s accounts',
    (_label, overrides) => {
      expect(pickAccount(input({ accounts: [account('a', overrides), account('b')] }))).toEqual(
        selected('b'),
      )
    },
  )

  it('goes by the health of an account, not by a reason recorded beside it', () => {
    expect(
      pickAccount(input({ accounts: [account('a', { healthReason: 'operator_note' })] })),
    ).toEqual(selected())
  })

  it('honors the provider stop switch for new and existing tasks', () => {
    expect(pickAccount(input({ providerEnabled: false }))).toEqual({
      kind: 'wait',
      probeAccountIds: [],
      reason: 'provider_disabled',
      retryAt: at(15),
    })
    expect(pickAccount({ ...bound(), providerEnabled: false })).toEqual({
      kind: 'operator',
      reason: 'provider_disabled',
    })
  })

  it('admits exactly 10% five-hour headroom for a new task, but not just below it', () => {
    expect(
      pickAccount(input({ accounts: [account('a', { limitWindows: [window('5h', 90)] })] })),
    ).toEqual(selected())
    expect(
      pickAccount(input({ accounts: [account('a', { limitWindows: [window('5h', 90.001)] })] })),
    ).toEqual({
      kind: 'wait',
      probeAccountIds: [],
      reason: 'pool_empty',
      retryAt: at(120),
    })
  })

  it.each(['week', 'month'] as const)('also enforces turn headroom in the %s window', (name) => {
    const base = account('a', { limitWindows: [window('5h', 0), window(name, 95)] })
    expect(pickAccount(input({ accounts: [base] }))).toEqual(selected())
    expect(
      pickAccount(
        input({ accounts: [{ ...base, limitWindows: [window('5h', 0), window(name, 95.001)] }] }),
      ),
    ).toEqual({
      kind: 'wait',
      probeAccountIds: [],
      reason: 'pool_empty',
      retryAt: at(120),
    })
  })

  it.each(['week', 'month'] as const)(
    'admits a plan reporting only its %s window for new and bound tasks',
    (name) => {
      const limitWindows = [window(name, 7)]
      expect(pickAccount(input({ accounts: [account('a', { limitWindows })] }))).toEqual(selected())
      expect(pickAccount(bound({ limitWindows }))).toEqual(selected('a', 'keep'))
    },
  )

  it.each(['week', 'month'] as const)(
    'applies the turn reserve to a %s-only plan without inventing a five-hour reserve',
    (name) => {
      expect(
        pickAccount(input({ accounts: [account('a', { limitWindows: [window(name, 95)] })] })),
      ).toEqual(selected())
      expect(
        pickAccount(input({ accounts: [account('a', { limitWindows: [window(name, 95.001)] })] })),
      ).toEqual({
        kind: 'wait',
        reason: 'pool_empty',
        retryAt: at(120),
        probeAccountIds: [],
      })
      expect(
        pickAccount(
          input({
            minTurnHeadroomPct: 20,
            accounts: [account('a', { limitWindows: [window(name, 80.001)] })],
          }),
        ),
      ).toEqual({
        kind: 'wait',
        reason: 'pool_empty',
        retryAt: at(120),
        probeAccountIds: [],
      })
    },
  )

  it('supports a larger configured turn reserve and retains the new-task 10% floor', () => {
    expect(
      pickAccount(
        input({
          minTurnHeadroomPct: 20,
          accounts: [account('a', { limitWindows: [window('5h', 80)] })],
        }),
      ),
    ).toEqual(selected())
    expect(
      pickAccount(
        input({
          minTurnHeadroomPct: 20,
          accounts: [account('a', { limitWindows: [window('5h', 80.001)] })],
        }),
      ).kind,
    ).toBe('wait')
    expect(
      pickAccount(
        input({
          minTurnHeadroomPct: 1,
          accounts: [account('a', { limitWindows: [window('5h', 91)] })],
        }),
      ).kind,
    ).toBe('wait')
  })
})

describe('pickAccount: bound tasks', () => {
  it('keeps a usable binding even if an alternative has more headroom', () => {
    expect(pickAccount(bound({ limitWindows: [window('5h', 95)] }, [account('b')]))).toEqual(
      selected('a', 'keep'),
    )
  })

  it('keeps the binding at the exact turn threshold, and waits just below it', () => {
    expect(pickAccount(bound({ limitWindows: [window('5h', 95, 10)] }))).toEqual(
      selected('a', 'keep'),
    )
    expect(pickAccount(bound({ limitWindows: [window('5h', 95.001, 10)] }))).toEqual({
      kind: 'wait',
      probeAccountIds: [],
      reason: 'cooling',
      retryAt: at(10),
    })
  })

  it('returns busy for 60 seconds without switching accounts or consuming a rebind', () => {
    const snapshot = { ...bound({ activeTurns: 1 }, [account('b')]), rebinds: 1 }
    expect(pickAccount(snapshot)).toEqual({ kind: 'busy', retryAt: at(1) })
    expect(snapshot.boundAccountId).toBe('a')
    expect(snapshot.rebinds).toBe(1)
    expect(pickAccount(bound({ activeTurns: 1, coolingUntil: at(120) }, [account('b')]))).toEqual({
      kind: 'busy',
      retryAt: at(1),
    })
  })

  it('uses account concurrency instead of a provider-specific constant', () => {
    expect(pickAccount(bound({ activeTurns: 1, maxConcurrentTurns: 2 }))).toEqual(
      selected('a', 'keep'),
    )
    expect(pickAccount(bound({ activeTurns: 2, maxConcurrentTurns: 2 }))).toEqual({
      kind: 'busy',
      retryAt: at(1),
    })
  })

  it('waits through exactly 45 minutes, then permits a rebind', () => {
    expect(pickAccount(bound({ coolingUntil: at(45) }, [account('b')]))).toEqual({
      kind: 'wait',
      probeAccountIds: [],
      reason: 'cooling',
      retryAt: at(45),
    })
    expect(
      pickAccount(bound({ coolingUntil: new Date(at(45).getTime() + 1) }, [account('b')])),
    ).toEqual(selected('b', 'rebind'))
  })

  it('waits for the latest blocking window, including the recorded cooldown buffer', () => {
    expect(
      pickAccount(
        bound(
          {
            limitWindows: [window('5h', 99, 5), window('week', 96, 40), window('month', 97, 30)],
            coolingUntil: at(41),
          },
          [account('b')],
        ),
      ),
    ).toEqual({ kind: 'wait', probeAccountIds: [], reason: 'cooling', retryAt: at(41) })
    expect(
      pickAccount(
        bound(
          {
            limitWindows: [window('5h', 99, 5), window('week', 96, 46)],
          },
          [account('b')],
        ),
      ),
    ).toEqual(selected('b', 'rebind'))
  })

  it('accepts expired cooling/breaker timestamps only with fresh quota windows', () => {
    expect(pickAccount(bound({ coolingUntil: NOW, breakerOpenUntil: NOW }))).toEqual(
      selected('a', 'keep'),
    )
    expect(
      pickAccount(bound({ coolingUntil: at(-1), limitWindows: [window('5h', 100, -1)] })),
    ).toEqual({
      kind: 'wait',
      probeAccountIds: ['a'],
      reason: 'limits_unknown',
      retryAt: at(15),
    })
  })

  it.each([
    ['disabled', { enabled: false }],
    ['banned', { status: 'banned' }],
    ['retired', { status: 'retired' }],
    ['retire requested', { retireRequestedAt: at(-1) }],
    ['needs login', { health: 'needs_relogin' }],
  ] satisfies [string, Partial<PoolAccountSnapshot>][])(
    'rebinds an existing %s account',
    (_label, overrides) => {
      expect(pickAccount(bound(overrides, [account('b')]))).toEqual(selected('b', 'rebind'))
    },
  )

  it('waits out the 15-minute usage breaker without spending the rebind or calling the operator', () => {
    const waiting = { kind: 'wait', probeAccountIds: [], reason: 'cooling', retryAt: at(15) }
    const snapshot = bound({ breakerOpenUntil: at(15) }, [account('b')])
    expect(pickAccount(snapshot)).toEqual(waiting)
    expect(pickAccount({ ...snapshot, rebinds: 1 })).toEqual(waiting)
    expect(pickAccount({ ...snapshot, now: at(15) })).toEqual(selected('a', 'keep'))
  })

  it('applies the 45-minute rule and the latest blocker to the breaker as to a cooldown', () => {
    expect(pickAccount(bound({ breakerOpenUntil: at(45) }, [account('b')]))).toEqual({
      kind: 'wait',
      probeAccountIds: [],
      reason: 'cooling',
      retryAt: at(45),
    })
    expect(
      pickAccount(bound({ breakerOpenUntil: new Date(at(45).getTime() + 1) }, [account('b')])),
    ).toEqual(selected('b', 'rebind'))
    for (const [breakerOpenUntil, coolingUntil] of [
      [at(12), at(5)],
      [at(5), at(12)],
    ] as const)
      expect(pickAccount(bound({ breakerOpenUntil, coolingUntil }, [account('b')]))).toEqual({
        kind: 'wait',
        probeAccountIds: [],
        reason: 'cooling',
        retryAt: at(12),
      })
    expect(
      pickAccount(bound({ breakerOpenUntil: at(15), activeTurns: 1 }, [account('b')])),
    ).toEqual({ kind: 'busy', retryAt: at(1) })
  })

  it('does not apply the new-task 10% filter to an existing task rebind', () => {
    expect(
      pickAccount(bound({ enabled: false }, [account('b', { limitWindows: [window('5h', 95)] })])),
    ).toEqual(selected('b', 'rebind'))
  })

  it('allows continued use after one rebind but sends a second rebind to the operator', () => {
    expect(pickAccount({ ...bound(), rebinds: 1 })).toEqual({
      ...selected('a', 'keep'),
      rebinds: 1,
    })
    expect(pickAccount({ ...bound({ enabled: false }, [account('b')]), rebinds: 1 })).toEqual({
      kind: 'operator',
      reason: 'rebind_limit',
    })
  })

  it.each([null, at(-24 * 60 + 1 / MINUTE), NOW, at(1)])(
    'holds a recent/unknown suspension (%s) even if another condition allows rebind',
    (healthChangedAt) => {
      expect(
        pickAccount(
          bound({ health: 'suspended', healthChangedAt, enabled: false }, [account('b')]),
        ),
      ).toEqual({
        kind: 'operator',
        reason: 'account_suspended',
      })
    },
  )

  it('permits the first rebind at exactly 24 hours after suspension', () => {
    expect(
      pickAccount(bound({ health: 'suspended', healthChangedAt: at(-24 * 60) }, [account('b')])),
    ).toEqual(selected('b', 'rebind'))
  })

  it('never spreads a policy-flagged task regardless of account and provider state', () => {
    expect(
      pickAccount({
        ...bound({ enabled: false }, [account('b')]),
        providerEnabled: false,
        policyFlagged: true,
      }),
    ).toEqual({
      kind: 'operator',
      reason: 'policy_flagged',
    })
    expect(pickAccount(input({ policyFlagged: true }))).toEqual({
      kind: 'operator',
      reason: 'policy_flagged',
    })
  })

  it('fails closed when the bound account is missing', () => {
    expect(pickAccount(input({ boundAccountId: 'missing' }))).toEqual({
      kind: 'operator',
      reason: 'binding_missing',
    })
  })
})

describe('pickAccount: unknown usage and exhausted pools', () => {
  it.each([
    null,
    [],
    [window('week', 0, 0)],
    [{ ...window('week', 100), resetsAt: null }],
    [{ ...window('5h', 100), resetsAt: null }],
    [window('5h', 0, 0)],
    [window('5h', 100, -1)],
    [window('5h', 0), window('month', 0, -1)],
  ])('never assumes unknown/stale windows provide headroom: %j', (limitWindows) => {
    expect(pickAccount(bound({ limitWindows }, [account('b')]))).toEqual({
      kind: 'wait',
      probeAccountIds: ['a'],
      reason: 'limits_unknown',
      retryAt: at(15),
    })
    expect(pickAccount(input({ accounts: [account('a', { limitWindows })] }))).toEqual({
      kind: 'wait',
      probeAccountIds: ['a'],
      reason: 'limits_unknown',
      retryAt: at(15),
    })
  })

  it.each([null, at(300)])(
    'requests a one-off probe after reset and accepts ample refreshed usage with reset %s',
    (resetsAt) => {
      const snapshot = bound({ limitWindows: [window('5h', 100, 0)] })
      expect(pickAccount(snapshot)).toEqual({
        kind: 'wait',
        reason: 'limits_unknown',
        retryAt: at(15),
        probeAccountIds: ['a'],
      })
      const afterProbe = {
        ...snapshot,
        accounts: [account('a', { limitWindows: [{ ...window('5h', 0), resetsAt }] })],
      }
      expect(pickAccount(afterProbe)).toEqual(selected('a', 'keep'))
      expect(snapshot.accounts[0]?.limitWindows).toEqual([window('5h', 100, 0)])
    },
  )

  it('accepts ample reported usage without reset dates in every window', () => {
    const limitWindows = [window('5h', 90), window('week', 95), window('month', 95)].map(
      (window) => ({ ...window, resetsAt: null }),
    )
    expect(pickAccount(input({ accounts: [account('a', { limitWindows })] }))).toEqual(selected())
    expect(pickAccount(bound({ limitWindows }))).toEqual(selected('a', 'keep'))
  })

  it('needs an unknown reset only below the applicable new-task or turn headroom threshold', () => {
    const limitWindows = [{ ...window('5h', 95), resetsAt: null }]
    expect(pickAccount(bound({ limitWindows }))).toEqual(selected('a', 'keep'))
    expect(pickAccount(input({ accounts: [account('a', { limitWindows })] }))).toEqual({
      kind: 'wait',
      reason: 'limits_unknown',
      retryAt: at(15),
      probeAccountIds: ['a'],
    })
    expect(
      pickAccount(
        bound({
          limitWindows: [
            window('5h', 0),
            {
              ...window('month', 95.001),
              resetsAt: null,
            },
          ],
        }),
      ),
    ).toEqual({
      kind: 'wait',
      reason: 'limits_unknown',
      retryAt: at(15),
      probeAccountIds: ['a'],
    })
  })

  it('selects a ready unbound candidate without probing stale alternatives', () => {
    expect(
      pickAccount(input({ accounts: [account('a', { limitWindows: null }), account('b')] })),
    ).toEqual(selected('b'))
  })

  it('requests only account ids for eligible candidates with unknown limits and a free slot', () => {
    const unknown = { limitWindows: null }
    const snapshot = input({
      accounts: [
        account('z', unknown),
        account('disabled', { ...unknown, enabled: false }),
        account('suspended', { ...unknown, health: 'suspended' }),
        account('banned', { ...unknown, status: 'banned' }),
        account('retired', { ...unknown, status: 'retired' }),
        account('retiring', { ...unknown, retireRequestedAt: NOW }),
        account('relogin', { ...unknown, health: 'needs_relogin' }),
        account('busy', { ...unknown, activeTurns: 1 }),
        account('a', unknown),
      ],
    })
    // The busy account is not probed, but its slot may free long before the 15-minute fallback.
    expect(pickAccount(snapshot)).toEqual({
      kind: 'wait',
      reason: 'limits_unknown',
      retryAt: at(1),
      probeAccountIds: ['a', 'z'],
    })
    expect(
      pickAccount({ ...snapshot, accounts: snapshot.accounts.filter(({ id }) => id !== 'busy') }),
    ).toEqual({
      kind: 'wait',
      reason: 'limits_unknown',
      retryAt: at(15),
      probeAccountIds: ['a', 'z'],
    })
    expect(pickAccount({ ...snapshot, providerEnabled: false })).toEqual({
      kind: 'wait',
      reason: 'provider_disabled',
      retryAt: at(15),
      probeAccountIds: [],
    })
  })

  it('retains a known blocking reset while requesting unknown usage on the bound account', () => {
    expect(pickAccount(bound({ limitWindows: null, coolingUntil: at(30) }))).toEqual({
      kind: 'wait',
      reason: 'limits_unknown',
      retryAt: at(30),
      probeAccountIds: ['a'],
    })
  })

  it('uses the unknown-account fallback before another account long cooldown', () => {
    expect(
      pickAccount(
        input({
          accounts: [account('a', { limitWindows: null }), account('b', { coolingUntil: at(60) })],
        }),
      ),
    ).toEqual({
      kind: 'wait',
      reason: 'limits_unknown',
      retryAt: at(15),
      probeAccountIds: ['a'],
    })
  })

  it('respects a known long blocking window even when another window is unknown', () => {
    expect(
      pickAccount(
        bound(
          { limitWindows: [{ ...window('5h', 100), resetsAt: null }, window('week', 96, 60)] },
          [account('b')],
        ),
      ),
    ).toEqual(selected('b', 'rebind'))
  })

  it('uses the earliest account recovery after each account clears all its blockers', () => {
    expect(
      pickAccount(
        input({
          accounts: [
            account('a', {
              coolingUntil: at(5),
              limitWindows: [window('5h', 100, 5), window('week', 96, 60)],
            }),
            account('b', { limitWindows: [window('5h', 100, 30), window('month', 96, 20)] }),
            account('disabled', { enabled: false, coolingUntil: at(1) }),
          ],
        }),
      ),
    ).toEqual({ kind: 'wait', probeAccountIds: [], reason: 'pool_empty', retryAt: at(30) })
  })

  it('waits 15 minutes for an unbound pool with no eligible account and no known reset', () => {
    for (const accounts of [[], [account('a', { enabled: false, activeTurns: 1 })]])
      expect(pickAccount(input({ accounts }))).toEqual({
        kind: 'wait',
        probeAccountIds: [],
        reason: 'pool_empty',
        retryAt: at(15),
      })
  })

  it('returns busy for 60 seconds when the only obstacle of an unbound task is occupied slots', () => {
    const busy = { kind: 'busy', retryAt: at(1) }
    expect(pickAccount(input({ accounts: [account('a', { activeTurns: 1 })] }))).toEqual(busy)
    expect(
      pickAccount(
        input({
          accounts: [
            account('a', { activeTurns: 1 }),
            account('b', { activeTurns: 2, maxConcurrentTurns: 2 }),
          ],
        }),
      ),
    ).toEqual(busy)
  })

  it.each([[null], [[]], [[window('5h', 20, 0), window('week', 40, 5_000)]]])(
    'treats a busy account with unknown usage %j as busy: it is probed once its slot is free',
    (limitWindows) => {
      const occupied = account('a', { activeTurns: 1, limitWindows })
      expect(pickAccount(input({ accounts: [occupied] }))).toEqual({
        kind: 'busy',
        retryAt: at(1),
      })
      expect(
        pickAccount(
          input({ accounts: [occupied, account('b', { coolingUntil: at(4 * 24 * 60) })] }),
        ),
      ).toEqual({ kind: 'busy', retryAt: at(1) })
      expect(pickAccount(input({ accounts: [{ ...occupied, activeTurns: 0 }] }))).toEqual({
        kind: 'wait',
        probeAccountIds: ['a'],
        reason: 'limits_unknown',
        retryAt: at(15),
      })
    },
  )

  it('never waits for another account distant reset while a ready account is only busy', () => {
    const weekly = {
      coolingUntil: at(4 * 24 * 60 + 1),
      limitWindows: [window('week', 100, 4 * 24 * 60)],
    }
    expect(
      pickAccount(input({ accounts: [account('a', { activeTurns: 1 }), account('b', weekly)] })),
    ).toEqual({ kind: 'busy', retryAt: at(1) })
    const rebinding = bound({ enabled: false }, [
      account('b', { activeTurns: 1 }),
      account('c', weekly),
    ])
    const original = structuredClone(rebinding)
    expect(pickAccount(rebinding)).toEqual({ kind: 'busy', retryAt: at(1) })
    expect(rebinding).toEqual(original)
    expect(
      pickAccount({ ...rebinding, accounts: [account('a', { enabled: false }), account('b')] }),
    ).toEqual(selected('b', 'rebind'))
  })

  it('does not report busy for an account that stays blocked after its slot frees', () => {
    expect(
      pickAccount(input({ accounts: [account('a', { activeTurns: 1, coolingUntil: at(120) })] })),
    ).toEqual({ kind: 'wait', probeAccountIds: [], reason: 'pool_empty', retryAt: at(120) })
    // A new task skips accounts below the 10% five-hour reserve even when their slot frees.
    expect(
      pickAccount(
        input({ accounts: [account('a', { activeTurns: 1, limitWindows: [window('5h', 95)] })] }),
      ),
    ).toEqual({ kind: 'wait', probeAccountIds: [], reason: 'pool_empty', retryAt: at(120) })
    expect(
      pickAccount(
        input({
          accounts: [account('a', { activeTurns: 1, limitWindows: null, breakerOpenUntil: at(9) })],
        }),
      ),
    ).toEqual({ kind: 'wait', probeAccountIds: [], reason: 'pool_empty', retryAt: at(9) })
  })

  it('still probes an unknown free account next to a busy one, with the short retry as fallback', () => {
    expect(
      pickAccount(
        input({
          accounts: [account('a', { activeTurns: 1 }), account('b', { limitWindows: null })],
        }),
      ),
    ).toEqual({ kind: 'wait', probeAccountIds: ['b'], reason: 'limits_unknown', retryAt: at(1) })
  })

  it('retries an unbound task when the usage breaker closes, not after the 15-minute fallback', () => {
    expect(pickAccount(input({ accounts: [account('a', { breakerOpenUntil: at(2) })] }))).toEqual({
      kind: 'wait',
      probeAccountIds: [],
      reason: 'pool_empty',
      retryAt: at(2),
    })
    expect(
      pickAccount(
        input({
          accounts: [
            account('a', { breakerOpenUntil: at(9), coolingUntil: at(3) }),
            account('b', { coolingUntil: at(7) }),
          ],
        }),
      ),
    ).toEqual({ kind: 'wait', probeAccountIds: [], reason: 'pool_empty', retryAt: at(7) })
  })

  it('requests unknown usage behind an open breaker like behind a cooldown', () => {
    const waiting = {
      kind: 'wait',
      probeAccountIds: ['a'],
      reason: 'limits_unknown',
      retryAt: at(2),
    }
    const overrides = { limitWindows: null, breakerOpenUntil: at(2) }
    expect(pickAccount(input({ accounts: [account('a', overrides)] }))).toEqual(waiting)
    expect(pickAccount(bound(overrides, [account('b')]))).toEqual(waiting)
  })

  it('keeps the current binding/count if no replacement is ready, then re-evaluates fresh state', () => {
    const snapshot = bound({ coolingUntil: at(60) })
    const original = structuredClone(snapshot)
    expect(pickAccount(snapshot)).toEqual({
      kind: 'wait',
      probeAccountIds: [],
      reason: 'pool_empty',
      retryAt: at(60),
    })
    expect(snapshot).toEqual(original)
    expect(pickAccount({ ...snapshot, now: at(60) })).toEqual(selected('a', 'keep'))
  })

  it('proposes a rebind without mutating caller state, so failed issue transactions can retry', () => {
    const snapshot = bound({ enabled: false }, [account('b')])
    const original = structuredClone(snapshot)
    Object.freeze(snapshot.accounts)
    Object.freeze(snapshot)
    const first = pickAccount(snapshot)
    expect(first).toEqual(selected('b', 'rebind'))
    expect(snapshot).toEqual(original)
    expect(pickAccount(snapshot)).toEqual(first)
    const committed = { ...snapshot, boundAccountId: 'b', rebinds: 1 }
    expect(pickAccount(committed)).toEqual({ ...selected('b', 'keep'), rebinds: 1 })
  })

  it('does not return input Date references that a caller could mutate', () => {
    const snapshot = bound({ coolingUntil: at(10) })
    const result = pickAccount(snapshot)
    if (result.kind !== 'wait') throw new Error('Expected wait')
    result.retryAt.setTime(0)
    expect(snapshot.accounts[0]?.coolingUntil).toEqual(at(10))
  })
})

describe('pickAccount: a backend without windows', () => {
  // The pay-per-token API: an account is limited by its pauses and slots, never by windows.
  const windowless = (overrides: Partial<PickAccountInput> = {}) =>
    input({ backend: 'zai-api', capacity: 'none', ...overrides })
  const apiAccount = (id = 'a', overrides: Partial<PoolAccountSnapshot> = {}) =>
    account(id, { backend: 'zai-api', limitWindows: [], ...overrides })

  it.each([
    null,
    [],
    // Whatever a column holds, it is no report of this backend.
    [window('5h', 100)],
    [{ ...window('week', 100), resetsAt: null }],
    [window('5h', 0, -1)],
  ])('selects an account with windows %j and asks for no probe', (limitWindows) => {
    expect(pickAccount(windowless({ accounts: [apiAccount('a', { limitWindows })] }))).toEqual(
      selected(),
    )
    expect(
      pickAccount(
        windowless({ boundAccountId: 'a', accounts: [apiAccount('a', { limitWindows })] }),
      ),
    ).toEqual(selected('a', 'keep'))
  })

  it('reads the same empty windows as unknown usage on a backend that has them', () => {
    expect(pickAccount(input({ accounts: [account('a', { limitWindows: [] })] }))).toMatchObject({
      kind: 'wait',
      reason: 'limits_unknown',
      probeAccountIds: ['a'],
    })
  })

  it('waits out a pause of the account, without a probe', () => {
    for (const pause of [{ coolingUntil: at(30) }, { breakerOpenUntil: at(15) }]) {
      const until = pause.coolingUntil ?? pause.breakerOpenUntil
      expect(pickAccount(windowless({ accounts: [apiAccount('a', pause)] }))).toEqual({
        kind: 'wait',
        reason: 'pool_empty',
        retryAt: until,
        probeAccountIds: [],
      })
      expect(
        pickAccount(windowless({ boundAccountId: 'a', accounts: [apiAccount('a', pause)] })),
      ).toEqual({ kind: 'wait', reason: 'cooling', retryAt: until, probeAccountIds: [] })
    }
    // A pause that has passed blocks nothing: there are no windows to refresh first.
    expect(
      pickAccount(windowless({ accounts: [apiAccount('a', { coolingUntil: at(-1) })] })),
    ).toEqual(selected())
  })

  it('rebinds a task whose account is paused longer than a bound task waits', () => {
    expect(
      pickAccount(
        windowless({
          boundAccountId: 'a',
          accounts: [apiAccount('a', { coolingUntil: at(60) }), apiAccount('b')],
        }),
      ),
    ).toEqual(selected('b', 'rebind'))
  })

  it('takes the least recently used free account and keeps slots and health as they are', () => {
    expect(
      pickAccount(
        windowless({
          accounts: [
            apiAccount('busy', { activeTurns: 1 }),
            apiAccount('relogin', { health: 'needs_relogin' }),
            apiAccount('newer', { lastUsedAt: at(-1) }),
            apiAccount('older', { lastUsedAt: at(-60) }),
          ],
        }),
      ),
    ).toEqual(selected('older'))
    expect(pickAccount(windowless({ accounts: [apiAccount('a', { activeTurns: 1 })] }))).toEqual({
      kind: 'busy',
      retryAt: at(1),
    })
  })

  it('never takes an account of another backend', () => {
    expect(pickAccount(windowless({ accounts: [account('a')] }))).toEqual({
      kind: 'wait',
      reason: 'pool_empty',
      retryAt: at(15),
      probeAccountIds: [],
    })
  })
})

describe('pickAccount: boundary validation', () => {
  it.each([
    { now: new Date('invalid') },
    { now: new Date(8.64e15) },
    { now: NOW.toISOString() },
    { rebinds: NaN },
    { rebinds: -1 },
    { rebinds: 2 },
    { rebinds: 0.5 },
    { rebinds: null },
    { rebinds: 1, boundAccountId: null },
    { policyFlagged: null },
    { providerEnabled: null },
    { minTurnHeadroomPct: NaN },
    { minTurnHeadroomPct: Infinity },
    { minTurnHeadroomPct: 0 },
    { minTurnHeadroomPct: 101 },
    { minTurnHeadroomPct: null },
    { backend: 'unknown' },
    // Never defaulted: every caller states what its backend declares.
    { capacity: undefined },
    { capacity: 'balance' },
    { capacity: null },
  ])('rejects malformed task snapshots: %j', (overrides) => {
    expect(() => pickAccount({ ...input(), ...overrides } as never)).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
  })

  it.each([
    { activeTurns: NaN },
    { activeTurns: null },
    { activeTurns: -1 },
    { activeTurns: 0.5 },
    { activeTurns: Number.MAX_SAFE_INTEGER + 1 },
    { maxConcurrentTurns: 0 },
    { maxConcurrentTurns: Infinity },
    { enabled: null },
    { health: null },
    { status: 'cooling' },
    { healthChangedAt: new Date('invalid') },
    { lastUsedAt: new Date('invalid') },
    { coolingUntil: undefined },
    { coolingUntil: at(1).toISOString() },
    { breakerOpenUntil: new Date('invalid') },
    { limitWindows: [window('5h', NaN)] },
    { limitWindows: [window('5h', Infinity)] },
    { limitWindows: [window('5h', -1)] },
    { limitWindows: [window('5h', 101)] },
    { limitWindows: [{ ...window('5h', 0), usedPct: null }] },
    { limitWindows: [{ ...window('5h', 0), resetsAt: new Date('invalid') }] },
    { limitWindows: [window('5h', 0), window('5h', 1)] },
  ])('rejects malformed account snapshots instead of making them eligible: %j', (overrides) => {
    expect(() =>
      pickAccount(input({ accounts: [{ ...account(), ...overrides } as never] })),
    ).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }))
  })

  it('rejects duplicate ids instead of depending on database row order', () => {
    expect(() =>
      pickAccount(input({ accounts: [account(), account('a', { enabled: false })] })),
    ).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }))
  })
})
