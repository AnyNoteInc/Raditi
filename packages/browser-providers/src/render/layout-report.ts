import { artifactRenderLimits } from '@repo/domain/artifacts'

import type { FrameRenderResult } from './frame-renderer.ts'

// The report of `artifact_layout` (docs/plan/88-artifacts.md, Ар32; spike 3, lib/report.mjs): a
// short English text for the model — it lands in the expensive main context of the turn — and
// one Russian line for the client (rule 10). Page text appears only as quotes of up to 32
// characters: it is data of the artifact, not words of the client, and may be another person's.

interface Box {
  id?: string | null
  tag?: string
  text?: string
  width?: number
  why?: string
  tw?: number
  th?: number
}

interface Finding extends Box {
  kind: string
  w: number
  culprits?: Box[]
  more?: number | Finding[]
  by?: number | Box
  under?: Box
  ow?: number
  oh?: number
  axis?: string
  need?: number
  has?: number
  ratio?: number
  upto?: number
  fg?: string
  bg?: string
  gradient?: boolean
  photo?: boolean
  px?: number
  h?: number
  y?: number
  emptyBox?: boolean
  blocks?: number
  first?: Box[]
  count?: number
  family?: string
  src?: string
  url?: string
  what?: string
  directive?: string | null
}

function findingsOf(byWidth: ReadonlyMap<number, FrameRenderResult>): Finding[] {
  const all: Finding[] = []
  for (const [w, r] of byWidth) {
    for (const issue of r.map?.issues ?? []) all.push({ ...(issue as unknown as Finding), w })
    const ev = r.events
    for (const text of ev.pageErrors) all.push({ kind: 'script-error', text, w })
    for (const text of ev.consoleErrors) all.push({ kind: 'console-error', text, w })
    for (const c of ev.csp)
      if (c.url) all.push({ kind: 'blocked', url: c.url, what: c.kind, directive: c.directive, w })
    for (const b of ev.blocked)
      if (!b.navigation) all.push({ kind: 'blocked', url: b.url, what: b.type, w })
    for (const url of ev.navigations) all.push({ kind: 'navigates', url, w })
    if (r.hung) all.push({ kind: 'hung', w })
    else if (r.settled === false) all.push({ kind: 'unsettled', w })
    if (r.error) all.push({ kind: 'render-failed', text: r.error, w })
    if (r.map && r.map.photo.length > 0)
      all.push({ kind: 'photo-text', count: r.map.photo.length, w })
  }
  return all
}

const SEVERITY = [
  'render-failed',
  'hung',
  'script-error',
  'navigates',
  'blocked',
  'font-missing',
  'font-failed',
  'broken-img',
  'hscroll',
  'cut',
  'overlap',
  'clipped',
  'contrast-hard',
  'small-text',
  'empty',
  'invisible',
  'contrast',
  'console-error',
  'tap-small',
  'no-viewport',
  'unsettled',
  'photo-text',
]
const severity = (f: Finding) =>
  SEVERITY.indexOf(f.kind === 'contrast' && (f.ratio ?? 9) < 3 ? 'contrast-hard' : f.kind)

const keyOf = (f: Finding): string => {
  switch (f.kind) {
    case 'hscroll':
    case 'cut':
      return `${f.kind}|${(f.culprits ?? []).map((c) => c.id).join(',')}`
    case 'contrast':
      return `contrast|${f.id}|${f.fg}|${f.bg}`
    case 'small-text':
      return `small|${f.id}|${f.px}`
    case 'overlap':
      return `overlap|${f.id}|${f.under?.id}`
    case 'clipped':
      return `clipped|${f.id}|${f.axis}`
    case 'blocked':
    case 'navigates':
      return `${f.kind}|${f.url}`
    case 'script-error':
    case 'console-error':
    case 'render-failed':
      // Two errors that read the same in the report are one line.
      return `${f.kind}|${layoutQuote(f.text)}`
    case 'font-missing':
    case 'font-failed':
      return `${f.kind}|${f.family}`
    default:
      return `${f.kind}|${f.id ?? ''}`
  }
}
const familyOf = (f: Finding): string | null => {
  switch (f.kind) {
    case 'contrast':
      return `contrast|${f.tag}|${f.fg}|${f.bg}`
    case 'small-text':
      return `small|${f.tag}|${f.px}`
    case 'clipped':
      return f.axis === 'ancestor'
        ? `clipped-by|${(f.by as Box | undefined)?.id}`
        : `clipped|${f.tag}`
    case 'overlap':
      return `overlap|${f.tag}`
    default:
      return null
  }
}

