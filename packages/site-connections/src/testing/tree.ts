// The read-only file tree of the test servers. Paths are POSIX, absolute, `/`-separated strings in
// the server's own form: the SFTP server keeps the UTF-8 text, the FTP server the raw bytes of a
// name as a latin1 string. Everything is in memory; nothing in it is ever changed by a client.

export type TreeNode =
  { type: 'file'; data: Buffer } | { type: 'directory' } | { type: 'link'; target: string }

export interface TestTreeOptions {
  files: Record<string, string | Uint8Array>
  directories?: readonly string[]
  /** A path of the tree that is a symbolic link to another path (absolute, or relative to its folder). */
  links?: Record<string, string>
  /** How a key of the options becomes a path of the tree. */
  encode?: (key: string) => string
}

const MAX_LINK_DEPTH = 16

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '' && segment !== '.')
}

function joinSegments(segments: readonly string[]): string {
  return `/${segments.join('/')}`
}

/** Lexical: `..` drops the segment before it, and never goes above `/`. */
export function normalizePath(base: string, path: string): string {
  const segments = path.startsWith('/') ? [] : segmentsOf(base)
  for (const segment of segmentsOf(path)) {
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return joinSegments(segments)
}

export function parentOf(path: string): string {
  return normalizePath(path, '..')
}

export class TestTree {
  readonly nodes = new Map<string, TreeNode>([['/', { type: 'directory' }]])

  constructor(options: TestTreeOptions) {
    const encode = options.encode ?? ((key: string) => key)
    const addDirectory = (path: string) => {
      const segments = segmentsOf(path)
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const at = joinSegments(segments.slice(0, depth))
        if (!this.nodes.has(at)) this.nodes.set(at, { type: 'directory' })
      }
    }
    for (const directory of options.directories ?? [])
      addDirectory(normalizePath('/', encode(directory)))
    for (const [key, content] of Object.entries(options.files)) {
      const path = normalizePath('/', encode(key))
      addDirectory(parentOf(path))
      const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
      this.nodes.set(path, { type: 'file', data })
    }
    for (const [key, target] of Object.entries(options.links ?? {})) {
      const path = normalizePath('/', encode(key))
      addDirectory(parentOf(path))
      this.nodes.set(path, { type: 'link', target: encode(target) })
    }
  }

  /**
   * The canonical path and node of `path` (absolute), every link along it followed — the last one too
   * when `followLast`. null when a segment is missing or the links loop.
   */
  resolve(path: string, followLast = true, depth = 0): { path: string; node: TreeNode } | null {
    if (depth > MAX_LINK_DEPTH) return null
    const segments = segmentsOf(normalizePath('/', path))
    let current = '/'
    for (const [index, segment] of segments.entries()) {
      const next = normalizePath(current, segment)
      const node = this.nodes.get(next)
      if (!node) return null
      const last = index === segments.length - 1
      if (node.type === 'link' && (!last || followLast)) {
        const target = this.resolve(normalizePath(current, node.target), true, depth + 1)
        if (!target) return null
        if (last) return target
        if (target.node.type !== 'directory') return null
        current = target.path
        continue
      }
      if (!last && node.type !== 'directory') return null
      current = next
    }
    const node = this.nodes.get(current)
    return node ? { path: current, node } : null
  }

  /** The entries of a canonical directory, sorted by name. */
  children(directory: string): Array<{ name: string; path: string; node: TreeNode }> {
    const prefix = directory === '/' ? '/' : `${directory}/`
    const entries: Array<{ name: string; path: string; node: TreeNode }> = []
    for (const [path, node] of this.nodes) {
      if (path === directory || !path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (rest.includes('/')) continue
      entries.push({ name: rest, path, node })
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /** What a listing shows for a node: a link as itself, or as what it points to. */
  shown(path: string, node: TreeNode, followLinks: boolean): TreeNode {
    if (node.type !== 'link' || !followLinks) return node
    return this.resolve(path, true)?.node ?? node
  }
}
