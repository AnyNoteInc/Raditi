// mui-tiptap 1.31.0 with React 19.3 and MUI 9.4: the module loads and RichTextEditor mounts in a
// jsdom document with the Markdown extension — a smoke check of the peer set, not a UI.
import { installDom } from './dom.mjs'
installDom()
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Node takes the CommonJS build of mui-tiptap (its ESM build has extensionless imports for a
// bundler), so everything else is required as CommonJS too: one copy of @tiptap/core, as in a
// bundle. Mixing an ESM StarterKit with the CJS mui-tiptap gives two cores and ProseMirror's
// «Adding different instances of a keyed plugin» — an artefact of Node, not of the packages.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const React = require('react')
const { createRoot } = require('react-dom/client')
const { createTheme, ThemeProvider } = require('@mui/material/styles')
const mui = require('mui-tiptap')
const StarterKit = require('@tiptap/starter-kit').default
const { Markdown } = require('@tiptap/markdown')

console.log('react', React.version)
for (const n of ['RichTextEditor', 'MenuControlsContainer', 'MenuButtonBold', 'MenuSelectHeading', 'LinkBubbleMenu', 'TableBubbleMenu', 'TableImproved'])
  console.log(' ', n, typeof mui[n])

const errors = []
const origError = console.error
console.error = (...args) => {
  errors.push(args.map(String).join(' ').slice(0, 200))
}
const ref = React.createRef()
const container = document.createElement('div')
document.body.append(container)
const recovered = []
const root = createRoot(container, { onRecoverableError: (error) => recovered.push(String(error?.cause?.message ?? error?.message ?? error).slice(0, 300)) })
await React.act(async () => {
  root.render(
    React.createElement(
      ThemeProvider,
      { theme: createTheme() },
      React.createElement(mui.RichTextEditor, {
        ref,
        extensions: [StarterKit, Markdown],
        content: '### Цены\n\n**Цена:** 1 990 ₽ — «ёлочки»',
        contentType: 'markdown',
        renderControls: () =>
          React.createElement(
            mui.MenuControlsContainer,
            null,
            React.createElement(mui.MenuSelectHeading),
            React.createElement(mui.MenuButtonBold),
          ),
      }),
    ),
  )
})
await React.act(async () => new Promise((r) => setTimeout(r, 50)))
const editor = ref.current?.editor
console.error = origError
console.log('mounted:', !!container.querySelector('.ProseMirror'), '| MuiTiptap classes:', container.innerHTML.includes('MuiTiptap'))
console.log('markdown back:', JSON.stringify(editor?.getMarkdown()))
console.log('console.error calls:', errors.length, errors.slice(0, 3))
console.log('recoverable errors:', recovered)
await React.act(async () => root.unmount())
