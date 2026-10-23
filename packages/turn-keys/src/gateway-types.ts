import { limitWindowsSchema, type CallSignal, type CallUsage, type LimitWindow } from '@repo/domain'

/**
 * The task event a content refusal leaves (p3-design §2.5): a durable task fact, unlike
 * llm_keys.last_refusal, which any later refusal of the same key overwrites. Core never
 * rebinds such a task, and the gateway admits none of its requests.
 */
export const policyFlaggedEvent = 'llm.policy_flagged'

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
