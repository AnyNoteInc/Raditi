// A window for Tiptap in Node (written for the check, not the harness's dom.mjs).
import { JSDOM } from 'jsdom'
const { window } = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true })
for (const k of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'DOMParser', 'MutationObserver', 'getComputedStyle', 'Text', 'Range', 'Selection', 'Event', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'ClipboardEvent', 'DragEvent', 'CustomEvent', 'DocumentFragment', 'requestAnimationFrame', 'cancelAnimationFrame'])
  if (globalThis[k] === undefined) globalThis[k] = k === 'window' ? window : window[k]
window.HTMLElement.prototype.getClientRects = () => []
window.Range.prototype.getClientRects = () => []
window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
window.document.elementFromPoint = () => null
