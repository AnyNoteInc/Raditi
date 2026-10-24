// A viewer of the stream of a task's browser, the way a tab of the cabinet speaks to the stream
// gateway (docs/plan/57-browser-tasks.md, §3.6): a WebSocket from the cabinet's own Origin, the
// ticket as the first message, the frames decoded with the codec of the domain and acknowledged
// one by one, pings answered; then «Взять управление», input with the latest page, epoch and size
// of the window, «Продолжить работу агента». Everything the gateway sent is kept for the checks.
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * `ws` of the build copy (the package the gateway itself is built on) and the codec and the
 * parsers of the copy's domain: what the client reads is read as the product reads it.
 */
export function streamTools(copy, domain) {
  const require = createRequire(join(copy, 'packages/browser-link/package.json'))
  return { WebSocket: require('ws'), domain }
}

/**
 * Opens a viewer: `url` of the gateway, `origin` of the cabinet, `ticket` of `browser.streamTicket`.
 * `hello: false` sends no ticket (the gateway must close the connection on its own); `ack: false`
 * leaves frames unacknowledged.
 */
export function openViewer(tools, { url, origin, ticket, hello = true, ack = true }) {
  const { WebSocket, domain } = tools
  const socket = new WebSocket(url, { origin, handshakeTimeout: 15_000 })
  const viewer = {
    socket,
    messages: [],
    frames: [],
    refusals: [],
    closed: null,
    viewerId: null,
    state: null,
    opened: new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
      socket.once('unexpected-response', (_request, response) =>
        reject(
          Object.assign(new Error(`upgrade refused ${response.statusCode}`), {
            status: response.statusCode,
          }),
        ),
      )
    }),
    send(message) {
      socket.send(JSON.stringify(message))
    },
    /** Input with the page, epoch and window of the latest state, as the cabinet sends it. */
    input(event, state = viewer.state) {
      viewer.send({
        t: 'input',
        pageId: state.pageId,
        controlEpoch: state.controlEpoch,
        viewportVersion: state.viewportVersion,
        event,
      })
    },
    /** A printable text as text, every key of `keys` as a key press. */
    key(key, { code = '', modifiers = [] } = {}) {
      viewer.input({ kind: 'key', type: 'down', key, code, modifiers })
      viewer.input({ kind: 'key', type: 'up', key, code, modifiers })
    },
    text(text) {
      viewer.input({ kind: 'text', text })
    },
    holds() {
      return (
        viewer.state !== null &&
        viewer.state.controller === 'user' &&
        viewer.state.holder === viewer.viewerId &&
        viewer.state.manualReady
      )
    },
    close() {
      try {
        socket.close(1000)
      } catch {
        // Gone already.
      }
    },
  }
  socket.binaryType = 'nodebuffer'
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      const frame = domain.decodeBrowserFrame(bytes)
      if (frame === null) {
        viewer.messages.push({ t: 'bad-frame', size: bytes.byteLength })
        return
      }
      viewer.frames.push({ ...frame.header, jpeg: Buffer.from(frame.jpeg), at: Date.now() })
      if (ack && socket.readyState === 1)
        socket.send(JSON.stringify({ t: 'ack', frameSeq: frame.header.frameSeq }))
      return
    }
    const message = domain.parseBrowserServerMessage(String(data))
    if (message === null) {
      viewer.messages.push({ t: 'unparsed' })
      return
    }
    viewer.messages.push({ ...message, at: Date.now() })
    if (message.t === 'viewer') viewer.viewerId = message.viewer
    if (message.t === 'state') viewer.state = message
    if (message.t === 'refused') viewer.refusals.push(message.reason)
    if (message.t === 'ping' && socket.readyState === 1)
      socket.send(JSON.stringify({ t: 'pong', ts: message.ts }))
  })
  socket.on('close', (code, reason) => {
    viewer.closed = { code, reason: String(reason), at: Date.now() }
  })
  socket.on('error', () => {})
  if (hello)
    viewer.opened.then(
      () => socket.send(JSON.stringify({ t: 'hello', ticket })),
      () => {},
    )
  return viewer
}

/**
 * The client acting over a raw viewer, with the verbs of the cabinet operator (cabinet.mjs): what
 * the canvas of the cabinet would send for the same keys.
 */
export function streamOperator(stand, viewer) {
  const until = (what, check, timeoutMs = 30_000) =>
    stand.rt.until(what, async () => check(), { timeoutMs, intervalMs: 50 })
  const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta'])
  return {
    kind: 'stream',
    viewer,
    state: () => viewer.state,
    holds: () => viewer.holds(),
    async take() {
      viewer.send({ t: 'take' })
      await until('the viewer to hold control', () => viewer.holds())
    },
    async navigate(url) {
      viewer.send({ t: 'navigate', url })
    },
    async type(text) {
      viewer.text(text)
    },
    /** `Tab`, `Enter`, `Escape`, `Control+s`: a key with its modifiers, down then up. */
    async press(combo) {
      const parts = combo.split('+')
      const key = parts.pop()
      const modifiers = parts.filter((part) => MODIFIERS.has(part))
      const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
      viewer.key(key, { code, modifiers })
    },
    async resume() {
      throw new Error('«Продолжить работу агента» of a waiting task is task.resumeAgent')
    },
    close: () => viewer.close(),
  }
}

/** Whether a JPEG is a picture with more than one colour: a painted page, not a blank one. */
export function jpegLooksPainted(jpeg) {
  // The entropy-coded data of a single-colour JPEG of 1280×800 is a few hundred bytes; a page
  // with text and fields is tens of kilobytes. The header alone is ~600 bytes.
  return jpeg.byteLength > 8 * 1024 && jpeg[0] === 0xff && jpeg[1] === 0xd8
}
