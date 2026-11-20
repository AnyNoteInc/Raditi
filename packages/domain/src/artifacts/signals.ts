// Signals of a changed artifact (docs/plan/88-artifacts.md, Ар20, §7.4; slice 88.5). A committed
// batch of operations notifies `raditi_artifact` with the artifact's id alone (the trigger of
// 20261120100000_artifacts, once per artifact of a statement); core relays it to the Redis
// channel of the artifact, and web tells the pages that watch it, which read `artifact.changes`
// from their `seq`. Leases and presence go without NOTIFY: presence lives in Redis alone, a mark
// every 15 s that is gone after 30. A signal is only a hint: a lost one costs the time of the next
// poll, a repeated one a read.

/** The channel of PostgreSQL the trigger of `artifact_ops` notifies on. */
export const ARTIFACT_SIGNAL_PG_CHANNEL = 'raditi_artifact'

/** `changes` — read the artifact from your `seq`; `presence` — read who is here. */
export const artifactSignalKinds = ['changes', 'presence'] as const
export type ArtifactSignalKind = (typeof artifactSignalKinds)[number]

/** What a page is told: a kind of change, or `resync` — signals may have been lost meanwhile. */
export type ArtifactSignal = ArtifactSignalKind | 'resync'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The Redis channel of one artifact's signals. */
export const artifactSignalChannel = (artifactId: string): string =>
  `raditi:artifact:${artifactId.toLowerCase()}`

/** The Redis hash of who has the artifact open: a field per person, deleted after `presenceTtlMs`. */
export const artifactPresenceKey = (artifactId: string): string =>
  `raditi:artifact:${artifactId.toLowerCase()}:presence`

/** The id the trigger notified, or null when the payload is not one of its. */
export function parseArtifactSignal(payload: string): string | null {
  const id = payload.trim().toLowerCase()
  return UUID.test(id) ? id : null
}

/** The message of an artifact's Redis channel, or null when it is not a kind. */
export function readArtifactSignal(message: string): ArtifactSignalKind | null {
  return (artifactSignalKinds as readonly string[]).includes(message)
    ? (message as ArtifactSignalKind)
    : null
}

export const artifactSignalLimits = Object.freeze({
  /** A page marks itself present this often (Ар20). */
  presenceMarkMs: 15_000,
  /** A mark is gone this long after it was made. */
  presenceTtlMs: 30_000,
  /** Artifacts one subscription watches: the tabs of a page (Ар44) with room for a chat's. */
  subscriptionArtifacts: 20,
  /** A subscription checks again this often that its reader may still read each artifact. */
  recheckMs: 15_000,
  /** People one artifact shows at once; the rest — «ещё N». */
  presencePeople: 20,
})

/** One mark of presence as it lives in Redis: the block the person is in, and when it ends. */
export interface ArtifactPresenceMark {
  block: string | null
  until: number
}

/** A mark read back from Redis, or null when it is not one (another version, a broken value). */
export function readArtifactPresenceMark(value: string): ArtifactPresenceMark | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    const { block, until } = parsed as Record<string, unknown>
    if (typeof until !== 'number' || !Number.isFinite(until)) return null
    if (block !== null && (typeof block !== 'string' || block.length > 40)) return null
    return { block, until }
  } catch {
    return null
  }
}
