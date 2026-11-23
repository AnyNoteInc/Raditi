'use client'

import Box from '@mui/material/Box'
import { ARTIFACT_EDIT_SANDBOX } from '@repo/domain/artifacts'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'

// The edit frame of a mockup (docs/plan/88-artifacts.md, Ар9, Ар29; spike 1): the copy of the
// mockup the server stamped with ids, on the cabinet's own origin, `sandbox="allow-same-origin"`
// without scripts and `script-src 'none'` — nothing of the artifact runs. The cabinet never relies
// on handlers inside it (WebKit does not call them): the pointer is taken on the cabinet's own layer
// above the frame (the frame has `pointer-events: none`), the element is found by `elementFromPoint`,
// the outline is drawn by the cabinet. The text is edited by native `contenteditable="plaintext-only"`
// on one element, read back at the end. Every method of the frame's document is called through the
// prototypes of the cabinet's window: names of elements may shadow those of its `document`.

export interface EditedText {
  /** The id the server stamped: `<block>.<n>`. */
  element: string
  shape: string[]
  edits: { slot: number; text: string }[]
}

export interface PickedElement {
  element: string
  tag: string
  text: string
}

/** The end of an edit: what changed; nothing; or the elements of the source moved under it. */
export type EditEnd = { kind: 'edit'; text: EditedText } | { kind: 'none' } | { kind: 'moved' }

export interface EditFrameHandle {
  /** Ends the edit under way. */
  commit: () => EditEnd
  discard: () => void
}

type Box4 = { x: number; y: number; w: number; h: number }

const ID = 'data-rid'
const SHOWN_TEXT = 60

// The getters of the cabinet's own prototypes: an element named `contains` or `textContent` inside
// a form shadows the properties of that form (named properties), never these.
// Read on use, never on import: the module is also evaluated on the server, where there is no DOM.
const getter =
  <T,>(proto: () => object, name: string) =>
  (node: unknown): T =>
    (Object.getOwnPropertyDescriptor(proto(), name)!.get! as (this: unknown) => T).call(node)
const nodeTypeOf = getter<number>(() => Node.prototype, 'nodeType')
const nodeNameOf = getter<string>(() => Node.prototype, 'nodeName')
const nodeValueOf = getter<string | null>(() => Node.prototype, 'nodeValue')
const textOf = getter<string | null>(() => Node.prototype, 'textContent')
const childrenOf = getter<NodeListOf<ChildNode>>(() => Node.prototype, 'childNodes')
const connected = getter<boolean>(() => Node.prototype, 'isConnected')
const localNameOf = getter<string>(() => Element.prototype, 'localName')
const bodyOf = getter<HTMLElement | null>(() => Document.prototype, 'body')
const rootOf = getter<HTMLElement | null>(() => Document.prototype, 'documentElement')
const scrollHeightOf = getter<number>(() => Element.prototype, 'scrollHeight')
const kids = (node: Node) => Array.from(childrenOf(node))
const isElement = (node: Node): node is Element => nodeTypeOf(node) === 1
const isText = (node: Node) => nodeTypeOf(node) === 3

/** The non-text children of an element as the server reads them (`artifactElementShape`). */
function shapeOf(element: Element): string[] {
  return kids(element)
    .filter((child) => !isText(child))
    .map((child) =>
      isElement(child)
        ? `${localNameOf(child)}#${Element.prototype.getAttribute.call(child, ID) ?? ''}`
        : nodeNameOf(child),
    )
}

/** The slots of text: the runs of text between its non-text children. */
function slotsOf(element: Element): string[] {
  const slots = ['']
  for (const child of kids(element)) {
    if (isText(child)) slots[slots.length - 1] += nodeValueOf(child) ?? ''
    else slots.push('')
  }
  return slots
}

/**
 * The slots after an edit: a line break the browser added (`<br>` in WebKit and Firefox, `\n` in
 * Chromium) is text; another element it added is read as its text; one the source had ends a slot.
 * Null — an element of the source is gone or moved: the edit cannot be put back into the source.
 */