/**
 * A quote of what the frame holds — its text, an error its script threw, an address it asked —:
 * never longer than 32 characters, without what would read as markup or a quote's end.
 */
export function layoutQuote(
  text: unknown,
  asked: number = artifactRenderLimits.layoutQuoteChars,
): string {
  const n = Math.min(asked, artifactRenderLimits.layoutQuoteChars)
  const t = String(text ?? '')
    .replace(/«/g, '„')
    .replace(/»/g, '“')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const el = (f: Box | undefined) => `${f?.id ?? '?'} <${f?.tag ?? 'element'}>`
const quote = (t: unknown) => (t ? ` «${layoutQuote(t)}»` : '')
const widths = (ws: number[]) => (ws.length > 1 ? 'both' : String(ws[0]))

function line(f: Finding, ws: number[], same: string[]): string {
  const at = `${widths(ws)}: `
  const also = same.length
    ? `; same in ${same.slice(0, 3).join(', ')}${same.length > 3 ? ` and ${same.length - 3} more` : ''}`
    : ''
  switch (f.kind) {
    case 'render-failed':
      return `${at}the frame was not drawn: ${layoutQuote(f.text, 80)}.`
    case 'hung':
      return `${at}a script of the frame did not finish in time; it was stopped and the frame drawn as it stood.`
    case 'unsettled':
      return `${at}the frame kept changing for 1 s (an animation or a timer); it was drawn mid-way.`
    case 'script-error':
      return `${at}script error — ${layoutQuote(f.text, 84)}. The frame is sandboxed: no storage, cookies, network or pop-ups.`
    case 'console-error':
      return `${at}console error — ${layoutQuote(f.text, 90)}.`
    case 'navigates':
      return `${at}the frame tries to leave its page for ${layoutQuote(f.url, 60)}; the client would see that page instead.`
    case 'blocked': {
      const all = [f, ...((f.more as Finding[] | undefined) ?? [])]
      const urls = all
        .slice(0, 3)
        .map((x) => `${x.what ?? 'load'} ${layoutQuote(x.url, 56)}`)
        .join('; ')
      return `${at}blocked ${all.length > 1 ? `${all.length} loads: ` : ''}${urls}${all.length > 3 ? ` and ${all.length - 3} more` : ''} — a frame loads nothing from outside; use the platform fonts and artifact files.`
    }
    case 'font-missing':
      return `${at}font «${layoutQuote(f.family, 30)}» is not available (${f.blocks} blocks fall back to another font).`
    case 'font-failed':
      return `${at}font «${layoutQuote(f.family, 30)}» failed to load.`
    case 'broken-img':
      return `${at}picture ${el(f)} does not draw (${layoutQuote(f.src, 30)}).`
    case 'hscroll':
    case 'cut': {
      const c = (f.culprits ?? [])
        .slice(0, 2)
        .map((x) => `${el(x)} ${x.width} px${x.why ? ` (${layoutQuote(x.why, 44)})` : ''}`)
        .join('; ')
      return `${at}${f.kind === 'cut' ? 'content is cut at the right edge' : 'the page scrolls sideways'} by ${String(f.by)} px. Wider than the screen: ${c || 'unknown'}${typeof f.more === 'number' && f.more ? ` and ${f.more} more` : ''}.`
    }
    case 'overlap':
      return `${at}${el(f)}${quote(f.text)} covers text of ${el(f.under)}${quote(f.under?.text)} (${f.ow}×${f.oh} px)${also}.`
    case 'clipped':
      return f.axis === 'ancestor'
        ? `${at}text of ${el(f)}${quote(f.text)} is cut by ${el(f.by as Box)} (overflow hidden)${also}.`
        : `${at}text of ${el(f)}${quote(f.text)} is cut: needs ${f.need} px, has ${f.has} px${also}.`
    case 'contrast':
      return f.photo
        ? `${at}low contrast on a picture — ${el(f)}${quote(f.text)} reaches ${f.ratio}:1 (needs ${f.need})${also}.`
        : `${at}low contrast ${f.ratio}${f.upto ? `–${f.upto}` : ''}:1 (needs ${f.need}) — ${el(f)}${quote(f.text)} ${f.fg} on ${f.gradient ? 'gradient ' : ''}${f.bg}${also}.`
    case 'small-text':
      return `${at}small text ${f.px} px — ${el(f)}${quote(f.text)}${also}.`
    case 'empty':
      return `${at}empty area ${f.h} px tall at y ${f.y}${f.id ? ` in ${el(f)}${f.emptyBox ? ' (an empty box)' : ''}` : ''}.`
    case 'invisible':
      return `${at}${f.blocks} blocks with text stay transparent until a script shows them (${(f.first ?? []).map((x) => el(x)).join(', ')}): pictures show them empty.`
    case 'tap-small':
      return `${at}${f.count} touch target${f.count === 1 ? '' : 's'} smaller than 24 px: ${(f.first ?? []).map((x) => `${el(x)} ${x.tw}×${x.th}`).join(', ')}.`
    case 'no-viewport':
      return `${at}no <meta name="viewport" content="width=device-width">: a phone will show the published page zoomed out.`
    case 'photo-text':
      return `${at}${f.count} text blocks lie on pictures; contrast there was not measured.`
    default:
      return `${at}${f.kind}.`
  }
}

const RU: Readonly<Record<string, string>> = Object.freeze({
  'render-failed': 'кадр не отрисовался',
  hung: 'скрипт кадра зависал',
  'script-error': 'ошибка в скрипте',
  navigates: 'кадр уходит на другую страницу',
  blocked: 'внешние файлы не загружаются',
  'font-missing': 'нет шрифта',
  'font-failed': 'шрифт не загрузился',
  'broken-img': 'картинка не показывается',
  hscroll: 'на телефоне страница шире экрана',
  cut: 'содержимое обрезано справа',
  overlap: 'блоки наезжают друг на друга',
  clipped: 'текст обрезан',
  contrast: 'низкий контраст текста',
  'small-text': 'мелкий текст',
  empty: 'большое пустое место',
  invisible: 'блоки видны только после прокрутки',
  'tap-small': 'мелкие кнопки на телефоне',
  'no-viewport': 'нет настройки страницы для телефона',
})
const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11
    ? one
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
      ? few
      : many

interface Line {
  f: Finding
  ws: number[]
  same: string[]
}

export interface LayoutReport {
  text: string
  ru: string
  problems: number
}

const NOTES = ['unsettled', 'photo-text', 'console-error']

/** The report of the layout of one frame drawn at its widths. */
export function layoutReport(input: {
  title: string
  byWidth: ReadonlyMap<number, FrameRenderResult>
  detail?: boolean
}): LayoutReport {
  const limit = artifactRenderLimits.layoutReportChars
  const findings = findingsOf(input.byWidth)
  const merged = new Map<string, { f: Finding; ws: number[] }>()
  for (const f of findings) {
    const k = keyOf(f)
    const prev = merged.get(k)
    if (prev) {
      if (!prev.ws.includes(f.w)) prev.ws.push(f.w)
    } else merged.set(k, { f, ws: [f.w] })
  }
  const families = new Map<string, Line>()
  const lines: Line[] = []
  for (const { f, ws } of merged.values()) {
    const fam = familyOf(f)
    const famKey = fam ? `${fam}|${widths([...ws].sort())}` : null
    const known = famKey ? families.get(famKey) : undefined
    if (known) {
      known.same.push(f.id ?? '?')
      continue
    }
    const entry: Line = { f, ws: [...ws].sort((a, b) => b - a), same: [] }
    if (famKey) families.set(famKey, entry)
    lines.push(entry)
  }
  const blocked = lines.filter((l) => l.f.kind === 'blocked')
  if (blocked.length > 1) {
    const first = blocked[0]!
    first.f = { ...first.f, more: blocked.slice(1).map((l) => l.f) }
    first.ws = [...new Set(blocked.flatMap((l) => l.ws))].sort((a, b) => b - a)
    for (const l of blocked.slice(1)) lines.splice(lines.indexOf(l), 1)
  }
  lines.sort((a, b) => severity(a.f) - severity(b.f))
  const sizes = [...input.byWidth]
    .map(([w, r]) => (r.docHeight !== null ? `${w}×${r.docHeight}` : `${w}: not drawn`))
    .join(', ')
  const head = `Layout of «${layoutQuote(input.title, 48)}» as the client sees it (${sizes}). Elements are named <block>.<n>: the n-th element of that block.`
  const problems = lines.filter((l) => !NOTES.includes(l.f.kind))
  const checked = new Set(findings.map((f) => f.kind))
  const ok = (
    [
      ['script-error', 'scripts'],
      ['blocked', 'loads'],
      ['font-missing', 'fonts'],
      ['hscroll', 'width'],
      ['overlap', 'overlaps'],
      ['clipped', 'cut text'],
      ['contrast', 'contrast'],
      ['small-text', 'text size'],
      ['empty', 'empty areas'],
      ['broken-img', 'pictures'],
    ] as const
  )
    .filter(([k]) => !checked.has(k) && !(k === 'hscroll' && checked.has('cut')))
    .map(([, w]) => w)
  const footer = ok.length ? `OK: ${ok.join(', ')}.` : ''
  const body: string[] = []
  let length = head.length
  let dropped = 0
  for (const l of [
    ...lines.filter((x) => !NOTES.includes(x.f.kind)),
    ...lines.filter((x) => NOTES.includes(x.f.kind)),
  ]) {
    const text = `${NOTES.includes(l.f.kind) ? 'Note' : '-'} ${line(l.f, l.ws, l.same)}`
    if (!input.detail && length + text.length + footer.length + 60 > limit) {
      dropped += 1
      continue
    }
    body.push(text)
    length += text.length + 1
  }
  const summary = problems.length
    ? `${problems.length} problem${problems.length === 1 ? '' : 's'}, most serious first:`
    : 'No problems found.'
  const text = [
    head,
    summary,
    ...body,
    dropped ? `(+${dropped} more; call again with detail: true)` : '',
    footer,
  ]
    .filter(Boolean)
    .join('\n')
  return { text, ru: russianLine(problems), problems: problems.length }
}

function russianLine(problems: readonly Line[]): string {
  if (problems.length === 0) return 'Проверка вёрстки на компьютере и телефоне: замечаний нет'
  const kinds: string[] = []
  for (const l of problems) {
    const word =
      l.f.kind === 'hscroll' && !l.ws.includes(390) ? 'страница шире экрана' : RU[l.f.kind]
    if (word && !kinds.includes(word)) kinds.push(word)
  }
  const n = problems.length
  return `Проверка вёрстки на компьютере и телефоне: ${n} ${plural(n, 'замечание', 'замечания', 'замечаний')} — ${kinds.slice(0, 3).join(', ')}${kinds.length > 3 ? ' и другое' : ''}`
}
