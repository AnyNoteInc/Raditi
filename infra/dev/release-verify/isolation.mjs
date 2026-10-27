// What the code of a preview and the agent's browser reach, and what they do not (plan 53, R12:
// «атаки из PHP и JS страницы на сервисы хоста, соседний предпросмотр, порт браузера,
// метаданные, интернет»). A preview is one container on a bridge of its own and its internet is
// open (docs/plan/58, owner's answer of 26.10.2026): PHP reaches the internet when this machine
// does, and the rules of its bridge close the host, every address that is not public and the
// neighbours. Every target has a control that reaches it from where a trusted container of the
// platform stands — the default bridge, the site's network or the container that serves it —,
// and a target counts as isolated only when the packet found no way (unreachable network or host,
// or no answer) or its name did not resolve: a refusal means it reached a host. A target no
// control reaches on this machine is printed as not provable here, never as a PASS.
import { randomBytes, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { isIP } from 'node:net'
import { join } from 'node:path'

import { localVaultRequest } from '../../vault/bootstrap.mjs'
import { CheckFailed } from './runtime.mjs'
import { NODE_ERRNO_PROBE, PHP_ERRNO_PROBE, TEXT, isolatedAnswer } from './stand.mjs'

/** Where each image keeps node: the tools image (node:26) and the browser image (Playwright). */
const NODE = { tools: '/usr/local/bin/node', browser: '/usr/bin/node' }
const PREVIEW_NETWORK = /^raditi-preview-[0-9a-f-]{36}$/
const BROWSER_NETWORK = /^raditi-preview-[0-9a-f-]{36}-browser$/
const BROWSER_CONTROL_PORT = 9333
const RELAY_PROXY_PORT = 3128
/** The gateway of a preview inside its container, and the web server behind it on the loopback. */
const ENTRY_PORT = 8080
const WEB_PORT = 8081

export function isolationOf(stand) {
  const { rt, names, images, siteId } = stand

  const containerOf = async (filters) => {
    const list = await rt.docker([
      'ps',
      '-q',
      ...filters.flatMap((filter) => ['--filter', `label=${filter}`]),
    ])
    return list.output.split('\n').filter(Boolean)[0] ?? null
  }
  const previewContainer = async (previewId, role) => {
    const id = await containerOf([
      `io.raditi.preview.id=${previewId}`,
      `io.raditi.preview.role=${role}`,
    ])
    if (id === null)
      throw new CheckFailed(`the ${role} container of preview ${previewId} is not running`)
    return id
  }
  const networks = async (container) =>
    JSON.parse(
      (await rt.docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', container]))
        .output,
    )
  /** The address of a container on a network: `preview`, `browser`, `bridge` or a network name. */
  const addressOn = async (container, which) => {
    const found = Object.entries(await networks(container)).find(([name]) =>
      which === 'preview'
        ? PREVIEW_NETWORK.test(name)
        : which === 'browser'
          ? BROWSER_NETWORK.test(name)
          : name === which,
    )
    const address = found?.[1]?.IPAddress
    if (!address) throw new CheckFailed(`container ${container} has no address on ${which}`)
    return address
  }

  /** `kind`: php (the preview's PHP, as www-data), tools or browser (node, as 10001). */
  const probe = async (container, kind, host, port) => {
    const argv =
      kind === 'php'
        ? ['exec', '-u', '33:33', container, 'php', '-r', PHP_ERRNO_PROBE, '--', host, String(port)]
        : [
            'exec',
            '-u',
            '10001:10001',
            container,
            NODE[kind],
            '-e',
            NODE_ERRNO_PROBE,
            host,
            String(port),
          ]
    const { output } = await rt.docker(argv, { allowFailure: true, timeoutMs: 30_000 })
    const seen = output.trim()
    return /^(open|dns|closed:[\w: ]{0,80})$/.test(seen) ? seen : `error: ${seen.slice(0, 120)}`
  }

  // The control: a container of the tools image on the default bridge, as any trusted container
  // of the platform stands, joined to the site's network too; it also tells where containers see
  // the host (`host-gateway`).
  let control = null
  const ensureControl = async () => {
    if (control) return control
    const name = `${names.stand}-control`
    await rt.docker([
      ...['run', '-d', '--rm', '--pull', 'never', '--name', name, '--label', names.label],
      ...['--network', 'bridge', '--add-host', 'host.docker.internal:host-gateway'],
      ...['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'],
      ...['--user', '10001:10001', images.tools, 'sleep', '3600'],
    ])
    await rt.docker(['network', 'connect', names.network, name])
    const resolved = await rt.docker(['exec', name, 'getent', 'ahostsv4', 'host.docker.internal'])
    const hostAddress = resolved.output.trim().split(/\s+/)[0]
    if (isIP(hostAddress) !== 4)
      throw new CheckFailed('host.docker.internal did not resolve in the control')
    control = { name, hostAddress, probe: (host, port) => probe(name, 'tools', host, port) }
    return control
  }

  /**
   * A target that must not be reached. `controlBy` reaches it from elsewhere first: required —
   * a stand whose control does not reach a service it started is broken; optional — the target
   * is not provable on this machine (no metadata service on Docker Desktop, no internet). A name
   * that does not resolve counts as isolated, one that resolves must find no way: the resolvers
   * of a preview answer the internet's names (docs/plan/58).
   */
  const blocked = async ({
    from,
    container,
    kind,
    label,
    host,
    port,
    controlBy,
    optional = false,
  }) => {
    const seen = await probe(container, kind, host, port)
    if (seen === 'open') throw new CheckFailed(`${from} reaches ${label}`)
    const isolated = seen === 'dns' || isolatedAnswer(seen)
    const reached = await controlBy()
    if (reached !== 'open') {
      if (!optional)
        throw new CheckFailed(
          `the control does not reach ${label} (${reached}): the stand is broken`,
        )
      rt.note(
        `${from} → ${label}: not provable on this machine, its control does not reach it either (control ${reached}, seen ${seen})`,
      )
      if (!isolated) throw new CheckFailed(`${from} → ${label}: ${seen}`)
      return
    }
    rt.check(isolated, `${from} does not reach ${label} (${seen}; control open)`)
  }
  /** Reached when this machine reaches it: the control first, a NOTE without it. */
  const reachableOutside = async (container, kind, host, port, text) => {
    const c = await ensureControl()
    const reached = await c.probe(host, port)
    if (reached !== 'open') {
      rt.note(`${text}: not provable on this machine, its control does not reach it (${reached})`)
      return
    }
    const seen = await probe(container, kind, host, port)
    rt.check(seen === 'open', `${text} (${seen}; control open)`)
  }
  const reachable = async (container, kind, host, port, text) => {
    const seen = await probe(container, kind, host, port)
    rt.check(seen === 'open', `${text} (control: ${seen})`)
  }

  /** The agent's Chromium of a preview, as the browser server of the preview serves it. */
  const agentChromium = async (previewId) => {
    const secret = await localVaultRequest(
      stand.vault.root,
      `kv/data/previews/${previewId}/browser`,
    )
    if (secret.status !== 200) throw new CheckFailed(`no browser secret of preview ${previewId}`)
    const { wsEndpoint, wsPath } = secret.body.data.data
    const require = createRequire(join(stand.copy, 'packages/browser-providers/package.json'))
    const { chromium } = require('playwright-core')
    const browser = await chromium.connect(`${wsEndpoint}${wsPath}`, { timeout: 30_000 })
    return { browser, wsPath }
  }
  /**
   * A session of the agent's browser on its own preview, as core gives one (preview-browser.ts,
   * `browserTicket`): a service ticket of kind `browser`, entered through the relay.
   */
  const enterAsAgent = async (page, preview, origin, path = '/') => {
    const ticket = randomBytes(32).toString('base64url')
    await stand.db.previewTicket.create({
      data: {
        previewId: preview.id,
        userId: null,
        kind: 'browser',
        tokenHash: createHash('sha256').update(ticket).digest('hex'),
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    })
    return page.goto(`${origin}/__raditi/enter?t=${ticket}&to=${encodeURIComponent(path)}`, {
      timeout: 30_000,
    })
  }
  const visit = (page, url) =>
    page
      .goto(url, { timeout: 20_000 })
      .then(async (response) => ({
        status: response?.status() ?? 0,
        text: await response?.text().catch(() => ''),
      }))
      .catch((error) => ({ status: 0, text: String(error.message).slice(0, 80) }))
  /** From the page's own JavaScript: whether a WebSocket to `url` opens. */
  const socketFromPage = (page, url) =>
    page.evaluate(
      (target) =>
        new Promise((done) => {
          const socket = new WebSocket(target)
          const timer = setTimeout(() => done('timeout'), 10_000)
          socket.onopen = () => (clearTimeout(timer), socket.close(), done('open'))
          socket.onerror = () => (clearTimeout(timer), done('error'))
        }),
      url,
    )
  /** From the page's own JavaScript: what a fetch of `url` gets, without credentials. */
  const fetchFromPage = (page, url) =>
    page.evaluate(
      (target) =>
        fetch(target, { cache: 'no-store' })
          .then(
            async (response) =>
              `status ${response.status} ${(await response.text()).slice(0, 200)}`,
          )
          .catch(() => 'refused'),
      url,
    )

  return {
    previewContainer,
    addressOn,
    probe,
    ensureControl,

    /** S2: the PHP of a preview and the agent's browser, against the host and everything around. */
    async attacks({ preview, origin, hostPorts, siteWeb }) {
      const c = await ensureControl()
      const box = await previewContainer(preview.id, 'preview')
      const relay = await previewContainer(preview.id, 'relay')
      const browser = await previewContainer(preview.id, 'browser')
      const ip = {
        box: await addressOn(box, 'preview'),
        relayBridge: await addressOn(relay, 'bridge'),
        relayInside: await addressOn(relay, 'browser'),
        browser: await addressOn(browser, 'browser'),
        siteWeb: await addressOn(siteWeb, names.network),
      }
      await reachable(
        box,
        'php',
        '127.0.0.1',
        WEB_PORT,
        'PHP of the preview reaches its own server',
      )
      await reachable(
        box,
        'php',
        '127.0.0.1',
        ENTRY_PORT,
        'PHP of the preview reaches its own gateway on the loopback',
      )
      // The internet of a preview is open (owner's answer of 26.10.2026).
      await reachableOutside(
        box,
        'php',
        '1.1.1.1',
        443,
        'PHP of the preview reaches the internet 1.1.1.1:443',
      )
      await reachableOutside(
        box,
        'php',
        'example.com',
        443,
        'PHP of the preview reaches the internet by name example.com:443',
      )
      const fromPhp = { from: 'PHP of the preview', container: box, kind: 'php' }
      for (const [service, port] of Object.entries(hostPorts))
        await blocked({
          ...fromPhp,
          label: `the host's ${service} at ${c.hostAddress}:${port}`,
          host: c.hostAddress,
          port,
          controlBy: () => c.probe(c.hostAddress, port),
        })
      await blocked({
        ...fromPhp,
        label: `the host's core by name host.docker.internal`,
        host: 'host.docker.internal',
        port: hostPorts.core,
        controlBy: () => c.probe('host.docker.internal', hostPorts.core),
      })
      await blocked({
        ...fromPhp,
        label: `production's web server on the site's network ${ip.siteWeb}:80`,
        host: ip.siteWeb,
        port: 80,
        controlBy: () => c.probe(ip.siteWeb, 80),
      })
      // The control port of the agent's browser: the relay's side on the default bridge, its
      // browser side, the browser itself.
      await blocked({
        ...fromPhp,
        label: `the browser's control port on the relay ${ip.relayBridge}:${BROWSER_CONTROL_PORT}`,
        host: ip.relayBridge,
        port: BROWSER_CONTROL_PORT,
        controlBy: () => c.probe(ip.relayBridge, BROWSER_CONTROL_PORT),
      })
      await blocked({
        ...fromPhp,
        label: `the browser's control port on the relay's browser side ${ip.relayInside}:${BROWSER_CONTROL_PORT}`,
        host: ip.relayInside,
        port: BROWSER_CONTROL_PORT,
        controlBy: () => probe(browser, 'browser', ip.relayInside, BROWSER_CONTROL_PORT),
      })
      await blocked({
        ...fromPhp,
        label: `the browser's control port ${ip.browser}:${BROWSER_CONTROL_PORT}`,
        host: ip.browser,
        port: BROWSER_CONTROL_PORT,
        controlBy: () => probe(relay, 'tools', ip.browser, BROWSER_CONTROL_PORT),
      })
      await blocked({
        ...fromPhp,
        label: 'the cloud metadata 169.254.169.254:80',
        host: '169.254.169.254',
        port: 80,
        controlBy: () => c.probe('169.254.169.254', 80),
        optional: true,
      })

      // The agent's browser container: its relay only.
      await reachable(
        browser,
        'browser',
        ip.relayInside,
        RELAY_PROXY_PORT,
        'the agent browser reaches its relay to the gateway',
      )
      const fromBrowser = { from: 'the agent browser', container: browser, kind: 'browser' }
      for (const service of ['core', 'preview gateway'])
        await blocked({
          ...fromBrowser,
          label: `the host's ${service} at ${c.hostAddress}:${hostPorts[service]}`,
          host: c.hostAddress,
          port: hostPorts[service],
          controlBy: () => c.probe(c.hostAddress, hostPorts[service]),
        })
      await blocked({
        ...fromBrowser,
        label: `its preview past the gateway ${ip.box}:${ENTRY_PORT}`,
        host: ip.box,
        port: ENTRY_PORT,
        controlBy: () => probe(box, 'php', ip.box, ENTRY_PORT),
      })
      await blocked({
        ...fromBrowser,
        label: `the default bridge ${ip.relayBridge}:${BROWSER_CONTROL_PORT}`,
        host: ip.relayBridge,
        port: BROWSER_CONTROL_PORT,
        controlBy: () => c.probe(ip.relayBridge, BROWSER_CONTROL_PORT),
      })
      await blocked({
        ...fromBrowser,
        label: 'the cloud metadata 169.254.169.254:80',
        host: '169.254.169.254',
        port: 80,
        controlBy: () => c.probe('169.254.169.254', 80),
        optional: true,
      })
      // The browser's only way is its relay to the gateway: the preview's open internet is not its.
      await blocked({
        ...fromBrowser,
        label: 'the internet 1.1.1.1:443',
        host: '1.1.1.1',
        port: 443,
        controlBy: () => c.probe('1.1.1.1', 443),
        optional: true,
      })

      // The page's own JavaScript in the agent's Chromium: every request goes to the gateway,
      // which serves only the preview of this dialog to this browser.
      const { browser: chromium, wsPath } = await agentChromium(preview.id)
      try {
        const context = await chromium.newContext()
        const page = await context.newPage()
        const own = await enterAsAgent(page, preview, origin)
        const ownText = await page.content()
        rt.check(
          own?.status() === 200 && ownText.includes(TEXT.footer(1)),
          "the agent's Chromium enters its own preview through the gateway with a browser ticket (control)",
          { status: own?.status() },
        )
        for (const [label, url] of [
          ['production', `${stand.siteUrl}/`],
          ["the host's core", `http://host.docker.internal:${hostPorts.core}/health`],
          ["the host's core by address", `http://${c.hostAddress}:${hostPorts.core}/health`],
          ['the cloud metadata', 'http://169.254.169.254/'],
          ['the internet', 'https://example.com/'],
        ]) {
          const result = await visit(page, url)
          rt.check(
            (result.status === 0 || result.status === 403) &&
              !String(result.text).includes(TEXT.siteName) &&
              !String(result.text).includes('"status"'),
            `the agent's Chromium does not reach ${label} (${result.status === 0 ? 'refused' : `gateway ${result.status}`})`,
          )
        }
        // Back on its own page: what its JavaScript can reach. The secret path of the control
        // socket is known here: only a way to the socket would open it.
        await page.goto(`${origin}/`, { timeout: 20_000 })
        for (const [label, url] of [
          ['on loopback', `ws://127.0.0.1:${BROWSER_CONTROL_PORT}${wsPath}`],
          ['at the browser', `ws://${ip.browser}:${BROWSER_CONTROL_PORT}${wsPath}`],
          ['at the relay', `ws://${ip.relayInside}:${BROWSER_CONTROL_PORT}${wsPath}`],
        ]) {
          const socket = await socketFromPage(page, url)
          rt.check(
            socket !== 'open',
            `JavaScript of the page does not open the browser's control socket ${label}, its secret path known (${socket})`,
          )
        }
        const fetched = await fetchFromPage(
          page,
          `http://${ip.browser}:${BROWSER_CONTROL_PORT}/json/version`,
        )
        rt.check(
          fetched === 'refused' || /^status 403 $/.test(fetched),
          `JavaScript of the page does not fetch from the browser's control port (${fetched})`,
        )
        const control = await visit(page, `http://${ip.browser}:${BROWSER_CONTROL_PORT}${wsPath}`)
        rt.check(
          control.status === 403 && control.text === '',
          `a navigation to the browser's control port gets the gateway's empty 403 (${control.status})`,
        )
        await context.close()
      } finally {
        await chromium.close()
      }
    },

    /** S6a: two previews of one site live side by side: neither reaches the other. */
    async neighbours({ previewB, previewC, originB, originC, paths }) {
      const c = await ensureControl()
      const boxB = await previewContainer(previewB.id, 'preview')
      const boxC = await previewContainer(previewC.id, 'preview')
      const ipB = await addressOn(boxB, 'preview')
      const ipC = await addressOn(boxC, 'preview')
      // Each on a bridge of its own: the neighbour reaches itself there, not the other.
      for (const [from, box, ip, other] of [
        ['PHP of preview B', boxB, ipC, boxC],
        ['PHP of preview C', boxC, ipB, boxB],
      ])
        await blocked({
          from,
          container: box,
          kind: 'php',
          label: `the neighbouring preview ${ip}:${ENTRY_PORT}`,
          host: ip,
          port: ENTRY_PORT,
          controlBy: () => probe(other, 'php', ip, ENTRY_PORT),
        })
      for (const [from, box, other] of [
        ['PHP of preview B', boxB, previewC],
        ['PHP of preview C', boxC, previewB],
      ])
        await blocked({
          from,
          container: box,
          kind: 'php',
          label: `the entry of the neighbour on the host ${c.hostAddress}:${other.upstreamPort}`,
          host: c.hostAddress,
          port: other.upstreamPort,
          controlBy: () => c.probe(c.hostAddress, other.upstreamPort),
        })

      // The only way the agent's browser has: the gateway, through its relay.
      const { browser: chromium } = await agentChromium(previewB.id)
      try {
        const context = await chromium.newContext()
        const page = await context.newPage()
        const own = await enterAsAgent(page, previewB, originB)
        const ownText = await page.content()
        rt.check(
          own?.status() === 200 && ownText.includes(TEXT.footer(2)),
          "B's Chromium enters B's own preview through the gateway and sees its footer (control)",
          { status: own?.status() },
        )
        const neighbour = await visit(page, `${originC}${paths.contacts}`)
        rt.check(
          neighbour.status === 403 && !String(neighbour.text).includes(TEXT.contactsConflict),
          `B's Chromium does not reach the preview of dialog C: the gateway answers ${neighbour.status} without its page`,
        )
        const entered = await visit(page, `${originC}/__raditi/enter?t=${'A'.repeat(43)}&to=%2F`)
        rt.check(entered.status === 403, `nor through the entry of C's preview (${entered.status})`)
        await page.goto(`${originB}/`, { timeout: 20_000 })
        const fetched = await fetchFromPage(page, `${originC}${paths.contacts}`)
        rt.check(
          !fetched.includes(TEXT.contactsConflict),
          `JavaScript of B's page gets nothing of C's preview (${fetched.slice(0, 40)})`,
        )
        await context.close()
      } finally {
        await chromium.close()
      }
    },

    /** Everything of the site of the run Docker still holds, by the labels core gives it. */
    async leftOfSite() {
      const left = []
      for (const label of [
        'io.raditi.preview.site',
        'io.raditi.sandbox.siteId',
        'io.raditi.gateway.siteId',
      ])
        for (const kind of [
          ['ps', '-aq'],
          ['network', 'ls', '-q'],
          ['volume', 'ls', '-q'],
        ]) {
          const { output } = await rt.docker([...kind, '--filter', `label=${label}=${siteId}`])
          for (const id of output.split('\n').filter(Boolean))
            left.push(`${kind[0]} ${id} (${label})`)
        }
      return left
    },
  }
}
