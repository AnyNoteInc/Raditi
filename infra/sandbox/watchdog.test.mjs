import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dockerClient, reapExpired } from './watchdog.mjs'

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

test('only absolute Unix socket paths are accepted', () => {
  for (const path of ['tcp://daemon:2375', './socket', '/tmp/a\nb'])
    assert.throws(() => dockerClient(path))
})
