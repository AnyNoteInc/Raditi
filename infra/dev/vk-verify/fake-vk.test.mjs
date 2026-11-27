import assert from 'node:assert/strict'
import { test } from 'node:test'

import { answerVk, fakeVkState, startFakeVk } from './fake-vk.mjs'

const state = () =>
  fakeVkState({
    groupId: 1001,
    name: 'Кофейня у дома',
    screenName: 'coffee',
    groupKey: 'vk1.a.group',
    serviceKey: 'service-key',
    rights: ['manage', 'wall'],
  })
const form = (fields) => new URLSearchParams({ v: '5.199', ...fields })

test('the fake takes each method only with the keys VK takes for it', () => {
  const vk = state()
  assert.deepEqual(
    answerVk(vk, 'wall.get', form({ access_token: 'vk1.a.group', owner_id: '-1001' })).error
      .error_code,
    27,
  )
  assert.deepEqual(
    answerVk(vk, 'wall.post', form({ access_token: 'service-key', owner_id: '-1001' })).error
      .error_code,
    27,
  )
  assert.equal(answerVk(vk, 'groups.getById', form({ access_token: 'nope' })).error.error_code, 5)
  assert.equal(
    answerVk(vk, 'groups.getById', new URLSearchParams({ access_token: 'vk1.a.group', v: '5.131' }))
      .error.error_code,
    8,
  )
  assert.equal(answerVk(vk, 'users.get', form({ access_token: 'vk1.a.group' })).error.error_code, 3)
  assert.deepEqual(vk.calls.map((call) => [call.method, call.key]).slice(0, 3), [
    ['wall.get', 'group'],
    ['wall.post', 'service'],
    ['groups.getById', 'unknown'],
  ])
})

test('a post from the community lands on the wall, newest first, and a reply under it', () => {
  const vk = state()
  const posted = answerVk(
    vk,
    'wall.post',
    form({
      access_token: 'vk1.a.group',
      owner_id: '-1001',
      from_group: '1',
      message: 'Открылись!',
    }),
  )
  const postId = posted.response.post_id
  const wall = answerVk(
    vk,
    'wall.get',
    form({ access_token: 'service-key', owner_id: '-1001', count: '10' }),
  )
  assert.equal(wall.response.count, 1)
  assert.equal(wall.response.items[0].text, 'Открылись!')
  answerVk(
    vk,
    'wall.createComment',
    form({
      access_token: 'vk1.a.group',
      owner_id: '-1001',
      post_id: String(postId),
      reply_to_comment: '5',
      message: 'Спасибо',
    }),
  )
  const comments = answerVk(
    vk,
    'wall.getComments',
    form({ access_token: 'service-key', owner_id: '-1001', post_id: String(postId) }),
  )
  assert.equal(comments.response.items[0].from_id, -1001)
})

test('a callback server needs the right «Управление»', () => {
  const vk = state()
  vk.keys.set('vk1.a.weak', { kind: 'group', rights: ['wall'] })
  assert.equal(
    answerVk(
      vk,
      'groups.addCallbackServer',
      form({ access_token: 'vk1.a.weak', group_id: '1001', url: 'https://x', title: 't' }),
    ).error.error_code,
    15,
  )
  const added = answerVk(
    vk,
    'groups.addCallbackServer',
    form({
      access_token: 'vk1.a.group',
      group_id: '1001',
      url: 'https://x',
      title: 't',
      secret_key: 's',
    }),
  )
  assert.equal(added.response.server_id, 1)
  assert.deepEqual(vk.servers, [{ id: 1, url: 'https://x', secret: 's' }])
})

test('the fake answers over http in the form VkHttpApi posts', async () => {
  const vk = state()
  const fake = await startFakeVk(vk)
  try {
    const response = await fetch(`${fake.baseUrl}groups.getById`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ access_token: 'vk1.a.group' }),
    })
    assert.equal((await response.json()).response.groups[0].screen_name, 'coffee')
    assert.equal((await fetch(`${fake.baseUrl}nope`)).status, 404)
  } finally {
    await fake.close()
  }
})
