import { z } from 'zod'

import { checkPageFile } from '../pages/files.ts'
import { PAGE_COMMON_HEADERS } from '../pages/headers.ts'

/**
 * The frame of an artifact (docs/plan/88-artifacts.md, Ар9, Ар12, Ар28–Ар31, §7.7, §7.9; spikes
 * 1 and 2): how a screen of a canvas, a slide or a picture is shown on the root of the domain of pages, how its files, fonts and
 * libraries are named and served, what its bridge to the cabinet says, and the edit frame of the
 * cabinet that runs no script at all.
 */

/**
 * The sandbox of the frame of an artifact (Ар28): its scripts, never pop-ups, the top, forms or
 * the same origin. The same set stands in the `sandbox` attribute and in the CSP.
 */
export const ARTIFACT_SANDBOX = 'allow-scripts'

/** The sandbox of the edit frame (Ар9): the cabinet reads its DOM, no script runs in it. */
export const ARTIFACT_EDIT_SANDBOX = 'allow-same-origin'

/** What a frame document loads besides itself: exact absolute addresses of the domain of pages. */
export interface ArtifactFrameSources {
  scripts: readonly string[]
  styles: readonly string[]
  images: readonly string[]
  fonts: readonly string[]
}

export const noFrameSources: ArtifactFrameSources = Object.freeze({
  scripts: [],
  styles: [],
  images: [],
  fonts: [],
})

const list = (base: string, extra: readonly string[]) =>
  [base, ...new Set(extra)].filter((each) => each !== '').join(' ')

/**
 * The policy of the frame of an artifact (Ар28): only the addresses it names — each file, font and
 * library exactly (spike 2: 64 of them fit a header in every engine) —, no network, form, frame or
 * worker, framed only by the cabinet.
 */
export function artifactFramePolicy(framedBy: string, sources: ArtifactFrameSources): string {
  return [
    `sandbox ${ARTIFACT_SANDBOX}`,
    "default-src 'none'",
    `script-src ${list("'unsafe-inline'", sources.scripts)}`,
    `style-src ${list("'unsafe-inline'", sources.styles)}`,
    `img-src ${list('data: blob:', sources.images)}`,
    `font-src ${list('data:', sources.fonts)}`,
    'media-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    `frame-ancestors ${framedBy}`,
    "object-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
  ].join('; ')
}

/** The headers of a frame document on `/v/<token>` (no ACAO, ever: Ар28). */
export function artifactFrameHeaders(
  framedBy: string,
  sources: ArtifactFrameSources,
): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': artifactFramePolicy(framedBy, sources),
    'Cache-Control': 'no-store',
    ...PAGE_COMMON_HEADERS,
  }
}

/**
 * The headers of the edit frame `/api/artifact-frame/<token>` on the origin of the cabinet (Ар9,
 * §7.9; spike 1): no script by the sandbox and by `script-src 'none'`, pictures and fonts only of
 * the root of the pages, framed only by the cabinet itself.
 */
export function artifactEditFrameHeaders(pagesOrigin: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': [
      `sandbox ${ARTIFACT_EDIT_SANDBOX}`,
      "default-src 'none'",
      "script-src 'none'",
      "style-src 'unsafe-inline'",
      `img-src data: blob: ${pagesOrigin}`,
      `font-src data: ${pagesOrigin}`,
      'media-src data:',
      "connect-src 'none'",
      "form-action 'none'",
      "frame-src 'none'",
      "child-src 'none'",
      "object-src 'none'",
      "worker-src 'none'",
      "manifest-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self'",
    ].join('; '),
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  }
}

// ---- The files of an artifact (Ар12) ----

const fileIdPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const fileRefGlobal = new RegExp(`artifact-file:(${fileIdPattern})`, 'g')

/** The reference to a file of an artifact its content holds (never an address). */
export const artifactFileRef = (fileId: string): string => `artifact-file:${fileId.toLowerCase()}`

/** The files a text names, each once, in order. */
export function artifactFileRefsOf(text: string): string[] {
  return [...new Set([...text.matchAll(fileRefGlobal)].map((match) => match[1]!))]
}

/** The text with each reference replaced by its address; one with none — by an empty address. */
export function withArtifactFileAddresses(
  text: string,
  address: (fileId: string) => string | null,
): string {
  return text.replace(fileRefGlobal, (_all, id: string) => address(id) ?? 'about:blank')
}

/** The types a file of an artifact may be (Ар12): pictures and fonts, by the rules of Дер34. */
export const artifactFileExtensions = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'woff2',
  'woff',
] as const

export const artifactFileNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((name) => !/[\p{Cc}/\\]/u.test(name), 'a name of a file')
  .refine(
    (name) =>
      (artifactFileExtensions as readonly string[]).includes(
        name.slice(name.lastIndexOf('.') + 1).toLowerCase(),
      ),
    'a picture or a font: png, jpg, gif, webp, avif, svg, woff2, woff',
  )

