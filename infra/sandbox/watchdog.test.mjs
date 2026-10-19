import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dockerClient, reapExpired, reapExpiredPreviews } from './watchdog.mjs'

const main = 'io.raditi.sandbox.'
const gateway = 'io.raditi.gateway.'
const item = (prefix, deadline, id, extra = {}) => ({
  Id: id.repeat(64),
  Names: ['/raditi-turn-task-1'],
  Labels: {
    [`${prefix}owner`]: 'raditi',
    [`${prefix}protocol`]: '1',
    [`${prefix}deadline`]: String(deadline),
    [`${prefix}taskId`]: 'task',
    [`${prefix}turn`]: '1',
    ...extra,
  },
})

test('deadline cleanup touches only explicitly owned expired objects and main precedes gateway', async () => {
  const calls = []
  const resource = '01234567-1234-1234-1234-0123456789ab'
  const client = async (method, path) => {
    if (method === 'DELETE') {
      calls.push(path)
      return null
    }
    const prefix = path.includes('sandbox.') ? main : gateway
    if (prefix === main)
      return [
        item(main, 99, 'a'),
        item(main, 101, 'b'),
        item(main, 99, 'c', { [`${main}owner`]: 'foreign' }),
        item(main, 'invalid', 'd'),
      ]
    const role = path.startsWith('/networks') ? 'network' : 'guard'
    return [
      item(gateway, 99, role === 'network' ? 'e' : 'f', {
        [`${gateway}resourceId`]: resource,
        [`${gateway}role`]: role,
      }),
    ]
  }
  assert.equal(await reapExpired(client, 100), 3)
  assert.deepEqual(calls, [
    `/containers/${'a'.repeat(64)}?force=1&v=1`,
    `/containers/${'f'.repeat(64)}?force=1&v=1`,
    `/networks/${'e'.repeat(64)}`,
  ])
})

test('one removal failure preserves its gateway without starving other expired turns', async () => {
  const calls = []
  const resource = '01234567-1234-1234-1234-0123456789ab'
  await assert.rejects(
    reapExpired(async (method, path) => {
      if (method === 'DELETE') {
        calls.push(path)
        if (path.includes('a'.repeat(64))) throw new Error('unavailable')
        return null
      }
      if (path.includes('sandbox.'))
        return [item(main, 99, 'a', { [`${main}gatewayId`]: resource }), item(main, 99, 'b')]
      return [
        item(gateway, 99, 'c', {
          [`${gateway}resourceId`]: resource,
          [`${gateway}role`]: path.startsWith('/networks') ? 'network' : 'guard',
        }),
      ]
    }, 100),
  )
  assert.deepEqual(calls, [
    `/containers/${'a'.repeat(64)}?force=1&v=1`,
    `/containers/${'b'.repeat(64)}?force=1&v=1`,
  ])
})

test('failed discovery does not guess whether resources exist', async () => {
  let calls = 0
  await assert.rejects(
    reapExpired(async () => {
      calls++
      throw new Error('unavailable')
    }, 100),
  )
  assert.equal(calls, 1)
})

test('expired host firewall helpers are reaped; unknown gateway roles are not', async () => {
  const calls = []
  const resource = '01234567-1234-1234-1234-0123456789ab'
  const removed = await reapExpired(async (method, path) => {
    if (method === 'DELETE') {
      calls.push(path)
      return null
    }
    if (path.includes('sandbox.') || path.startsWith('/networks')) return []
    return ['firewall', 'other'].map((role, index) =>
      item(gateway, 99, 'ab'[index], {
        [`${gateway}resourceId`]: resource,
        [`${gateway}role`]: role,
      }),
    )
  }, 100)
  assert.equal(removed, 1)
  assert.deepEqual(calls, [`/containers/${'a'.repeat(64)}?force=1&v=1`])
})

test('only absolute Unix socket paths are accepted', () => {
  for (const path of ['tcp://daemon:2375', './socket', '/tmp/a\nb'])
    assert.throws(() => dockerClient(path))
})

const preview = 'io.raditi.preview.'
const previewA = '0196abcd-0000-7000-8000-00000000000a'
const previewB = '0196abcd-0000-7000-8000-00000000000b'
const ofPreview = (id, deadline, extra = {}) => ({
  [`${preview}owner`]: 'raditi',
  [`${preview}protocol`]: '1',
  [`${preview}id`]: id,
  [`${preview}deadline`]: String(deadline),
  ...extra,
})
/** A daemon of previews: lists by kind, records deletions, can fail one of them. */
function previewDaemon({ containers = [], networks = [], volumes = [], fail = () => false }) {
  const calls = []
  const client = async (method, path) => {
    if (method === 'DELETE') {
      calls.push(path)
      if (fail(path)) throw new Error('unavailable')
      return null
    }
    assert.match(path, /io\.raditi\.preview\.owner%3Draditi/)
    if (path.startsWith('/containers')) return containers
    if (path.startsWith('/networks')) return networks
    return { Volumes: volumes }
  }
  return { client, calls }
}

