import {
  DOCUMENT_ANCHOR_PREFIX,
  documentImageOf,
  documentKindOf,
  documentLinkOf,
  documentSlug,
} from '@repo/domain/tasks/chat-documents'
import type { Element, ElementContent, Properties, Root, RootContent } from 'hast'

// The rules of a text document of a chat (docs/plan/67-agent-documents.md, Д6): one rehype plugin
// that react-markdown runs — in the cabinet's tab and in the page for reading the platform draws on
// a server (docs/plan/69-pages.md, Ст11), one set for both. Raw HTML never reaches it —
// react-markdown skips it, remark-rehype without `allowDangerousHtml` drops it — and what is left
// is bound here:
// only the elements Markdown makes, only their own attributes, no class or style of the text, ids
// under a prefix, links and pictures by `documentLinkOf` and `documentImageOf`.

export interface DocumentRules {
  /** The names of the documents of the chat: a link to one of them is a link inside the tab. */
  documents: ReadonlySet<string>
  /** The address of a picture of the chat by its name, as this version knew it; null — none. */
  imageSrc: (name: string) => string | null
  /**
   * Whether a link to another document stays one (the cabinet's tab) or becomes its words — for a
   * document shown alone, apart from its chat (plan 69).
   */
  documentLinks: boolean
}

/** The elements GitHub-flavoured Markdown makes; any other one is left as its children. */
const ELEMENTS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'em',
  'strong',
  'del',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'hr',
  'br',
  'input',
  'sup',
  'section',
])

/** The attributes an element keeps from the tree; everything else, class and style too, goes. */
const ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ['href'],
  img: ['src', 'alt'],
  input: ['type', 'checked', 'disabled'],
  th: ['align'],
  td: ['align'],
  ol: ['start'],
}

/** The hint of a link to a document the chat does not have. */
export const MISSING_DOCUMENT = 'Такого документа в чате нет.'

/** A link that names a document by its file name, and the chat has none of that name. */
function namesDocument(href: string): boolean {
  const path = href.trim().replace(/^\.\//, '').split('#')[0] ?? ''
  if (path === '' || /[/\\:]/.test(path)) return false
  try {
    return documentKindOf(decodeURIComponent(path)) !== null
  } catch {
    return false
  }
}

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

/** The words of a node, as text. */
export function textOf(node: Root | RootContent | ElementContent): string {
  if (node.type === 'text') return node.value
  if ('children' in node) return node.children.map((child) => textOf(child)).join('')
  return ''
}

const element = (tagName: string, properties: Properties, children: ElementContent[]): Element => ({
  type: 'element',
  tagName,
  properties,
  children,
})

const words = (children: ElementContent[]): Element => element('span', {}, children)

/** The host a link leads to when its words do not say it; null — they do, or it is mail. */
export function hiddenHostOf(href: string, text: string): string | null {
  if (!/^https?:/i.test(href)) return null
  const host = URL.parse(href)?.hostname.replace(/^www\./, '') ?? null
  if (host === null || host === '') return null
  return text.toLowerCase().includes(host.toLowerCase()) ? null : host
}

function link(node: Element, rules: DocumentRules): Element {
  const href = typeof node.properties.href === 'string' ? node.properties.href : ''
  const target = documentLinkOf(href, rules.documents)
  switch (target.kind) {
    case 'external': {
      const host = hiddenHostOf(target.href, textOf(node))
      return element(
        'a',
        { href: target.href, target: '_blank', rel: ['noopener', 'noreferrer', 'nofollow'] },
        host
          ? [
              ...node.children,
              element('span', { dataHost: '' }, [{ type: 'text', value: ` (${host})` }]),
            ]
          : node.children,
      )
    }
    case 'anchor':
      return element('a', { href: `#${DOCUMENT_ANCHOR_PREFIX}${target.anchor}` }, node.children)
    case 'document':
      return rules.documentLinks
        ? element(
            'a',
            {
              href: '#',
              dataDocument: target.name,
              ...(target.anchor ? { dataAnchor: target.anchor } : {}),
            },
            node.children,
          )
        : words(node.children)
    case 'none':
      // Alone, apart from its chat, a document has no others to miss: the link is its words.
      return rules.documentLinks && namesDocument(href)
        ? element('span', { dataMissingDocument: '', title: MISSING_DOCUMENT }, node.children)
        : words(node.children)
  }
}

function image(node: Element, rules: DocumentRules): Element {
  const src = typeof node.properties.src === 'string' ? node.properties.src : ''
  const alt = typeof node.properties.alt === 'string' ? node.properties.alt : ''
  const found = documentImageOf(src)
  const address =
    found === null ? null : found.kind === 'data' ? found.src : rules.imageSrc(found.name)
  if (address === null)
    return element('span', { dataImageMissing: '' }, alt ? [{ type: 'text', value: alt }] : [])
  return element('img', { src: address, alt, loading: 'lazy' }, [])
}

/** The rehype plugin of the rules: `[rehypeDocumentRules, rules]`. */
export function rehypeDocumentRules(rules: DocumentRules) {
  return (tree: Root) => {
    const seen = new Map<string, number>()
    const bind = (children: (RootContent | ElementContent)[]): ElementContent[] =>
      children.flatMap((child): ElementContent[] => {
        if (child.type === 'text') return [child]
        if (child.type !== 'element') return []
        const inner = bind(child.children)
        if (!ELEMENTS.has(child.tagName)) return inner
        const kept: Properties = {}
        for (const name of ATTRIBUTES[child.tagName] ?? [])
          if (child.properties[name] !== undefined) kept[name] = child.properties[name]
        // A footnote's own id, under the prefix its links get too.
        const id = child.properties.id
        if (typeof id === 'string' && id.startsWith('user-content-'))
          kept.id = `${DOCUMENT_ANCHOR_PREFIX}${id}`
        const bound = element(child.tagName, kept, inner)
        if (child.tagName === 'a') return [link(bound, rules)]
        if (child.tagName === 'img') return [image(child, rules)]
        if (child.tagName === 'input')
          return [
            element(
              'input',
              { type: 'checkbox', checked: kept.checked === true, disabled: true },
              [],
            ),
          ]
        if (HEADINGS.has(child.tagName))
          bound.properties.id = `${DOCUMENT_ANCHOR_PREFIX}${documentSlug(textOf(bound), seen)}`
        return [bound]
      })
    tree.children = bind(tree.children)
  }
}

/** The title of a text document: its first `# …` outside code; null — it has none. */
export function markdownTitleOf(text: string): string | null {
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) fenced = !fenced
    if (fenced) continue
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line)
    if (match) return match[1]!.replace(/[*_`]/g, '').trim() || null
  }
  return null
}