/**
 * The headers of a file of an artifact on the root of the pages: a shared file's (Дер34, with
 * `Access-Control-Allow-Origin: *` for the CORS request of a font from the opaque frame, spike 2),
 * never kept: its address is bound to one viewer for five minutes.
 */
export function artifactFileHeaders(pageHeaders: Record<string, string>): Record<string, string> {
  return { ...pageHeaders, 'Cache-Control': 'private, no-store' }
}

// ---- The fonts and libraries of the platform (Ар28, Ар30) ----

/** `/v/<label>.<hash>`: a label of the registry and the first 16 hex of the SHA-256 of the bytes. */
const platformPathPattern = /^(lib-[a-z0-9-]{1,40})\.([0-9a-f]{16})$/

export function artifactPlatformPath(label: string, hash: string): string {
  return `/v/${label}.${hash}`
}

/** What a segment of `/v/` names as a file of the platform; null — not one. */
export function readArtifactPlatformToken(token: string): { label: string; hash: string } | null {
  const match = platformPathPattern.exec(token)
  return match ? { label: match[1]!, hash: match[2]! } : null
}

/** The headers of a file of the platform (Ар28): any frame loads it, forever the same bytes. */
export function artifactPlatformFileHeaders(type: string): Record<string, string> {
  return {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  }
}

// ---- The bridge (Ар29) ----

/** The mark of every message of the bridge: a message without it is not one. */
export const ARTIFACT_BRIDGE = 'raditi-artifact'

/**
 * A message of a frame (Ар29). The script of the platform and the scripts of the artifact live in
 * one opaque origin, so each message is data of the artifact: a white list, a schema, never HTML.
 */
export const artifactBridgeMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ bridge: z.literal(ARTIFACT_BRIDGE), type: z.literal('ready') }),
  z.strictObject({
    bridge: z.literal(ARTIFACT_BRIDGE),
    type: z.literal('size'),
    /** The height of the document at this width of the view (Ар8): another width is not taken. */
    height: z.number().int().min(0).max(100_000),
    width: z.number().int().min(0).max(10_000),
  }),
  z.strictObject({
    bridge: z.literal(ARTIFACT_BRIDGE),
    type: z.literal('link'),
    href: z
      .string()
      .max(2000)
      .refine((href) => /^https?:\/\//i.test(href), 'an address of the web'),
  }),
])
export type ArtifactBridgeMessage = z.infer<typeof artifactBridgeMessageSchema>

/**
 * The script of the platform in each frame: «готово», the size of the document, and a link — the
 * cabinet opens it after asking (Ар28). It runs before the scripts of the artifact.
 */
export const ARTIFACT_BRIDGE_SCRIPT = `(function(){
var B=${JSON.stringify(ARTIFACT_BRIDGE)};
function say(m){try{m.bridge=B;parent.postMessage(m,'*')}catch(e){}}
var last='';
function size(){var d=document.documentElement;if(!d)return;var h=Math.ceil(Math.max(d.scrollHeight,document.body?document.body.scrollHeight:0));var w=Math.round(innerWidth);var k=h+'x'+w;if(k!==last){last=k;say({type:'size',height:h,width:w})}}
document.addEventListener('click',function(e){var t=e.target;while(t&&t.nodeType===1&&t.tagName!=='A'&&t.tagName!=='AREA')t=t.parentNode;if(!t||t.nodeType!==1)return;var h=t.getAttribute('href');if(!h||h.charAt(0)==='#')return;e.preventDefault();var u;try{u=new URL(h,location.href).href}catch(x){return}if(/^https?:/i.test(u))say({type:'link',href:u})},true);
addEventListener('load',function(){size();say({type:'ready'})});
try{new ResizeObserver(size).observe(document.documentElement)}catch(e){setInterval(size,500)}
})();`

// ---- The document of a frame ----

export interface ArtifactFrameParts {
  /** The `html` blocks in order: fragments of the body. */
  html: readonly string[]
  style: readonly string[]
  script: readonly string[]
  /** The JSON of the `settings` block, or null. */
  settings: string | null
}

/** A text inside `<script>` or `<style>` never closes its element early. */
const inRawText = (text: string, tag: 'script' | 'style') =>
  text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1')

/**
 * The document of a frame, assembled by the platform at the time of serving (§7.2): the styles in
 * its head with the platform's fonts, the parts of its body, the settings as JSON its script reads
 * (`#raditi-settings`, Ар9), the bridge and the scripts of the artifact. `bridge: false` and no
 * scripts — the edit frame.
 */
