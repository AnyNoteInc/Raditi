import type {
  GatewayRefusal,
  LlmBackendId,
  LlmCapacity,
  LlmModelPrices,
  LlmRoute,
} from '@repo/domain'
import type { GatewayFinish } from '@repo/turn-keys'

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

export interface GatewayStore {
  lookup(keyHash: string, source: string): Promise<GatewayKey | null>
  admit(input: GatewayAdmitInput): Promise<GatewayAdmission>
  refuse(keyId: string, reason: GatewayRefusal): Promise<void>
  /** False means another closer or the stale-call collector already closed this call. */
  finish(callId: string, outcome: GatewayFinish): Promise<boolean>
  /** Close calls older than eleven minutes using estimates and mark revoked keys with no open calls. */
  collectLost(): Promise<number>
}
