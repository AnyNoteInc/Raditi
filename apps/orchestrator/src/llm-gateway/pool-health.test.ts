import type { PrismaClient } from '@repo/db'
import type { EgressHttp, LlmBackend, ProbeResult } from '@repo/domain'
import { zaiCodingBackend } from '@repo/llm-backends'
import { describe, expect, it, vi } from 'vitest'

import { SubscriptionPoolHealth } from './pool-health.ts'
import type { PoolHealthAccount, PoolHealthStore } from './pool-health-store.ts'
import type { GatewayCall, GatewayFinish } from './types.ts'

const account: PoolHealthAccount = {
  accountId: 'synthetic-account',
  backendId: zaiCodingBackend.id,
  credentialRef: `subs/${zaiCodingBackend.id}/synthetic-account`,
  credentialVersion: 1,
  limitsSeenAt: null,
  windowsKnown: false,
}
const probe = (status: ProbeResult['status'] = 'ok'): ProbeResult => ({
  status,
  windows: status === 'ok' ? [{ name: 'week', usedPct: 10, resetsAt: null }] : null,
  plan: null,
})
const call = (id = 'call-1', startedAt = new Date(0)): GatewayCall =>
  ({
    id,
    accountId: account.accountId,
    startedAt,
  }) as GatewayCall
const finish = (signal?: GatewayFinish['signal'], upstreamStatus?: number): GatewayFinish => ({
  state: signal && signal.kind !== 'ok' ? 'failed' : 'completed',
  estimated: false,
  billable: true,
  estimateReason: null,
  usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 },
  responseBytes: 1,
  ...(signal === undefined ? {} : { signal }),
  ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
})

