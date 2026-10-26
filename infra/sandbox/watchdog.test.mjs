import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dockerClient, reapExpired, reapExpiredBrowsers, reapExpiredPreviews } from './watchdog.mjs'

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
const ofPreview = (id, deadline, extra = {}, protocol = '1') => ({
  [`${preview}owner`]: 'raditi',
  [`${preview}protocol`]: protocol,
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
    // Every protocol is listed: the watchdog tells them apart itself.
    assert.doesNotMatch(path, /protocol/)
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

test('a preview of plan 58 — one container `preview` — goes like one of plan 53', async () => {
  const two = (id, deadline) => ofPreview(id, deadline, {}, '2')
  const daemon = previewDaemon({
    containers: [
      {
        Id: 'a'.repeat(64),
        Names: [`/raditi-preview-${previewA}-preview`],
        Labels: two(previewA, 99),
      },
      {
        Id: 'b'.repeat(64),
        Names: [`/raditi-preview-${previewA}-lease-99`],
        Labels: two(previewA, 99),
      },
      // A preview of protocol 1 still on the host, and one of protocol 2 ahead of its deadline.
      {
        Id: 'c'.repeat(64),
        Names: [`/raditi-preview-${previewB}-web`],
        Labels: ofPreview(previewB, 99),
      },
      {
        Id: 'd'.repeat(64),
        Names: [`/raditi-preview-${previewB}-preview`],
        Labels: ofPreview(previewB, 500, {}, '2'),
      },
      // An unknown protocol is never ours to remove.
      {
        Id: 'e'.repeat(64),
        Names: [`/raditi-preview-${previewA}-other`],
        Labels: ofPreview(previewA, 99, {}, '3'),
      },
    ],
    networks: [
      { Id: 'f'.repeat(64), Name: `raditi-preview-${previewA}`, Labels: two(previewA, 99) },
    ],
    volumes: [
      { Name: `rpv-${previewA}-files`, Labels: two(previewA, 99) },
      { Name: `rpv-${previewA}-db`, Labels: two(previewA, 99) },
    ],
  })
  assert.equal(await reapExpiredPreviews(daemon.client, 100), 5)
  assert.deepEqual(daemon.calls, [
    `/containers/${'a'.repeat(64)}?force=1&v=1`,
    `/containers/${'b'.repeat(64)}?force=1&v=1`,
    `/networks/${'f'.repeat(64)}`,
    `/volumes/rpv-${previewA}-files`,
    `/volumes/rpv-${previewA}-db`,
  ])
})

const browser = 'io.raditi.browser.'
const sessionA = '0196abcd-0000-7000-8000-0000000000a1'
const sessionB = '0196abcd-0000-7000-8000-0000000000b2'
const ofSession = (id, deadline, role, extra = {}) => ({
  [`${browser}owner`]: 'raditi',
  [`${browser}protocol`]: '1',
  [`${browser}session`]: id,
  [`${browser}task`]: '0196abcd-0000-7000-8000-0000000000c3',
  [`${browser}site`]: '0196abcd-0000-7000-8000-0000000000d4',
  [`${browser}deadline`]: String(deadline),
  [`${browser}role`]: role,
  ...extra,
})
/** A daemon of browser sessions: lists by kind, records deletions, can fail one of them. */
function browserDaemon({ containers = [], networks = [], fail = () => false }) {
  const calls = []
  const client = async (method, path) => {
    if (method === 'DELETE') {
      calls.push(path)
      if (fail(path)) throw new Error('unavailable')
      return null
    }
    assert.match(path, /io\.raditi\.browser\.owner%3Draditi/)
    if (path.startsWith('/containers')) return containers
    if (path.startsWith('/networks')) return networks
    assert.fail(`unexpected ${path}`)
  }
  return { client, calls }
}
const sessionContainer = (id, letter, role, deadline, name = `/raditi-browser-${id}-${role}`) => ({
  Id: letter.repeat(64),
  Names: [name],
  Labels: ofSession(id, deadline, role),
})

test('an expired browser session goes whole: its containers, then its network', async () => {
  const daemon = browserDaemon({
    containers: [
      sessionContainer(sessionA, 'a', 'browser', 99),
      sessionContainer(sessionA, 'b', 'egress', 99),
      sessionContainer(sessionA, 'c', 'forwarder', 99),
      // Alive: another session, ahead of its deadline.
      sessionContainer(sessionB, 'd', 'browser', 500),
    ],
    networks: [
      {
        Id: 'e'.repeat(64),
        Name: `raditi-browser-${sessionA}`,
        Labels: ofSession(sessionA, 99, 'network'),
      },
      {
        Id: 'f'.repeat(64),
        Name: `raditi-browser-${sessionB}`,
        Labels: ofSession(sessionB, 500, 'network'),
      },
    ],
  })
  assert.equal(await reapExpiredBrowsers(daemon.client, 100), 4)
  assert.deepEqual(daemon.calls, [
    `/containers/${'a'.repeat(64)}?force=1&v=1`,
    `/containers/${'b'.repeat(64)}?force=1&v=1`,
    `/containers/${'c'.repeat(64)}?force=1&v=1`,
    `/networks/${'e'.repeat(64)}`,
  ])
})

test('a browser session lives until the latest deadline of any of its resources', async () => {
  const daemon = browserDaemon({
    containers: [
      sessionContainer(sessionA, 'a', 'browser', 50),
      // A host firewall helper of a moment ago: its own deadline is later than the session's.
      sessionContainer(sessionA, 'b', 'firewall', 150, `/raditi-browser-${sessionA}-firewall-x`),
    ],
    networks: [
      {
        Id: 'c'.repeat(64),
        Name: `raditi-browser-${sessionA}`,
        Labels: ofSession(sessionA, 50, 'network'),
      },
    ],
  })
  assert.equal(await reapExpiredBrowsers(daemon.client, 100), 0)
  assert.equal(await reapExpiredBrowsers(daemon.client, 150), 3)
})

test('foreign names, owners and bad labels of browser sessions are never removed', async () => {
  const daemon = browserDaemon({
    containers: [
      sessionContainer(sessionA, 'a', 'browser', 99, '/someone-else'),
      sessionContainer(sessionA, 'b', 'browser', 99, `/raditi-browser-${sessionB}-browser`),
      sessionContainer(sessionA, 'c', 'browser', 99, `/raditi-preview-${sessionA}-browser`),
      {
        ...sessionContainer(sessionA, 'd', 'browser', 99),
        Labels: { ...ofSession(sessionA, 99, 'browser'), [`${browser}owner`]: 'other' },
      },
      {
        Id: 'e'.repeat(64),
        Names: ['/raditi-browser-not-a-uuid-browser'],
        Labels: ofSession('not-a-uuid', 99, 'browser'),
      },
      {
        ...sessionContainer(sessionB, 'f', 'browser', 99),
        Labels: ofSession(sessionB, 'never', 'browser'),
      },
    ],
    networks: [
      { Id: '1'.repeat(64), Name: 'bridge', Labels: ofSession(sessionA, 99, 'network') },
      {
        Id: '2'.repeat(64),
        Name: `raditi-preview-${sessionA}-browser`,
        Labels: ofSession(sessionA, 99, 'network'),
      },
    ],
  })
  assert.equal(await reapExpiredBrowsers(daemon.client, 100), 0)
  assert.deepEqual(daemon.calls, [])
})

test('a browser container that stays keeps its network; other sessions still go', async () => {
  const daemon = browserDaemon({
    containers: [
      sessionContainer(sessionA, 'a', 'browser', 99),
      sessionContainer(sessionB, 'b', 'browser', 99),
    ],
    networks: [
      {
        Id: 'c'.repeat(64),
        Name: `raditi-browser-${sessionA}`,
        Labels: ofSession(sessionA, 99, 'network'),
      },
      {
        Id: 'd'.repeat(64),
        Name: `raditi-browser-${sessionB}`,
        Labels: ofSession(sessionB, 99, 'network'),
      },
    ],
    fail: (path) => path.includes('a'.repeat(64)),
  })
  await assert.rejects(reapExpiredBrowsers(daemon.client, 100))
  assert.deepEqual(daemon.calls, [
    `/containers/${'a'.repeat(64)}?force=1&v=1`,
    `/containers/${'b'.repeat(64)}?force=1&v=1`,
    `/networks/${'d'.repeat(64)}`,
  ])
})
