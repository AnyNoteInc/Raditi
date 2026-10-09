import { z } from 'zod'

import { badRequest } from '../errors.ts'
import { limitWindowsSchema, llmBackendIdSchema } from '../ports/llm-backend.ts'

export const poolPolicy = Object.freeze({
  minTurnHeadroomPct: 5,
  newTaskFiveHourHeadroomPct: 10,
  // A window snapshot older than this is refreshed by one probe before a key is issued and
  // before the first call of a key. Its age alone closes nothing.
  windowsFreshMs: 10 * 60_000,
  busyRetryMs: 60_000,
  unknownRetryMs: 15 * 60_000,
  boundWaitMs: 45 * 60_000,
  suspendedHoldMs: 24 * 60 * 60_000,
  maxRebinds: 1,
})

/** A snapshot from the issuing transaction, including unavailable bound accounts. */
export const poolAccountSnapshotSchema = z
  .object({
    id: z.string().min(1),
    backend: llmBackendIdSchema,
    enabled: z.boolean(),
    status: z.enum(['active', 'banned', 'retired']),
    health: z.enum(['ok', 'needs_relogin', 'suspended']),
    healthReason: z.string().nullable(),
    healthChangedAt: z.date().nullable(),
    retireRequestedAt: z.date().nullable(),
    coolingUntil: z.date().nullable(),
    breakerOpenUntil: z.date().nullable(),
    limitWindows: limitWindowsSchema.nullable(),
    activeTurns: z.number().int().nonnegative(),
    maxConcurrentTurns: z.number().int().positive(),
    lastUsedAt: z.date().nullable(),
  })
  .strict()
export type PoolAccountSnapshot = z.infer<typeof poolAccountSnapshotSchema>

export const pickAccountInputSchema = z
  .object({
    backend: llmBackendIdSchema,
    providerEnabled: z.boolean(),
    now: z.date().refine((date) => date.getTime() <= 8.64e15 - poolPolicy.unknownRetryMs),
    boundAccountId: z.string().min(1).nullable(),
    rebinds: z.number().int().min(0).max(poolPolicy.maxRebinds),
    policyFlagged: z.boolean(),
    minTurnHeadroomPct: z.number().positive().max(100).default(poolPolicy.minTurnHeadroomPct),
    accounts: z.array(poolAccountSnapshotSchema).readonly(),
  })
  .strict()
  .refine((input) => input.boundAccountId !== null || input.rebinds === 0, {
    message: 'An unbound task cannot have rebinds',
  })
  .refine(
    (input) => new Set(input.accounts.map((account) => account.id)).size === input.accounts.length,
    {
      message: 'Account ids must be unique',
    },
  )
export type PickAccountInput = z.input<typeof pickAccountInputSchema>
type ParsedInput = z.output<typeof pickAccountInputSchema>

export type PoolDecision =
  | {
      kind: 'selected'
      accountId: string
      binding: 'initial' | 'keep' | 'rebind'
      rebinds: number
    }
  | {
      kind: 'wait'
      retryAt: Date
      /** `cooling`: the bound account is paused by a window, a cooldown or the usage breaker. */
      reason: 'cooling' | 'limits_unknown' | 'pool_empty' | 'provider_disabled'
      /** Refresh usage once through the gateway outside the issue transaction, then reselect. */
      probeAccountIds: readonly string[]
    }
  /** A free slot is the only known obstacle, on the binding or in the pool: retry shortly. */
  | { kind: 'busy'; retryAt: Date }
  | {
      kind: 'operator'
      reason:
        | 'policy_flagged'
        | 'account_suspended'
        | 'rebind_limit'
        | 'binding_missing'
        | 'binding_backend_mismatch'
        | 'provider_disabled'
    }

function eligible(account: PoolAccountSnapshot, input: ParsedInput): boolean {
  return (
    account.backend === input.backend &&
    account.enabled &&
    account.status === 'active' &&
    account.health === 'ok' &&
    // Current spec §9 excludes ambiguous refreshes for existing bindings too.
    account.healthReason !== 'refresh_ambiguous' &&
    account.retireRequestedAt === null
  )
}

interface Readiness {
  ready: boolean
  headroom: number
  needsProbe: boolean
  /** Latest known blocking reset for this account, never the earliest window. */
  retryAt: number | null
}

function readiness(account: PoolAccountSnapshot, input: ParsedInput, newTask: boolean): Readiness {
  const now = input.now.getTime()
  const windows = account.limitWindows ?? []
  // Plans expose different windows; only reported windows constrain capacity. An empty
  // snapshot is still unknown usage, never unlimited capacity.
  let unknown = windows.length === 0
  let headroom = 100
  let retryAt: number | null = null
  // The usage breaker is a pause with a known end like a cooldown, not an unusable account.
  for (const pausedUntil of [account.coolingUntil, account.breakerOpenUntil]) {
    if (pausedUntil !== null && pausedUntil.getTime() > now)
      retryAt = Math.max(retryAt ?? pausedUntil.getTime(), pausedUntil.getTime())
  }

  for (const window of windows) {
    headroom = Math.min(headroom, 100 - window.usedPct)
    if (window.resetsAt !== null && window.resetsAt.getTime() <= now) {
      // A passed reset needs fresh usage, not a guessed zero usage or a reset in the past.
      unknown = true
      continue
    }
    const threshold =
      newTask && window.name === '5h'
        ? Math.max(input.minTurnHeadroomPct, poolPolicy.newTaskFiveHourHeadroomPct)
        : input.minTurnHeadroomPct
    if (window.usedPct <= 100 - threshold) continue
    if (window.resetsAt === null) {
      // Known ample headroom needs no reset time; a blocking window does, to schedule a retry.
      unknown = true
      continue
    }
    retryAt = Math.max(retryAt ?? window.resetsAt.getTime(), window.resetsAt.getTime())
  }

  return { ready: !unknown && retryAt === null, headroom, retryAt, needsProbe: unknown }
}

