import { brandColors } from '@repo/ui/theme/tokens'
import type { MetadataRoute } from 'next'

/**
 * The manifest of the cabinet as an app (docs/plan/82-scheduled-tasks.md, Зп42): Safari on iPhone
 * and iPad gives Web Push only to a site added to the home screen and opened from there as an app
 * of its own. It opens the chats; the icons are the brand mark (`public/brand-icon*.png`, from
 * `public/brand-icon.svg`).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/chats',
    name: 'Радити',
    short_name: 'Радити',
    description: 'Поддержка сайта в чате: напишите, что поменять на сайте.',
    lang: 'ru',
    start_url: '/chats',
    scope: '/',
    display: 'standalone',
    background_color: brandColors.paper,
    theme_color: brandColors.paper,
    icons: [
      { src: '/brand-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/brand-icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  }
}
