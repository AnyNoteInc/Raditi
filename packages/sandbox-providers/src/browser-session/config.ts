import {
  appEnvSchema,
  DIGEST_PINNED_IMAGE,
  isProduction,
  parseIpSubnet,
  previewImageSchema,
  previewRuntimes,
} from '@repo/domain'
import { z } from 'zod'

import { isLocalSocket } from '../docker-api.ts'
import { previewServiceLimits } from '../preview/config.ts'

/**
 * The Docker runtime of the browser sessions of tasks (docs/plan/57-browser-tasks.md, Б10, Б11):
 * what is the same for every session of this host. Each session gets Chromium on an internal
 * network of its own, an egress proxy with the session's hosts as its only way out and a
 * forwarder of its control port to the host loopback — the containers of a preview's browser
 * (infra/preview, infra/sandbox/client-egress.mjs), keyed by the session instead of a preview.
 */

const serviceLimitsSchema = z.strictObject({
  cpu: z.number().min(0.1).max(1),
  memoryMiB: z.number().int().min(64).max(512),
  pids: z.number().int().min(16).max(256),
})

/** The containers' limits by default: those of a preview's browser and its forwarders. */
export const browserSessionDefaultLimits = Object.freeze({
  browser: previewServiceLimits.browser,
  /** The egress proxy and the forwarder of the control port. */
  service: previewServiceLimits.forwarder,
})

export const browserSessionRuntimeLimits = Object.freeze({
  /** Every container of a session starts and answers within this. */
  readyMs: 120_000,
  /** Local sites of one session (BROWSER_LOCAL_SITES); infra/sandbox/client-egress.mjs takes 16. */
  localSites: 16,
  /** `host:port` of one egress proxy (clientEgressLimits.hosts). */
  hosts: 256,
  /** Tunnels of one egress proxy (MAX_TUNNELS of client-egress.mjs). */
  tunnels: { min: 1, max: 256, default: 32 },
})

export const dockerBrowserSessionConfigSchema = z
  .strictObject({
    /**
     * APP_ENV of the worker, required: the egress proxy gets it too, and refuses local sites in
     * production on its own (infra/sandbox/client-egress.mjs) — a third line after the worker's
     * configuration and `localSites` here.
     */
    appEnv: appEnvSchema,
    /** gVisor on Linux; runc where it is unavailable (outside production). */
    runtime: z.enum(previewRuntimes),
    /** A local Unix socket only, never DOCKER_HOST or TCP. */
    socketPath: z
      .string()
      .refine(isLocalSocket, 'expected an absolute Unix socket path')
      .default('/var/run/docker.sock'),
    /** Pinned by digest, never pulled: infra/preview `browser` and `tools`, infra/sandbox `client-egress`. */
    images: z.strictObject({
      browser: previewImageSchema,
      forwarder: previewImageSchema,
      egress: previewImageSchema,
    }),
    /**
     * runsc only: the image with infra/sandbox/host-firewall.mjs (SANDBOX_NETWORK_GUARD_IMAGE). It
     * puts `INPUT -i <bridge> -j DROP` on the host for the session's bridge before code joins it.
     */
    firewallImage: z.string().regex(DIGEST_PINNED_IMAGE).optional(),
    /**
     * SANDBOX_EGRESS_REFUSED_SUBNETS: the platform's own subnets, which the egress proxy never
     * connects to besides every address that is not public. It sits on the default bridge: a
     * public address of a machine of the platform is what a name could be pointed at.
     */
    refusedSubnets: z
      .array(z.string().refine((text) => parseIpSubnet(text) !== null, 'expected a CIDR subnet'))
      .max(64)
      .default([]),
    limits: z
      .strictObject({
        browser: z.strictObject({
          cpu: z.number().min(0.25).max(2),
          memoryMiB: z.number().int().min(512).max(4096),
          pids: z.number().int().min(128).max(1024),
          shmMiB: z.number().int().min(64).max(1024),
        }),
        service: serviceLimitsSchema,
      })
      .default(browserSessionDefaultLimits),
    /** Concurrent tunnels of a session's egress proxy: a page of wp-admin opens a few dozen. */
    maxTunnels: z
      .number()
      .int()
      .min(browserSessionRuntimeLimits.tunnels.min)
      .max(browserSessionRuntimeLimits.tunnels.max)
      .default(browserSessionRuntimeLimits.tunnels.default),
    /**
     * Outside production only (BROWSER_LOCAL_SITES): whether a session may name local sites —
     * plain-http origins its egress proxy forwards to a fixed target without DNS. The app never
     * sets it in production; without it a spec with a local site is refused.
     */
    localSites: z.boolean().default(false),
  })
  .refine((config) => config.runtime !== 'runsc' || config.firewallImage !== undefined, {
    message: 'runsc browser sessions need the host firewall image (SANDBOX_NETWORK_GUARD_IMAGE)',
    path: ['firewallImage'],
  })
  .refine((config) => !(isProduction(config.appEnv) && config.localSites), {
    message: 'local sites are for stands only, never in production',
    path: ['localSites'],
  })
export type DockerBrowserSessionConfig = z.input<typeof dockerBrowserSessionConfigSchema>
