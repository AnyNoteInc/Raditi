import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  badRequest,
  databaseDumpLimits,
  dbAccessSchema,
  DIGEST_PINNED_IMAGE,
  previewRuntimes,
  sandboxCommandFailed,
  type StagedDatabase,
  type StagingDatabaseInput,
  type StagingDatabaseRuntime,
} from '@repo/domain'
import type Docker from 'dockerode'
import { z } from 'zod'

import {
  bounded,
  commandError,
  createOwned,
  isLocalSocket,
  isMissing,
  localDocker,
} from '../docker-api.ts'
import {
  DATABASE_SECRET_DIR,
  DATABASE_SECRET_FILES,
  DATABASE_USER,
  hardened,
  tmpfs,
  WAIT_FOR_DATABASE_SECRETS,
} from './containers.ts'
import { execChecked, execIn } from './exec.ts'

// The temporary database a SQL dump of a site is loaded into before the copy of a preview
// (owner's decision of 26.10.2026; StagingDatabaseRuntime of @repo/domain). One container of the
// preview's database image on a bridge network of its own — nothing else of the platform is on
// it —, its port published on the loopback the copier of core dials, its data in an anonymous
// volume removed with it. The dump loads through the image's client as `loader`, a user with
// rights on the one database `staging` only: no client command of the dump runs (`--sandbox`),
// the server reads and writes no file for it (`--local-infile=0`, an empty `secure_file_priv`
// folder, no FILE right), plugins and other users cannot be made (no administrative right),
// and the event scheduler is off. The passwords are made for this load and die with it.

export const STAGING_LABEL = 'io.raditi.staging'
const STAGING_DATABASE = Object.freeze({ name: 'staging', user: 'loader', port: 3306 })
/** An empty tmpfs the server may read files from: none is there. */
const NO_FILES_DIR = '/run/raditi/nofiles'
const WRITE_FILE = ['/bin/sh', '-c', 'umask 077 && cat > "$1.tmp" && mv -f "$1.tmp" "$1"', 'raditi']
const READY_MS = 120_000

export const stagingDatabaseLimits = Object.freeze({ cpu: 1, memoryMiB: 1024, pids: 256 })

export const dockerStagingConfigSchema = z.strictObject({
  /** PREVIEW_RUNTIME. */
  runtime: z.enum(previewRuntimes),
  /** SANDBOX_DOCKER_SOCKET. */
  socketPath: z
    .string()
    .refine(isLocalSocket, 'expected an absolute Unix socket path')
    .default('/var/run/docker.sock'),
  /** PREVIEW_UPSTREAM_HOST: where the published port listens and the copier dials. */
  upstreamHost: z.ipv4().default('127.0.0.1'),
})
export type DockerStagingConfig = z.input<typeof dockerStagingConfigSchema>

const stagingIdSchema = z.uuid()
export const stagingNames = (stagingId: string) => ({
  container: `raditi-staging-${stagingId.toLowerCase()}`,
  network: `raditi-staging-${stagingId.toLowerCase()}`,
})

const password = () => randomBytes(24).toString('base64url')

/** The create options of the staging container: a pure function, tested apart. */
export function stagingContainer(input: {
  stagingId: string
  image: string
  networkId: string
  runtime: (typeof previewRuntimes)[number]
  upstreamHost: string
}): Docker.ContainerCreateOptions {
  const names = stagingNames(input.stagingId)
  return {
    name: names.container,
    Image: input.image,
    User: DATABASE_USER,
    Entrypoint: ['/bin/sh', '-c', WAIT_FOR_DATABASE_SECRETS, 'raditi-staging-db'],
    Cmd: [
      'docker-entrypoint.sh',
      'mariadbd',
      '--local-infile=0',
      `--secure-file-priv=${NO_FILES_DIR}`,
      '--event-scheduler=OFF',
      '--skip-name-resolve',
      '--max-allowed-packet=64M',
    ],
    Env: [
      `MARIADB_DATABASE=${STAGING_DATABASE.name}`,
      `MARIADB_USER=${STAGING_DATABASE.user}`,
      `MARIADB_PASSWORD_FILE=${DATABASE_SECRET_FILES.user}`,
      `MARIADB_ROOT_PASSWORD_FILE=${DATABASE_SECRET_FILES.root}`,
      'MARIADB_ROOT_HOST=localhost',
    ],
    Labels: { [STAGING_LABEL]: input.stagingId.toLowerCase() },
    ExposedPorts: { [`${STAGING_DATABASE.port}/tcp`]: {} },
    Tty: false,
    OpenStdin: false,
    HostConfig: {
      ...hardened(stagingDatabaseLimits, input.runtime),
      NetworkMode: input.networkId,
      PortBindings: {
        [`${STAGING_DATABASE.port}/tcp`]: [{ HostIp: input.upstreamHost, HostPort: '' }],
      },
      // No source: an anonymous volume, removed with the container (`v: true`).
      Mounts: [{ Type: 'volume', Source: '', Target: '/var/lib/mysql' }],
      Tmpfs: {
        '/run/mysqld': tmpfs(DATABASE_USER, '4m').replace('mode=0700', 'mode=0755'),
        '/tmp': tmpfs(DATABASE_USER, '256m'),
        [DATABASE_SECRET_DIR]: tmpfs(DATABASE_USER, '1m'),
        [NO_FILES_DIR]: tmpfs(DATABASE_USER, '1m'),
      },
    },
  }
}

