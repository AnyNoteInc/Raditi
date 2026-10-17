import {
  limitResetPlausible,
  limitWindowsSchema,
  type CallSignal,
  type CallUsage,
  type GatewayRefusal,
  type LimitWindow,
  type LlmBackendId,
  type LlmCapacity,
  type LlmModelPrices,
  type LlmRoute,
} from '@repo/domain'

/**
 * The task event a content refusal leaves (p3-design §2.5): a durable task fact, unlike
 * llm_keys.last_refusal, which any later refusal of the same key overwrites. Core never
 * rebinds such a task, and the gateway admits none of its requests.
 */
export const policyFlaggedEvent = 'llm.policy_flagged'

/** Immutable fields used to normalize a body; admission verifies them again under the key lock. */
export interface GatewayProfile {
  keyId: string
  modelId: string
  model: string
  reasoningEffort: string | null
}

/** Non-secret database metadata. Subscription credentials are read separately from Vault. */
export interface GatewayKey extends GatewayProfile {
  backendId: LlmBackendId
  providerId: string
  taskId: string
  taskAttempt: number
  driverId: string
  accountId: string
  modelSlug: string
  reserveOutputTokens: number
  budgetRub: string
  credentialRef: string
  credentialVersion: number
  maxConcurrentRequests: number
  /**
   * The key has started no call yet and the window snapshot of its account is older than the
   * pool keeps one for (poolPolicy.windowsFreshMs): the gateway asks for one refresh before
   * admission, unless the backend of the route has no windows. Never a reason to refuse.
   */
  staleWindows: boolean
}

export interface GatewayCall extends GatewayKey {
  id: string
  priceId: string
  prices: LlmModelPrices
  estimatedInputTokens: number
  /** The part of est_in the reserve priced as cache reads; an estimate of this call splits its input the same way. */
  estimatedCacheReadTokens: number
  reservedRub: string
  startedAt: Date
}

export interface GatewayAdmitInput {
  keyHash: string
  source: string
  backendId: LlmBackendId
  /**
   * What the backend of the route declares (LlmBackend.capacity): `windows` reads the account's
   * windows and pauses, `none` only its pauses.
   */
  capacity: LlmCapacity
  route: LlmRoute
  profile: GatewayProfile
  requestBytes: number
  estimatedInputTokens: number
}

export type GatewayAdmission =
  | { kind: 'admitted'; call: GatewayCall }
  | {
      kind: 'refused'
      keyId?: string
      reason: GatewayRefusal | 'unauthorized' | 'backend'
      retryAfterMs?: number
      /** Only account-slot contention may wait up to twenty seconds outside its transaction. */
      waitForSlot?: boolean
      /** The account's windows are unknown: one fresh probe may let a repeated admission pass. */
      probeAccount?: boolean
      /** With probeAccount: limits_seen_at of the snapshot whose windows admission read as unknown. */
      limitsSeenAt?: Date | null
      /**
       * With `budget`: the limit of the key that refused — its money, its pace (calls within
       * thirty seconds) or its ceiling of calls. The answer to the sandbox and
       * llm_keys.last_refusal say `budget` for all three; only the log of the role names it.
       */
      limit?: GatewayKeyLimit
    }

export type GatewayKeyLimit = 'money' | 'pace' | 'calls'

export type GatewayEstimateReason =
  'aborted_client' | 'aborted_platform' | 'lost' | 'no_usage' | 'invalid_usage'

export interface GatewayFinish {
  state: 'completed' | 'failed' | 'aborted' | 'lost'
  usage: CallUsage
  estimated: boolean
  billable: boolean
  estimateReason: GatewayEstimateReason | null
  responseBytes: number
  upstreamStatus?: number
  signal?: CallSignal
}

/**
 * An egress failure after which no byte of the request can have reached the provider: the
 * channel was closed, or the tunnel or provider TLS session was never established. The call
 * then closes without a usage estimate. Any other egress failure may follow a delivered
 * request, and its estimate stays in the attempt ceiling.
 */
export class EgressNotDelivered extends Error {
  constructor() {
    super('Subscription egress unavailable')
    this.name = 'EgressNotDelivered'
  }
}

/** subscription_accounts.limit_windows as stored; null (unknown capacity) when it cannot be read. */
export function decodeLimitWindows(json: unknown): LimitWindow[] | null {
  if (!Array.isArray(json)) return null
  const result = limitWindowsSchema.safeParse(
    json.map((window: unknown) => {
      if (typeof window !== 'object' || window === null || !('resetsAt' in window)) return window
      return {
        ...window,
        resetsAt: typeof window.resetsAt === 'string' ? new Date(window.resetsAt) : window.resetsAt,
      }
    }),
  )
  return result.success ? result.data : null
}

/**
 * The adapters' rule, checked again before a write: a window whose reset lies further ahead
 * than the window is long makes its whole report unreadable.
 */
export const resetsPlausible = (windows: readonly LimitWindow[], now: Date): boolean =>
  windows.every(
    (window) => window.resetsAt === null || limitResetPlausible(window.resetsAt, now, window.name),
  )

/** The columns one window snapshot is written with; an empty list is unknown capacity. */
export function limitWindowColumns(windows: readonly LimitWindow[], now: Date) {
  return {
    limitWindows: windows.map((window) => ({
      ...window,
      resetsAt: window.resetsAt?.toISOString() ?? null,
    })),
    headroomPct:
      windows.length === 0
        ? null
        : String(Math.min(...windows.map((window) => 100 - window.usedPct))),
    limitsSeenAt: now,
  }
}

/** The store can never record this outcome: repeating the same write cannot succeed. */
export class GatewayRecordRejected extends Error {
  constructor(message = 'Gateway call outcome cannot be recorded') {
    super(message)
    this.name = 'GatewayRecordRejected'
  }
}

export interface GatewayStore {
  lookup(keyHash: string, source: string): Promise<GatewayKey | null>
  admit(input: GatewayAdmitInput): Promise<GatewayAdmission>
  refuse(keyId: string, reason: GatewayRefusal): Promise<void>
  /** False means another closer or the stale-call collector already closed this call. */
  finish(callId: string, outcome: GatewayFinish): Promise<boolean>
  /** Close calls older than eleven minutes using estimates and mark revoked keys with no open calls. */
  collectLost(): Promise<number>
}
