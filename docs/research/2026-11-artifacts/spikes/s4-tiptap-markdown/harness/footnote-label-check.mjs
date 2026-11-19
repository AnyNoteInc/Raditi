// The footnotes of an agent document as @repo/doc-render draws them: react-markdown with
// remark-gfm and skipHtml, then the element and attribute filter of rehypeDocumentRules
// (packages/doc-render/src/rules.ts: ELEMENTS, ATTRIBUTES — copied here without the link and
// picture rules, which need @repo/domain). remark-rehype's footnote label is English by default
// and is hidden only by its class `sr-only`, which the filter drops.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const ELEMENTS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'del', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br', 'input', 'sup', 'section'])
const ATTRIBUTES = { a: ['href'], img: ['src', 'alt'], input: ['type', 'checked', 'disabled'], th: ['align'], td: ['align'], ol: ['start'] }
function rules() {
  return (tree) => {
    const bind = (children) =>
      children.flatMap((child) => {
        if (child.type === 'text') return [child]
        if (child.type !== 'element') return []
        const inner = bind(child.children)
        if (!ELEMENTS.has(child.tagName)) return inner
        const kept = {}
        for (const name of ATTRIBUTES[child.tagName] ?? []) if (child.properties[name] !== undefined) kept[name] = child.properties[name]
        return [{ type: 'element', tagName: child.tagName, properties: kept, children: inner }]
      })
    tree.children = bind(tree.children)
  }
}
const md = 'Цена указана с НДС[^1].\n\n[^1]: Продавец — самозанятый, НДС не облагается.'
console.log(renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm], rehypePlugins: [rules], skipHtml: true, children: md })))
