import { fitRect, type BrowserSize, type FittedRect } from '@repo/domain/browser/coordinates'
import type { BrowserFrame } from '@repo/domain/browser/stream-codec'

// How a frame of the stream reaches the screen (docs/plan/57-browser-tasks.md, Б13, Б29): the
// JPEG decoded off the main thread's parser, drawn whole, scaled to fit the panel with margins
// (a letterbox), sharp on a screen of any pixel density. The last image stays: a resized panel
// is drawn again from it, and a broken stream keeps it on the screen.

/** Decodes the JPEG of a frame; `createImageBitmap` in a browser. */
export type DecodeJpeg = (jpeg: Uint8Array) => Promise<ImageBitmap>

export const decodeJpeg: DecodeJpeg = (jpeg) =>
  createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }))

export interface FramePainter {
  /** Draws a frame; false when it could not be decoded (nothing changes on the screen). */
  paint(frame: BrowserFrame): Promise<boolean>
  /** The panel got another size: CSS pixels and the device pixel ratio. */
  resize(width: number, height: number, pixelRatio: number): void
  /**
   * Where the image lies in the panel, in CSS pixels: what a point of input is measured on.
   * Before the first frame, where a window of `fallback`'s proportions would lie.
   */
  rect(fallback?: BrowserSize): FittedRect
  /**
   * The picture moved by `shift` window pixels of `viewport` (docs/plan/85-browser-stream-mobile.md,
   * ТР7): a scroll sent that no frame shows yet. What it uncovers stays the colour of the panel.
   * `redraw: false` — for the frame about to be painted: the old picture stays where it is until
   * the new one replaces it, never moved back while the new one is decoded.
   */
  shift(
    shift: { dx: number; dy: number },
    viewport: BrowserSize,
    options?: { redraw?: boolean },
  ): void
  /** A frame has been drawn: there is something on the screen. */
  painted(): boolean
  /** The panel goes: the last image is released. */
  dispose(): void
}

/** The 2D context the painter draws with: a fake one in the tests. */
export interface PaintContext {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  clearRect(x: number, y: number, width: number, height: number): void
  drawImage(image: CanvasImageSource, x: number, y: number, width: number, height: number): void
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void
  imageSmoothingQuality?: ImageSmoothingQuality
}

export function createFramePainter(
  canvas: HTMLCanvasElement,
  options: { decode?: DecodeJpeg; context?: PaintContext | null } = {},
): FramePainter {
  const decode = options.decode ?? decodeJpeg
  const context: PaintContext | null =
    options.context !== undefined ? options.context : canvas.getContext('2d')
  let size: BrowserSize = { width: 0, height: 0 }
  let ratio = 1
  let image: ImageBitmap | null = null
  let imageSize: BrowserSize | null = null
  let disposed = false
  let moved = { dx: 0, dy: 0 }
  let movedIn: BrowserSize | null = null
  /** A shift given for the next frame and not on the screen yet. */
  let pending = false

  const rect = (fallback?: BrowserSize): FittedRect => fitRect(size, imageSize ?? fallback ?? size)

  function draw() {
    if (context === null) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, size.width, size.height)
    if (image === null || imageSize === null) return
    const where = rect()
    if (context.imageSmoothingQuality !== undefined) context.imageSmoothingQuality = 'high'
    // Window pixels of the shift as pixels of the panel: the picture goes the other way.
    const ox = movedIn && movedIn.width > 0 ? (-moved.dx * where.width) / movedIn.width : 0
    const oy = movedIn && movedIn.height > 0 ? (-moved.dy * where.height) / movedIn.height : 0
    if (ox === 0 && oy === 0) {
      context.drawImage(image, where.x, where.y, where.width, where.height)
      return
    }
    // Only the part still inside the picture's place is drawn: nothing spills on the margins.
    const width = where.width - Math.abs(ox)
    const height = where.height - Math.abs(oy)
    if (width <= 0 || height <= 0) return
    const kx = imageSize.width / where.width
    const ky = imageSize.height / where.height
    context.drawImage(
      image,
      Math.max(0, -ox) * kx,
      Math.max(0, -oy) * ky,
      width * kx,
      height * ky,
      where.x + Math.max(0, ox),
      where.y + Math.max(0, oy),
      width,
      height,
    )
  }

  return {
    async paint(frame) {
      let next: ImageBitmap
      try {
        next = await decode(frame.jpeg)
      } catch {
        // No new picture: the shift meant for it goes on the old one.
        if (pending) {
          pending = false
          draw()
        }
        return false
      }
      if (disposed) {
        next.close?.()
        return false
      }
      image?.close?.()
      image = next
      imageSize = { width: frame.header.width, height: frame.header.height }
      pending = false
      draw()
      return true
    },
    resize(width, height, pixelRatio) {
      const nextRatio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1
      size = { width: Math.max(0, width), height: Math.max(0, height) }
      ratio = nextRatio
      canvas.width = Math.max(1, Math.round(size.width * ratio))
      canvas.height = Math.max(1, Math.round(size.height * ratio))
      draw()
    },
    rect,
    shift(next, viewport, options) {
      if (!Number.isFinite(next.dx) || !Number.isFinite(next.dy)) return
      moved = { dx: next.dx, dy: next.dy }
      movedIn = { width: viewport.width, height: viewport.height }
      if (options?.redraw === false) {
        pending = true
        return
      }
      pending = false
      draw()
    },
    painted: () => image !== null,
    dispose() {
      disposed = true
      image?.close?.()
      image = null
    },
  }
}
