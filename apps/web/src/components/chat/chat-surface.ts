import type { Theme } from '@mui/material/styles'
import { fontFamilies } from '@repo/ui/theme/tokens'

// The surface of «Чат» (owner's brief of 26.10.2026, the look of the web ChatGPT): a neutral,
// monochrome palette instead of the cream and orange of the cabinet — on the column of dialogs,
// the dialog, its field and the screen of a new dialog only. The rest of the site page and the
// content of a preview keep their own colours. The palette is tokens: `--chat-*` for the surface
// itself, and within it the variables of the theme the components read, so a button, a divider
// or a focus ring of the chat takes the same neutral colours.

export interface ChatPalette {
  /** The page under the dialog and the answers of the agent. */
  page: string
  /** The column of dialogs. */
  side: string
  /** The field and the messages of the client. */
  fill: string
  text: string
  muted: string
  line: string
  hover: string
  selected: string
}

export const chatPalette: Readonly<Record<'light' | 'dark', ChatPalette>> = Object.freeze({
  light: {
    page: '#FFFFFF',
    side: '#F9F9F9',
    fill: '#F4F4F4',
    text: '#202020',
    // 6.6:1 on the page, 6.3:1 on the column.
    muted: '#5D5D5D',
    line: '#E5E5E5',
    hover: 'rgba(0, 0, 0, 0.05)',
    selected: 'rgba(0, 0, 0, 0.08)',
  },
  dark: {
    page: '#212121',
    side: '#171717',
    fill: '#2F2F2F',
    text: '#ECECEC',
    // 8.6:1 on the page.
    muted: '#B4B4B4',
    line: '#383838',
    hover: 'rgba(255, 255, 255, 0.06)',
    selected: 'rgba(255, 255, 255, 0.10)',
  },
})

/** `#202020` → `32 32 32`: the channels the theme's alpha colours are built from. */
export function channels(hex: string): string {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(' ')
}

/** The variables of one scheme on the surface. */
export function chatVariables(palette: ChatPalette): Record<string, string> {
  return {
    '--chat-page': palette.page,
    '--chat-side': palette.side,
    '--chat-fill': palette.fill,
    '--chat-text': palette.text,
    '--chat-muted': palette.muted,
    '--chat-line': palette.line,
    '--chat-hover': palette.hover,
    '--chat-selected': palette.selected,
    // What the components of the theme read inside the surface.
    '--mui-palette-text-primary': palette.text,
    '--mui-palette-text-primaryChannel': channels(palette.text),
    '--mui-palette-text-secondary': palette.muted,
    '--mui-palette-text-secondaryChannel': channels(palette.muted),
    '--mui-palette-divider': palette.line,
    '--mui-palette-background-paper': palette.page,
    '--mui-palette-background-default': palette.side,
    '--mui-palette-action-hover': palette.hover,
    '--mui-palette-action-selected': palette.selected,
    '--mui-palette-primary-main': palette.text,
    '--mui-palette-primary-mainChannel': channels(palette.text),
    '--mui-palette-primary-dark': palette.text,
    '--mui-palette-primary-contrastText': palette.page,
  }
}

/**
 * The surface of the chat for the theme in use: one scheme, or both switched by the system's
 * scheme as the theme itself is (createAppTheme, preference `system`).
 */
export function chatSurface(theme: Theme) {
  const schemes = (theme as Theme & { colorSchemes?: Partial<Record<'light' | 'dark', unknown>> })
    .colorSchemes
  const light = chatVariables(chatPalette.light)
  const dark = chatVariables(chatPalette.dark)
  const variables =
    schemes?.light && schemes.dark
      ? { ...light, '@media (prefers-color-scheme: dark)': dark }
      : schemes?.dark
        ? dark
        : light
  return {
    ...variables,
    bgcolor: 'var(--chat-page)',
    color: 'var(--chat-text)',
    fontFamily: fontFamilies.body,
    // No display face in the chat: every heading in it is the text face.
    '& .MuiTypography-root': { fontFamily: fontFamilies.body },
    // The vivid fill of the cabinet's main action turns the contrast of the surface.
    '& .MuiButton-contained.MuiButton-colorPrimary': {
      bgcolor: 'var(--chat-text)',
      color: 'var(--chat-page)',
      borderColor: 'transparent',
      boxShadow: 'none',
    },
    '& .MuiButton-contained.MuiButton-colorPrimary:hover:not(.Mui-disabled)': {
      bgcolor: 'var(--chat-text)',
      opacity: 0.86,
    },
  }
}
