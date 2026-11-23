import { artifactFrameBlocksOf } from './frame.ts'
import { artifactLimits, artifactRenderLimits } from './limits.ts'

/**
 * «Холст» (docs/plan/88-artifacts.md, Ар8, Ар49, §7.7, §7.10; spike 6; slice 88.15): a board of the
 * screens of a site. A screen is one adaptive frame (`frame` block: its `html`, `style` and
 * `script` children) the board shows side by side at the width of a computer and of a phone;
 * variants А and Б are frames of their own with the same name. A sticky note is a `note` block at
 * the top with its place; a pin is a `note` inside a frame, its place in per cent of the frame.
 * The common style of the canvas is a `style` block at the top, its settings one `settings`.
 */

/** The two views of a screen (Ар8): the width and the window of the device. */
export const canvasViews = Object.freeze([
  { width: artifactRenderLimits.viewportWidths.desktop, height: 900, label: 'Компьютер' },
  { width: artifactRenderLimits.viewportWidths.phone, height: 844, label: 'Телефон' },
] as const)
export type CanvasViewWidth = (typeof canvasViews)[number]['width']

/** Thumbnails are drawn at half of the CSS pixels of a view (§7.7); the phone list at 2× its top. */
export const canvasThumbScale = 0.5
/** How tall the full thumbnail of a view is at most, in CSS px of the page (spike 3). */
export const canvasThumbMaxCssPx = 4800
/** The gap between the two views of a screen and between the screens, in board px. */
export const canvasGap = 80

/** What a block of a canvas is as the board reads it. */
export interface CanvasBlock {
  key: string
  kind: string
  parent: string | null
  rank?: string | null
  rev: number
  content: string | null
  props: Readonly<Record<string, unknown>>
}

export interface CanvasScreen {
  key: string
  name: string
  variant: string | null
  /** The variant the client chose of its screen (`chosen`): published instead of the others. */
  chosen: boolean
  /** Its place on the board; absent — the board lays it out by order. */
  x: number
  y: number
  /** The address of its page when the canvas is published as a site, `/` or `/<path>`. */
  path: string
}

export interface CanvasNote {
  key: string
  text: string
  /** The frame of a pin; null — a sticky note of the board. */
  frame: string | null
  x: number
  y: number
  color: string
}

const num = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

const translit: Readonly<Record<string, string>> = Object.freeze({
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
})

/** A segment of an address from the name of a screen: «О компании» → `o-kompanii`. */
export function canvasSegmentOf(name: string): string {
  const latin = [...name.toLowerCase()].map((char) => translit[char] ?? char).join('')
  const segment = latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return segment === '' ? 'page' : segment
}

