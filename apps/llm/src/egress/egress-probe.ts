import { readFileSync } from 'node:fs'
import { request } from 'node:https'
import { isIP } from 'node:net'

import { withTimeout } from '@repo/domain'

import type { EgressConfig } from '../config/llm-config.ts'

export interface EgressProbe {
  check(signal: AbortSignal): Promise<boolean>
}

export const egressProbeBytes = 65_536

/**
 * The proxy's authenticated probe measures the channel without exposing any provider token.
 * Without a proxy the platform has no channel of its own to measure: the way out is the network
 * of the role's host, and the role opens no connection there of its own accord. Whether a
 * provider can be reached is then what each request and each account probe finds, and what
 * EgressHealth.observeDirect hears of them.
 */
export function createEgressProbe(config: EgressConfig): EgressProbe {
  if (config.proxyUrl === null) return { check: async () => true }
  let credentials: { ca: Buffer; cert: Buffer; key: Buffer }
  try {
    credentials = {
      ca: readFileSync(config.caFile),
      cert: readFileSync(config.clientCertFile),
      key: readFileSync(config.clientKeyFile),
    }
  } catch {
    throw new Error('Subscription egress unavailable')
  }
  const host = config.proxyUrl.hostname.replace(/^\[(.*)\]$/, '$1')
  const url = new URL(`/probe?bytes=${egressProbeBytes}`, config.proxyUrl)
  return {
    check(signal) {
      if (signal.aborted) return Promise.resolve(false)
      return new Promise((resolve) => {
        let settled = false
        const outgoing = request(url, {
          ...credentials,
          agent: false,
          method: 'GET',
          rejectUnauthorized: true,
          minVersion: 'TLSv1.3',
          servername: isIP(host) ? 'egress-1.raditi.internal' : host,
          signal,
          headers: { accept: 'application/octet-stream', 'accept-encoding': 'identity' },
        })
        const finish = (healthy: boolean) => {
          if (settled) return
          settled = true
          resolve(healthy)
          outgoing.destroy()
        }
        outgoing.on('error', () => finish(false))
        outgoing.on('upgrade', (_response, socket) => {
          socket.destroy()
          finish(false)
        })
        outgoing.on('response', (response) => {
          if (response.statusCode !== 200) {
            response.destroy()
            finish(false)
            return
          }
          let bytes = 0
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength
            if (bytes > egressProbeBytes) {
              response.destroy()
              finish(false)
            }
          })
          response.on('error', () => finish(false))
          response.on('aborted', () => finish(false))
          response.on('end', () => finish(bytes === egressProbeBytes))
        })
        outgoing.end()
      })
    },
  }
}

const channelIntervalMs = 5 * 60_000
// A failed probe is repeated within seconds: the channel to egress-1 is unreliable, and five
// minutes of closed admission outlast every retry of a running CLI.
const retryDelaysMs = [5_000, 15_000, 30_000] as const
// One failure may be the probe's own: a healthy channel closes on the second in a row.
const closeAfterFailures = 2
// p3-design §2.4 step 9: a confirmed region block is checked again after ten minutes.
const regionRecheckMs = 10 * 60_000
// Without a proxy nothing probes a provider. This many connections of the role's own in a row
// that never opened, the last of them this recent, are the one sign that it is out of reach.
const directFailuresUnreachable = 3
const directFailureFreshMs = 5 * 60_000

/**
 * The channel and the provider's region are separate facts. The byte probe proves only the
 * mTLS channel to egress-1; a confirmed region block holds until a provider answers an account
 * probe through that channel without refusing the region (p3-design §2.5, §3.8).
 */
export class EgressHealth {
  readonly #shutdown = new AbortController()
  #channel = false
  #failures = 0
  #region: { accountId: string; recheckAt: number } | null = null
  #regionRevision = 0
  #directFailures = 0
  #directFailedAt = -Infinity
  #pending: Promise<void> | undefined
  #closing = false
  private readonly probe: EgressProbe
  private readonly logger: { warn(message: string): void }
  private readonly now: () => number

  constructor(
    probe: EgressProbe,
    logger: { warn(message: string): void } = { warn: () => {} },
    now: () => number = Date.now,
  ) {
    this.probe = probe
    this.logger = logger
    this.now = now
  }

  /** Admission and provider traffic: the channel works and no region block holds. */
  healthy(): boolean {
    return this.reachable() && this.#region === null
  }

  /** The channel alone, for the one account probe that may lift a region block. */
  reachable(): boolean {
    return !this.#closing && this.#channel
  }

  /** A connection of the role's own to a provider was opened, or could not be (no proxy). */
  observeDirect(established: boolean): void {
    if (established) {
      this.#directFailures = 0
      return
    }
    this.#directFailures += 1
    this.#directFailedAt = this.now()
    if (this.#directFailures === directFailuresUnreachable)
      this.logger.warn(JSON.stringify({ event: 'llm_egress_direct_unreachable' }))
  }

  /**
   * For the health answer alone, never for admission: the role opens no connection of its own
   * accord, so only the next request can find the provider again, and it must be let through.
   * With nothing tried for five minutes nothing is known, as when the role started.
   */
  directReachable(): boolean {
    return (
      this.#directFailures < directFailuresUnreachable ||
      this.now() - this.#directFailedAt >= directFailureFreshMs
    )
  }

  blockRegion(accountId: string): void {
    if (this.#region === null)
      this.logger.warn(JSON.stringify({ event: 'llm_egress_region_confirmed' }))
    this.#regionRevision += 1
    this.#region = { accountId, recheckAt: this.now() + regionRecheckMs }
  }

  /** The account to probe now if a region block is due for its recheck; the next is due later. */
  regionRecheck(): { accountId: string; revision: number } | null {
    const region = this.#region
    if (region === null || !this.reachable() || this.now() < region.recheckAt) return null
    region.recheckAt = this.now() + regionRecheckMs
    return { accountId: region.accountId, revision: this.#regionRevision }
  }

  /** Lifts the block the recheck was taken for; a region confirmed since then stays. */
  clearRegion(revision: number): void {
    if (this.#region === null || revision !== this.#regionRevision) return
    this.#region = null
    this.logger.warn(JSON.stringify({ event: 'llm_egress_region_cleared' }))
  }

  /** Delay until the next channel probe or region recheck. */
  nextCheckMs(): number {
    const channel =
      this.#failures === 0
        ? channelIntervalMs
        : retryDelaysMs[Math.min(this.#failures, retryDelaysMs.length) - 1]!
    if (this.#region === null) return channel
    return Math.min(channel, Math.max(1_000, this.#region.recheckAt - this.now()))
  }

  check(): Promise<void> {
    if (this.#closing) return Promise.resolve()
    if (this.#pending) return this.#pending
    const signal = AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(15_000)])
    const failed = () => {
      this.#failures += 1
      if (this.#failures >= closeAfterFailures) this.#channel = false
      this.logger.warn(JSON.stringify({ event: 'llm_egress_probe_failed' }))
    }
    this.#pending = withTimeout(
      Promise.resolve().then(() => this.probe.check(signal)),
      15_000,
      'Egress probe timed out',
    )
      .then((healthy) => {
        if (this.#closing) return
        if (!healthy) return failed()
        this.#channel = true
        this.#failures = 0
      })
      .catch(failed)
      .finally(() => {
        this.#pending = undefined
      })
    return this.#pending
  }

  async close(): Promise<void> {
    this.#closing = true
    this.#shutdown.abort()
    if (this.#pending)
      await withTimeout(this.#pending, 1000, 'Egress shutdown timed out').catch(() => {})
  }
}
