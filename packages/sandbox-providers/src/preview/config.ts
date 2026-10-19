import { DIGEST_PINNED_IMAGE, parseIpSubnet, previewRuntimes } from '@repo/domain'
import { z } from 'zod'

import { isLocalSocket } from '../docker-api.ts'

/**
 * The Docker runtime of previews (docs/plan/53-chat-preview-release.md, Р18): what is the same for
 * every preview of this host. The images of a preview come with its spec; the browser's with
 * `startBrowser`.
 */
export const dockerPreviewConfigSchema = z
  .strictObject({
    /** PREVIEW_RUNTIME: every spec must name the same one. */
    runtime: z.enum(previewRuntimes),
    /** SANDBOX_DOCKER_SOCKET: a local Unix socket only, never DOCKER_HOST or TCP. */
    socketPath: z
      .string()
      .refine(isLocalSocket, 'expected an absolute Unix socket path')
      .default('/var/run/docker.sock'),
    /**
     * PREVIEW_GATEWAY_PORT: the browser relay sends the browser's proxy traffic to
     * `host.docker.internal` on this port — the gateway of the `preview` role (Р21).
     */
    gatewayPort: z.number().int().min(1).max(65_535),
    /**
     * Where that gateway is: `host.docker.internal` — this host as Docker's `host-gateway` names
     * it, the local executor — or an IPv4 of it when that name is another machine (a VM whose
     * daemon points `host-gateway` at its own host) and, later, the runner executor (M10).
     */
    gatewayHost: z
      .union([z.literal('host.docker.internal'), z.ipv4()])
      .default('host.docker.internal'),
    /**
     * runsc only: the image with infra/sandbox/host-firewall.mjs (SANDBOX_NETWORK_GUARD_IMAGE). It
     * puts `INPUT -i <bridge> -j DROP` on the host for each preview bridge before code joins it.
     */
    firewallImage: z.string().regex(DIGEST_PINNED_IMAGE).optional(),
    /**
     * SANDBOX_EGRESS_REFUSED_SUBNETS: the platform's own subnets, CIDR, which the egress proxy of
     * a preview never connects to (docs/plan/53-chat-preview-release.md, Р13) — besides every
     * address that is not public and the subnets of its own interfaces. The proxy sits on the
     * default bridge: a public address of this host or of another machine of the platform is
     * what a client could point a name at.
     */
    egressRefusedSubnets: z
      .array(z.string().refine((text) => parseIpSubnet(text) !== null, 'expected a CIDR subnet'))
      .max(64)
      .default([]),
  })
  .refine((config) => config.runtime !== 'runsc' || config.firewallImage !== undefined, {
    message: 'runsc previews need the host firewall image (SANDBOX_NETWORK_GUARD_IMAGE)',
    path: ['firewallImage'],
  })
export type DockerPreviewConfig = z.input<typeof dockerPreviewConfigSchema>

/** Fixed limits of the containers the platform runs next to the preview's own. */
export const previewServiceLimits = Object.freeze({
  /** Forwarders, the egress proxy and the browser relay. */
  forwarder: { cpu: 0.25, memoryMiB: 128, pids: 64 },
  /** The files helper: no network, the docroot volume only. */
  helper: { cpu: 1, memoryMiB: 256, pids: 32 },
  browser: { cpu: 1, memoryMiB: 1536, pids: 512, shmMiB: 256 },
})

/** Fixed time and size limits of the runtime's own commands. */
export const previewRuntimeLimits = Object.freeze({
  /**
   * The deadline label of a preview's resources is its `expiresAt` plus this: core stops or
   * destroys an expired preview itself, and the host's watchdog removes it only once core has
   * been gone this long past it — never at the moment core acts.
   */
  deadlineGraceMs: 12 * 60 * 60_000,
  readyMs: 120_000,
  /** The settings file and the server's configuration: well below the tmpfs. */
  settingsBytes: 512 * 1024,
  settingsTmpfs: '1m',
  writeFilesMs: 15 * 60_000,
  /** Matches infra/preview/files.mjs. */
  writeFilesBytes: 4 * 1024 ** 3 + 64 * 1024 ** 2,
  loadDatabaseMs: 30 * 60_000,
  /** The seed as written (`databaseCopyLimits.seedBytes`), with room for the plan's replay. */
  loadDatabaseBytes: 1024 ** 3,
  execStdinBytes: 64 * 1024 ** 2,
  execStdoutBytes: 16 * 1024 ** 2,
  execStderrBytes: 1024 ** 2,
})
