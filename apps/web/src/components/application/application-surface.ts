/** Shared browser affordances for the account and project layouts. */
export const applicationSurface = {
  minHeight: '100dvh',
  '& ::selection': { bgcolor: 'primary.main', color: 'primary.contrastText' },
  '& input::placeholder': { color: 'text.secondary', opacity: 1 },
  '& :focus-visible': {
    outline: '2px solid',
    outlineColor: 'primary.main',
    outlineOffset: '3px',
  },
  '& a': { textUnderlineOffset: '3px' },
} as const