/** The client of the image, inside the container, as `loader`: its password in the exec only. */
const client = (secret: string) => ({
  env: [`MYSQL_PWD=${secret}`],
  argv: [
    'mariadb',
    '--protocol=TCP',
    '--host=127.0.0.1',
    `--user=${STAGING_DATABASE.user}`,
    '--skip-ssl',
    '--batch',
    '--local-infile=0',
    `--database=${STAGING_DATABASE.name}`,
  ],
})

export function createDockerStagingDatabaseRuntime(
  value: DockerStagingConfig,
  docker: Docker = localDocker(dockerStagingConfigSchema.parse(value).socketPath),
): StagingDatabaseRuntime {
  const config = dockerStagingConfigSchema.parse(value)

  const removeOf = async (stagingId: string) => {
    const names = stagingNames(stagingId)
    try {
      await bounded(docker.getContainer(names.container).remove({ force: true, v: true }), 30_000)
    } catch (error) {
      if (!isMissing(error)) throw commandError()
    }
    try {
      await bounded(docker.getNetwork(names.network).remove())
    } catch (error) {
      if (!isMissing(error)) throw commandError()
    }
  }

  return {
    async load(input: StagingDatabaseInput): Promise<StagedDatabase> {
      const id = stagingIdSchema.safeParse(input.stagingId)
      if (!id.success) throw badRequest('Invalid staging id')
      if (!DIGEST_PINNED_IMAGE.test(input.image)) throw badRequest('Invalid staging image')
      const { signal } = input
      const names = stagingNames(id.data)
      const secrets = { user: password(), root: password() }
      // A container of an earlier load that did not finish is never reused: its passwords died.
      await removeOf(id.data)
      try {
        const network = await createOwned(
          docker.createNetwork({
            Name: names.network,
            Driver: 'bridge',
            Labels: { [STAGING_LABEL]: id.data.toLowerCase() },
          }),
          (created) => created.remove(),
          signal,
        )
        const container = await createOwned(
          docker.createContainer(
            stagingContainer({
              stagingId: id.data,
              image: input.image,
              networkId: network.id,
              runtime: config.runtime,
              upstreamHost: config.upstreamHost,
            }),
          ),
          (created) => created.remove({ force: true, v: true }),
          signal,
        )
        await bounded(container.start(), 30_000, signal)
        for (const [file, value] of [
          [DATABASE_SECRET_FILES.user, secrets.user],
          [DATABASE_SECRET_FILES.root, secrets.root],
        ] as const)
          await execChecked(container, {
            argv: [...WRITE_FILE, file],
            user: DATABASE_USER,
            stdin: Buffer.from(value),
            stdinBytes: 1024,
            stdoutBytes: 1024,
            stderrBytes: 4096,
            timeoutMs: 10_000,
            ...(signal ? { signal } : {}),
          })
        const login = client(secrets.user)
        const until = Date.now() + READY_MS
        for (;;) {
          if (signal?.aborted) throw commandError()
          const state = await bounded(container.inspect(), 10_000, signal)
          if (!state.State.Running) throw sandboxCommandFailed('The staging database stopped')
          const probe = await execIn(container, {
            argv: [...login.argv, '--execute=SELECT 1'],
            user: DATABASE_USER,
            env: login.env,
            stdoutBytes: 4096,
            stderrBytes: 4096,
            timeoutMs: 5_000,
          }).catch(() => null)
          if (probe?.code === 0) break
          if (Date.now() > until) throw sandboxCommandFailed('The staging database did not start')
          await delay(300)
        }
        // Data only: no client command of the dump runs (`\!`, `system`, `source`).
        const loaded = await execIn(container, {
          argv: [...login.argv, '--binary-mode', '--sandbox', '--max-allowed-packet=64M'],
          user: DATABASE_USER,
          env: login.env,
          stdin: input.dump,
          stdinBytes: databaseDumpLimits.loadBytes,
          stdoutBytes: 64 * 1024,
          stderrBytes: 64 * 1024,
          timeoutMs: databaseDumpLimits.loadMs,
          ...(signal ? { signal } : {}),
        })
        if (loaded.code !== 0) throw sandboxCommandFailed('The dump did not load')
        const inspected = await bounded(container.inspect(), 10_000, signal)
        const port =
          inspected.NetworkSettings.Ports?.[`${STAGING_DATABASE.port}/tcp`]?.[0]?.HostPort
        if (!port || !/^[1-9]\d{0,4}$/.test(port)) throw commandError()
        return {
          access: dbAccessSchema.parse({
            v: '1',
            engine: 'mysql',
            host: config.upstreamHost,
            port,
            tls: 'plain',
            database: STAGING_DATABASE.name,
            username: STAGING_DATABASE.user,
            password: secrets.user,
          }),
        }
      } catch (error) {
        await removeOf(id.data).catch(() => {})
        throw error
      }
    },

    async remove(stagingId) {
      const id = stagingIdSchema.safeParse(stagingId)
      if (!id.success) throw badRequest('Invalid staging id')
      await removeOf(id.data)
    },

    async list() {
      const rows = (await bounded(
        docker.listContainers({ all: true, filters: { label: [STAGING_LABEL] } }),
      )) as { Created?: number; Labels?: Record<string, string> }[]
      const found = new Map<string, number>()
      for (const row of rows) {
        const id = row.Labels?.[STAGING_LABEL]
        if (typeof id !== 'string' || !stagingIdSchema.safeParse(id).success) continue
        // Docker counts in seconds.
        found.set(id, Math.min(found.get(id) ?? Infinity, (row.Created ?? 0) * 1000))
      }
      return [...found]
        .map(([stagingId, createdAt]) => ({ stagingId, createdAt }))
        .sort((a, b) => a.stagingId.localeCompare(b.stagingId))
    },
  }
}
