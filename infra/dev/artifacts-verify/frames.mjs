// The frame of a mockup in real browsers (docs/plan/88-artifacts.md, Ар9, Ар12, Ар28–Ар30, §7.13;
// slices 88.12 and 88.13; spikes 1 and 2), part of `pnpm verify:artifacts`. Two https servers on
// loopback with a certificate made for the run: the root of the pages answers `/v/<segment>` as web
// does — the frame of a mockup assembled by @repo/trpc from PostgreSQL with its headers, its file by
// a signed address, the font of the platform by `/v/lib-….<hash>` — and the cabinet answers a page
// that frames it and the edit frame `/api/artifact-frame/<token>`, plus a collector of hits for what
// would leak. Chromium (the full build) and WebKit run here; Firefox runs in the Playwright image of
// Docker (it does not start on macOS, spike 1) and reaches the servers by host.docker.internal.
// The font is checked by the width of a text and `FontFace.status`, never `document.fonts.check()`.

import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PLAYWRIGHT_IMAGE = 'mcr.microsoft.com/playwright:v1.63.0-noble'

/** What the frame's own script reports: everything a mockup may and may not do in its frame. */
const PROBE = `
const say = (m) => parent.postMessage({ probe: m }, '*')
const result = { classic: true }
try { localStorage.setItem('x', '1'); result.storage = 'open' } catch { result.storage = 'closed' }
try { result.popup = window.open('https://example.com/') === null ? 'closed' : 'open' } catch { result.popup = 'closed' }
result.style = getComputedStyle(document.getElementById('styled')).color
const image = document.getElementById('picture')
const font = async () => {
  await document.fonts.load('16px "Golos Text"', 'Привет')
  const faces = [...document.fonts].filter((face) => face.family.replace(/["']/g, '') === 'Golos Text')
  const width = (family) => {
    const span = document.createElement('span')
    span.style.cssText = 'font-size:40px;position:absolute;white-space:nowrap;font-family:' + family
    span.textContent = 'Привет, мир — 12345'
    document.body.append(span)
    const w = span.getBoundingClientRect().width
    span.remove()
    return w
  }
  return { loaded: faces.some((face) => face.status === 'loaded'), differs: width('"Golos Text", monospace') !== width('monospace') }
}
const network = async () => {
  try { await fetch(location.origin + '/v/x'); return 'open' } catch { return 'closed' }
}
Promise.all([font(), network(), new Promise((ok) => image.complete ? ok() : (image.onload = image.onerror = ok))]).then(([f, n]) => {
  result.font = f
  result.network = n
  result.image = image.naturalWidth
  result.module = window.__module === true
  say(result)
})
`

function certificate(dir) {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }
}

const listen = (server) =>
  new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)))

