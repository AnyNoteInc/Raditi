/**
 * The line icons of the landing and of the footer of the public pages: arrows, the check mark,
 * the undo arrow, the mail and the phone, drawn in a 24px grid with the colour of the text around
 * them.
 *
 * The icons are gathered here as they were drawn in their places, so the page looks as it did:
 * every place passes its own size, stroke width and line ends, and the outlines that the demo and
 * the pricing drew to another measure keep their own entries. The demo passes a size alone: the
 * stroke of every icon in it is set by its style sheet.
 */
const outlines = {
  'arrow-right': ['M4 12h15m-6-6 6 6-6 6'],
  /** The shaft is one unit shorter, as the pricing drew it. */
  'arrow-right-pricing': ['M5 12h14m-6-6 6 6-6 6'],
  'arrow-up-right': ['M6 18 18 6M6 6h12v12'],
  'arrow-down': ['M12 4v16m-6-6 6 6 6-6'],
  'arrow-up': ['M12 20V4m-6 6 6-6 6 6'],
  check: ['m5 12 4 4L19 6'],
  undo: ['m8 3-5 5 5 5M3 8h10a6 6 0 0 1 0 12h-3'],
  /** A smaller loop in two paths, as the demo drew it. */
  'undo-demo': ['m9 5-5 5 5 5', 'M4 10h10a5 5 0 0 1 0 10h-3'],
  /** The envelope and the handset of the contacts in the footer. */
  mail: ['M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2', 'm3 7 9 6 9-6'],
  phone: [
    'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  ],
} as const

export type LandingIconName = keyof typeof outlines

type LandingIconProps = {
  name: LandingIconName
  /** Width and height in px; a CSS rule of the place may still resize the icon. */
  size: number
  /** In units of the 24px grid; without it the stroke is the one the place inherits. */
  strokeWidth?: number
  linecap?: 'round'
  linejoin?: 'round'
}

/** Decorative: the text next to the icon names the action. */
export function LandingIcon({ name, size, strokeWidth, linecap, linejoin }: LandingIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {outlines[name].map((d) => (
        <path
          key={d}
          d={d}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap={linecap}
          strokeLinejoin={linejoin}
        />
      ))}
    </svg>
  )
}
