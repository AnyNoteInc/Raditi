import { canvasViews, type CanvasBlock } from './canvas.ts'
import { artifactRenderLimits } from './limits.ts'

// «Презентация» (docs/plan/88-artifacts.md, §7.13, Э11, slice 88.25): slides of 1280×720 on the
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

/** The views a frame of a kind is drawn at: a screen of a canvas twice, a slide once. */
export function artifactFrameViewsOf(kind: string): readonly FrameView[] {
  return kind === 'slides' ? slideViews : canvasViews
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
