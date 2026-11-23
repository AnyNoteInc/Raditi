import { canvasViews, type CanvasBlock } from './canvas.ts'
import { artifactRenderLimits } from './limits.ts'

// «Презентация» and «Изображение» (docs/plan/88-artifacts.md, §7.13, Э11, slices 88.25, 88.26): slides of 1280×720 on the
// mechanics of the canvas — a slide is a frame with its parts (`html`, `style`, `script`) and its
// speaker notes (`note` inside it), the common style at the top, the order of the slides the order
// of the frames. Pure: what the views of a framed kind are, and the slides read from the blocks.

export const slideSize = Object.freeze({
  width: artifactRenderLimits.viewportWidths.slide,
  height: artifactRenderLimits.viewportHeights.slide,
})

export const slideViews = Object.freeze([
  { width: slideSize.width, height: slideSize.height, label: 'Слайд' },
] as const)

export type FrameView = { width: number; height: number; label: string }

/**
 * The pictures of «Изображение» (88.26): a post, a story, a cover or a banner in the size of its
 * place, without a model that draws. The size of a frame is its `props.size`; absent — a post.
 */
export const artifactImageSizes = Object.freeze({
  post: { width: 1080, height: 1080, label: 'Пост' },
  portrait: { width: 1080, height: 1350, label: 'Пост 4:5' },
  story: { width: 1080, height: 1920, label: 'История' },
  'vk-cover': { width: 1920, height: 768, label: 'Обложка ВКонтакте' },
  banner: { width: 1200, height: 630, label: 'Баннер и превью ссылки' },
  wide: { width: 1920, height: 1080, label: 'Широкое' },
} as const)
export type ArtifactImageSize = keyof typeof artifactImageSizes
export const artifactImageSizeNames = Object.keys(artifactImageSizes) as ArtifactImageSize[]

export function artifactImageSizeOf(props: Readonly<Record<string, unknown>> | undefined) {
  const asked = props?.size
  return typeof asked === 'string' && asked in artifactImageSizes
    ? (asked as ArtifactImageSize)
    : 'post'
}

/**
 * The fixed size a frame of a kind is drawn at: a slide 1280×720, a picture its size; null — an
 * adaptive screen of a canvas, drawn at the widths of a computer and a phone.
 */
export function artifactFrameSizeOf(
  kind: string,
  frameProps?: Readonly<Record<string, unknown>>,
): FrameView | null {
  if (kind === 'slides') return slideViews[0]
  if (kind === 'image') return artifactImageSizes[artifactImageSizeOf(frameProps)]
  return null
}

/** The views a frame of a kind is drawn at: a screen of a canvas twice, a fixed frame once. */
export function artifactFrameViewsOf(
  kind: string,
  frameProps?: Readonly<Record<string, unknown>>,
): readonly FrameView[] {
  const fixed = artifactFrameSizeOf(kind, frameProps)
  return fixed ? [fixed] : canvasViews
}

export interface ArtifactSlide {
  key: string
  /** Its name: `props.name`, or «Слайд N». */
  name: string
  /** The speaker notes: the text of its `note`; '' — none. */
  notes: string
  /** The key of its `note` block; null — none yet. */
  noteKey: string | null
}

const str = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/** The slides in their order (the order of the frames at the top), each with its notes. */
export function artifactSlidesOf(blocks: readonly CanvasBlock[]): ArtifactSlide[] {
  return blocks
    .filter((block) => block.kind === 'frame' && block.parent === null)
    .map((frame, index) => {
      const note = blocks.find((block) => block.kind === 'note' && block.parent === frame.key)
      return {
        key: frame.key,
        name: str(frame.props.name) ?? `Слайд ${index + 1}`,
        notes: note?.content ?? '',
        noteKey: note?.key ?? null,
      }
    })
}
