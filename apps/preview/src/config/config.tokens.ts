/** PreviewGatewayConfig of this process. */
export const PREVIEW_CONFIG = Symbol('PREVIEW_CONFIG')
/** The clock of the gateway (PreviewClock): Date.now, a test's own in tests. */
export const PREVIEW_CLOCK = Symbol('PREVIEW_CLOCK')

/** Milliseconds since the epoch: the expiry of a session and the age of a cache entry. */
export type PreviewClock = () => number