function harness(backend: Partial<LlmBackend> = {}) {
  let now = 0
  const store = {
    account: vi.fn<PoolHealthStore['account']>().mockResolvedValue(account),
    probe: vi.fn<PoolHealthStore['probe']>().mockResolvedValue({ applied: true, alert: null }),
    cool: vi.fn<PoolHealthStore['cool']>().mockResolvedValue(),
    payment: vi
      .fn<PoolHealthStore['payment']>()
      .mockResolvedValue({ count: 1, suspended: false, at: new Date(0) }),
  }
  const backendProbe = vi.fn<typeof zaiCodingBackend.probe>().mockResolvedValue(probe())
  const http = { request: vi.fn<EgressHttp['request']>() }
  const regionHttp = { request: vi.fn<EgressHttp['request']>() }
  const credentials = { get: vi.fn().mockResolvedValue({ synthetic: 'credential' }) }
  const channelHealthy = vi.fn().mockReturnValue(true)
  const onRegion = vi.fn()
  const logger = { warn: vi.fn() }
  const health = new SubscriptionPoolHealth({
    prisma: {} as PrismaClient,
    store,
    backends: [{ ...zaiCodingBackend, probe: backendProbe, ...backend }],
    credentials,
    http,
    regionHttp,
    channelHealthy,
    onRegion,
    logger,
    now: () => now,
  })
  return {
    health,
    store,
    backendProbe,
    credentials,
    http,
    regionHttp,
    channelHealthy,
    onRegion,
    logger,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('subscription pool health coordination', () => {
  it('escalates transient pauses, limits CLI delay and ignores repeated observation', async () => {
    const h = harness()
    const transient = finish({ kind: 'transient', retryAfterMs: 30_000 }, 503)
    await h.health.observe(call('1'), transient)
    await h.health.observe(call('1'), transient)
    expect(h.health.pause(account.accountId)).toEqual({ reason: 'transient', retryAfterMs: 30_000 })
    h.advance(30_000)
    expect(h.health.pause(account.accountId)).toBeNull()
    await h.health.observe(call('2'), transient)
    h.advance(30_000)
    expect(h.health.pause(account.accountId)).toEqual({ reason: 'transient', retryAfterMs: 30_000 })
    h.advance(30_000)
    expect(h.health.pause(account.accountId)).toBeNull()
    await h.health.observe(call('3'), transient)
    h.advance(119_999)
    expect(h.health.pause(account.accountId)?.retryAfterMs).toBe(1)
    await h.health.observe(call('4'), finish({ kind: 'ok' }, 200))
    expect(h.health.pause(account.accountId)).toBeNull()
    expect(h.backendProbe).not.toHaveBeenCalled()
  })

  it.each([
    [1, 5],
    [2, 15],
    [3, 45],
  ] as const)('uses persisted 402 count %s for a %s-minute pause', async (count, minutes) => {
    const h = harness()
    h.store.payment.mockResolvedValue({ count, suspended: count >= 3, at: new Date(0) })
    await h.health.observe(call(), finish({ kind: 'transient', retryAfterMs: 300_000 }, 402))
    h.advance(minutes * 60_000 - 1)
    expect(h.health.pause(account.accountId)?.retryAfterMs).toBe(1)
    h.advance(1)
    expect(h.health.pause(account.accountId)).toBeNull()
    expect(h.store.payment).toHaveBeenCalledExactlyOnceWith(account.accountId)
    expect(h.backendProbe).not.toHaveBeenCalled()
    if (count >= 3)
      expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('payment_pending'))
  })

  it('a payment pause is lifted only by a success that started after the 402', async () => {
    const h = harness()
    const seen = new Date('2026-09-30T12:00:00Z')
    h.store.payment.mockResolvedValue({ count: 1, suspended: false, at: seen })
    await h.health.observe(call('402'), finish({ kind: 'transient', retryAfterMs: 1 }, 402))
    await h.health.observe(call('old', new Date(+seen - 1)), finish({ kind: 'ok' }, 200))
    expect(h.health.pause(account.accountId)).toEqual({ reason: 'transient', retryAfterMs: 30_000 })
    await h.health.observe(call('new', new Date(+seen + 1)), finish({ kind: 'ok' }, 200))
    expect(h.health.pause(account.accountId)).toBeNull()
  })

  it.each(['auth', 'account_risk', 'region', 'unconfirmed_block'] as const)(
    'confirms %s using a coalesced probe',
    async (kind) => {
      const h = harness()
      const signal = kind === 'account_risk' ? ({ kind, reason: 'risk' } as const) : { kind }
      await Promise.all([
        h.health.observe(call('1'), finish(signal, 403)),
        h.health.observe(call('2'), finish(signal, 403)),
      ])
      expect(h.backendProbe).toHaveBeenCalledTimes(1)
      expect(h.store.probe).toHaveBeenCalledExactlyOnceWith(account, probe())
      expect(h.onRegion).not.toHaveBeenCalled()
    },
  )

  it('coalesces the same account and observes the five-minute interval', async () => {
    const h = harness()
    await Promise.all([
      h.health.probeAccount(account.accountId),
      h.health.probeAccount(account.accountId),
    ])
    h.advance(299_999)
    await h.health.probeAccount(account.accountId)
    expect(h.backendProbe).toHaveBeenCalledTimes(1)
    h.advance(1)
    await h.health.probeAccount(account.accountId)
    expect(h.backendProbe).toHaveBeenCalledTimes(2)
  })

  it('a refresh of an old snapshot is no confirmation of a signal that comes after it', async () => {
    const h = harness()
    // A key was issued on an old snapshot: one refresh, and the provider answers as before.
    await h.health.refreshAccount(account.accountId)
    expect(h.backendProbe).toHaveBeenCalledTimes(1)
    // Seconds later the provider refuses the plan key: the refresh says nothing about that.
    h.advance(3_000)
    h.backendProbe.mockResolvedValue(probe('auth'))
    await h.health.observe(call('1'), finish({ kind: 'auth' }, 401))
    expect(h.backendProbe).toHaveBeenCalledTimes(2)
    expect(h.store.probe).toHaveBeenLastCalledWith(account, probe('auth'))
    // The confirming probe answers the signals of its five minutes and bounds the next refresh.
    h.advance(60_000)
    await h.health.observe(call('2'), finish({ kind: 'auth' }, 401))
    await h.health.refreshAccount(account.accountId)
    expect(h.backendProbe).toHaveBeenCalledTimes(2)
    h.advance(240_000)
    await h.health.refreshAccount(account.accountId)
    expect(h.backendProbe).toHaveBeenCalledTimes(3)
  })

  it('a probe for unknown windows bounds a refresh and confirms no later signal', async () => {
    const h = harness()
    await h.health.probeAccount(account.accountId, {})
    h.advance(3_000)
    await h.health.refreshAccount(account.accountId)
    expect(h.backendProbe).toHaveBeenCalledTimes(1)
    await h.health.observe(call('1'), finish({ kind: 'region' }, 403))
    expect(h.backendProbe).toHaveBeenCalledTimes(2)
    // Signals closing together still share the one probe they started.
    const h2 = harness()
    await h2.health.refreshAccount(account.accountId)
    await Promise.all([
      h2.health.observe(call('1'), finish({ kind: 'auth' }, 401)),
      h2.health.observe(call('2'), finish({ kind: 'auth' }, 401)),
    ])
    expect(h2.backendProbe).toHaveBeenCalledTimes(2)
  })

  it('a probe for the windows does not end the five minutes of the confirming probe before it', async () => {
    const h = harness()
    const signal = (id: string) => h.health.observe(call(id), finish({ kind: 'auth' }, 401))
    await signal('1')
    expect(h.backendProbe).toHaveBeenCalledTimes(1)
    // Twenty seconds later the windows are read as unknown: a probe of its own kind.
    h.advance(20_000)
    await h.health.probeAccount(account.accountId, {})
    expect(h.backendProbe).toHaveBeenCalledTimes(2)
    // The signal after it is still answered by the confirming probe of 21 seconds ago.
    h.advance(1_000)
    await signal('2')
    expect(h.backendProbe).toHaveBeenCalledTimes(2)
    h.advance(278_999)
    await signal('3')
    expect(h.backendProbe).toHaveBeenCalledTimes(2)
    // Five minutes after the confirming probe the next signal is confirmed anew.
    h.advance(1)
    await signal('4')
    expect(h.backendProbe).toHaveBeenCalledTimes(3)
  })

  it('a probe after cleared windows does not end those five minutes either', async () => {
    const h = harness()
    await h.health.observe(call('1'), finish({ kind: 'account_risk', reason: 'risk' }, 403))
    expect(h.backendProbe).toHaveBeenCalledTimes(1)
    h.advance(1_000)
    await h.health.observe(call('2'), finish({ kind: 'window_exhausted', until: null }, 429))
    expect(h.backendProbe).toHaveBeenCalledTimes(2)
    h.advance(1_000)
    await h.health.observe(call('3'), finish({ kind: 'account_risk', reason: 'risk' }, 403))
    expect(h.backendProbe).toHaveBeenCalledTimes(2)
  })

  it('a remembered region answer closes egress again after a probe for the windows', async () => {
    const h = harness()
    h.backendProbe.mockResolvedValueOnce(probe('region'))
    await h.health.observe(call('1'), finish({ kind: 'region' }, 403))
    h.advance(20_000)
    await h.health.probeAccount(account.accountId, {})
    h.advance(1_000)
    await h.health.observe(call('2'), finish({ kind: 'region' }, 403))
    expect(h.backendProbe).toHaveBeenCalledTimes(2)
    expect(h.onRegion.mock.calls).toEqual([[account.accountId], [account.accountId]])
  })

  it('a refresh shares a probe in flight, whatever it was sent for', async () => {
    const h = harness()
    let answer: (result: ProbeResult) => void = () => {}
    h.backendProbe.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const confirming = h.health.observe(call('1'), finish({ kind: 'auth' }, 401))
    const refresh = h.health.refreshAccount(account.accountId)
    await vi.waitFor(() => expect(h.backendProbe).toHaveBeenCalledTimes(1))
    answer(probe())
    await Promise.all([confirming, refresh])
    expect(h.backendProbe).toHaveBeenCalledTimes(1)
  })

  describe('a probe asked for because the windows are unknown', () => {
    const at = (ms: number) => new Date(Date.UTC(2026, 9, 3) + ms)
    /** The durable state as admission reads it: the windows and when they were last written. */
    function durable(h: ReturnType<typeof harness>) {
      const state = { windows: [] as unknown[], limitsSeenAt: null as Date | null, clock: 0 }
      h.store.probe.mockImplementation(async (_account, result) => {
        state.windows = result.windows ?? []
        state.limitsSeenAt = at(state.clock)
        return { applied: true, alert: null, limitsSeenAt: state.limitsSeenAt }
      })
      const advance = (ms: number) => {
        state.clock += ms
        h.advance(ms)
      }
      return { state, advance }
    }

    it('is repeated at once for a turn whose windows were cleared after the remembered one', async () => {
      const h = harness()
      const { state, advance } = durable(h)
      // t=0: issue probes the account, its windows become known.
      await h.health.probeAccount(account.accountId, {})
      expect(state.windows).toHaveLength(1)
      // t=10 s: a response with an unreadable report clears them.
      advance(10_000)
      state.windows = []
      state.limitsSeenAt = at(state.clock)
      // t=11 s: admission of the running turn reads them as unknown and asks for a probe.
      advance(1_000)
      await h.health.probeAccount(account.accountId, { limitsSeenAt: state.limitsSeenAt })
      expect(h.backendProbe).toHaveBeenCalledTimes(2)
      expect(state.windows).toHaveLength(1)
      // A caller that read the state this probe left is served from memory.
      await h.health.probeAccount(account.accountId, { limitsSeenAt: state.limitsSeenAt })
      // So is one whose read is older than the probe: its next admission sees the new state.
      await h.health.probeAccount(account.accountId, { limitsSeenAt: at(10_000) })
      expect(h.backendProbe).toHaveBeenCalledTimes(2)
    })

    it('that left them unknown is repeated after twenty seconds, not five minutes', async () => {
      const h = harness()
      const { state, advance } = durable(h)
      h.backendProbe.mockResolvedValue(probe('unknown'))
      await h.health.probeAccount(account.accountId, { limitsSeenAt: null })
      advance(19_999)
      await h.health.probeAccount(account.accountId, { limitsSeenAt: state.limitsSeenAt })
      await h.health.probeAccount(account.accountId, {})
      expect(h.backendProbe).toHaveBeenCalledTimes(1)
      advance(1)
      await h.health.probeAccount(account.accountId, { limitsSeenAt: state.limitsSeenAt })
      expect(h.backendProbe).toHaveBeenCalledTimes(2)
      // A request signal is confirmed by a probe of its own: both of these were sent for the
      // windows, before whatever the provider refused afterwards.
      advance(60_000)
      await h.health.probeAccount(account.accountId)
      expect(h.backendProbe).toHaveBeenCalledTimes(3)
      // That confirmation keeps the five-minute interval.
      advance(60_000)
      await h.health.probeAccount(account.accountId)
      expect(h.backendProbe).toHaveBeenCalledTimes(3)
    })

    it('shares a probe in flight and bounds repeats of one that failed', async () => {
      const h = harness()
      const answer = Promise.withResolvers<ProbeResult>()
      h.backendProbe.mockReturnValueOnce(answer.promise)
      const first = h.health.probeAccount(account.accountId, { limitsSeenAt: at(0) })
      const second = h.health.probeAccount(account.accountId, { limitsSeenAt: at(5_000) })
      answer.reject(new Error('synthetic transport failure'))
      expect(await Promise.all([first, second])).toEqual([null, null])
      expect(h.backendProbe).toHaveBeenCalledTimes(1)
      // Nothing was applied: a newer snapshot proves nothing against it, the floor still holds.
      h.advance(19_999)
      await h.health.probeAccount(account.accountId, { limitsSeenAt: at(10_000) })
      expect(h.backendProbe).toHaveBeenCalledTimes(1)
      h.advance(1)
      await h.health.probeAccount(account.accountId, { limitsSeenAt: at(10_000) })
      expect(h.backendProbe).toHaveBeenCalledTimes(2)
    })

    it('asks afresh for the reset of an exhausted window the store has just cleared', async () => {
      const h = harness()
      const { advance } = durable(h)
      // A probe answered seconds before the exhaustion: it shows spare capacity and no reset.
      await h.health.probeAccount(account.accountId, {})
      advance(5_000)
      const until = new Date('2026-10-03T12:00:00Z')
      h.backendProbe.mockResolvedValue({
        ...probe(),
        windows: [{ name: 'week', usedPct: 100, resetsAt: until }],
      })
      await h.health.observe(call(), finish({ kind: 'window_exhausted', until: null }, 429))
      expect(h.backendProbe).toHaveBeenCalledTimes(2)
      expect(h.store.cool).toHaveBeenLastCalledWith(account.accountId, until, 'week')
    })

    it('shares one probe between exhausted responses that close together', async () => {
      const h = harness()
      const answer = Promise.withResolvers<ProbeResult>()
      h.backendProbe.mockReturnValueOnce(answer.promise)
      const exhausted = finish({ kind: 'window_exhausted', until: null }, 429)
      const both = Promise.all([
        h.health.observe(call('1'), exhausted),
        h.health.observe(call('2'), exhausted),
      ])
      await vi.waitFor(() => expect(h.backendProbe).toHaveBeenCalled())
      answer.resolve(probe())
      await both
      expect(h.backendProbe).toHaveBeenCalledTimes(1)
      expect(h.store.cool.mock.calls).toEqual([
        [account.accountId, null],
        [account.accountId, null],
      ])
    })
  })

  it('does not close the channel for unknown or stale credential probes', async () => {
    const h = harness()
    h.backendProbe.mockResolvedValue(probe('unknown'))
    await h.health.observe(call(), finish({ kind: 'region' }, 403))
    expect(h.onRegion).not.toHaveBeenCalled()
    h.advance(300_000)
    h.backendProbe.mockResolvedValue(probe('region'))
    h.store.probe.mockResolvedValue({ applied: false, alert: null })
    expect(await h.health.probeAccount(account.accountId)).toBeNull()
    expect(h.onRegion).not.toHaveBeenCalled()
  })

  it('closes the channel only after a confirmed region probe', async () => {
    const h = harness()
    h.backendProbe.mockResolvedValue(probe('region'))
    await h.health.observe(call(), finish({ kind: 'unconfirmed_block' }, 403))
    expect(h.onRegion).toHaveBeenCalledExactlyOnceWith(account.accountId)
  })

  it('confirms the region block again from a remembered region probe', async () => {
    const h = harness()
    h.backendProbe.mockResolvedValue(probe('region'))
    await h.health.observe(call('1'), finish({ kind: 'region' }, 403))
    h.advance(60_000)
    await h.health.observe(call('2'), finish({ kind: 'region' }, 403))
    expect(h.backendProbe).toHaveBeenCalledOnce()
    expect(h.onRegion.mock.calls).toEqual([[account.accountId], [account.accountId]])
  })

  it.each([
    ['ok', true],
    ['auth', true],
    ['suspended', true],
    ['unknown', true],
    ['region', false],
  ] as const)(
    'rechecks a region block through the reachable channel; a %s answer lifts it: %s',
    async (status, lifted) => {
      const h = harness()
      h.channelHealthy.mockReturnValue(false)
      h.backendProbe.mockImplementation(async (_credential, http) => {
        await http.request(
          {
            method: 'GET',
            url: 'https://api.z.ai/api/monitor/usage/quota/limit',
            headers: new Headers(),
          },
          { signal: new AbortController().signal },
        )
        return probe(status)
      })
      expect(await h.health.recheckRegion(account.accountId)).toBe(lifted)
      expect(h.regionHttp.request).toHaveBeenCalledOnce()
      expect(h.http.request).not.toHaveBeenCalled()
      expect(h.store.probe).toHaveBeenCalledOnce()
      expect(h.onRegion.mock.calls).toEqual(lifted ? [] : [[account.accountId]])
      // The recheck counts as the account's probe for the five-minute interval.
      h.channelHealthy.mockReturnValue(true)
      await h.health.probeAccount(account.accountId)
      expect(h.backendProbe).toHaveBeenCalledOnce()
    },
  )

  it('keeps the region block when its recheck brings no applied provider answer', async () => {
    const h = harness()
    h.backendProbe.mockRejectedValueOnce(new Error('synthetic transport failure'))
    expect(await h.health.recheckRegion(account.accountId)).toBe(false)
    h.backendProbe.mockResolvedValue(probe('ok'))
    h.store.probe.mockResolvedValue({ applied: false, alert: null })
    expect(await h.health.recheckRegion(account.accountId)).toBe(false)
    expect(h.logger.warn.mock.calls.flat().join('\n')).not.toMatch(/region_recheck_unavailable/)
    // The confirming account can no longer be probed (revoked, deleted, no credential): the
    // block stays, and the operator is told why rather than seeing a silent closed egress.
    h.store.account.mockResolvedValue(null)
    expect(await h.health.recheckRegion(account.accountId)).toBe(false)
    expect(h.logger.warn).toHaveBeenLastCalledWith(
      JSON.stringify({ event: 'llm_pool_health', reason: 'region_recheck_unavailable' }),
    )
    expect(h.logger.warn.mock.calls.flat().join('\n')).not.toContain(account.accountId)
    // An ordinary probe of an unreadable account stays silent: only the recheck depends on it.
    h.logger.warn.mockClear()
    h.advance(5 * 60_000)
    expect(await h.health.probeAccount(account.accountId)).toBeNull()
    expect(h.logger.warn).not.toHaveBeenCalled()
    await h.health.close()
    expect(await h.health.recheckRegion(account.accountId)).toBe(false)
  })

  it('does not probe content/profile failures or an unhealthy channel', async () => {
    const h = harness()
    await h.health.observe(call('1'), finish({ kind: 'policy_flagged', code: 'synthetic' }, 400))
    await h.health.observe(call('2'), finish({ kind: 'profile', code: 'synthetic' }, 401))
    await h.health.observe(call('3'), finish({ kind: 'request_rejected', code: 'synthetic' }, 400))
    expect(h.health.pause(account.accountId)).toBeNull()
    h.channelHealthy.mockReturnValue(false)
    expect(await h.health.probeAccount(account.accountId)).toBeNull()
    expect(h.backendProbe).not.toHaveBeenCalled()
    expect(h.store.account).not.toHaveBeenCalled()
  })

  it('uses a known exhausted window reset, falling back to an hour when unknown', async () => {
    const h = harness()
    const until = new Date('2026-09-30T12:00:00Z')
    h.backendProbe.mockResolvedValue({
      ...probe(),
      windows: [{ name: 'week', usedPct: 100, resetsAt: until }],
    })
    await h.health.observe(call(), finish({ kind: 'window_exhausted', until: null }, 403))
    expect(h.store.cool).toHaveBeenLastCalledWith(account.accountId, until, 'week')
    h.advance(300_000)
    h.backendProbe.mockResolvedValue(probe('unknown'))
    await h.health.observe(call('2'), finish({ kind: 'window_exhausted', until: null }, 403))
    expect(h.store.cool).toHaveBeenLastCalledWith(account.accountId, null)
  })

  it('cools until the latest reset among exhausted windows, bounded by that window', async () => {
    const h = harness()
    const hours = new Date('2026-09-30T12:00:00Z')
    const month = new Date('2026-10-20T00:00:00Z')
    h.backendProbe.mockResolvedValue({
      ...probe(),
      windows: [
        { name: '5h', usedPct: 100, resetsAt: hours },
        { name: 'month', usedPct: 100, resetsAt: month },
        { name: 'week', usedPct: 40, resetsAt: new Date('2026-12-01T00:00:00Z') },
      ],
    })
    await h.health.observe(call(), finish({ kind: 'window_exhausted', until: null }, 403))
    expect(h.store.cool).toHaveBeenLastCalledWith(account.accountId, month, 'month')
    // A reset the signal itself names has no window: the store bounds it by the weekly horizon.
    await h.health.observe(call('2'), finish({ kind: 'window_exhausted', until: hours }, 429))
    expect(h.store.cool).toHaveBeenLastCalledWith(account.accountId, hours)
  })

  it('alerts only safe codes and preserves errors as opaque', async () => {
    const h = harness()
    h.credentials.get.mockRejectedValue(new Error('private synthetic token'))
    expect(await h.health.probeAccount(account.accountId)).toBeNull()
    expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith(
      '{"event":"llm_pool_health","reason":"probe_failed"}',
    )
    expect(h.store.probe).not.toHaveBeenCalled()
  })

  it('maintenance never polls usage and shutdown stops new observations', async () => {
    const h = harness()
    await h.health.tick()
    h.advance(600_000)
    await h.health.tick()
    expect(h.backendProbe).not.toHaveBeenCalled()
    await h.health.close()
    await h.health.observe(call(), finish({ kind: 'auth' }, 401))
    expect(await h.health.probeAccount(account.accountId)).toBeNull()
    expect(h.backendProbe).not.toHaveBeenCalled()
  })
})
