import type { CSSProperties } from 'react'

const paths = {
  projects:
    'M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 0V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2',
  profile: 'M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M16 5a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  plans: 'M3 11V4a1 1 0 0 1 1-1h7l10 10-8 8L3 11ZM7.5 7.5h.01',
  payment: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM3 10h18M7 15h3',
  usage: 'M4 20h16M7 20v-6M12 20V6M17 20v-9',
  panel: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM9 4v16',
  expand: 'm8 9 4-4 4 4M8 15l4 4 4-4',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M14 8l4 4-4 4M8 12h13',
  plus: 'M12 5v14M5 12h14',
  search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z',
  arrow: 'M7 17 17 7M7 7h10v10',
  chevron: 'm9 5 7 7-7 7',
  down: 'm8 10 4 4 4-4',
  close: 'm6 6 12 12M6 18 18 6',
  back: 'm12 5-7 7 7 7M5 12h15',
} as const

export type AppIconName = keyof typeof paths

export function AppIcon({
  name,
  size = 20,
  style,
}: {
  name: AppIconName
  size?: number
  style?: CSSProperties
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0, ...style }}
    >
      <path d={paths[name]} />
    </svg>
  )
}