export async function framesInBrowsers({ root, databaseUrl, check }) {
  const dbModule = await import(resolve(root, 'packages/db/src/index.ts'))
  const frames = await import(resolve(root, 'packages/trpc/src/services/artifacts/frame.ts'))
  const tokens = await import(resolve(root, 'packages/trpc/src/services/chat/page-tokens.ts'))
  const domain = await import(resolve(root, 'packages/domain/src/index.ts'))
  const artifacts = await import(resolve(root, 'packages/domain/src/artifacts/index.ts'))
  const doc = await import(resolve(root, 'packages/doc-bridge/src/index.ts'))
  const { artifactFontSources } = await import(
    resolve(root, 'apps/web/src/server/artifact-fonts.generated.ts')
  )
  const { chromium, webkit, firefox } = (
    await import(
      resolve(
        root,
        'node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/index.js',
      )
    )
  ).default
  const db = dbModule.createPrismaClient({ databaseUrl, log: [] })
  const dir = mkdtempSync(join(tmpdir(), 'raditi-frames-'))
  const tls = certificate(dir)
  const keys = tokens.pageKeys(randomBytes(24).toString('hex'))
  const objects = new Map()
  const storage = {
    get: async (_bucket, key) =>
      objects.has(key)
        ? (async function* () {
            yield objects.get(key)
          })()
        : null,
  }
  // The fonts of the platform as web serves them (apps/web/src/server/artifact-platform.ts).
  const platform = Object.entries(artifactFontSources).map(([label, source]) => {
    const bytes = Buffer.from(source.base64, 'base64')
    return { label, bytes, hash: createHash('sha256').update(bytes).digest('hex').slice(0, 16) }
  })
  const hits = []
  let host = { pages: '', cabinet: '' }
  const chat = () => ({
    pageViews: { origin: host.pages, appUrl: host.cabinet, keys },
    storage: () => storage,
  })
  const fonts = () => {
    const urls = platform.map(
      (file) => `${host.pages}${artifacts.artifactPlatformPath(file.label, file.hash)}`,
    )
    return {
      urls,
      css: urls
        .map(
          (url) =>
            `@font-face{font-family:'Golos Text';font-weight:400 900;src:url(${url}) format('woff2')}`,
        )
        .join(''),
    }
  }
  const send = (response, status, headers, body) => {
    response.writeHead(status, headers)
    response.end(body)
  }

  const pages = createServer(tls, async (request, response) => {
    const url = new URL(request.url, 'https://x')
    if (url.pathname === '/hit') {
      hits.push(url.searchParams.get('v'))
      return send(response, 204, {})
    }
    const segment = url.pathname.startsWith('/v/') ? url.pathname.slice(3) : ''
    const lib = artifacts.readArtifactPlatformToken(segment)
    if (lib) {
      const file = platform.find((each) => each.label === lib.label && each.hash === lib.hash)
      if (!file) return send(response, 404, {}, '')
      return send(response, 200, artifacts.artifactPlatformFileHeaders('font/woff2'), file.bytes)
    }
    if (frames.isArtifactFileToken(chat(), segment)) {
      const served = await frames.serveArtifactFile(db, chat(), { token: segment })
      if (!served.ok) return send(response, served.status, {}, '')
      return send(
        response,
        200,
        artifacts.artifactFileHeaders(domain.pageFileHeaders(served.type)),
        Buffer.from(served.bytes),
      )
    }
    const served = await frames.serveArtifactFrame(db, chat(), {
      token: segment,
      mode: 'view',
      fonts: fonts(),
    })
    if (!served.ok) return send(response, served.status, {}, '')
    send(response, 200, artifacts.artifactFrameHeaders(host.cabinet, served.sources), served.html)
  })
  const cabinet = createServer(tls, async (request, response) => {
    const url = new URL(request.url, 'https://x')
    if (url.pathname.startsWith('/api/artifact-frame/')) {
      // As web's route: only a frame of the cabinet's own origin asks for it.
      if (
        request.headers['sec-fetch-dest'] !== 'iframe' ||
        request.headers['sec-fetch-site'] !== 'same-origin'
      )
        return send(response, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Не найдено')
      const served = await frames.serveArtifactFrame(db, chat(), {
        token: url.pathname.slice('/api/artifact-frame/'.length),
        mode: 'edit',
        fonts: fonts(),
      })
      if (!served.ok) return send(response, served.status, {}, '')
      return send(response, 200, artifacts.artifactEditFrameHeaders(host.pages), served.html)
    }
    if (url.pathname === '/hit') {
      hits.push(url.searchParams.get('v'))
      return send(response, 204, {})
    }
    send(
      response,
      200,
      {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'self'; script-src 'unsafe-inline'; frame-src 'self' ${host.pages}; style-src 'unsafe-inline'`,
      },
      `<!doctype html><html><body><script>window.__messages=[];window.__ran=[];addEventListener('message',(e)=>{__messages.push({origin:e.origin,data:e.data});if(typeof e.data==='string'&&e.data.startsWith('ran:'))__ran.push(e.data.slice(4))})</script></body></html>`,
    )
  })
  const pagesPort = await listen(pages)
  const cabinetPort = await listen(cabinet)

  const user = await db.user.create({
    data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
  })
  const workspace = await db.workspace.create({
    data: { name: 'Synthetic frames', dataClass: 'synthetic', createdById: user.id },
  })
  await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
  const person = { kind: 'user', userId: user.id }
  const { id: artifactId } = await dbModule.createArtifact(db, {
    workspaceId: workspace.id,
    kind: 'mockup',
    title: 'Проверка рамки',
    actor: person,
  })
  const file = await dbModule.startArtifactFileUpload(db, {
    userId: user.id,
    artifactId,
    name: 'pixel.png',
    sizeBytes: PNG.byteLength,
  })
  objects.set(file.objectKey, PNG)
  await dbModule.markArtifactFileReady(db, {
    id: file.id,
    contentType: 'image/png',
    sizeBytes: PNG.byteLength,
    sha256: createHash('sha256').update(PNG).digest('hex'),
  })
  const ref = artifacts.artifactFileRef(file.id)
  const browsersOut = []
  let docker = null
  try {
    // The vectors of spike 1 that must run in no engine of the edit frame; the hit goes to the
    // cabinet's collector — the only place the edit frame may reach.
    const vector = (name) =>
      `(function(){try{top.postMessage('ran:${name}','*')}catch(e){}try{document.documentElement.setAttribute('data-ran','${name}')}catch(e){}try{(new Image()).src='/hit?v=${name}'}catch(e){}})()`
    const attr = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    const vectors = [
      `<img alt="" src="data:image/png;base64,AAAA" onerror="${attr(vector('img-onerror'))}">`,
      `<svg width="1" height="1" onload="${attr(vector('svg-onload'))}"></svg>`,
      `<details open ontoggle="${attr(vector('details-ontoggle'))}"><summary>Ещё</summary>текст</details>`,
      `<input autofocus onfocus="${attr(vector('input-autofocus'))}">`,
      `<iframe width="5" height="5" srcdoc="${attr(`<script>${vector('iframe-srcdoc')}</script>`)}"></iframe>`,
      `<object width="5" height="5" type="text/html" data="data:text/html,${encodeURIComponent(`<script>${vector('object-data')}</script>`)}"></object>`,
      `<svg width="1" height="1"><script>${vector('svg-script')}</script></svg>`,
    ].join('')
    await dbModule.applyArtifactOps(db, {
      batch: {
        artifactId,
        opId: randomUUID(),
        ops: [
          {
            op: 'insert',
            block: 'look',
            after: null,
            kind: 'style',
            content: '#styled{color:rgb(1, 2, 3)}',
          },
          {
            op: 'insert',
            block: 'page',
            after: 'look',
            kind: 'html',
            content: `<main><h1 id="styled">Кофейня «Колос»</h1><p>Свежий <b>хлеб</b> каждый день</p><img id="picture" alt="Пиксель" src="${ref}"><a id="away" href="https://example.com/zakaz">Заказать</a>${vectors}<script>${vector('inline-script')}</script></main>`,
          },
          {
            op: 'insert',
            block: 'conf',
            after: 'page',
            kind: 'settings',
            content: '{"price":1200}',
          },
          { op: 'insert', block: 'run', after: 'conf', kind: 'script', content: PROBE },
          {
            op: 'insert',
            block: 'mod',
            after: 'run',
            kind: 'script',
            content: 'window.__module = true',
          },
        ],
      },
      actor: person,
    })
    // The block a person edits by «Править текст»: the stamped id of the paragraph.
    const pageBlock = (await dbModule.readArtifact(db, { artifactId, actor: person })).blocks.find(
      (block) => block.key === 'page',
    )
    const stamped = doc.stampArtifactHtml('page', pageBlock.content)
    const paragraph = /<p data-rid="([^"]+)"/.exec(stamped)?.[1]

    const engines = [
      {
        name: 'chromium',
        open: () => chromium.launch({ channel: 'chromium', headless: true }),
        hostName: { pages: '127.0.0.1', cabinet: 'localhost' },
      },
      {
        name: 'webkit',
        open: () => webkit.launch({ headless: true }),
        hostName: { pages: '127.0.0.1', cabinet: 'localhost' },
      },
      {
        name: 'firefox',
        hostName: { pages: 'host.docker.internal', cabinet: 'host.docker.internal' },
        open: async () => {
          const name = `raditi-artifacts-firefox-${randomBytes(4).toString('hex')}`
          const core = resolve(
            root,
            'node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core',
          )
          const started = spawn('docker', [
            'run',
            '-d',
            '--rm',
            '--pull=never',
            '--name',
            name,
            '--label',
            'raditi.artifacts-verify=1',
            '-p',
            '127.0.0.1::3000',
            '-v',
            `${core}:/pw:ro`,
            PLAYWRIGHT_IMAGE,
            'node',
            '-e',
            "require('/pw').firefox.launchServer({port:3000,host:'0.0.0.0',wsPath:'/ff',headless:true}).then(()=>setInterval(()=>{},1e6))",
          ])
          await new Promise((done) => started.on('close', done))
          docker = name
          for (let attempt = 0; attempt < 60; attempt += 1) {
            try {
              const port = execFileSync('docker', ['port', name, '3000/tcp'])
                .toString()
                .split('\n')[0]
                .trim()
              return await firefox.connect(`ws://${port}/ff`, { timeout: 2000 })
            } catch {
              await sleep(1000)
            }
          }
          throw new Error('Firefox did not start in Docker')
        },
      },
    ]
    for (const engine of engines) {
      host = {
        pages: `https://${engine.hostName.pages}:${pagesPort}`,
        cabinet: `https://${engine.hostName.cabinet}:${cabinetPort}`,
      }
      hits.length = 0
      const browser = await engine.open()
      browsersOut.push(browser)
      const context = await browser.newContext({ ignoreHTTPSErrors: true })
      const page = await context.newPage()
      await page.goto(`${host.cabinet}/cabinet`)
      const expires = Date.now() + 5 * 60_000
      const viewToken = tokens.signArtifactToken(keys.view, 'artifact', {
        artifactId,
        userId: user.id,
        expiresAt: expires,
      })
      await page.evaluate(
        ({ src, sandbox }) => {
          const frame = document.createElement('iframe')
          frame.setAttribute('sandbox', sandbox)
          frame.id = 'view'
          frame.width = '600'
          frame.height = '600'
          frame.src = src
          document.body.append(frame)
        },
        { src: `${host.pages}/v/${viewToken}`, sandbox: artifacts.ARTIFACT_SANDBOX },
      )
      const probe = await page
        .waitForFunction(
          () => window.__messages.find((m) => m.data && m.data.probe)?.data.probe,
          null,
          { timeout: 15_000 },
        )
        .then((handle) => handle.jsonValue())
      const bridge = await page.evaluate(() =>
        window.__messages.filter((m) => m.data && m.data.bridge),
      )
      check(
        `${engine.name}: the frame runs the mockup’s classic and module scripts and its style`,
        probe.classic && probe.module && probe.style === 'rgb(1, 2, 3)',
        JSON.stringify(probe),
      )
      check(
        `${engine.name}: the font of the platform loads (FontFace and the width of a text)`,
        probe.font.loaded && probe.font.differs,
        JSON.stringify(probe.font),
      )
      check(
        `${engine.name}: the picture loads by its signed address`,
        probe.image === 1,
        String(probe.image),
      )
      check(
        `${engine.name}: no storage, pop-up or network in the frame`,
        probe.storage === 'closed' && probe.popup === 'closed' && probe.network === 'closed',
        JSON.stringify(probe),
      )
      check(
        `${engine.name}: the bridge says «ready» and the size from an opaque origin`,
        bridge.some((m) => m.data.type === 'ready') &&
          bridge.some((m) => m.data.type === 'size' && m.data.width === 600) &&
          bridge.every((m) => m.origin === 'null'),
        JSON.stringify(bridge.slice(0, 3)),
      )
      await page.frameLocator('#view').locator('#away').click()
      const link = await page
        .waitForFunction(
          () => window.__messages.find((m) => m.data && m.data.type === 'link')?.data.href,
          null,
          { timeout: 5_000 },
        )
        .then((handle) => handle.jsonValue())
        .catch(() => null)
      check(
        `${engine.name}: a link is handed to the cabinet, the frame stays`,
        link === 'https://example.com/zakaz' && page.frames().length >= 2,
        String(link),
      )
      // The script of the mockup sends its own frame elsewhere: frame-src of the cabinet keeps it.
      const viewFrame = page.frames().find((frame) => frame.url().includes('/v/'))
      await viewFrame
        ?.evaluate(() => {
          location.href = 'https://example.com/away'
        })
        .catch(() => undefined)
      await sleep(1500)
      const urls = page.frames().map((frame) => frame.url())
      check(
        `${engine.name}: the frame cannot take itself to another site (frame-src of the cabinet)`,
        !urls.some((url) => url.startsWith('https://example.com')),
        JSON.stringify(urls),
      )

      const editToken = tokens.signArtifactToken(keys.view, 'aedit', {
        artifactId,
        userId: user.id,
        expiresAt: expires,
      })
      await page.evaluate(
        ({ src, sandbox }) =>
          new Promise((done) => {
            // The frame of the view runs the mockup's scripts by design: it goes before the check.
            document.getElementById('view')?.remove()
            window.__ran.length = 0
            const frame = document.createElement('iframe')
            frame.setAttribute('sandbox', sandbox)
            frame.id = 'edit'
            frame.width = '600'
            frame.height = '600'
            frame.style.pointerEvents = 'none'
            frame.addEventListener('load', () => done(), { once: true })
            frame.src = src
            document.body.append(frame)
          }),
        { src: `/api/artifact-frame/${editToken}`, sandbox: artifacts.ARTIFACT_EDIT_SANDBOX },
      )
      await sleep(1500)
      const edit = await page.evaluate((id) => {
        const doc = document.getElementById('edit').contentDocument
        const element = Document.prototype.querySelector.call(doc, `[data-rid="${id}"]`)
        const box = element && Element.prototype.getBoundingClientRect.call(element)
        const found =
          box &&
          Document.prototype.elementFromPoint.call(doc, box.left + 2, box.top + box.height / 2)
        // The cabinet's own edit: native plaintext-only, read back without the frame's handlers.
        Element.prototype.setAttribute.call(element, 'contenteditable', 'plaintext-only')
        return {
          ran: [...window.__ran, doc.documentElement.getAttribute('data-ran')].filter(Boolean),
          text: element?.textContent,
          editable: element?.isContentEditable,
          picked: found
            ? Element.prototype.closest.call(found, '[data-rid]')?.getAttribute('data-rid')
            : null,
          href: Document.prototype.querySelector.call(doc, '#away')?.getAttribute('href'),
          // The `script` blocks of the mockup and the bridge are not in the edit frame at all.
          blocks:
            doc.documentElement.innerHTML.includes('__module') ||
            doc.documentElement.innerHTML.includes('raditi-artifact'),
        }
      }, paragraph)
      check(
        `${engine.name}: the edit frame runs no script of the mockup — ${7 + 1} vectors`,
        edit.ran.length === 0 && hits.length === 0 && edit.blocks === false,
        `${JSON.stringify(edit.ran)} ${JSON.stringify(hits)}`,
      )
      check(
        `${engine.name}: the cabinet finds the element by its point and edits it natively; links lead nowhere`,
        edit.picked === paragraph &&
          edit.text === 'Свежий хлеб каждый день' &&
          edit.editable === true &&
          edit.href === '#raditi-no-link',
        JSON.stringify(edit),
      )
      // Opened as a tab, the edit frame answers nothing (no Sec-Fetch-Dest: iframe).
      const tab = await context.newPage()
      const status = await tab
        .goto(`${host.cabinet}/api/artifact-frame/${editToken}`)
        .then((answer) => answer?.status())
        .catch(() => 404)
      const shown = await tab.content().catch(() => '')
      check(
        `${engine.name}: the edit frame opened as a tab is not found`,
        status === 404 && !shown.includes('Кофейня'),
        String(status),
      )
      await browser.close()
    }
  } finally {
    for (const browser of browsersOut) await browser.close().catch(() => undefined)
    if (docker) execFileSync('docker', ['rm', '-f', docker], { stdio: 'ignore' })
    pages.close()
    cabinet.close()
    rmSync(dir, { recursive: true, force: true })
    await db.artifact.deleteMany({ where: { workspaceId: workspace.id } })
    await db.member.deleteMany({ where: { workspaceId: workspace.id } })
    await db.workspace.delete({ where: { id: workspace.id } })
    await db.user.delete({ where: { id: user.id } })
    await db.$disconnect()
  }
}
