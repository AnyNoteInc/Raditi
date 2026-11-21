import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// The fonts of the platform in the renderer (docs/plan/88-artifacts.md, Ар30): the same faces of
// Golos Text a frame of the cabinet loads from the root of the pages, served from memory to the
// Chromium of the renderer, which has no network.

const require = createRequire(import.meta.url)

export interface RenderFontFace {
  file: string
  range: string
  bytes: Uint8Array
}

const faces = [
  ['golos-text-cyrillic-wght-normal.woff2', 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116'],
  [
    'golos-text-latin-wght-normal.woff2',
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  ],
] as const

let loaded: readonly RenderFontFace[] | null = null

/** The faces, read once from @fontsource-variable/golos-text (OFL-1.1). */
export function renderFontFaces(): readonly RenderFontFace[] {
  if (loaded) return loaded
  const dir = join(
    dirname(require.resolve('@fontsource-variable/golos-text/package.json')),
    'files',
  )
  loaded = Object.freeze(
    faces.map(([file, range]) => ({
      file,
      range,
      bytes: new Uint8Array(readFileSync(join(dir, file))),
    })),
  )
  return loaded
}

/** The CSS of the fonts with their addresses on the origin of the renderer's files. */
export function renderFontCss(origin: string): { css: string; urls: string[] } {
  const urls: string[] = []
  const css = renderFontFaces()
    .map((face) => {
      const url = `${origin}/v/lib-${face.file}`
      urls.push(url)
      return `@font-face{font-family:'Golos Text';font-style:normal;font-display:swap;font-weight:400 900;src:url(${url}) format('woff2');unicode-range:${face.range}}`
    })
    .join('')
  return { css, urls }
}
