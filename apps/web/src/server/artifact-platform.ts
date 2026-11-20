import 'server-only'

import { createHash } from 'node:crypto'

import { artifactPlatformPath } from '@repo/domain/artifacts'

import { artifactFontSources } from './artifact-fonts.generated'

// The files of the platform a frame of an artifact loads from the root of the pages
// (docs/plan/88-artifacts.md, Ар28, Ар30; spike 2): `/v/<label>.<hash>`, the same bytes forever
// under one address. No CDN and no Google Fonts (rule 1): Golos Text of the cabinet, by subsets.

export interface ArtifactPlatformFile {
  label: string
  hash: string
  type: string
  bytes: Uint8Array
}

/** The faces of Golos Text and the characters of each (as @fontsource-variable/golos-text says). */
const ranges: Readonly<Record<keyof typeof artifactFontSources, string>> = Object.freeze({
  'lib-golos-cyr': 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
  'lib-golos-lat':
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
})

export const artifactPlatformFiles: readonly ArtifactPlatformFile[] = Object.freeze(
  Object.entries(artifactFontSources).map(([label, source]) => {
    const bytes = new Uint8Array(Buffer.from(source.base64, 'base64'))
    return {
      label,
      hash: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
      type: 'font/woff2',
      bytes,
    }
  }),
)

/** The file a segment `<label>.<hash>` of `/v/` names; null — none (an old hash too). */
export function artifactPlatformFileOf(label: string, hash: string): ArtifactPlatformFile | null {
  return artifactPlatformFiles.find((file) => file.label === label && file.hash === hash) ?? null
}

/** The CSS of the fonts of the platform for a frame, with the absolute addresses its CSP names. */
export function artifactPlatformFonts(pagesOrigin: string): { css: string; urls: string[] } {
  const urls: string[] = []
  const css = artifactPlatformFiles
    .map((file) => {
      const url = `${pagesOrigin}${artifactPlatformPath(file.label, file.hash)}`
      urls.push(url)
      return `@font-face{font-family:'Golos Text';font-style:normal;font-display:swap;font-weight:400 900;src:url(${url}) format('woff2');unicode-range:${ranges[file.label as keyof typeof ranges]}}`
    })
    .join('')
  return { css, urls }
}
