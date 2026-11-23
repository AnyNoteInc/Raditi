import { PDFDocument } from 'pdf-lib'
import pptxModule from 'pptxgenjs'

// The PDF and the PPTX of «Презентация» (docs/plan/88-artifacts.md, §7.13, slice 88.25в): each slide
// the picture the renderer drew of it — the same 1280×720 the client sees —, one page or one slide
// each, in order; the PPTX keeps the speaker notes. Pictures, not editable text: a frame of HTML has
// no faithful shape in PowerPoint (§7.13, «PPTX картинками»).

/** pptxgenjs is CommonJS: its class is the default of the default under Node's interop. */
type PptxClass = (typeof pptxModule)['default']
const PptxGenJS: PptxClass =
  (pptxModule as unknown as { default?: PptxClass }).default ?? (pptxModule as unknown as PptxClass)

export interface DeckSlide {
  /** A JPEG of the slide, 16:9. */
  picture: Uint8Array
  notes: string
}

/** A PDF of 16:9 pages, one a slide: 960×540 pt (13.33×7.5 in), the slide over the whole page. */
export async function deckPdf(input: { title: string; slides: readonly DeckSlide[] }) {
  const pdf = await PDFDocument.create()
  pdf.setTitle(input.title)
  pdf.setProducer('Радити')
  pdf.setCreator('Радити')
  for (const slide of input.slides) {
    const image = await pdf.embedJpg(slide.picture)
    const page = pdf.addPage([960, 540])
    page.drawImage(image, { x: 0, y: 0, width: 960, height: 540 })
  }
  return new Uint8Array(await pdf.save())
}

/** A PPTX of 16:9 slides, the picture over the whole slide and the speaker notes below it. */
export async function deckPptx(input: { title: string; slides: readonly DeckSlide[] }) {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  pptx.title = input.title
  pptx.company = 'Радити'
  for (const each of input.slides) {
    const slide = pptx.addSlide()
    slide.addImage({
      data: `data:image/jpeg;base64,${Buffer.from(each.picture).toString('base64')}`,
      x: 0,
      y: 0,
      w: '100%',
      h: '100%',
    })
    if (each.notes.trim() !== '') slide.addNotes(each.notes)
  }
  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
  return new Uint8Array(out)
}
