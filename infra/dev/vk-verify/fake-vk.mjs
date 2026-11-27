// The fake of api.vk.com of the stand `pnpm verify:vk` (docs/plan/99-vk-community.md, slice 99.8):
// the methods Raditi calls, each with the kinds of key VK takes for it (the schema of VK API,
// `access_token_type`, plan 99 §1), answering in the shapes of version 5.199. One community, its
// wall and the comments of its posts live in memory; every call is kept, so the stand can say what
// went to VK and with which key.
import { createServer } from 'node:http'

/** The kinds of key a method takes, as the schema of VK API names them. */
export const methodKeys = Object.freeze({
  'groups.getById': ['group', 'service'],
  'groups.getTokenPermissions': ['group'],
  'groups.getCallbackConfirmationCode': ['group'],
  'groups.addCallbackServer': ['group'],
  'groups.setCallbackSettings': ['group'],
  'groups.deleteCallbackServer': ['group'],
  'wall.get': ['service'],
  'wall.getComments': ['service'],
  // The schema says `user`; developers publish with the key of a community (plan 99, §1).
  'wall.post': ['group'],
  'wall.createComment': ['group'],
})

/**
 * The state of the fake: `keys` — a key → its kind and community; `group` — the community;
 * `posts`, `comments` — its wall; `calls` — every call as it came, its key named by its kind.
 */
export function fakeVkState({ groupId, name, screenName, groupKey, serviceKey, rights }) {
  return {
    group: { id: groupId, name, screen_name: screenName, is_closed: 0 },
    keys: new Map([
      [groupKey, { kind: 'group', rights }],
      [serviceKey, { kind: 'service' }],
    ]),
    posts: [],
    comments: [],
    servers: [],
    calls: [],
    nextId: 100,
  }
}

const error = (code) => ({ error: { error_code: code, error_msg: `fake error ${code}` } })

/** The answer of one method to one form, and what it changed in the state. */
export function answerVk(state, method, form) {
  const kinds = methodKeys[method]
  const key = state.keys.get(form.get('access_token') ?? '')
  state.calls.push({ method, key: key?.kind ?? 'unknown', form: Object.fromEntries(form) })
  if (!kinds) return error(3)
  if (form.get('v') !== '5.199') return error(8)
  if (!key) return error(5)
  if (!kinds.includes(key.kind)) return error(27)
  const groupOk = (field) => Math.abs(Number(form.get(field))) === state.group.id
  switch (method) {
    case 'groups.getById':
      return { response: { groups: [state.group], profiles: [] } }
    case 'groups.getTokenPermissions':
      return {
        response: { mask: 0, permissions: key.rights.map((name) => ({ setting: 1, name })) },
      }
    case 'groups.getCallbackConfirmationCode':
      return groupOk('group_id') ? { response: { code: 'fakec0de' } } : error(15)
    case 'groups.addCallbackServer': {
      if (!groupOk('group_id') || !key.rights.includes('manage')) return error(15)
      const server = {
        id: state.servers.length + 1,
        url: form.get('url'),
        secret: form.get('secret_key'),
      }
      state.servers.push(server)
      return { response: { server_id: server.id } }
    }
    case 'groups.setCallbackSettings':
      return groupOk('group_id') ? { response: 1 } : error(15)
    case 'groups.deleteCallbackServer':
      state.servers = state.servers.filter((server) => String(server.id) !== form.get('server_id'))
      return { response: 1 }
    case 'wall.get': {
      if (!groupOk('owner_id')) return error(15)
      const newest = [...state.posts].reverse()
      const offset = Number(form.get('offset') ?? 0)
      const items = newest.slice(offset, offset + Number(form.get('count') ?? 20))
      return { response: { count: newest.length, items } }
    }
    case 'wall.getComments': {
      const postId = Number(form.get('post_id'))
      const items = state.comments.filter((comment) => comment.post_id === postId)
      return { response: { count: items.length, items } }
    }
    case 'wall.post': {
      if (!groupOk('owner_id') || form.get('from_group') !== '1') return error(15)
      const id = state.nextId++
      state.posts.push({
        id,
        date: Number(form.get('publish_date') ?? Math.floor(Date.now() / 1000)),
        text: form.get('message') ?? '',
        views: { count: 0 },
        likes: { count: 0 },
        reposts: { count: 0 },
        comments: { count: 0 },
      })
      return { response: { post_id: id } }
    }
    case 'wall.createComment': {
      if (!groupOk('owner_id')) return error(15)
      const id = state.nextId++
      state.comments.push({
        id,
        from_id: -state.group.id,
        post_id: Number(form.get('post_id')),
        reply_to_comment: Number(form.get('reply_to_comment')),
        date: Math.floor(Date.now() / 1000),
        text: form.get('message') ?? '',
      })
      return { response: { comment_id: id, parents_stack: [] } }
    }
    default:
      return error(3)
  }
}

/** Serves the fake on 127.0.0.1 at a free port: `baseUrl` is what VkHttpApi takes. */
export async function startFakeVk(state) {
  const server = createServer((request, response) => {
    const match = /^\/method\/([a-z]+\.[A-Za-z]+)$/.exec(request.url ?? '')
    if (request.method !== 'POST' || !match) {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(answerVk(state, match[1], form)))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}/method/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
