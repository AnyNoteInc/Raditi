// A clean SVG the server drew — of «Схема» and of a diagram of the chat — shown as `<img>` and
// saved as SVG or PNG (docs/plan/88-artifacts.md, §7.13; docs/plan/91-chat-diagrams.md, Д1).

export const svgDataUrl = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A PNG of the picture at twice its size, drawn in the browser from the same clean SVG. */
export async function svgToPng(svg: string, width: number, height: number): Promise<Blob | null> {
  const image = new Image()
  image.src = svgDataUrl(svg)
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = width * 2
  canvas.height = height * 2
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

/** A file name of a title: no characters a file system refuses. */
export const pictureFileName = (title: string, extension: string, fallback = 'Схема') =>
  `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || fallback}.${extension}`
