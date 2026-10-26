// The pure parts of the browser-task stand (pnpm test:infra): options, names, the environments of
// the apps, the files of a task, the reading of observations and the replay of the scripted model.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { nextMove, toolAnswerOf, turnOf } from './model.mjs'
import { Page, attachmentsOf, treeLines } from './programs.mjs'
import {
  CORE_WITHOUT,
  SITE_ORIGIN,
  UPLOAD_LIMIT_BYTES,
  appEnvironment,
  leakedIn,
  localSites,
  scenariosToRun,
  solidPng,
  standNames,
  standOptions,
  syntheticPdf,
  webEnvironment,
} from './stand.mjs'

const context = {
  path: '/usr/bin',
  directory: '/tmp/run',
  ports: {
    vault: 41001,
    s3: 41002,
    site: 41003,
    web: 41004,
    core: 41005,
    mcp: 41006,
    llm: 41007,
    preview: 41008,
    stream: 41009,
    browser: 41010,
    zai: 41011,
  },
  databaseUrl: 'postgresql://raditi:x@127.0.0.1:5432/raditi',
  redisUrl: 'redis://default:x@127.0.0.1:6379',
  vault: { address: 'http://127.0.0.1:41001' },
  roles: Object.fromEntries(
    ['core', 'mcp', 'llm', 'web'].map((name) => [
      name,
      { roleId: `${name}-role`, secretId: `${name}-secret` },
    ]),
  ),
  s3: { endpoint: 'http://127.0.0.1:41002', accessKey: 'access', secretKey: 'secret' },
  secrets: {
    metrics: 'm'.repeat(48),
    auth: 'a'.repeat(48),
    previewSession: 'p'.repeat(48),
    workerToken: 'w'.repeat(48),
  },
  caFile: '/tmp/run/ca.pem',
  siteTarget: '172.17.0.9:80',
  socket: '/var/run/docker.sock',
  images: Object.fromEntries(
    ['sandbox', 'gateway', 'guard', 'egress', 'tools', 'browser'].map((name) => [
      name,
      `raditi-browser-task-verify/${name}@sha256:${'0'.repeat(64)}`,
    ]),
  ),
}

describe('options and names', () => {
  it('reads the flags and refuses anything else', () => {
    assert.deepEqual(standOptions([]), {
      build: true,
      keep: false,
      webDev: false,
      streamOnly: false,
      only: null,
    })
    assert.deepEqual(
      standOptions(['--', '--no-build', '--keep', '--web-dev', '--stream-only', '--only', 'F,K']),
      { build: false, keep: true, webDev: true, streamOnly: true, only: ['F', 'K'] },
    )
    assert.deepEqual(standOptions(['--only=L']).only, ['L'])
    assert.throws(() => standOptions(['--database=x']), /accepts/)
    assert.throws(() => standOptions(['--only', 'Z']), /Unknown scenario/)
  })

  it('runs a scenario with what it needs, in the order of the stand', () => {
    assert.deepEqual(scenariosToRun(['F']), ['A', 'D', 'E', 'F'])
    assert.deepEqual(scenariosToRun(['K', 'B']), ['A', 'D', 'B', 'K'])
    assert.equal(scenariosToRun(null).length, 13)
  })

  it('names every resource of a run under its label', () => {
    const names = standNames('0123abcd')
    assert.equal(names.label, 'io.raditi.browser-task-verify=0123abcd')
    assert.equal(names.containers['site-web'], 'raditi-browser-task-verify-0123abcd-site-web')
    assert.throws(() => standNames('nope'), /Invalid run/)
  })
})