export function artifactFrameDocument(input: {
  parts: ArtifactFrameParts
  /** The CSS of the platform: the fonts. */
  platformCss: string
  bridge: boolean
  title: string
}): string {
  const escapeHtml = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const settings =
    input.parts.settings === null
      ? ''
      : `<script type="application/json" id="raditi-settings">${input.parts.settings.replace(/</g, '\\u003c')}</script>`
  return [
    '<!doctype html><html lang="ru"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.title)}</title>`,
    input.platformCss === '' ? '' : `<style>${inRawText(input.platformCss, 'style')}</style>`,
    ...input.parts.style.map((css) => `<style>${inRawText(css, 'style')}</style>`),
    '</head><body>',
    ...input.parts.html,
    settings,
    input.bridge ? `<script>${ARTIFACT_BRIDGE_SCRIPT}</script>` : '',
    ...input.parts.script.map((js) => `<script>${inRawText(js, 'script')}</script>`),
    '</body></html>',
  ].join('')
}

// ---- The settings of a canvas (Ар9) ----

export type ArtifactSettingValue = string | number | boolean

/** The values of the settings the form of the cabinet edits: the top level, scalars only. */
export function artifactSettingsFields(
  json: string,
): { key: string; value: ArtifactSettingValue }[] | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.entries(value as Record<string, unknown>).flatMap(([key, each]) =>
    typeof each === 'string' || typeof each === 'number' || typeof each === 'boolean'
      ? [{ key, value: each }]
      : [],
  )
}

/** Whether a setting is a colour: `#rgb` or `#rrggbb`. */
export const artifactSettingIsColor = (value: ArtifactSettingValue): boolean =>
  typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)

/** Where the bytes of a file of an artifact lie in the artifacts bucket (spec §14). */
export const artifactFileKey = (input: {
  workspaceId: string
  artifactId: string
  fileId: string
}): string => `artifacts/${input.workspaceId}/${input.artifactId}/${input.fileId}`

export type ArtifactFileVerdict =
  | { ok: true; type: string }
  | { ok: false; reason: 'type' | 'too_large' | 'not_utf8' | 'signature' }

/**
 * Whether bytes may be a file of an artifact (Ар12): a picture or a font of the list, its type by
 * the extension, its first bytes as that type begins — the rules of the shared files of a site.
 * The text of an SVG is the caller's to check as a page (`checkPageContent`).
 */
export function checkArtifactFile(name: string, bytes: Uint8Array): ArtifactFileVerdict {
  if (!artifactFileNameSchema.safeParse(name).success) return { ok: false, reason: 'type' }
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return checkPageFile(`/_files/file.${extension}`, bytes)
}

// ---- Import of a whole file (§7.5 `artifact_import`, «Открыть как артефакт») ----

/**
 * Which kind a file of the outbox or of a chat becomes, by its extension: a page or a picture is a
 * canvas of one screen (docs/plan/93-artifacts-trim.md, АТ6).
 */
const importKinds: Readonly<Record<string, 'document' | 'canvas'>> = Object.freeze({
  md: 'document',
  html: 'canvas',
  htm: 'canvas',
  svg: 'canvas',
})

/** The kind a file is imported as; null — it is not imported. */
export function artifactImportKindOf(name: string): 'document' | 'canvas' | null {
  return importKinds[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? null
}

// ---- The blocks a frame is assembled of (§7.2; slice 88.15) ----

/** A block as the assembly of a frame reads it: in the order of the artifact. */
export interface ArtifactFrameSourceBlock {
  key: string
  kind: string
  parent: string | null
  content: string | null
}

export interface ArtifactFrameBlocks<B extends ArtifactFrameSourceBlock> {
  html: B[]
  style: B[]
  script: B[]
  settings: B | null
}

/**
 * The blocks of one frame document, the same in web (`/v/`, the edit frame) and in the renderer of
 * `apps/browser` (Ар32: «одна функция сборки»): the parts of that frame of a canvas, a slide or a
 * picture, after the common style of the artifact, with its settings. Null — no such frame.
 * Blocks without checked text (null) are left out.
 */
export function artifactFrameBlocksOf<B extends ArtifactFrameSourceBlock>(input: {
  blocks: readonly B[]
  frame: string
}): ArtifactFrameBlocks<B> | null {
  const has = (block: B) => block.content !== null
  const top = input.blocks.filter((block) => block.parent === null && has(block))
  const of = (list: readonly B[], kind: string) => list.filter((block) => block.kind === kind)
  const frame = input.blocks.find(
    (block) => block.key === input.frame && block.kind === 'frame' && block.parent === null,
  )
  if (!frame) return null
  const parts = input.blocks.filter((block) => block.parent === frame.key && has(block))
  return {
    html: of(parts, 'html'),
    style: [...of(top, 'style'), ...of(parts, 'style')],
    script: of(parts, 'script'),
    settings: of(top, 'settings')[0] ?? null,
  }
}

/** The mark of a part of a frame for the renderer's report (Ар32): an HTML comment, never shown. */
export const artifactFramePartMark = (key: string): string => `<!--raditi-block:${key}-->`