test('an expired preview goes whole: containers, then networks, then volumes', async () => {
  const daemon = previewDaemon({
    containers: [
      {
        Id: 'a'.repeat(64),
        Names: [`/raditi-preview-${previewA}-web`],
        Labels: ofPreview(previewA, 99),
      },
      {
        Id: 'b'.repeat(64),
        Names: [`/raditi-preview-${previewA}-lease-99`],
        Labels: ofPreview(previewA, 99),
      },
    ],
    networks: [
      { Id: 'c'.repeat(64), Name: `raditi-preview-${previewA}`, Labels: ofPreview(previewA, 99) },
      {
        Id: 'd'.repeat(64),
        Name: `raditi-preview-${previewA}-browser`,
        Labels: ofPreview(previewA, 99),
      },
    ],
    volumes: [
      { Name: `rpv-${previewA}-files`, Labels: ofPreview(previewA, 99) },
      { Name: `rpv-${previewA}-db`, Labels: ofPreview(previewA, 99) },
    ],
  })
  assert.equal(await reapExpiredPreviews(daemon.client, 100), 6)
  assert.deepEqual(daemon.calls, [
    `/containers/${'a'.repeat(64)}?force=1&v=1`,
    `/containers/${'b'.repeat(64)}?force=1&v=1`,
    `/networks/${'c'.repeat(64)}`,
    `/networks/${'d'.repeat(64)}`,
    `/volumes/rpv-${previewA}-files`,
    `/volumes/rpv-${previewA}-db`,
  ])
})

test('a later lease keeps every resource of its preview, however old their own labels', async () => {
  const daemon = previewDaemon({
    containers: [
      {
        Id: 'a'.repeat(64),
        Names: [`/raditi-preview-${previewA}-web`],
        Labels: ofPreview(previewA, 50),
      },
      {
        Id: 'b'.repeat(64),
        Names: [`/raditi-preview-${previewA}-lease-500`],
        Labels: ofPreview(previewA, 500),
      },
      {
        Id: 'e'.repeat(64),
        Names: [`/raditi-preview-${previewB}-web`],
        Labels: ofPreview(previewB, 50),
      },
    ],
    volumes: [{ Name: `rpv-${previewA}-files`, Labels: ofPreview(previewA, 50) }],
  })
  assert.equal(await reapExpiredPreviews(daemon.client, 100), 1)
  assert.deepEqual(daemon.calls, [`/containers/${'e'.repeat(64)}?force=1&v=1`])
})

test('foreign names, foreign owners and bad deadlines are never removed', async () => {
  const daemon = previewDaemon({
    containers: [
      { Id: 'a'.repeat(64), Names: ['/someone-else'], Labels: ofPreview(previewA, 99) },
      {
        Id: 'b'.repeat(64),
        Names: [`/raditi-preview-${previewB}-web`],
        Labels: ofPreview(previewA, 99),
      },
      {
        Id: 'c'.repeat(64),
        Names: [`/raditi-preview-${previewA}-web`],
        Labels: { ...ofPreview(previewA, 99), [`${preview}owner`]: 'other' },
      },
      {
        Id: 'd'.repeat(64),
        Names: [`/raditi-preview-not-a-uuid-web`],
        Labels: ofPreview('not-a-uuid', 99),
      },
    ],
    networks: [{ Id: 'e'.repeat(64), Name: 'bridge', Labels: ofPreview(previewA, 99) }],
    volumes: [
      { Name: 'precious', Labels: ofPreview(previewA, 99) },
      { Name: `rpv-${previewB}-files`, Labels: ofPreview(previewB, 'never') },
    ],
  })
  assert.equal(await reapExpiredPreviews(daemon.client, 100), 0)
  assert.deepEqual(daemon.calls, [])
})

test('a container that stays keeps the networks and volumes of its preview', async () => {
  const daemon = previewDaemon({
    containers: [
      {
        Id: 'a'.repeat(64),
        Names: [`/raditi-preview-${previewA}-web`],
        Labels: ofPreview(previewA, 99),
      },
      {
        Id: 'b'.repeat(64),
        Names: [`/raditi-preview-${previewB}-web`],
        Labels: ofPreview(previewB, 99),
      },
    ],
    networks: [
      { Id: 'c'.repeat(64), Name: `raditi-preview-${previewA}`, Labels: ofPreview(previewA, 99) },
      { Id: 'd'.repeat(64), Name: `raditi-preview-${previewB}`, Labels: ofPreview(previewB, 99) },
    ],
    volumes: [{ Name: `rpv-${previewA}-db`, Labels: ofPreview(previewA, 99) }],
    fail: (path) => path.includes('a'.repeat(64)),
  })
  await assert.rejects(reapExpiredPreviews(daemon.client, 100))
  assert.deepEqual(daemon.calls, [
    `/containers/${'a'.repeat(64)}?force=1&v=1`,
    `/containers/${'b'.repeat(64)}?force=1&v=1`,
    `/networks/${'d'.repeat(64)}`,
  ])
})