function editedSlots(element: Element, shape: readonly string[]): string[] | null {
  const slots = ['']
  const seen: string[] = []
  for (const child of kids(element)) {
    if (isText(child)) {
      slots[slots.length - 1] += nodeValueOf(child) ?? ''
      continue
    }
    if (isElement(child)) {
      const id = Element.prototype.getAttribute.call(child, ID)
      if (id === null) {
        // Added by the browser while typing.
        slots[slots.length - 1] += localNameOf(child) === 'br' ? '\n' : `${textOf(child) ?? ''}\n`
        continue
      }
      seen.push(`${localNameOf(child)}#${id}`)
    } else seen.push(nodeNameOf(child))
    slots.push('')
  }
  if (JSON.stringify(seen) !== JSON.stringify(shape)) return null
  // The placeholder line break of an element whose text was cleared is no text.
  return slots.map((slot) => slot.replace(/\n$/, ''))
}

function rectOf(element: Element): Box4 {
  const rect = Element.prototype.getBoundingClientRect.call(element)
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
}

export function EditFrame({
  src,
  width,
  scale,
  title,
  mode,
  onPick,
  onEditing,
  ref,
  fixedHeight,
}: {
  src: string
  width: number
  /** A slide of «Презентация» (88.25): its 720 px, whatever the copy measures. */
  fixedHeight?: number
  scale: number
  title: string
  mode: 'select' | 'text'
  onPick: (picked: PickedElement | null) => void
  /** Whether an edit of text is under way, and whether it changed anything yet. */
  onEditing: (editing: { dirty: boolean } | null) => void
  ref?: Ref<EditFrameHandle>
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(fixedHeight ?? 900)
  const [outline, setOutline] = useState<Box4 | null>(null)
  const editing = useRef<{
    element: Element
    shape: string[]
    slots: string[]
    observer: MutationObserver
  } | null>(null)
  const selected = useRef<Element | null>(null)

  const documentOf = (): Document | null => {
    const doc = frame.current?.contentDocument ?? null
    // The first load may be about:blank; the copy of the mockup has a body.
    return doc && bodyOf(doc) ? doc : null
  }

  // Each load of the copy: its height, and nothing left of the edit before.
  useEffect(() => {
    const element = frame.current
    if (!element) return
    const controller = new AbortController()
    const measure = () => {
      const doc = documentOf()
      if (!doc) return
      if (fixedHeight === undefined)
        setHeight(Math.min(Math.max(scrollHeightOf(rootOf(doc)), 100), 20_000))
      editing.current = null
      selected.current = null
      setOutline(null)
    }
    element.addEventListener('load', measure, { signal: controller.signal })
    measure()
    return () => controller.abort()
  }, [src, fixedHeight])

  // The outline follows the element on the cabinet's own frames of animation.
  useEffect(() => {
    let raf = 0
    const follow = () => {
      const element = editing.current?.element ?? selected.current
      if (element && connected(element)) {
        const next = rectOf(element)
        setOutline((was) =>
          was && was.x === next.x && was.y === next.y && was.w === next.w && was.h === next.h
            ? was
            : next,
        )
      }
      raf = requestAnimationFrame(follow)
    }
    raf = requestAnimationFrame(follow)
    return () => cancelAnimationFrame(raf)
  }, [])

  const stop = () => {
    const current = editing.current
    if (!current) return null
    current.observer.disconnect()
    Element.prototype.removeAttribute.call(current.element, 'contenteditable')
    editing.current = null
    onEditing(null)
    return current
  }

  useImperativeHandle(ref, () => ({
    commit: () => {
      const current = stop()
      if (!current) return { kind: 'none' }
      const element = Element.prototype.getAttribute.call(current.element, ID)!
      const after = editedSlots(current.element, current.shape)
      if (after === null || after.length !== current.slots.length) return { kind: 'moved' }
      const edits = after.flatMap((text, slot) =>
        text === current.slots[slot] ? [] : [{ slot, text }],
      )
      return edits.length === 0
        ? { kind: 'none' }
        : { kind: 'edit', text: { element, shape: current.shape, edits } }
    },
    discard: () => {
      stop()
      // The DOM of the copy was typed into: load it again.
      if (frame.current) frame.current.src = src
    },
  }))

  const pointAt = (clientX: number, clientY: number) => {
    const doc = documentOf()
    const box = frame.current?.getBoundingClientRect()
    if (!doc || !box) return null
    const x = (clientX - box.left) / scale
    const y = (clientY - box.top) / scale
    const hit = Document.prototype.elementFromPoint.call(doc, x, y)
    const element = hit ? Element.prototype.closest.call(hit, `[${ID}]`) : null
    return element ? { doc, element, x, y } : null
  }

  const caretTo = (doc: Document, x: number, y: number) => {
    const selection = Document.prototype.getSelection.call(doc)
    if (!selection) return
    const proto = Document.prototype as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    const position = proto.caretPositionFromPoint?.call(doc, x, y)
    if (position) selection.collapse(position.offsetNode, position.offset)
    else {
      const range = proto.caretRangeFromPoint?.call(doc, x, y)
      if (range) selection.collapse(range.startContainer, range.startOffset)
    }
  }

  const onPointerDown = (event: React.PointerEvent) => {
    // The focus stays in the frame: the layer is the cabinet's, not a place to type.
    event.preventDefault()
    const at = pointAt(event.clientX, event.clientY)
    if (mode === 'select') {
      selected.current = at?.element ?? null
      if (!at) {
        setOutline(null)
        onPick(null)
        return
      }
      const text = (textOf(at.element) ?? '').replace(/\s+/g, ' ').trim()
      onPick({
        element: Element.prototype.getAttribute.call(at.element, ID)!,
        tag: localNameOf(at.element),
        text: text.length > SHOWN_TEXT ? `${text.slice(0, SHOWN_TEXT)}…` : text,
      })
      return
    }
    const current = editing.current
    if (
      current &&
      at &&
      (at.element === current.element || Node.prototype.contains.call(current.element, at.element))
    ) {
      HTMLElement.prototype.focus.call(current.element as HTMLElement)
      caretTo(at.doc, at.x, at.y)
      return
    }
    // A click elsewhere ends nothing by itself: «Готово» or «Отменить правку» does.
    if (current || !at) return
    const element = at.element
    Element.prototype.setAttribute.call(element, 'contenteditable', 'plaintext-only')
    const observer = new MutationObserver(() => onEditing({ dirty: true }))
    observer.observe(element, { childList: true, characterData: true, subtree: true })
    editing.current = { element, shape: shapeOf(element), slots: slotsOf(element), observer }
    onEditing({ dirty: false })
    HTMLElement.prototype.focus.call(element as HTMLElement)
    caretTo(at.doc, at.x, at.y)
  }

  return (
    <Box
      sx={{
        position: 'relative',
        width: width * scale,
        height: height * scale,
        mx: 'auto',
        overflow: 'hidden',
      }}
    >
      <iframe
        ref={frame}
        key={src}
        src={src}
        title={title}
        sandbox={ARTIFACT_EDIT_SANDBOX}
        data-artifact-frame="edit"
        style={{
          width,
          height,
          border: 0,
          display: 'block',
          pointerEvents: 'none',
          transform: scale === 1 ? undefined : `scale(${scale})`,
          transformOrigin: '0 0',
          background: '#fff',
        }}
      />
      <Box
        data-testid="edit-frame-layer"
        onPointerDown={onPointerDown}
        sx={{ position: 'absolute', inset: 0, cursor: mode === 'text' ? 'text' : 'crosshair' }}
      />
      {outline && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            left: outline.x * scale - 2,
            top: outline.y * scale - 2,
            width: outline.w * scale + 4,
            height: outline.h * scale + 4,
            border: 2,
            borderColor: 'primary.main',
            borderRadius: '4px',
            pointerEvents: 'none',
          }}
        />
      )}
    </Box>
  )
}