describe('the environments of the apps', () => {
  it('gives core the worker and no git at all', () => {
    const core = appEnvironment('core', context)
    for (const name of CORE_WITHOUT) assert.equal(core[name], undefined, name)
    assert.equal(core.BROWSER_WORKER_URL, 'http://127.0.0.1:41010')
    assert.equal(core.BROWSER_WORKER_TOKEN, context.secrets.workerToken)
    assert.equal(core.TURN_EXECUTOR, 'local')
    assert.equal(core.SANDBOX_WARM_MINUTES, '0')
    assert.equal(core.NODE_ENV, 'production')
  })

  it('maps the exact origin of the site to its published port for the worker only', () => {
    const browser = appEnvironment('browser', context)
    assert.deepEqual(JSON.parse(browser.BROWSER_LOCAL_SITES), { [SITE_ORIGIN]: '172.17.0.9:80' })
    assert.equal(browser.BROWSER_LOCAL_SITES, localSites('172.17.0.9:80'))
    assert.throws(() => localSites('host.docker.internal:80'), /IPv4/)
    assert.equal(browser.S3_BUCKET_INBOX, 'raditi-inbox')
    assert.equal(browser.S3_BUCKET_SESSIONS, undefined)
    for (const app of ['core', 'mcp', 'preview', 'llm'])
      assert.equal(appEnvironment(app, context).BROWSER_LOCAL_SITES, undefined, app)
  })

  it('opens the stream gateway in preview and points web at it', () => {
    const preview = appEnvironment('preview', context)
    assert.equal(preview.BROWSER_STREAM_PORT, '41009')
    assert.equal(preview.APP_URL, 'http://127.0.0.1:41004')
    const web = webEnvironment(context)
    assert.equal(web.BROWSER_STREAM_PUBLIC_URL, 'ws://127.0.0.1:41009/v1/browser/stream')
    assert.equal(web.NODE_ENV, 'production')
    assert.equal(webEnvironment(context, { dev: true }).NODE_ENV, undefined)
  })

  it('gives mcp the worker and no content profile', () => {
    const mcp = appEnvironment('mcp', context)
    assert.equal(mcp.BROWSER_WORKER_URL, 'http://127.0.0.1:41010')
    assert.equal(mcp.MCP_CONTENT_PROFILE, undefined)
    assert.equal(mcp.S3_ENDPOINT, undefined)
  })
})

describe('the files of a task', () => {
  it('makes a valid PNG and a PDF above the limit of scenario I', () => {
    const png = solidPng(8, 4, [1, 2, 3])
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(png.readUInt32BE(16), 8)
    assert.equal(png.readUInt32BE(20), 4)
    const pdf = syntheticPdf('x', UPLOAD_LIMIT_BYTES + 10)
    assert.ok(pdf.byteLength > UPLOAD_LIMIT_BYTES)
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-')
  })

  it('names the secrets it finds, never their values', () => {
    assert.deepEqual(
      leakedIn('a password-123456 here', { password: 'password-123456', short: 'abc' }),
      ['password'],
    )
    assert.deepEqual(leakedIn('nothing', { password: 'password-123456' }), [])
  })
})

const LOGIN = `- generic [ref=e1]:
  - heading "Log In" [level=1] [ref=e2]
  - generic [ref=e5]:
    - textbox "Username or Email Address" [active] [ref=e8]
    - textbox "Password" [ref=e12]
    - button "Show password" [ref=e13] [cursor=pointer]
  - paragraph:
    - button "Log In" [ref=e21] [cursor=pointer]`

const EDITOR = `- generic [ref=f2e1]:
  - region "Editor top bar" [ref=f2e36]:
    - button "Save draft" [ref=f2e67] [cursor=pointer]
    - button "Publish" [ref=f2e76] [cursor=pointer]
  - region "Editor content" [ref=f2e82]:
    - iframe [active] [ref=f2e88]:
      - generic [ref=f3e1]:
        - textbox "Add title" [ref=f3e3]
        - 'document "Block: Paragraph" [ref=f3e11]': Текст новости.
        - 'document "Block: Image" [ref=f3e42]':
          - button "Upload" [ref=f3e48] [cursor=pointer]
        - 'document "Block: File" [ref=f3e71]':
          - button "Upload" [ref=f3e77] [cursor=pointer]
  - region "Editor publish":
    - button "Publish" [ref=f2e1246] [cursor=pointer]
  - button [ref=f2e1067] [cursor=pointer]: Set featured image
  - dialog [active] [ref=f2e1084]:
    - button "Close dialog" [ref=f2e1085] [cursor=pointer]
    - button "Set featured image" [disabled] [ref=f2e1106]`

