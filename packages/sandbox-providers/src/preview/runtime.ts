import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  badRequest,
  conflict,
  isDomainError,
  PREVIEW_SETTINGS_PATH,
  previewBrowserInputSchema,
  previewDatabasePasswordsSchema,
  previewExecInputSchema,
  previewGeneratedFileSchema,
  previewRuntimeSecretsSchema,
  previewRuntimeSpecSchema,
  previewSettingsSchema,
  sandboxCommandFailed,
  type PreviewBrowserEndpoint,
  type PreviewDatabasePasswords,
  type PreviewExecResult,
  type PreviewFilesInput,
  type PreviewRuntime,
  type PreviewRuntimeSpec,
  type PreviewRuntimeState,
  type PreviewSettings,
} from '@repo/domain'
import type Docker from 'dockerode'
import { z } from 'zod'

import {
  bounded,
  commandError,
  createOwned,
  hasStatus,
  isMissing,
  localDocker,
} from '../docker-api.ts'
import { safeRunscRuntime } from '../docker.ts'
import {
  dockerPreviewConfigSchema,
  previewRuntimeLimits,
  type DockerPreviewConfig,
} from './config.ts'
import {
  BROWSER_CONTROL_PORT,
  BROWSER_READY_FILE,
  BROWSER_SECRET_FILE,
  browserContainer,
  CONFIG_LABEL,
  DATABASE_READY_FILE,
  DATABASE_SECRET_FILES,
  DATABASE_SECRET_LABEL,
  DATABASE_USER,
  databaseSecretMark,
  filesHelperContainer,
  firewallContainer,
  FORWARD_PORT,
  FORWARD_READY_FILE,
  identityOf,
  leaseContainer,
  PREVIEW_DATABASE,
  previewContainer,
  relayContainer,
  RUN_AS,
  SETTINGS_DIR,
  TOOLS,
  TOOLS_IMAGE_LABEL,
  WEB_USER_LABEL,
  type NetworkPlace,
} from './containers.ts'
import { execChecked, execIn } from './exec.ts'
import {
  browserAddresses,
  browserBridge,
  hostlessBridge,
  isHostlessBridge,
  isPreviewBridge,
  isPreviewId,
  legacyPreviewRoles,
  ownedIdentity,
  previewBridge,
  previewBridgeOptions,
  previewFilter,
  previewLabels,
  previewNames,
  PREVIEW_LABEL,
  PREVIEW_PROTOCOL,
  subnetAddress,
  type PreviewIdentity,
  type PreviewRole,
} from './resources.ts'

type Listed = { Id: string; Names?: string[]; Labels?: Record<string, string>; State?: string }

const SERVICE_USER = '10001:10001'
/** The latest `expiresAt` the spec takes (previewRuntimeSpecSchema). */
const MAX_EXPIRES_AT = 8_640_000_000_000_000
/** A write of the settings file or a configuration: a fixed script of /bin/sh, the path as $1. */
const WRITE_FILE = ['/bin/sh', '-c', 'umask 077 && cat > "$1.tmp" && mv -f "$1.tmp" "$1"', 'raditi']
const suffix = () => randomBytes(4).toString('hex')
const refusedReason = /^refused: ([a-z_]{1,32})\n?$/
const addressOn = (info: Docker.ContainerInspectInfo, network: NetworkPlace) =>
  Object.values(info.NetworkSettings?.Networks ?? {}).find(
    (endpoint) => endpoint.NetworkID === network.id,
  )?.IPAddress

