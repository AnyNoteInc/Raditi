/** Vivid orange and amber share warm neutrals across the landing and both colour schemes. */
export const brandColors = {
  paper: '#FFF8EC',
  paper2: '#F3E7D5',
  card: '#FFFCF5',
  ink: '#241710',
  ink2: '#352217',
  graphite: '#695547',
  rule: '#E1CDB6',
  marker: '#FFC547',
  accent: '#FF6B24',
  accentText: '#A63D12',
  accentLight: '#FFB86B',
  ok: '#79573B',
  onInk: '#C6AE95',
  ruleInk: '#5A3C28',
  snow: '#FFF1DE',
  white: '#FFFFFF',
} as const

/** Warm status tones; labels and icons carry the meaning without relying on hue alone. */
export const semanticColors = {
  light: {
    success: brandColors.ok,
    error: '#9C3D26',
    warning: '#92551E',
    info: brandColors.accentText,
  },
  dark: {
    success: '#D6B495',
    error: '#F09B7C',
    warning: '#E6BA7E',
    info: brandColors.accentLight,
  },
} as const

// Keep this module dependency-free: metadata and error boundaries also consume the palette.
function alpha(hex: string, opacity: number): string {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
  return `rgba(${channels.join(', ')}, ${opacity})`
}

/** MUI interaction opacities retained, with the brand foreground as their shared source. */
export const actionColors = {
  light: {
    active: alpha(brandColors.ink, 0.54),
    hover: alpha(brandColors.ink, 0.04),
    hoverOpacity: 0.04,
    selected: alpha(brandColors.ink, 0.08),
    selectedOpacity: 0.08,
    disabled: alpha(brandColors.ink, 0.26),
    disabledBackground: alpha(brandColors.ink, 0.12),
    disabledOpacity: 0.38,
    focus: alpha(brandColors.ink, 0.12),
    focusOpacity: 0.12,
    activatedOpacity: 0.12,
  },
  dark: {
    active: brandColors.snow,
    hover: alpha(brandColors.snow, 0.08),
    hoverOpacity: 0.08,
    selected: alpha(brandColors.snow, 0.16),
    selectedOpacity: 0.16,
    disabled: alpha(brandColors.snow, 0.3),
    disabledBackground: alpha(brandColors.snow, 0.12),
    disabledOpacity: 0.38,
    focus: alpha(brandColors.snow, 0.12),
    focusOpacity: 0.12,
    activatedOpacity: 0.24,
  },
} as const

/** Shared surface roles, derived from the palette rather than independently chosen shades. */
export const brandColorRoles = {
  onAccent: brandColors.ink,
  accentHover: 'color-mix(in srgb, var(--raditi-accent) 85%, var(--raditi-marker))',
  onAccentMuted: brandColors.ink,
  accentRule: 'color-mix(in srgb, var(--raditi-accent) 75%, var(--raditi-ink))',
  accentSoft: 'color-mix(in srgb, var(--raditi-accent) 16%, var(--raditi-paper))',
  accentInk: 'color-mix(in srgb, var(--raditi-accent) 40%, var(--raditi-ink))',
  markerRule: 'color-mix(in srgb, var(--raditi-marker) 80%, var(--raditi-ink))',
  markerSoft: 'color-mix(in srgb, var(--raditi-marker) 70%, var(--raditi-paper))',
  inkMuted: alpha(brandColors.ink, 0.38),
  snowMuted: alpha(brandColors.snow, 0.38),
  shadowSoft: alpha(brandColors.ink, 0.24),
  shadowMedium: alpha(brandColors.ink, 0.25),
  shadowStrong: alpha(brandColors.ink, 0.45),
  borderSoft: alpha(brandColors.ink, 0.09),
  accentBorder: alpha(brandColors.accent, 0.24),
  accentBorderSoft: alpha(brandColors.accent, 0.15),
} as const

/** Generated once; CssBaseline emits the same brand roles during SSR in every colour scheme. */
export const brandCssVariables = Object.fromEntries(
  Object.entries({ ...brandColors, ...brandColorRoles }).map(([key, value]) => [
    `--raditi-${key.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase()}`,
    value,
  ]),
) as Record<`--raditi-${string}`, string>

/**
 * apps/web defines the variables for its self-hosted fonts. Each `var()` has its own fallback: a
 * `var()` without one makes the whole declaration invalid when the variable is missing.
 */
export const fontFamilies = {
  body: 'var(--font-golos, "Golos Text"), "Segoe UI", "Helvetica Neue", Arial, sans-serif',
  heading: 'var(--font-unbounded, "Unbounded"), Verdana, sans-serif',
  mono: 'var(--font-jetbrains, "JetBrains Mono"), ui-monospace, Menlo, monospace',
} as const