const pathPattern = /^\/(?:[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)?$/

/**
 * The screens of a canvas in their order, each with its place and the address of its page: the
 * `path` property of the frame when it is one, else `/` for the first screen and the segment of the
 * name for the others; a second screen of the same address gets `-2`, `-3`.
 */
export function canvasScreensOf(blocks: readonly CanvasBlock[]): CanvasScreen[] {
  return canvasScreens(blocks, false)
}

function canvasScreens(blocks: readonly CanvasBlock[], legacyPaths: boolean): CanvasScreen[] {
  const frames = blocks.filter((block) => block.kind === 'frame' && block.parent === null)
  const used = new Set<string>()
  const pathsByName = new Map<string, string>()
  const width = canvasViews[0].width + canvasGap + canvasViews[1].width + canvasGap * 2
  return frames.map((frame, index) => {
    const name = str(frame.props.name) ?? `Экран ${index + 1}`
    let path = legacyPaths ? undefined : pathsByName.get(name)
    if (path === undefined) {
      const asked = str(frame.props.path)
      const base =
        asked !== null && pathPattern.test(asked)
          ? asked
          : index === 0
            ? '/'
            : `/${canvasSegmentOf(name)}`
      path = base
      for (let n = 2; used.has(path); n += 1) path = base === '/' ? `/page-${n}` : `${base}-${n}`
      used.add(path)
      pathsByName.set(name, path)
    }
    return {
      key: frame.key,
      name,
      variant: str(frame.props.variant),
      chosen: frame.props.chosen === true,
      x: num(frame.props.x, (index % 2) * width),
      y: num(frame.props.y, Math.floor(index / 2) * 2400),
      path,
    }
  })
}

/** The notes and pins of a canvas: a pin's place is in per cent of its frame. */
export function canvasNotesOf(blocks: readonly CanvasBlock[]): CanvasNote[] {
  const frames = new Set(blocks.filter((b) => b.kind === 'frame').map((b) => b.key))
  return blocks
    .filter((block) => block.kind === 'note' && (block.parent === null || frames.has(block.parent)))
    .map((note) => ({
      key: note.key,
      text: note.content ?? '',
      frame: note.parent,
      x: num(note.props.x, 0),
      y: num(note.props.y, 0),
      color: str(note.props.color) ?? 'yellow',
    }))
}

/**
 * The screens «Опубликовать как сайт» makes pages of (Ар8, §7.10): one page a screen — of a
 * screen with variants the chosen one, or the first when none is chosen.
 */
export function canvasPublishedScreens(
  blocks: readonly CanvasBlock[],
): (CanvasScreen & { frameKeys: readonly string[] })[] {
  return publishedVariants(canvasScreensOf(blocks))
}

function publishedVariants(screens: readonly CanvasScreen[]) {
  const byName = new Map<string, CanvasScreen[]>()
  for (const screen of screens)
    byName.set(screen.name, [...(byName.get(screen.name) ?? []), screen])
  return [...byName.values()].map((group) => ({
    ...(group.find((screen) => screen.chosen) ?? group[0]!),
    frameKeys: group.map((screen) => screen.key).toSorted(),
  }))
}

/** Older publications left the home frame unset: replay their selection on the saved blocks. */
export function canvasLegacyHome(blocks: readonly CanvasBlock[]): readonly string[] {
  const screens = canvasScreens(blocks, true)
  const selected = new Map(publishedVariants(screens).map((screen) => [screen.key, screen]))
  const first = screens.find((screen) => selected.has(screen.key))
  const root = screens.find((screen) => screen.path === '/' && selected.has(screen.key))
  return (root ? selected.get(root.key) : first && selected.get(first.key))?.frameKeys ?? []
}

/** Which frames the board shows live (§7.7, spike 6): in view, at 30 % and more, at most four. */
export function canvasLiveFrames(input: {
  /** The frames with the share of each in the view, the most visible first. */
  visible: readonly { key: string; share: number }[]
  scale: number
  zooming: boolean
}): string[] {
  if (input.zooming || input.scale < artifactLimits.liveFrameMinScale) return []
  return [...input.visible]
    .filter((frame) => frame.share > 0)
    .sort((a, b) => b.share - a.share)
    .slice(0, artifactLimits.liveFrames)
    .map((frame) => frame.key)
}

/**
 * The thumbnail key includes the assembled, checked parts in render order. A pending agent
 * write takes its revision before approval, so revisions alone cannot identify the visible text.
 */
export function canvasThumbKey(input: {
  blocks: readonly Pick<CanvasBlock, 'key' | 'kind' | 'parent' | 'rev' | 'content'>[]
  frame: string
  title: string
  /** The brand of the canvas: its artifact and its `seq`; null — none. */
  brand: { id: string; seq: number } | null
}): string {
  const parts = artifactFrameBlocksOf({ framed: true, blocks: input.blocks, frame: input.frame })
  const entry = (block: (typeof input.blocks)[number]) => [block.key, block.rev, block.content]
  const used = parts && {
    html: parts.html.map(entry),
    style: parts.style.map(entry),
    script: parts.script.map(entry),
    settings: parts.settings && entry(parts.settings),
  }
  // The size of a picture of «Изображение» is a property of its frame (88.26): a new size, a new
  // thumbnail.
  const size = (
    input.blocks.find((block) => block.key === input.frame) as
      { props?: Readonly<Record<string, unknown>> } | undefined
  )?.props?.size
  return stringHash(
    JSON.stringify({
      v: CANVAS_RENDER_VERSION,
      frame: input.frame,
      ...(typeof size === 'string' ? { size } : {}),
      title: input.title,
      used,
      brand: input.brand,
    }),
  )
}

/**
 * A hash of a text for a cache key, the same in the browser and on the server (no `node:crypto`
 * in a module the cabinet loads): two 53-bit hashes of different seeds, 26 hex characters.
 */
export function stringHash(text: string): string {
  const one = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed
    let h2 = 0x41c6ce57 ^ seed
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i)
      h1 = Math.imul(h1 ^ code, 2654435761)
      h2 = Math.imul(h2 ^ code, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0').slice(-13)
  }
  return one(1) + one(2)
}

/** The version of the renderer of frames: a change of how a frame is drawn draws them again. */
export const CANVAS_RENDER_VERSION = 2

/** Where a thumbnail lies in the artifacts bucket (spec §14). */
export const canvasThumbObjectKey = (input: {
  workspaceId: string
  artifactId: string
  key: string
  width: number
}): string =>
  `artifacts/${input.workspaceId.toLowerCase()}/${input.artifactId.toLowerCase()}/thumbs/${input.key}-${input.width}.jpg`