/** The Docker runtime of previews (Р18): one local daemon, previews on their own networks. */
export function createDockerPreviewRuntime(
  configValue: DockerPreviewConfig,
  /** Injection is trusted infrastructure, used by tests. */
  options: { client?: Docker } = {},
): PreviewRuntime {
  const config = dockerPreviewConfigSchema.parse(configValue)
  const docker = options.client ?? localDocker(config.socketPath)
  const runsc = config.runtime === 'runsc'

  // --- discovery ------------------------------------------------------------------------------

  const listContainers = async (previewId?: string, role?: PreviewRole) =>
    (
      (await bounded(
        docker.listContainers({ all: true, filters: previewFilter(previewId, role) }),
      )) as Listed[]
    ).filter((item) => {
      const owned = ownedIdentity(item.Labels)
      return (
        owned && (!previewId || owned.previewId === previewId) && (!role || owned.role === role)
      )
    })

  const inspectContainer = async (id: string) => {
    try {
      return await bounded(docker.getContainer(id).inspect())
    } catch (error) {
      if (isMissing(error)) return null
      throw commandError()
    }
  }

  /** The one container of a role; two of them is not a state this runtime leaves. */
  const containerOf = async (previewId: string, role: PreviewRole) => {
    const rows = await listContainers(previewId, role)
    if (rows.length > 1) throw commandError()
    return rows[0] ? inspectContainer(rows[0].Id) : null
  }

  const removeContainer = async (id: string) => {
    try {
      await bounded(docker.getContainer(id).remove({ force: true, v: true }), 30_000)
    } catch (error) {
      if (!isMissing(error)) throw commandError()
    }
  }

  const portOf = (info: Docker.ContainerInspectInfo, port: number): number | null => {
    const binding = info.NetworkSettings?.Ports?.[`${port}/tcp`]?.[0]
    const value = Number(binding?.HostPort)
    return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : null
  }

  /** The identity of an existing preview, from any of its resources. */
  const identityFromLabels = async (previewId: string): Promise<PreviewIdentity> => {
    const [row] = await listContainers(previewId)
    const owned = ownedIdentity(row?.Labels)
    if (!owned) throw conflict('The preview has no containers here')
    return { previewId, siteId: owned.siteId, taskId: owned.taskId }
  }

  // --- checks ---------------------------------------------------------------------------------

  const checkRuntime = async (signal?: AbortSignal) => {
    const daemon = await bounded(docker.info(), 10_000, signal)
    const runtime: unknown = daemon.Runtimes?.[config.runtime]
    if (!runtime) throw sandboxCommandFailed('Configured preview runtime is not available')
    if (runsc && !safeRunscRuntime(runtime))
      throw sandboxCommandFailed(
        'runsc must be the plain binary with its own network stack and no raw sockets',
      )
  }

  /** Never pulled; a declared volume the container does not mount would leave an anonymous one. */
  const checkImage = async (image: string, mounted: readonly string[], signal?: AbortSignal) => {
    let info: Docker.ImageInspectInfo
    try {
      info = await bounded(docker.getImage(image).inspect(), 10_000, signal)
    } catch (error) {
      if (isMissing(error))
        throw sandboxCommandFailed('A preview image is not present on this host')
      throw commandError()
    }
    const declared = Object.keys(info.Config?.Volumes ?? {})
    if (declared.some((path) => !mounted.includes(path)))
      throw badRequest('A preview image declares a volume the runtime does not mount')
  }

  /** The labels of a container are its own: another site or task under this id is a conflict. */
  const assertIdentity = async (identity: PreviewIdentity) => {
    for (const row of await listContainers(identity.previewId)) {
      const owned = ownedIdentity(row.Labels)!
      if (owned.siteId !== identity.siteId || owned.taskId !== identity.taskId)
        throw conflict('The preview belongs to another site or task')
    }
  }

  // --- host firewall ----------------------------------------------------------------------------

  const hostFirewall = async (identity: PreviewIdentity, args: string[], signal?: AbortSignal) => {
    const helper = await createOwned(
      docker.createContainer(
        firewallContainer({
          identity,
          image: config.firewallImage,
          args,
          suffix: `${args[0]}-${suffix()}`,
        }),
      ),
      (created) => created.remove({ force: true, v: true }),
      signal,
    )
    let status: unknown
    try {
      await bounded(helper.start(), 10_000, signal)
      status = ((await bounded(helper.wait(), 20_000, signal)) as { StatusCode?: unknown })
        .StatusCode
    } finally {
      await removeContainer(helper.id)
    }
    if (status !== 0) throw commandError()
  }

  // --- networks and volumes -------------------------------------------------------------------

  /**
   * The preview's own bridge (docs/plan/58) and the bridge of its agent's browser. The first is
   * not internal and takes its host rules under any runtime before its container starts; the
   * second has no host address and takes the INPUT rule under runsc, as before.
   */
  /** host-firewall.mjs on the preview's own bridge: the same subnets on install and on check. */
  const previewBridgeRules = (command: 'install' | 'check', previewId: string) => [
    command,
    previewBridge(previewId),
    ...(config.refusedSubnets.length ? ['--refuse', config.refusedSubnets.join(',')] : []),
  ]

  const networkKinds = {
    network: {
      name: (id: string) => previewNames(id).network,
      bridge: previewBridge,
      create: previewBridgeOptions,
      valid: isPreviewBridge,
    },
    'browser-network': {
      name: (id: string) => previewNames(id).browserNetwork,
      bridge: browserBridge,
      create: hostlessBridge,
      valid: isHostlessBridge,
    },
  } as const

  const findNetwork = async (previewId: string, role: keyof typeof networkKinds) => {
    const rows = (await bounded(
      docker.listNetworks({ filters: previewFilter(previewId, role) }),
    )) as Listed[]
    const owned = rows.filter((row) => ownedIdentity(row.Labels)?.previewId === previewId)
    if (owned.length > 1) throw commandError()
    if (!owned[0]) return null
    const info = await bounded(docker.getNetwork(owned[0].Id).inspect())
    const kind = networkKinds[role]
    if (info.Name !== kind.name(previewId) || !kind.valid(info, kind.bridge(previewId)))
      throw commandError()
    return info
  }

  const ensureNetwork = async (
    identity: PreviewIdentity,
    role: keyof typeof networkKinds,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<NetworkPlace> => {
    const kind = networkKinds[role]
    const bridge = kind.bridge(identity.previewId)
    let info = await findNetwork(identity.previewId, role)
    if (!info) {
      const network = await createOwned(
        docker.createNetwork(
          kind.create(
            kind.name(identity.previewId),
            bridge,
            previewLabels(identity, role, deadline),
          ),
        ),
        (created) => created.remove(),
        signal,
      )
      info = await bounded(network.inspect(), 10_000, signal)
      if (!kind.valid(info, bridge)) {
        await bounded(network.remove()).catch(() => {})
        throw commandError()
      }
    }
    // Before anything that runs code joins the bridge; idempotent, so a lost rule comes back,
    // and checked by the helper itself: without its rules a preview does not start.
    if (role === 'network')
      await hostFirewall(identity, previewBridgeRules('install', identity.previewId), signal)
    else if (runsc) await hostFirewall(identity, ['install', bridge], signal)
    const subnet = info.IPAM?.Config?.[0]?.Subnet
    if (!subnet) throw commandError()
    return { id: info.Id, subnet }
  }

  /**
   * Removes the network of the role by its labels and its name, whatever its shape: a bridge of
   * protocol 1 (internal) goes as the preview's does. Another network under the name is not ours.
   */
  const removeNetwork = async (previewId: string, role: keyof typeof networkKinds) => {
    const rows = (await bounded(
      docker.listNetworks({ filters: previewFilter(previewId, role) }),
    )) as Listed[]
    for (const row of rows) {
      if (ownedIdentity(row.Labels)?.previewId !== previewId) continue
      const info = await bounded(docker.getNetwork(row.Id).inspect()).catch(() => null)
      if (info?.Name !== networkKinds[role].name(previewId)) continue
      try {
        await bounded(docker.getNetwork(row.Id).remove())
      } catch (error) {
        if (!isMissing(error)) throw commandError()
      }
    }
  }

  /** true — created by this call. A volume of the name with other labels is not ours. */
  const ensureVolume = async (
    identity: PreviewIdentity,
    name: string,
    role: PreviewRole,
    deadline: number,
  ): Promise<boolean> => {
    try {
      const info = await bounded(docker.getVolume(name).inspect())
      const owned = ownedIdentity(info.Labels ?? undefined)
      if (owned?.previewId !== identity.previewId || owned.role !== role) throw commandError()
      return false
    } catch (error) {
      if (!isMissing(error)) throw isDomainError(error) ? error : commandError()
    }
    await bounded(
      docker.createVolume({ Name: name, Labels: previewLabels(identity, role, deadline) }),
    )
    return true
  }

  const volumeExists = async (name: string) =>
    bounded(docker.getVolume(name).inspect()).then(
      () => true,
      (error: unknown) => {
        if (isMissing(error)) return false
        throw commandError()
      },
    )

  // --- containers -----------------------------------------------------------------------------

  /** Unchanged since it was created as asked: same labels and desired state, still hardened. */
  const matches = (info: Docker.ContainerInspectInfo, desired: Docker.ContainerCreateOptions) => {
    const host = info.HostConfig
    const labels = info.Config.Labels ?? {}
    return (
      labels[CONFIG_LABEL] === desired.Labels?.[CONFIG_LABEL] &&
      ['id', 'site', 'task', 'role'].every(
        (key) => labels[`${PREVIEW_LABEL}${key}`] === desired.Labels?.[`${PREVIEW_LABEL}${key}`],
      ) &&
      info.Name === `/${desired.name}` &&
      host.ReadonlyRootfs === true &&
      !host.Privileged &&
      host.CapDrop?.join() === 'ALL' &&
      (host.Binds?.length ?? 0) === 0 &&
      !host.PidMode &&
      host.IpcMode !== 'host'
    )
  }

  /**
   * The container as desired: kept when it matches and is attached as asked, replaced otherwise.
   * `attach` joins a second network at a fixed address before the start (dual-homed services).
   */
  const ensureContainer = async (
    desired: Docker.ContainerCreateOptions,
    attach: { network: NetworkPlace; address: string } | null,
    signal?: AbortSignal,
  ): Promise<Docker.ContainerInspectInfo> => {
    const [row] = (await bounded(
      docker.listContainers({ all: true, filters: { name: [`^/${desired.name}$`] } }),
    )) as Listed[]
    if (row) {
      const info = await inspectContainer(row.Id)
      const attached = !attach || (info && addressOn(info, attach.network) === attach.address)
      if (info && matches(info, desired) && attached) {
        if (!info.State.Running) await bounded(docker.getContainer(info.Id).start(), 10_000, signal)
        return (await inspectContainer(info.Id)) ?? Promise.reject(commandError())
      }
      // Ours by labels or by name: anything else under the name is never touched.
      if (info && !ownedIdentity(info.Config.Labels))
        throw conflict('A foreign container holds a preview name')
      if (info) await removeContainer(info.Id)
    }
    const container = await createOwned(
      docker.createContainer(desired),
      (created) => created.remove({ force: true, v: true }),
      signal,
    )
    try {
      if (attach)
        await bounded(
          docker.getNetwork(attach.network.id).connect({
            Container: container.id,
            EndpointConfig: { IPAMConfig: { IPv4Address: attach.address } },
          }),
          10_000,
          signal,
        )
      await bounded(container.start(), 10_000, signal)
      return (await inspectContainer(container.id)) ?? Promise.reject(commandError())
    } catch (error) {
      await removeContainer(container.id)
      throw isDomainError(error) ? error : commandError()
    }
  }

  /** Polls a check until it passes, the container stops or the time is up. */
  const waitFor = async (
    container: Docker.ContainerInspectInfo,
    check: () => Promise<boolean>,
    signal?: AbortSignal,
  ) => {
    const until = Date.now() + previewRuntimeLimits.readyMs
    while (Date.now() < until) {
      if (signal?.aborted) throw commandError()
      const state = await inspectContainer(container.Id)
      if (!state?.State.Running) throw sandboxCommandFailed('A preview container stopped')
      if (await check().catch(() => false)) return
      await delay(200)
    }
    throw sandboxCommandFailed('A preview container did not become ready')
  }

  const fileExists = (info: Docker.ContainerInspectInfo, path: string, user: string) => () =>
    execIn(docker.getContainer(info.Id), {
      argv: ['test', '-f', path],
      user,
      stdoutBytes: 1024,
      stderrBytes: 1024,
      timeoutMs: 5_000,
    }).then((outcome) => outcome.code === 0)

  /** Writes one file of a tmpfs as `user` with umask 077, renamed into place. */
  const writeInto = (
    info: Docker.ContainerInspectInfo,
    user: string,
    path: string,
    content: string,
    signal?: AbortSignal,
  ) =>
    execChecked(docker.getContainer(info.Id), {
      argv: [...WRITE_FILE, path],
      user,
      stdin: Buffer.from(content),
      stdinBytes: previewRuntimeLimits.settingsBytes,
      stdoutBytes: 1024,
      stderrBytes: 4096,
      timeoutMs: 10_000,
      ...(signal ? { signal } : {}),
    })

  // --- the lease -------------------------------------------------------------------------------

  /** The latest deadline of the preview; a later one asked for becomes a new lease. */
  const extendLease = async (identity: PreviewIdentity, deadline: number, image: string) => {
    const leases = await listContainers(identity.previewId, 'lease')
    const current = Math.max(0, ...leases.map((row) => ownedIdentity(row.Labels)!.deadline))
    if (deadline <= current) return current
    await createOwned(
      docker.createContainer(leaseContainer({ identity, deadline, image })),
      (created) => created.remove({ force: true }),
    )
    for (const row of leases) await removeContainer(row.Id)
    return deadline
  }

  const currentDeadline = async (previewId: string) => {
    const leases = await listContainers(previewId, 'lease')
    const deadline = Math.max(0, ...leases.map((row) => ownedIdentity(row.Labels)!.deadline))
    if (!deadline) throw conflict('The preview has no lease here')
    return deadline
  }

  // --- the database ---------------------------------------------------------------------------

  /** The client as the preview's user: its password from the caller (Vault), never from Docker. */
  const databaseClient = (password: string) => ({
    env: [`MYSQL_PWD=${password}`],
    argv: [
      'mariadb',
      '--protocol=TCP',
      '--host=127.0.0.1',
      `--user=${PREVIEW_DATABASE.user}`,
      '--skip-ssl',
      '--batch',
      '--local-infile=0',
    ],
  })

  // --- the files helper -----------------------------------------------------------------------

  const withFilesHelper = async <T>(
    identity: PreviewIdentity,
    input: { image: string; user: string; root: boolean; timeoutMs: number },
    run: (helper: Docker.Container) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const deadline = await currentDeadline(identity.previewId).catch(() => Date.now() + 3_600_000)
    const helper = await createOwned(
      docker.createContainer(
        filesHelperContainer({
          identity,
          deadline,
          image: input.image,
          runtime: config.runtime,
          user: input.user,
          root: input.root,
          seconds: input.timeoutMs / 1000 + 60,
          suffix: suffix(),
        }),
      ),
      (created) => created.remove({ force: true, v: true }),
      signal,
    )
    try {
      await bounded(helper.start(), 10_000, signal)
      return await run(helper)
    } finally {
      await removeContainer(helper.id)
    }
  }

  const filesCommand = (args: string[]) => ['/usr/local/bin/node', `${TOOLS}/files.mjs`, ...args]

  /**
   * Exit 3 is a refusal of the input; its reason is a word of a fixed list, never a path. A
   * docroot that is not the PHP user's is no fault of the input: that preview is rebuilt.
   */
  const filesOutcome = (outcome: { code: number; stderr: Buffer }) => {
    if (outcome.code === 0) return
    const reason = refusedReason.exec(outcome.stderr.toString('utf8'))?.[1]
    if (outcome.code === 3 && reason === 'root_owner')
      throw conflict(
        'The docroot of this preview belongs to another user: destroy the preview and build it again',
      )
    if (outcome.code === 3 && reason) throw badRequest(`Preview files were refused: ${reason}`)
    throw commandError()
  }

  // --- the parts of a running preview ---------------------------------------------------------

  const previewOf = async (previewId: string) => {
    if (!isPreviewId(previewId)) throw badRequest('Invalid preview id')
    const preview = await containerOf(previewId, 'preview')
    if (!preview) throw conflict('The preview is not built here')
    return preview
  }

  /** What the container was made with: the PHP user and the image of the platform's tools. */
  const madeWith = (preview: Docker.ContainerInspectInfo) => {
    const user = preview.Config.Labels?.[WEB_USER_LABEL]
    const tools = preview.Config.Labels?.[TOOLS_IMAGE_LABEL]
    if (!user || !/^\d+:\d+$/.test(user) || !tools) throw commandError()
    return { user, tools }
  }

  /** Anything of protocol 1 (several containers on an internal bridge) left of this preview. */
  const legacyOf = async (previewId: string) => {
    const old = (labels: Record<string, string> | undefined) => {
      const owned = ownedIdentity(labels)
      return (
        owned !== null &&
        (owned.protocol !== PREVIEW_PROTOCOL || legacyPreviewRoles.includes(owned.role))
      )
    }
    if ((await listContainers(previewId)).some((row) => old(row.Labels))) return true
    const networks = (await bounded(
      docker.listNetworks({ filters: previewFilter(previewId) }),
    )) as Listed[]
    if (networks.some((row) => old(row.Labels))) return true
    const volumes = await bounded(docker.listVolumes({ filters: previewFilter(previewId) }))
    return (volumes.Volumes ?? []).some((volume) => old(volume.Labels ?? undefined))
  }

  /** Containers first: a network or a volume goes only once nothing is attached to it. */
  const destroyPreview = async (previewId: string) => {
    const results = await Promise.allSettled(
      (await listContainers(previewId)).map((row) => removeContainer(row.Id)),
    )
    if (results.some((result) => result.status === 'rejected')) throw commandError()
    await removeNetwork(previewId, 'browser-network')
    await removeNetwork(previewId, 'network')
    await sweepFirewall(previewId)
    const names = previewNames(previewId)
    for (const name of [names.filesVolume, names.databaseVolume])
      await bounded(docker.getVolume(name).remove()).catch((error: unknown) => {
        if (!isMissing(error)) throw commandError()
      })
  }

  const removeRole = async (previewId: string, role: PreviewRole) => {
    for (const row of await listContainers(previewId, role)) await removeContainer(row.Id)
  }

  return {
    async ensure(specValue, secretsValue, signal) {
      const parsedSpec = previewRuntimeSpecSchema.safeParse(specValue)
      const parsedSecrets = previewRuntimeSecretsSchema.safeParse(secretsValue)
      if (!parsedSpec.success) throw badRequest('Invalid preview runtime spec')
      if (!parsedSecrets.success) throw badRequest('Invalid preview variables')
      let spec: PreviewRuntimeSpec = parsedSpec.data
      if (spec.runtime !== config.runtime)
        throw badRequest(`Preview runtime ${spec.runtime} differs from PREVIEW_RUNTIME`)
      const identity = identityOf(spec)
      const hasDatabase = spec.database
      // The image's database is MariaDB: it serves the MySQL protocol and nothing else.
      if (hasDatabase && spec.recipe.database !== 'mysql')
        throw badRequest(`Preview databases of ${spec.recipe.database} are not supported here`)
      const passwords = hasDatabase ? parsedSecrets.data.database : null
      if (hasDatabase && !passwords)
        throw badRequest('The passwords of the preview database are missing')
      const docroot = spec.recipe.web.docroot
      // Built past its deadline, the watchdog would take it before anyone saw it.
      if (spec.expiresAt <= Date.now()) throw badRequest('The preview has expired already')
      await checkRuntime(signal)
      await checkImage(spec.images.preview, [docroot, '/var/lib/mysql'], signal)
      await checkImage(spec.images.tools, [], signal)
      await assertIdentity(identity)
      // A preview of protocol 1 — several containers on an internal bridge — is built anew: its
      // copy comes back from the seed and the candidate (docs/plan/58, «Переход»).
      if (await legacyOf(spec.previewId)) await destroyPreview(spec.previewId)

      // The labels carry the deadline of the watchdog: past core's own, never at it.
      const deadline = await extendLease(
        identity,
        spec.expiresAt + previewRuntimeLimits.deadlineGraceMs,
        spec.images.tools,
      )
      spec = { ...spec, expiresAt: deadline }
      const network = await ensureNetwork(identity, 'network', deadline, signal)
      const names = previewNames(spec.previewId)

      // A new volume belongs to root until the helper gives it to the PHP user. Every call asks
      // again — the helper leaves a volume of that user as it is — so a call that died between
      // creating the volume and preparing it is mended by the next one; a volume that is someone
      // else's is a CONFLICT. A volume this call created and could not prepare is removed.
      const filesCreated = await ensureVolume(identity, names.filesVolume, 'files', deadline)
      await withFilesHelper(
        identity,
        { image: spec.images.tools, user: spec.recipe.web.user, root: true, timeoutMs: 30_000 },
        async (helper) =>
          filesOutcome(
            await execIn(helper, {
              argv: filesCommand(['init', spec.recipe.web.user]),
              user: '0:0',
              stdoutBytes: 4096,
              stderrBytes: 4096,
              timeoutMs: 30_000,
              ...(signal ? { signal } : {}),
            }),
          ),
        signal,
      ).catch(async (error: unknown) => {
        if (filesCreated)
          await bounded(docker.getVolume(names.filesVolume).remove()).catch(() => {})
        throw error
      })

      let databaseCreated = false
      if (hasDatabase) {
        const existing = await containerOf(spec.previewId, 'preview')
        const volumeWasThere = await volumeExists(names.databaseVolume)
        // The users of a database live in its volume: without the container that tells which
        // passwords made them the volume is of no use, and a silently empty database is not a
        // preview. A container made with other passwords (a secret of Vault lost and made anew)
        // would never become ready with these.
        if (
          (!existing && volumeWasThere) ||
          (existing &&
            existing.Config.Labels?.[DATABASE_SECRET_LABEL] !== databaseSecretMark(passwords!))
        )
          throw conflict(
            'The database of this preview was lost: destroy the preview and build it again',
          )
        databaseCreated = await ensureVolume(identity, names.databaseVolume, 'database', deadline)
      }

      try {
        const preview = await ensureContainer(
          previewContainer({ spec, network, dnsServers: config.dnsServers, passwords }),
          null,
          signal,
        )
        // A preview that no longer has a database: its volume goes once the container that
        // mounted it was replaced by this one.
        if (!passwords)
          await bounded(docker.getVolume(names.databaseVolume).remove()).catch((error: unknown) => {
            if (!isMissing(error)) throw commandError()
          })
        // init waits for these in its tmpfs — at the first start and after any restart.
        if (passwords) {
          await writeInto(
            preview,
            DATABASE_USER,
            DATABASE_SECRET_FILES.user,
            passwords.user,
            signal,
          )
          await writeInto(
            preview,
            DATABASE_USER,
            DATABASE_SECRET_FILES.root,
            passwords.root,
            signal,
          )
        }
        const settings = previewSettingsSchema.parse({
          v: 2,
          hostname: spec.hostname,
          origin: spec.origin,
          productionOrigin: spec.productionOrigin,
          database: passwords
            ? {
                engine: spec.recipe.database!,
                host: PREVIEW_DATABASE.host,
                port: PREVIEW_DATABASE.port,
                name: PREVIEW_DATABASE.name,
                user: PREVIEW_DATABASE.user,
                password: passwords.user,
              }
            : null,
          settings: spec.recipe.settings,
          env: parsedSecrets.data.env,
        } satisfies PreviewSettings)
        // The configuration first: the settings file is what init waits for.
        const webUser = spec.recipe.web.user
        for (const file of spec.recipe.web.configFiles)
          await writeInto(preview, webUser, `${SETTINGS_DIR}/${file.name}`, file.content, signal)
        await writeInto(preview, webUser, PREVIEW_SETTINGS_PATH, JSON.stringify(settings), signal)

        if (passwords)
          await waitFor(preview, fileExists(preview, DATABASE_READY_FILE, SERVICE_USER), signal)
        await waitFor(preview, fileExists(preview, FORWARD_READY_FILE, SERVICE_USER), signal)
        // The server answers on its port of the loopback, as the gateway inside sees it.
        await waitFor(
          preview,
          () =>
            execIn(docker.getContainer(preview.Id), {
              argv: [
                '/usr/local/bin/node',
                '-e',
                'require("net").connect(+process.argv[1],"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))',
                String(spec.recipe.web.port),
              ],
              user: SERVICE_USER,
              stdoutBytes: 1024,
              stderrBytes: 1024,
              timeoutMs: 5_000,
            }).then((outcome) => outcome.code === 0),
          signal,
        )
        const port = portOf((await inspectContainer(preview.Id))!, FORWARD_PORT)
        if (!port) throw commandError()
        return { host: spec.upstreamHost, port }
      } catch (error) {
        // A database that never started is not kept: its volume would outlive its passwords.
        if (databaseCreated) {
          await removeRole(spec.previewId, 'preview').catch(() => {})
          await bounded(docker.getVolume(names.databaseVolume).remove()).catch(() => {})
        }
        throw error
      }
    },

    async extend(previewId, expiresAt) {
      if (!isPreviewId(previewId)) throw badRequest('Invalid preview id')
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > MAX_EXPIRES_AT)
        throw badRequest('Invalid preview deadline')
      const [lease] = await listContainers(previewId, 'lease')
      const info = lease ? await inspectContainer(lease.Id) : null
      const owned = ownedIdentity(info?.Config.Labels)
      if (!info || !owned) throw conflict('The preview is not built here')
      await extendLease(
        { previewId, siteId: owned.siteId, taskId: owned.taskId },
        expiresAt + previewRuntimeLimits.deadlineGraceMs,
        info.Config.Image,
      )
    },

    async inspect(previewId) {
      if (!isPreviewId(previewId)) throw badRequest('Invalid preview id')
      // Only its container tells what the docroot holds. Leftovers of protocol 1, or volumes
      // whose container is gone, are no preview here: `ensure` builds it anew and the caller
      // writes the whole tree, never a difference over an empty volume.
      const preview = (await listContainers(previewId, 'preview')).find(
        (row) => ownedIdentity(row.Labels)?.protocol === PREVIEW_PROTOCOL,
      )
      if (!preview) return null
      const running = preview.State === 'running'
      const info = running ? await inspectContainer(preview.Id) : null
      const port = info ? portOf(info, FORWARD_PORT) : null
      const binding = info?.NetworkSettings?.Ports?.[`${FORWARD_PORT}/tcp`]?.[0]?.HostIp
      const state: PreviewRuntimeState = {
        previewId,
        runtime: config.runtime,
        running: running && port !== null,
        upstream: port && binding ? { host: binding, port } : null,
      }
      return state
    },

    async checkBoundary(previewId) {
      if (!isPreviewId(previewId)) throw badRequest('Invalid preview id')
      const preview = await containerOf(previewId, 'preview')
      if (!preview?.State.Running) return
      const owned = ownedIdentity(preview.Config.Labels)
      if (!owned) throw commandError()
      const identity = { previewId, siteId: owned.siteId, taskId: owned.taskId }
      await hostFirewall(identity, previewBridgeRules('check', previewId))
      // The agent's browser, under runsc: the INPUT rule of its own bridge.
      if (runsc && (await containerOf(previewId, 'browser'))?.State.Running)
        await hostFirewall(identity, ['check', browserBridge(previewId)])
    },

    async writeFiles(previewId, input: PreviewFilesInput, signal) {
      const made = madeWith(await previewOf(previewId))
      const platform =
        input.platform === undefined
          ? null
          : z.array(previewGeneratedFileSchema).max(16).safeParse(input.platform)
      if (
        typeof input.replace !== 'boolean' ||
        !Array.isArray(input.deletes) ||
        input.deletes.length > 10_000 ||
        input.deletes.some((path) => typeof path !== 'string' || path.length > 4096) ||
        platform?.success === false
      )
        throw badRequest('Invalid preview files input')
      const identity = await identityFromLabels(previewId)
      const user = made.user
      /** The platform's own steps (R5c): root with CAP_CHOWN alone, the docroot volume only. */
      const asRoot = (args: string[], stdin?: Buffer) =>
        withFilesHelper(
          identity,
          { image: made.tools, user, root: true, timeoutMs: 60_000 },
          async (helper) =>
            filesOutcome(
              await execIn(helper, {
                argv: filesCommand([...args, user]),
                user: '0:0',
                ...(stdin
                  ? {
                      stdin: (async function* () {
                        yield stdin
                      })(),
                    }
                  : {}),
                stdinBytes: 2 * 1024 * 1024,
                stdoutBytes: 4096,
                stderrBytes: 4096,
                timeoutMs: 60_000,
                ...(signal ? { signal } : {}),
              }),
            ),
          signal,
        )
      // A whole new tree empties the docroot: the platform's files and folders go back first.
      if (input.replace) await asRoot(['release'])
      const frame = Buffer.from(JSON.stringify({ replace: input.replace, deletes: input.deletes }))
      const head = Buffer.alloc(4)
      head.writeUInt32BE(frame.length)
      const stdin = (async function* () {
        yield Buffer.concat([head, frame])
        yield* input.archive
      })()
      await withFilesHelper(
        identity,
        {
          image: made.tools,
          user,
          root: false,
          timeoutMs: previewRuntimeLimits.writeFilesMs,
        },
        async (helper) =>
          filesOutcome(
            await execIn(helper, {
              argv: filesCommand(['write']),
              user,
              stdin,
              stdinBytes: previewRuntimeLimits.writeFilesBytes,
              stdoutBytes: 64 * 1024,
              stderrBytes: 4096,
              timeoutMs: previewRuntimeLimits.writeFilesMs,
              ...(signal ? { signal } : {}),
            }),
          ),
        signal,
      )
      if (platform?.success) {
        const frame = Buffer.from(JSON.stringify({ files: platform.data }))
        const length = Buffer.alloc(4)
        length.writeUInt32BE(frame.length)
        await asRoot(['platform'], Buffer.concat([length, frame]))
      }
    },

    async loadDatabase(previewId, seed, passwordsValue: PreviewDatabasePasswords, signal) {
      if (!isPreviewId(previewId)) throw badRequest('Invalid preview id')
      const passwords = previewDatabasePasswordsSchema.safeParse(passwordsValue)
      if (!passwords.success) throw badRequest('Invalid preview database passwords')
      const preview = await containerOf(previewId, 'preview')
      if (!preview?.State.Running || !preview.Config.Labels?.[DATABASE_SECRET_LABEL])
        throw conflict('The preview has no running database here')
      const client = databaseClient(passwords.data.user)
      const container = docker.getContainer(preview.Id)
      const name = PREVIEW_DATABASE.name
      await execChecked(container, {
        argv: [
          ...client.argv,
          `--execute=DROP DATABASE IF EXISTS \`${name}\`; CREATE DATABASE \`${name}\``,
        ],
        user: DATABASE_USER,
        env: client.env,
        stdoutBytes: 4096,
        stderrBytes: 4096,
        timeoutMs: 60_000,
        ...(signal ? { signal } : {}),
      })
      // Data only: no client command of the seed runs (`\!`, `system`), no file is read.
      await execChecked(container, {
        argv: [
          ...client.argv,
          '--binary-mode',
          '--sandbox',
          '--max-allowed-packet=64M',
          `--database=${name}`,
        ],
        user: DATABASE_USER,
        env: client.env,
        stdin: seed,
        stdinBytes: previewRuntimeLimits.loadDatabaseBytes,
        stdoutBytes: 64 * 1024,
        stderrBytes: 64 * 1024,
        timeoutMs: previewRuntimeLimits.loadDatabaseMs,
        ...(signal ? { signal } : {}),
      })
    },

    async exec(previewId, value, signal): Promise<PreviewExecResult> {
      const parsed = previewExecInputSchema.safeParse({
        argv: value.argv,
        timeoutMs: value.timeoutMs,
      })
      if (!parsed.success) throw badRequest('Invalid preview command')
      const preview = await previewOf(previewId)
      if (!preview.State.Running) throw conflict('The preview is not running here')
      const { user } = madeWith(preview)
      const seconds = Math.ceil(parsed.data.timeoutMs / 1000)
      // Inside the preview, as its PHP user with no capability, in a session of its own: run-as.sh
      // kills whatever the command left running once it ends or its time is up (docs/plan/58).
      const outcome = await execIn(docker.getContainer(preview.Id), {
        argv: [RUN_AS, user, String(seconds), '--', ...parsed.data.argv],
        user: '0:0',
        // No home: /tmp is the PHP user's too, and a tool's configuration or packages planted
        // there by the site's code would be read by the platform's command.
        env: ['HOME=/nonexistent'],
        workingDir: preview.Config.WorkingDir,
        ...(value.stdin ? { stdin: value.stdin } : {}),
        stdinBytes: previewRuntimeLimits.execStdinBytes,
        stdoutBytes: previewRuntimeLimits.execStdoutBytes,
        stderrBytes: previewRuntimeLimits.execStderrBytes,
        timeoutMs: parsed.data.timeoutMs + 10_000,
        ...(signal ? { signal } : {}),
      })
      return { code: outcome.code, stdout: outcome.stdout, stderr: outcome.stderr }
    },

    async startBrowser(previewId, value): Promise<PreviewBrowserEndpoint> {
      const parsed = previewBrowserInputSchema.safeParse(value)
      if (!parsed.success) throw badRequest('Invalid preview browser input')
      if (!isPreviewId(previewId)) throw badRequest('Invalid preview id')
      const made = madeWith(await previewOf(previewId))
      await checkRuntime()
      await checkImage(parsed.data.image, [])
      const identity = await identityFromLabels(previewId)
      const deadline = await currentDeadline(previewId)
      const network = await ensureNetwork(identity, 'browser-network', deadline)
      const relay = await ensureContainer(
        relayContainer({
          identity,
          deadline,
          image: made.tools,
          network,
          gatewayHost: config.gatewayHost,
          gatewayPort: config.gatewayPort,
        }),
        { network, address: subnetAddress(network.subnet, browserAddresses.relay) },
      )
      const desired = browserContainer({
        identity,
        deadline,
        image: parsed.data.image,
        runtime: config.runtime,
        network,
        hostname: parsed.data.hostname,
      })
      const browser = await ensureContainer(desired, null)
      const container = docker.getContainer(browser.Id)
      const user = browser.Config.User
      // A path once written stays: the server may have read it already.
      let wsPath: string
      if (await fileExists(browser, BROWSER_SECRET_FILE, user)()) {
        wsPath = (
          await execChecked(container, {
            argv: ['cat', BROWSER_SECRET_FILE],
            user,
            stdoutBytes: 1024,
            stderrBytes: 1024,
            timeoutMs: 5_000,
          })
        )
          .toString('utf8')
          .trim()
      } else {
        wsPath = `/${randomBytes(32).toString('base64url')}`
        await writeInto(browser, user, BROWSER_SECRET_FILE, wsPath)
      }
      if (!/^\/[A-Za-z0-9_-]{43,128}$/.test(wsPath)) throw commandError()
      await waitFor(relay, fileExists(relay, FORWARD_READY_FILE, SERVICE_USER))
      await waitFor(browser, fileExists(browser, BROWSER_READY_FILE, user))
      const port = portOf((await inspectContainer(relay.Id))!, BROWSER_CONTROL_PORT)
      if (!port) throw commandError()
      return { wsEndpoint: `ws://127.0.0.1:${port}${wsPath}` }
    },

    async stopBrowser(previewId) {
      if (!isPreviewId(previewId)) throw badRequest('Invalid preview id')
      await removeRole(previewId, 'browser')
      await removeRole(previewId, 'relay')
      await removeNetwork(previewId, 'browser-network')
      await sweepFirewall(previewId)
    },

    async stop(previewId) {
      if (!isPreviewId(previewId)) throw badRequest('Invalid preview id')
      for (const row of await listContainers(previewId)) {
        if (row.State !== 'running') continue
        try {
          await bounded(docker.getContainer(row.Id).stop({ t: 10 }), 30_000)
        } catch (error) {
          // 304: it stopped on its own meanwhile.
          if (!isMissing(error) && !hasStatus(error, 304)) throw commandError()
        }
      }
    },

    async destroy(previewId) {
      if (!isPreviewId(previewId)) throw badRequest('Invalid preview id')
      await destroyPreview(previewId)
    },

    async list() {
      const ids = new Set<string>()
      for (const row of await listContainers()) ids.add(ownedIdentity(row.Labels)!.previewId)
      const networks = (await bounded(
        docker.listNetworks({ filters: previewFilter() }),
      )) as Listed[]
      for (const row of networks) {
        const owned = ownedIdentity(row.Labels)
        if (owned) ids.add(owned.previewId)
      }
      const volumes = await bounded(docker.listVolumes({ filters: previewFilter() }))
      for (const volume of volumes.Volumes ?? []) {
        const owned = ownedIdentity(volume.Labels ?? undefined)
        if (owned) ids.add(owned.previewId)
      }
      return [...ids].sort()
    },
  }

  /** Drops host rules of bridges that are gone; a failed sweep is retried by the next install. */
  async function sweepFirewall(previewId: string) {
    const identity = await identityFromLabels(previewId).catch(() => ({
      previewId,
      siteId: previewId,
      taskId: previewId,
    }))
    await hostFirewall(identity, ['sweep']).catch(() =>
      process.emitWarning('Preview host firewall sweep failed', {
        code: 'RADITI_PREVIEW_FIREWALL_SWEEP',
      }),
    )
  }
}
