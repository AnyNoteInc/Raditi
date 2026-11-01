// The REAL cloud browser of the product (createPlaywrightCloudBrowser) on a local Chromium, driven the way the
// agent drives it: read the tree of observe(), act only by a ref found in that tree. A permissive policy: the
// question here is what the admin looks like to the model, not what a stack's policy should close.
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
const R = '<repo>/packages/browser-providers'
const { chromium } = await import(`${R}/node_modules/playwright-core/index.mjs`)
const { createPlaywrightCloudBrowser } = await import(`${R}/src/cloud/cloud-browser.ts`)
const INTERACTIVE = /^\s*- (button|link|textbox|searchbox|checkbox|radio|combobox|menuitem|tab|option|spinbutton|switch|treeitem|slider)\b/
export function stats(tree) {
  const lines = tree.split('\n')
  const inter = lines.filter((l) => INTERACTIVE.test(l))
  const unnamed = inter.filter((l) => !/^\s*- \w+ "/.test(l))
  const roles = {}
  for (const l of unnamed) { const r = /- (\w+)/.exec(l)[1]; roles[r] = (roles[r] ?? 0) + 1 }
  return { chars: tree.length, lines: lines.length, refs: (tree.match(/\[ref=/g) ?? []).length, interactive: inter.length, unnamed: unnamed.length, unnamedByRole: roles, iframes: lines.filter((l) => /- iframe/.test(l)).length }
}
export async function openAgent({ tag, origin, startPath, signIn, viewport = { width: 1280, height: 800 } }) {
  const dir = new URL(`../snap/${tag}/`, import.meta.url).pathname
  mkdirSync(dir, { recursive: true })
  const server = await chromium.launchServer({ host: '127.0.0.1', port: 0, wsPath: `/${randomBytes(24).toString('base64url')}`, headless: true })
  const factory = createPlaywrightCloudBrowser({ actionTimeoutMs: 20_000 })
  const events = []
  const policy = { startPath, extraHosts: [], requestDenied: () => false, pageDenied: () => false, ...(signIn ? { signIn } : {}) }
  const session = await factory.open({ endpoint: server.wsEndpoint(), allowedHosts: [], localSites: [origin], startUrl: `${origin}${startPath}`, viewport, policy, onEvent: (e) => events.push(e) })
  let n = 0; let tree = ''
  const agent = {
    session, events, get tree() { return tree },
    async open(path) { return session.act({ tool: 'web_open', url: path.startsWith('http') ? path : `${origin}${path}` }) },
    async observe(name) {
      const o = await session.observe({}); tree = o.tree
      const s = stats(tree); n += 1
      const file = `${String(n).padStart(2, '0')}-${name}.txt`
      writeFileSync(dir + file, `# ${o.page.url}\n# ${o.page.title}\n# ${JSON.stringify(s)}\n${tree}\n`)
      console.log(`[${name}] ${o.page.url.replace(origin, '')} | ${o.page.title.slice(0, 50)} | ${JSON.stringify(s)}`)
      return o
    },
    /** The line of the latest tree that matches; a model would pick it the same way. */
    line(re) { return tree.split('\n').find((l) => re.test(l)) ?? null },
    lines(re) { return tree.split('\n').filter((l) => re.test(l)) },
    ref(re) { const l = agent.line(re); const m = l && /\[ref=([a-z0-9]+)\]/.exec(l); if (!m) throw new Error(`no ref for ${re}`); return m[1] },
    async click(re) { const ref = agent.ref(re); console.log(`  click ${agent.line(re).trim().slice(0, 100)}`); return session.act({ tool: 'web_click', ref }) },
    async fill(re, text) { const ref = agent.ref(re); console.log(`  fill  ${agent.line(re).trim().slice(0, 100)}`); return session.act({ tool: 'web_fill', ref, text }) },
    async press(key) { return session.act({ tool: 'web_press', key }) },
    async wait(ms, extra = {}) { return session.act({ tool: 'web_wait', ms, ...extra }) },
    async close() { await session.close().catch(() => {}); await server.close().catch(() => {}) },
  }
  return agent
}