function wait(
  input: ParsedInput,
  reason: Extract<PoolDecision, { kind: 'wait' }>['reason'],
  retryAt?: number,
  probeAccountIds: readonly string[] = [],
): PoolDecision {
  return {
    kind: 'wait',
    reason: probeAccountIds.length > 0 ? 'limits_unknown' : reason,
    retryAt: new Date(retryAt ?? input.now.getTime() + poolPolicy.unknownRetryMs),
    probeAccountIds,
  }
}

function pickUnbound(input: ParsedInput, binding: 'initial' | 'rebind'): PoolDecision {
  const candidates: { account: PoolAccountSnapshot; headroom: number }[] = []
  const resets: number[] = []
  const probeAccountIds: string[] = []
  let slotsBusy = false
  for (const account of input.accounts) {
    if (!eligible(account, input)) continue
    const state = readiness(account, input, binding === 'initial')
    const freeSlot = account.activeTurns < account.maxConcurrentTurns
    if (state.retryAt !== null) resets.push(state.retryAt)
    if (state.needsProbe && freeSlot) {
      probeAccountIds.push(account.id)
      if (state.retryAt === null) resets.push(input.now.getTime() + poolPolicy.unknownRetryMs)
    }
    // If no replacement is ready, waiting may still make the current binding usable again.
    if (account.id === input.boundAccountId) continue
    if (state.ready && freeSlot) candidates.push({ account, headroom: state.headroom })
    // The slot is the only known obstacle: unknown usage is probed once the slot is free.
    else if (!freeSlot && state.retryAt === null) slotsBusy = true
  }
  candidates.sort((left, right) => {
    const headroom = right.headroom - left.headroom
    if (headroom !== 0) return headroom
    const leftUsed = left.account.lastUsedAt?.getTime() ?? -Infinity
    const rightUsed = right.account.lastUsedAt?.getTime() ?? -Infinity
    if (leftUsed !== rightUsed) return leftUsed < rightUsed ? -1 : 1
    // Stable even when database row order changes; never depend on machine locale.
    return left.account.id < right.account.id ? -1 : left.account.id > right.account.id ? 1 : 0
  })
  const selected = candidates[0]
  if (selected)
    return {
      kind: 'selected',
      accountId: selected.account.id,
      binding,
      rebinds: input.rebinds + (binding === 'rebind' ? 1 : 0),
    }
  if (slotsBusy) {
    // A slot frees without any window reset: never wait for another account's reset instead.
    // A pending probe still goes first, or a free account with unknown usage would stay idle.
    const retryAt = input.now.getTime() + poolPolicy.busyRetryMs
    if (probeAccountIds.length === 0) return { kind: 'busy', retryAt: new Date(retryAt) }
    resets.push(retryAt)
  }
  return wait(
    input,
    'pool_empty',
    resets.length > 0 ? resets.reduce((a, b) => Math.min(a, b)) : undefined,
    probeAccountIds.sort(),
  )
}

/**
 * Pure decision under the caller's provider advisory lock and site lease fence (spec §9).
 * Unknown windows request an on-demand usage probe through the gateway, outside the issue
 * transaction and its locks (at most once per five minutes/account). The caller reads a fresh
 * snapshot and reselects; retryAt is the fallback if probing cannot establish availability.
 * The caller maps wait/busy to DomainError 503, before starting a container. Only a successful
 * issue transaction may persist a selected binding/rebind count; wait/operator never consumes
 * a rebind. A rebind asks the driver adapter how to continue or replace its native session.
 */
export function pickAccount(snapshot: PickAccountInput): PoolDecision {
  const parsed = pickAccountInputSchema.safeParse(snapshot)
  if (!parsed.success) throw badRequest('Invalid subscription pool snapshot')
  const input = parsed.data
  if (input.policyFlagged) return { kind: 'operator', reason: 'policy_flagged' }
  if (!input.providerEnabled)
    return input.boundAccountId === null
      ? wait(input, 'provider_disabled')
      : { kind: 'operator', reason: 'provider_disabled' }
  if (input.boundAccountId === null) return pickUnbound(input, 'initial')

  const bound = input.accounts.find((account) => account.id === input.boundAccountId)
  if (!bound) return { kind: 'operator', reason: 'binding_missing' }
  if (bound.backend !== input.backend)
    return { kind: 'operator', reason: 'binding_backend_mismatch' }
  if (
    bound.health === 'suspended' &&
    (bound.healthChangedAt === null ||
      input.now.getTime() - bound.healthChangedAt.getTime() < poolPolicy.suspendedHoldMs)
  )
    return { kind: 'operator', reason: 'account_suspended' }

  if (eligible(bound, input)) {
    if (bound.activeTurns >= bound.maxConcurrentTurns)
      return { kind: 'busy', retryAt: new Date(input.now.getTime() + poolPolicy.busyRetryMs) }
    const state = readiness(bound, input, false)
    if (state.ready)
      return { kind: 'selected', accountId: bound.id, binding: 'keep', rebinds: input.rebinds }
    if (state.retryAt === null) return wait(input, 'limits_unknown', undefined, [bound.id])
    if (state.retryAt - input.now.getTime() <= poolPolicy.boundWaitMs)
      return wait(input, 'cooling', state.retryAt, state.needsProbe ? [bound.id] : [])
  }
  if (input.rebinds >= poolPolicy.maxRebinds) return { kind: 'operator', reason: 'rebind_limit' }
  return pickUnbound(input, 'rebind')
}
