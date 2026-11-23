// A browser-like global DOM for Tiptap in Node. @tiptap/markdown parses inline and block HTML
// through window.DOMParser only when it exists (MarkdownManager.parseHTMLToken); without it HTML
// stays literal text. The editor runs in a browser, so the harness gives it a window.
import { JSDOM } from 'jsdom'

export function installDom() {
  if (globalThis.window) return
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  const { window } = dom
  globalThis.window = window
  globalThis.document = window.document
  for (const name of [
    'Node',
    'Element',
    'HTMLElement',
    'DocumentFragment',
    'DOMParser',
    'MutationObserver',
    'getComputedStyle',
    'Text',
    'Range',
    'Selection',
    'KeyboardEvent',
    'MouseEvent',
    'InputEvent',
    'ClipboardEvent',
    'DragEvent',
    'Event',
    'CustomEvent',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]) {
    if (window[name] !== undefined && globalThis[name] === undefined) globalThis[name] = window[name]
  }
  if (!globalThis.navigator) globalThis.navigator = window.navigator
  // ProseMirror's view asks for layout; jsdom has none.
  window.HTMLElement.prototype.getClientRects = () => []
  window.Range.prototype.getClientRects = () => []
  window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
  window.document.elementFromPoint = () => null
}
