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
  /** «Скрыть панель»: the panel on the right steps aside (docs/plan/59-dialog-tools-panel.md). */
  paneHide:
    'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM15 4v16M8.5 9.5 11 12l-2.5 2.5',
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
  send: 'M12 19V5M5 12l7-7 7 7',
  check: 'm5 12 4 4L19 6',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
  chat: 'M21 12a8 8 0 0 1-11.8 7L4 20l1.2-4.4A8 8 0 1 1 21 12Z',
  changes: 'M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3 4v4h4',
  runs: 'M10 6h10M10 12h10M10 18h10M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  database:
    'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3ZM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  lock: 'M8 11V8a4 4 0 0 1 8 0v3M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
  warning:
    'M12 9v4M12 17h.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  // The chat of a site (docs/plan/53-chat-preview-release.md, R9): commands, the preview, files.
  slash: 'M15.5 4 8.5 20',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5',
  stop: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM9 9h6v6H9V9Z',
  /** SSH: a window with a prompt. */
  terminal:
    'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM7.5 9l3 3-3 3M13 15h3.5',
  /** FTP: files coming down into a folder. */
  folder:
    'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6ZM12 10v6M9.5 13.5 12 16l2.5-2.5',
  /** The key of a server. */
  key: 'M12 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM10.8 10.8 20 20M17 17l2-2M14.5 14.5l2-2',
  retry: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1M21 4v4h-4',
  // A task in the browser (docs/plan/57-browser-tasks.md): files, the browser and its controls.
  attach:
    'm21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5',
  image:
    'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM3 16l5-5 4 4 3-3 6 6M15.5 8.5h.01',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  keyboard:
    'M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1ZM7 10h.01M11 10h.01M15 10h.01M8 14h8',
  pointer: 'M5 3l14 7-6 2-2 6L5 3Z',
  // What is done with a dialog (owner's request of 26.10.2026): its name, its deletion, stopping it.
  pencil: 'M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  square: 'M8 8h8v8H8Z',
  /** «Размышление»: how hard the model thinks (owner's request of 29.10.2026); Lucide «brain», ISC. */
  brain:
    'M12 5a3 3 0 1 0-6 .1 4 4 0 0 0-2.5 5.8 4 4 0 0 0 .6 6.6A4 4 0 1 0 12 18ZM12 5a3 3 0 1 1 6 .1 4 4 0 0 1 2.5 5.8 4 4 0 0 1-.6 6.6A4 4 0 1 1 12 18ZM15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4M17.6 6.5a3 3 0 0 0 .4-1.4M6 5.1a3 3 0 0 0 .4 1.4M3.5 10.9a4 4 0 0 1 .6-.4M19.9 10.5a4 4 0 0 1 .6.4M6 18a4 4 0 0 1-2-.5M20 17.5a4 4 0 0 1-2 .5',
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
