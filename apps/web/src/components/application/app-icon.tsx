import type { CSSProperties } from 'react'

const paths = {
  projects:
    'M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 0V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2',
  profile: 'M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M16 5a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  /** «Страницы»: a sheet with its lines (docs/plan/69-pages.md, Ст30). */
  pages: 'M6 3h8l4 4v14H6V3ZM14 3v4h4M9 12h6M9 16h6',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  plans: 'M3 11V4a1 1 0 0 1 1-1h7l10 10-8 8L3 11ZM7.5 7.5h.01',
  payment: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM3 10h18M7 15h3',
  usage: 'M4 20h16M7 20v-6M12 20V6M17 20v-9',
  panel: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM9 4v16',
  /** «Скрыть панель»: the panel on the right steps aside (docs/plan/59-dialog-tools-panel.md). */
  paneHide:
    'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM15 4v16M8.5 9.5 11 12l-2.5 2.5',
  expand: 'm8 9 4-4 4 4M8 15l4 4 4-4',
  /** «Результаты» beside the chat: show or hide its card (owner's request of 14.11.2026). */
  results: 'M4 6h.01M4 12h.01M4 18h.01M8 6h12M8 12h12M8 18h8',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M14 8l4 4-4 4M8 12h13',
  plus: 'M12 5v14M5 12h14',
  search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  /** «Надиктовать» in the field (docs/plan/75-chat-input-output.md, ВВ16). */
  microphone: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  /** «Закрепить» of a chat (docs/plan/75-chat-input-output.md, ВВ21). */
  pin: 'M12 17v5M9 3h6l-1 5 4 4v2H6v-2l4-4-1-5Z',
  /** «В архив» of a chat (ВВ21): a box with its lid. */
  archive: 'M3 4h18v4H3V4Zm2 4v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4',
  sort: 'M7 4v16M4 7l3-3 3 3M17 20V4m-3 13 3 3 3-3',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z',
  arrow: 'M7 17 17 7M7 7h10v10',
  chevron: 'm9 5 7 7-7 7',
  down: 'm8 10 4 4 4-4',
  /** «Скачать»: an arrow down onto a line. */
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
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
  // A sheet with lines of text: a page or a document the agent made (docs/plan/67, Д4).
  document:
    'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5M9 13h6M9 17h6M9 9h1',
  forward: 'm12 5 7 7-7 7M19 12H4',
  share:
    'M18 8a3 3 0 1 0-2.9-3.7L8.9 7.4a3 3 0 1 0 0 4.2l6.2 3.1A3 3 0 1 0 16 13l-6.2-3.1a3 3 0 0 0 0-.8l6.2-3.1A3 3 0 0 0 18 8Z',
  copy: 'M9 9h10v12H9V9ZM5 15V3h10',
  contents: 'M4 6h16M4 12h10M4 18h13',
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
  /** How the list of chats is shown (docs/plan/61-chats-first.md, К23). */
  group: 'M4 6h16M7 12h10M10 18h4',
  /** «Расписание»: a stopwatch (docs/plan/82-scheduled-tasks.md, Зп1). */
  timer:
    'M10 2h4M12 2v4M19.5 13.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0ZM12 13.5l3-3M18.5 7 20 5.5',
  // Templates of scheduled tasks (docs/plan/82-scheduled-tasks.md, §4.6).
  /** A line of a heartbeat: checking that something keeps working. */
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
  /** A lamp: an idea. */
  bulb: 'M9 18h6M10 21h4M9.5 15.5c0-1-.5-1.7-1.2-2.4a6 6 0 1 1 7.4 0c-.7.7-1.2 1.4-1.2 2.4',
  /** Binoculars: looking at others. */
  binoculars:
    'M10 16a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Zm11 0a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0ZM10 16h4M3.3 14.6l2.2-8.1a1.5 1.5 0 0 1 3 0v6M20.7 14.6l-2.2-8.1a1.5 1.5 0 0 0-3 0v6',
  /** «Что это за раздел» beside the title of a section: a circle with «i». */
  info: 'M12 16v-5M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  /** A funnel: the filters of a list. */
  filter: 'M3 5h18l-7 8v6l-4 2v-8L3 5Z',
  /** «Размышление»: how hard the model thinks (owner's request of 29.10.2026); Lucide «brain», ISC. */
  brain:
    'M12 5a3 3 0 1 0-6 .1 4 4 0 0 0-2.5 5.8 4 4 0 0 0 .6 6.6A4 4 0 1 0 12 18ZM12 5a3 3 0 1 1 6 .1 4 4 0 0 1 2.5 5.8 4 4 0 0 1-.6 6.6A4 4 0 1 1 12 18ZM15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4M17.6 6.5a3 3 0 0 0 .4-1.4M6 5.1a3 3 0 0 0 .4 1.4M3.5 10.9a4 4 0 0 1 .6-.4M19.9 10.5a4 4 0 0 1 .6.4M6 18a4 4 0 0 1-2-.5M20 17.5a4 4 0 0 1-2 .5',
  // «Проекты» (docs/plan/84-projects.md, §4.8), as the boards draw them.
  /** «В избранное»: a star; `filled` — the project is starred. */
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z',
  /** «Контекст» of a project: sheets laid on each other. */
  layers: 'M12 3 3 7.5l9 4.5 9-4.5L12 3ZM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5',
  /** «Инструкции» of a project: a book with its lines. */
  instructions:
    'M7 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM5 19a2 2 0 0 1 2-2h12M9 7h6M9 10.5h4',
  /** «Память» of a project and of the account (lucide `bookmark`). */
  memory: 'm19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z',
  /** «Вернуть» from the trash: an arrow that turns back. */
  restore: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  /** «Загрузить с устройства» (docs/plan/84-projects.md, §4.8): an arrow up from a line. */
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  /** «Добавить текстовое содержимое»: the letter T. */
  text: 'M5 7V5h14v2M12 5v14M9 19h6',
  /** «Ссылка на GitHub», «Подключить GitHub» (lucide `github`). */
  github:
    'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4M9 18c-4.51 2-5-2-7-2',
  /** «Подключить GitLab» (lucide `gitlab`). */
  gitlab:
    'm22 13.29-3.33-10a.42.42 0 0 0-.14-.18.38.38 0 0 0-.22-.11.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18l-2.26 6.67H8.32L6.1 3.26a.42.42 0 0 0-.1-.18.38.38 0 0 0-.26-.08.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18L2 13.29a.74.74 0 0 0 .27.83L12 21l9.69-6.88a.71.71 0 0 0 .31-.83Z',
  // «Артефакты» (docs/plan/88-artifacts.md, Ар43) and their kinds (Ар6).
  /** «Артефакты» in the rail: two sheets, one over the other. */
  artifacts:
    'M9 3h9a2 2 0 0 1 2 2v11M6 7h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2ZM8 12h5M8 16h5',
  /** «Макет»: a window of a page with its blocks. */
  mockup:
    'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM3 8h18M7 12h10M7 16h5',
  /** «Таблица»: a grid. */
  table:
    'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM3 10h18M3 15h18M9 10v10',
  /** «Холст»: two screens side by side. */
  canvas: 'M3 5h10v10H3V5ZM16 9h5v10h-5V9ZM6 18h4',
  /** «Фирменный стиль»: a drop of colour. */
  brand: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z',
  /** «Схема»: boxes and an arrow. */
  diagram: 'M3 4h7v6H3V4ZM14 14h7v6h-7v-6ZM6.5 10v4a3 3 0 0 0 3 3H14',
  /** «Презентация»: a board on its stand. */
  slides: 'M3 4h18v11H3V4ZM12 15v5M8 20h8',
  /** «Структура сайта»: a home page and its pages. */
  sitemap: 'M9 3h6v5H9V3ZM3 16h6v5H3v-5ZM15 16h6v5h-6v-5ZM12 8v4M6 16v-4h12v4',
  /** «История версий». */
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 8v4l3 2',
} as const

export type AppIconName = keyof typeof paths

export function AppIcon({
  name,
  size = 20,
  filled = false,
  style,
}: {
  name: AppIconName
  size?: number
  /** The shape is filled with the colour of its line: a starred project. */
  filled?: boolean
  style?: CSSProperties
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
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
