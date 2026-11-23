import { canvasSegmentOf } from './canvas.ts'

// «Структура сайта» (docs/plan/88-artifacts.md, §7.13, Э11, slice 88.27): the tree of a future
// site — a page a `node`: its title, goal and main action in its properties, the brief of its text
// as its content, its parent page in `up` and its address in `path`. The order of the pages is the
// order of the blocks. Pure: the tree read from the blocks, whatever the blocks say.

export interface SitemapBlock {
  key: string
  kind: string
  parent: string | null
  content: string | null
  props: Readonly<Record<string, unknown>>
}

export interface SitemapPage {
  key: string
  title: string
  goal: string
  action: string
  /** The brief of the text of the page. */
  brief: string
  /** Its parent page; null — the top. */
  up: string | null
  depth: number
  /** Its address: its own `path`, or made of the title — the first page of the top is `/`. */
  path: string
}

const str = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : ''

/** Pages deeper than this are drawn at this depth: a site of a small business is shallow. */
export const sitemapMaxDepth = 4

/**
 * The pages in the order of the tree — a page, then its children —, each with its depth. A parent
 * that is not a page, or that would make a loop, is ignored: the page stands at the top.
 */
export function sitemapPagesOf(blocks: readonly SitemapBlock[]): SitemapPage[] {
  const nodes = blocks.filter((block) => block.kind === 'node' && block.parent === null)
  const keys = new Set(nodes.map((node) => node.key))
  const upOf = new Map<string, string | null>()
  for (const node of nodes) {
    const up = str(node.props.up)
    upOf.set(node.key, up !== '' && up !== node.key && keys.has(up) ? up : null)
  }
  // A loop is cut where it is found: the page that closes it goes to the top.
  for (const node of nodes) {
    const seen = new Set([node.key])
    let at = upOf.get(node.key) ?? null
    while (at !== null) {
      if (seen.has(at)) {
        upOf.set(node.key, null)
        break
      }
      seen.add(at)
      at = upOf.get(at) ?? null
    }
  }
  const children = new Map<string | null, typeof nodes>()
  for (const node of nodes) {
    const up = upOf.get(node.key) ?? null
    children.set(up, [...(children.get(up) ?? []), node])
  }
  const used = new Set<string>()
  const pages: SitemapPage[] = []
  const walk = (up: string | null, depth: number) => {
    for (const node of children.get(up) ?? []) {
      const title = str(node.props.title) || `Страница ${pages.length + 1}`
      const asked = str(node.props.path)
      let path =
        asked !== ''
          ? asked
          : pages.length === 0 && up === null
            ? '/'
            : `/${canvasSegmentOf(title)}`
      for (let n = 2; used.has(path); n += 1) path = `${asked || `/${canvasSegmentOf(title)}`}-${n}`
      used.add(path)
      pages.push({
        key: node.key,
        title,
        goal: str(node.props.goal),
        action: str(node.props.action),
        brief: node.content ?? '',
        up,
        depth: Math.min(depth, sitemapMaxDepth),
        path,
      })
      walk(node.key, depth + 1)
    }
  }
  walk(null, 0)
  return pages
}

/** The request «Сделать сайт» puts into a new chat: the agent builds a canvas of these pages. */
export function sitemapSiteRequest(mention: string): string {
  return `Сделайте холст сайта по структуре ${mention}: экран на каждую страницу, с её целью, главным действием и текстом по заданию.`
}
