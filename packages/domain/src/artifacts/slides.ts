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

// ---- The deck theme (docs/plan/93-artifacts-trim.md, АТ8) ----

/** The key of the common style that carries the deck theme: one top-level `style` block. */
export const slidesThemeKey = 'deck-theme'

/**
 * The layouts of the theme, each a class beside `slide` on the `<section>` of a slide, with what
 * goes inside: the agent and «Добавить слайд» use them instead of writing CSS anew.
 */
export const slideLayouts = Object.freeze({
  's-title': 'the title: h1 and one line p',
  's-section': 'a section break: p.label and h2',
  's-points': 'h2 and a list of up to five short points',
  's-split': 'a div with h2 and p, then a figure with an img',
  's-number': 'p.value with one big number and a caption p',
  's-quote': 'blockquote and cite',
  's-end': 'the last slide: h2 and div.contacts',
} as const)
export type SlideLayout = keyof typeof slideLayouts

/**
 * The default theme of a deck: light, 1280×720, Golos Text, a type scale and safe padding of
 * 80 px, left-aligned. Colours and the font are CSS variables on `:root`, so one edit recolours
 * every slide.
 */
export const slidesThemeCss = [
  ":root{--deck-bg:#fff;--deck-fg:#16181d;--deck-muted:#5f6672;--deck-line:#e3e6eb;--deck-soft:#f3f5f8;--deck-accent:#3557c5;--deck-font:'Golos Text',Arial,sans-serif;--deck-pad:80px}",
  '*{box-sizing:border-box}',
  'html,body{margin:0;width:1280px;height:720px;overflow:hidden;background:var(--deck-bg);color:var(--deck-fg);font-family:var(--deck-font);-webkit-font-smoothing:antialiased}',
  '.slide{position:relative;width:1280px;height:720px;padding:var(--deck-pad);display:flex;flex-direction:column;justify-content:flex-start;align-items:flex-start;gap:28px;background:var(--deck-bg);overflow:hidden}',
  '.slide h1,.slide h2,.slide p,.slide ul,.slide ol,.slide blockquote,.slide figure{margin:0}',
  '.slide h1{font-size:72px;line-height:1.05;font-weight:600;letter-spacing:-.02em;max-width:1000px}',
  '.slide h2{font-size:48px;line-height:1.12;font-weight:600;letter-spacing:-.015em;max-width:1000px}',
  '.slide p,.slide li{font-size:28px;line-height:1.4;max-width:900px}',
  '.slide .caption,.slide small{font-size:20px;line-height:1.35;color:var(--deck-muted)}',
  '.slide .label{font-size:20px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--deck-accent)}',
  '.slide .muted{color:var(--deck-muted)}.slide .accent{color:var(--deck-accent)}',
  '.slide img{display:block;max-width:100%}',
  '.s-title{justify-content:flex-end;gap:24px}',
  ".s-title::before{content:'';position:absolute;left:var(--deck-pad);top:var(--deck-pad);width:64px;height:6px;border-radius:3px;background:var(--deck-accent)}",
  '.s-title p{color:var(--deck-muted);max-width:760px}',
  '.s-section{justify-content:center;background:var(--deck-soft)}',
  '.s-points ul,.s-points ol{list-style:none;padding:0;display:grid;gap:18px;margin-top:8px}',
  ".s-points li{position:relative;padding-left:40px}.s-points li::before{content:'';position:absolute;left:0;top:.6em;width:18px;height:4px;border-radius:2px;background:var(--deck-accent)}",
  '.s-split{display:grid;grid-template-columns:minmax(0,1fr) 520px;gap:64px;align-items:center;padding-right:0}',
  '.s-split>div{display:flex;flex-direction:column;gap:24px}',
  '.s-split figure{align-self:stretch;margin:calc(-1 * var(--deck-pad)) 0;display:flex;align-items:center;justify-content:center;background:var(--deck-soft);color:var(--deck-muted);font-size:20px;overflow:hidden}',
  '.s-split figure img{width:100%;height:100%;object-fit:cover}',
  '.s-number{justify-content:center;gap:16px}',
  '.s-number .value{font-size:160px;line-height:.95;font-weight:600;letter-spacing:-.03em;color:var(--deck-accent);font-variant-numeric:tabular-nums}',
  '.s-number p{max-width:760px}',
  '.s-quote{justify-content:center;gap:24px}',
  '.s-quote blockquote{font-size:44px;line-height:1.25;font-weight:500;letter-spacing:-.01em;max-width:1040px;padding-left:40px;border-left:6px solid var(--deck-accent)}',
  '.s-quote cite{font-style:normal;font-size:20px;color:var(--deck-muted);padding-left:46px}',
  '.s-end{justify-content:flex-end;gap:32px}',
  '.s-end .contacts{display:flex;flex-wrap:wrap;gap:16px 48px;width:100%;padding-top:24px;border-top:2px solid var(--deck-line);font-size:24px;color:var(--deck-muted)}',
].join('\n')

/** The common style block of a new deck: the theme, at the top (АТ8). */
export const slidesThemeBlock = Object.freeze({
  kind: 'style' as const,
  key: slidesThemeKey,
  content: slidesThemeCss,
})

/** The HTML of a slide «Добавить слайд» puts in: the points layout of the theme. */
export const newSlideHtml =
  '<section class="slide s-points"><h2>Заголовок слайда</h2><ul><li>Первая мысль</li><li>Вторая мысль</li><li>Третья мысль</li></ul></section>'
