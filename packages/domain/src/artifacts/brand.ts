/**
 * «Фирменный стиль» (docs/plan/88-artifacts.md, §4, Ар6, Ар25, Ар42; slice 88.15а): the colours,
 * fonts and words of a brand. Its tokens are the JSON of its `settings` block — flat, so the form
 * «Настройки» of the cabinet edits them —; its `section` holds the tone of the texts in words. The
 * brand of a project stands in every frame of the mockups and canvases of that project as CSS
 * variables, and in every turn of the project as data. It never opens to others with «Правит»
 * (`sharableEdit: false`): what it says reaches every turn of the project.
 */

/** The fonts of the built-in set (Ар30: no outside font): each with the stack it stands for. */
export const brandFonts: Readonly<Record<string, string>> = Object.freeze({
  'Golos Text': '"Golos Text", Arial, sans-serif',
  Arial: 'Arial, "Liberation Sans", sans-serif',
  Georgia: 'Georgia, "Times New Roman", serif',
  Verdana: 'Verdana, Geneva, sans-serif',
  'Courier New': '"Courier New", monospace',
})

/** The colour tokens and their CSS variables. */
export const brandColorTokens = [
  'primary',
  'accent',
  'background',
  'surface',
  'text',
  'muted',
] as const
export type BrandColorToken = (typeof brandColorTokens)[number]

/** What the client reads of each token in «Настройки» of a brand (rule 10). */
export const brandTokenLabels: Readonly<Record<string, string>> = Object.freeze({
  primary: 'Основной цвет',
  accent: 'Акцент',
  background: 'Фон',
  surface: 'Фон карточек',
  text: 'Текст',
  muted: 'Второстепенный текст',
  headingFont: 'Шрифт заголовков',
  bodyFont: 'Шрифт текста',
  radius: 'Скругление, px',
  logo: 'Логотип',
  tone: 'Тон текстов',
  avoid: 'Запретные слова',
})

export interface BrandTokens {
  colors: Partial<Record<BrandColorToken, string>>
  headingFont: string | null
  bodyFont: string | null
  radius: number | null
  /** `artifact-file:<id>` of the logo; null — none. */
  logo: string | null
  tone: string | null
  avoid: string | null
}

const color = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const fileRef = /^artifact-file:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null

/**
 * The tokens of a brand read from the JSON of its settings: only values of their shape — a colour
 * `#rgb` or `#rrggbb`, a font of the built-in set, a radius of 0–48 px, a file reference — so that
 * no text of a person ever reaches the CSS of a frame. Everything else is left out.
 */
export function brandTokensOf(json: string | null): BrandTokens {
  let value: unknown
  try {
    value = json === null ? null : JSON.parse(json)
  } catch {
    value = null
  }
  const raw =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const colors: Partial<Record<BrandColorToken, string>> = {}
  for (const token of brandColorTokens) {
    const each = raw[token]
    if (typeof each === 'string' && color.test(each)) colors[token] = each.toLowerCase()
  }
  const font = (each: unknown) =>
    typeof each === 'string' && Object.hasOwn(brandFonts, each) ? each : null
  const radius =
    typeof raw.radius === 'number' && Number.isFinite(raw.radius)
      ? Math.max(0, Math.min(48, Math.round(raw.radius)))
      : null
  return {
    colors,
    headingFont: font(raw.headingFont),
    bodyFont: font(raw.bodyFont),
    radius,
    logo: typeof raw.logo === 'string' && fileRef.test(raw.logo) ? raw.logo.toLowerCase() : null,
    tone: text(raw.tone, 300),
    avoid: text(raw.avoid, 300),
  }
}

/** The CSS variables of a brand in every frame of its project (`:root`, before the frame's own). */
export function brandCss(tokens: BrandTokens): string {
  const lines: string[] = []
  for (const token of brandColorTokens) {
    const value = tokens.colors[token]
    if (value) lines.push(`--brand-${token}:${value}`)
  }
  if (tokens.headingFont) lines.push(`--brand-font-heading:${brandFonts[tokens.headingFont]}`)
  if (tokens.bodyFont) lines.push(`--brand-font-body:${brandFonts[tokens.bodyFont]}`)
  if (tokens.radius !== null) lines.push(`--brand-radius:${tokens.radius}px`)
  return lines.length === 0 ? '' : `:root{${lines.join(';')}}`
}

/**
 * What the agent of a turn of the project reads of its brand (§7.6), in English: the variables to
 * use when it draws. The tone and the words to avoid are a person's text — the caller puts them
 * inside the data of the instructions, never among the rules.
 */
export function brandForAgent(tokens: BrandTokens): string {
  const parts: string[] = []
  const colors = brandColorTokens.filter((token) => tokens.colors[token])
  if (colors.length > 0)
    parts.push(
      `colours ${colors.map((token) => `--brand-${token} ${tokens.colors[token]}`).join(', ')}`,
    )
  if (tokens.headingFont) parts.push(`headings in ${tokens.headingFont} (--brand-font-heading)`)
  if (tokens.bodyFont) parts.push(`text in ${tokens.bodyFont} (--brand-font-body)`)
  if (tokens.radius !== null) parts.push(`corners ${tokens.radius}px (--brand-radius)`)
  if (tokens.logo) parts.push(`logo ${tokens.logo}`)
  return parts.length === 0
    ? 'no tokens set yet'
    : `${parts.join('; ')}. Every frame of a mockup or a canvas of the project has these CSS variables: use var(--brand-…) instead of other colours and fonts`
}

/** The tokens a new brand starts with: neutral, for the client to replace. */
export const brandStartTokens = Object.freeze({
  primary: '#2f5d50',
  accent: '#e07a3f',
  background: '#ffffff',
  surface: '#f6f3ee',
  text: '#1f2421',
  muted: '#6b706c',
  headingFont: 'Golos Text',
  bodyFont: 'Golos Text',
  radius: 12,
  tone: 'Дружелюбно и по делу, на «вы»',
  avoid: '',
})
