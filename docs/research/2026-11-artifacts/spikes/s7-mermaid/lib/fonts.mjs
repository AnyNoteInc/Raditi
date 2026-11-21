// Golos Text (OFL-1.1, @fontsource/golos-text 5.3.0) as @font-face rules with data: URLs.
// The same rules go into the Mermaid render page (so text is measured with this font) and into the
// final SVG (so <img> shows the text with the same font on any device).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const root = dirname(require.resolve('@fontsource/golos-text/package.json'))

const RANGES = {
  cyrillic: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
}

export const FONT_FAMILY = 'Golos Text'

/** @font-face rules for the given weights; returns { css, bytes } where bytes is the raw woff2 total. */
export function golosFontFaces({ weights = [400, 600], subsets = ['cyrillic', 'latin', 'latin-ext'] } = {}) {
  let css = ''
  let bytes = 0
  for (const weight of weights) {
    for (const subset of subsets) {
      const file = join(root, 'files', `golos-text-${subset}-${weight}-normal.woff2`)
      const data = readFileSync(file)
      bytes += data.length
      css += `@font-face{font-family:'${FONT_FAMILY}';font-style:normal;font-weight:${weight};` +
        `src:url(data:font/woff2;base64,${data.toString('base64')}) format('woff2');unicode-range:${RANGES[subset]}}`
    }
  }
  return { css, bytes }
}
