/** Brand tokens from the landing prototype (docs/landing/landing.dc.html). */
export const brandColors = {
  paper: '#F4F5F1',
  paper2: '#EAECE5',
  card: '#FBFBF8',
  ink: '#15171A',
  ink2: '#1F2227',
  graphite: '#565C66',
  rule: '#D5D8CF',
  marker: '#F1DF4A',
  accent: '#2A36D6',
  ok: '#1F7A4D',
  onInk: '#A3A9B3',
  ruleInk: '#33373E',
  snow: '#F1F2EE',
} as const

/**
 * apps/web defines the variables with next/font. Each `var()` carries its own fallback: a
 * `var()` without one makes the whole declaration invalid when the variable is missing.
 */
export const fontFamilies = {
  body: 'var(--font-golos, "Golos Text"), "Segoe UI", "Helvetica Neue", Arial, sans-serif',
  heading: 'var(--font-unbounded, "Unbounded"), Verdana, sans-serif',
  mono: 'var(--font-jetbrains, "JetBrains Mono"), ui-monospace, Menlo, monospace',
} as const
