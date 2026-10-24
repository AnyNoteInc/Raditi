/**
 * Points of the canvas and of the browser window (docs/plan/57-browser-tasks.md, §3.6, Б29): the
 * panel draws the frame scaled to fit, centred, with margins; a point the viewer touches is turned
 * into a point of the window, and a point on a margin is not sent at all. CSS pixels both sides.
 */
export interface BrowserSize {
  width: number
  height: number
}

export interface BrowserPoint {
  x: number
  y: number
}

/** Where the image lies in the container, in whole pixels, and how much it is scaled. */
export interface FittedRect {
  x: number
  y: number
  width: number
  height: number
  scale: number
}

const EMPTY: FittedRect = Object.freeze({ x: 0, y: 0, width: 0, height: 0, scale: 0 })

const usable = (size: BrowserSize) =>
  Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0

/**
 * The largest rectangle of the window's proportions that fits the container, centred (the
 * margins of a letterbox go to both sides; an odd pixel to the right and bottom). Nothing to
 * draw — an empty or broken size on either side — is a rectangle of zero size.
 */
export function fitRect(container: BrowserSize, viewport: BrowserSize): FittedRect {
  if (!usable(container) || !usable(viewport)) return EMPTY
  const scale = Math.min(container.width / viewport.width, container.height / viewport.height)
  const width = Math.min(container.width, Math.max(1, Math.round(viewport.width * scale)))
  const height = Math.min(container.height, Math.max(1, Math.round(viewport.height * scale)))
  return {
    x: Math.floor((container.width - width) / 2),
    y: Math.floor((container.height - height) / 2),
    width,
    height,
    scale,
  }
}

/**
 * The point of the window under a point of the container: the pixel it falls on, inside the
 * window always; null on a margin or with nothing drawn.
 */
export function toViewportPoint(
  point: BrowserPoint,
  rect: FittedRect,
  viewport: BrowserSize,
): BrowserPoint | null {
  if (rect.width <= 0 || rect.height <= 0 || !usable(viewport)) return null
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
  const dx = point.x - rect.x
  const dy = point.y - rect.y
  if (dx < 0 || dy < 0 || dx >= rect.width || dy >= rect.height) return null
  return {
    x: clamp(Math.floor((dx * viewport.width) / rect.width), viewport.width - 1),
    y: clamp(Math.floor((dy * viewport.height) / rect.height), viewport.height - 1),
  }
}

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max)