describe('reading an observation', () => {
  it('reads roles, names, references and values of the ai tree', () => {
    const lines = treeLines(EDITOR)
    const paragraph = lines.find((line) => line.name === 'Block: Paragraph')
    assert.equal(paragraph.role, 'document')
    assert.equal(paragraph.ref, 'f3e11')
    assert.equal(paragraph.value, 'Текст новости.')
  })

  it('finds elements by role and name, inside a part of the page', () => {
    const page = new Page({ observation: 'o3', tree: EDITOR, page: { url: 'http://x/' } })
    assert.equal(page.find('button', 'Publish'), 'f2e76')
    assert.equal(page.within('region', 'Editor publish').find('button', 'Publish'), 'f2e1246')
    assert.equal(page.within('document', 'Block: File').find('button', 'Upload'), 'f3e77')
    assert.deepEqual(page.at('textbox', 'Add title'), { observation: 'o3', ref: 'f3e3' })
    assert.throws(() => page.at('button', 'Nothing'), /no button/)
  })

  it('passes over disabled elements and prefers a named one to a text', () => {
    const page = new Page({ observation: 'o4', tree: EDITOR, page: { url: 'http://x/' } })
    // The dialog's own button is disabled; outside, a button without a name has the same text.
    assert.equal(page.modal().find('button', 'Set featured image'), null)
    assert.equal(page.find('button', 'Set featured image'), 'f2e1067')
    assert.equal(page.find('button', 'Set featured image', { enabled: false }), 'f2e1106')
  })

  it('reads the files of the task from the request of the platform', () => {
    const prompt = `Опубликуйте.\n\n---\nThe site of this task: http://wp.raditi.test\n\nFiles the client sent with this task (upload them with web_upload by id):\n- 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b: fasad.png, image/png, 1.2 KiB\n- 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c: prais.pdf, application/pdf, 2.1 KiB`
    assert.deepEqual(attachmentsOf(prompt), [
      { id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', name: 'fasad.png', type: 'image/png' },
      { id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c', name: 'prais.pdf', type: 'application/pdf' },
    ])
  })
})

describe('the scripted model', () => {
  const body = (steps) => ({
    tools: ['web_open', 'web_observe', 'web_help', 'web_upload'].map((tool) => ({
      function: { name: `raditi_${tool}` },
    })),
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'Добавьте новость.' },
      ...steps.flatMap(([name, args, answer], index) => [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: `c${index}`,
              function: { name: `raditi_${name}`, arguments: JSON.stringify(args) },
            },
          ],
        },
        { role: 'tool', tool_call_id: `c${index}`, content: JSON.stringify(answer) },
      ]),
    ],
  })
  const program = function* (_ctx, facts) {
    const opened = yield { tool: 'web_open', args: { url: '/wp-admin/' } }
    facts.dashboard = opened.code ?? null
    const tree = yield { tool: 'web_observe', args: {} }
    facts.login = new Page(tree).find('textbox', 'Password') !== null
    return { final: 'done' }
  }

  it('replays the calls the CLI made and answers the next one', () => {
    const first = nextMove(program, {}, turnOf(body([])).steps)
    assert.deepEqual(first.call, { tool: 'web_open', args: { url: '/wp-admin/' } })
    const second = nextMove(
      program,
      {},
      turnOf(
        body([
          ['web_open', { url: '/wp-admin/' }, { code: 'BROWSER_ACTION_DENIED', message: 'x' }],
        ]),
      ).steps,
    )
    assert.deepEqual(second.call, { tool: 'web_observe', args: {} })
    assert.equal(second.facts.dashboard, 'BROWSER_ACTION_DENIED')
    const last = nextMove(
      program,
      {},
      turnOf(
        body([
          ['web_open', { url: '/wp-admin/' }, { code: 'BROWSER_ACTION_DENIED', message: 'x' }],
          [
            'web_observe',
            {},
            { observation: 'o1', tree: LOGIN, page: { url: 'http://x/wp-login.php' } },
          ],
        ]),
      ).steps,
    )
    assert.equal(last.final, 'done')
    assert.equal(last.facts.login, true)
  })

  it('stops when the CLI made a call the program did not', () => {
    const move = nextMove(
      program,
      {},
      turnOf(body([['web_help', { reason: 'login', message: 'x' }, {}]])).steps,
    )
    assert.match(move.broken, /web_help/)
  })

  it('reads an answer of a tool as JSON, an MCP envelope or plain text', () => {
    assert.deepEqual(toolAnswerOf('{"a":1}'), { a: 1 })
    assert.deepEqual(toolAnswerOf([{ type: 'text', text: '{"b":2}' }]), { b: 2 })
    assert.deepEqual(toolAnswerOf('{"content":[{"type":"text","text":"{\\"c\\":3}"}]}'), { c: 3 })
    assert.deepEqual(toolAnswerOf('oops'), { text: 'oops' })
  })

  it('cuts a call whose answer has not come yet', () => {
    const request = body([['web_open', { url: '/wp-admin/' }, {}]])
    request.messages.pop()
    assert.deepEqual(turnOf(request), { prompt: 'Добавьте новость.', steps: [], open: true })
  })
})
