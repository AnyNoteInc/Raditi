import { describe, expect, it, vi } from 'vitest'

import { DATABASE_SECRET_FILES } from './containers.ts'
import { createDockerStagingDatabaseRuntime, STAGING_LABEL, stagingContainer } from './staging.ts'

const stagingId = '0199a3f2-0000-7000-8000-00000000000d'
const image = 'mariadb@sha256:70cc072b29b4a89ae07abb2d4da2c64678a7f2dfe092751bb51c87d67dc1338b'

describe('the staging database container', () => {
  const options = stagingContainer({
    stagingId,
    image,
    networkId: 'net-1',
    runtime: 'runc',
    upstreamHost: '127.0.0.1',
  })

  it('is hardened like the database of a preview and publishes its port on the loopback only', () => {
    expect(options.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: 'net-1',
      PortBindings: { '3306/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
    })
    expect(options.Labels).toEqual({ [STAGING_LABEL]: stagingId })
  })

  it('keeps its passwords out of the environment and reads no file for a dump', () => {
    const env = options.Env ?? []
    expect(env).toContain(`MARIADB_PASSWORD_FILE=${DATABASE_SECRET_FILES.user}`)
    expect(env.some((line) => /^MARIADB_(ROOT_)?PASSWORD=/.test(line))).toBe(false)
    expect(options.Cmd).toEqual(
      expect.arrayContaining([
        '--local-infile=0',
        '--secure-file-priv=/run/raditi/nofiles',
        '--event-scheduler=OFF',
      ]),
    )
    // The data die with the container: an anonymous volume.
    expect(options.HostConfig?.Mounts).toEqual([
      { Type: 'volume', Source: '', Target: '/var/lib/mysql' },
    ])
  })
})

describe('the staging runtime', () => {
  const docker = () => {
    const removed: string[] = []
    const fake = {
      removed,
      listContainers: vi.fn().mockResolvedValue([
        { Created: 1_800_000_100, Labels: { [STAGING_LABEL]: stagingId } },
        { Created: 1_800_000_000, Labels: { [STAGING_LABEL]: stagingId } },
        { Created: 1_800_000_000, Labels: { [STAGING_LABEL]: 'not-an-id' } },
      ]),
      getContainer: (name: string) => ({
        remove: async () => {
          removed.push(`container:${name}`)
        },
      }),
      getNetwork: (name: string) => ({
        remove: async () => {
          throw Object.assign(new Error('missing'), { statusCode: 404 })
        },
        name,
      }),
    }
    return fake
  }

  it('lists the staging databases it holds by their label', async () => {
    const fake = docker()
    const runtime = createDockerStagingDatabaseRuntime({ runtime: 'runc' }, fake as never)
    expect(await runtime.list()).toEqual([{ stagingId, createdAt: 1_800_000_000_000 }])
  })

  it('removes a staging database whose network is gone already', async () => {
    const fake = docker()
    const runtime = createDockerStagingDatabaseRuntime({ runtime: 'runc' }, fake as never)
    await runtime.remove(stagingId)
    expect(fake.removed).toEqual([`container:raditi-staging-${stagingId}`])
    await expect(runtime.remove('../x')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('refuses an image that is not pinned by its digest', async () => {
    const runtime = createDockerStagingDatabaseRuntime({ runtime: 'runc' }, docker() as never)
    await expect(
      runtime.load({ stagingId, image: 'mariadb:11', dump: (async function* () {})() }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
