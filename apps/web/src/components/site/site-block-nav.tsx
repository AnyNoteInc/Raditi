'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Link from 'next/link'
import { useSelectedLayoutSegment } from 'next/navigation'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'

/**
 * One block of a section split by its cards (owner's request of 26.10.2026): «База данных сайта»
 * and «Копии» of «База и бэкап», «Переменные окружения» and «Доступы» of «Переменные».
 */
export interface SiteBlock {
  /** The segment of its page under the section. */
  segment: string
  title: string
  /** What the block holds now, in a few words: «MySQL или MariaDB · kroshka_wp», «2 копии». */
  note: string
  icon: AppIconName
}

/**
 * The menu of a section split by its cards, in its list column: one link per block, the open one
 * marked. At the root of the section the first block is the open one from `md` — the root page
 * shows it there; on a phone the root shows the menu alone, so nothing looks open. On a phone the
 * menu is the whole screen, so each item ends with an arrow.
 */
export function SiteBlockNav({ root, blocks }: { root: string; blocks: readonly SiteBlock[] }) {
  const opened = useSelectedLayoutSegment()
  const atRoot = opened === null
  const segment = opened ?? blocks[0]?.segment ?? null
  return (
    <Box
      component="ul"
      sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 0.5 }}
    >
      {blocks.map((block) => {
        const current = block.segment === segment
        // Marked from `md` only while it is the root that shows it.
        const marked = (value: string, otherwise: string) =>
          current ? (atRoot ? { xs: otherwise, md: value } : value) : otherwise
        return (
          <li key={block.segment}>
            <Box
              component={Link}
              href={`${root}/${block.segment}`}
              aria-current={current ? 'page' : undefined}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                minHeight: 56,
                px: 1.25,
                py: 1,
                borderRadius: '12px',
                textDecoration: 'none',
                color: 'text.primary',
                bgcolor: marked('action.selected', 'transparent'),
                '&:hover': { bgcolor: marked('action.selected', 'action.hover') },
                '&:focus-visible': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: 2,
                },
              }}
            >
              <Box
                component="span"
                aria-hidden="true"
                sx={{
                  flex: 'none',
                  display: 'grid',
                  placeItems: 'center',
                  width: 36,
                  height: 36,
                  borderRadius: '10px',
                  border: 1,
                  borderColor: 'divider',
                  bgcolor: 'background.default',
                  color: marked('primary.main', 'text.secondary'),
                }}
              >
                <AppIcon name={block.icon} size={18} />
              </Box>
              <Box
                component="span"
                sx={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column' }}
              >
                <Typography
                  component="span"
                  sx={{
                    fontSize: 15,
                    fontWeight: current ? (atRoot ? { xs: 500, md: 600 } : 600) : 500,
                    lineHeight: 1.35,
                    overflowWrap: 'anywhere',
                  }}
                >
                  {block.title}
                </Typography>
                <Typography
                  component="span"
                  variant="caption"
                  color="text.secondary"
                  sx={{ overflowWrap: 'anywhere' }}
                >
                  {block.note}
                </Typography>
              </Box>
              <Box
                component="span"
                aria-hidden="true"
                sx={{ display: { xs: 'flex', md: 'none' }, color: 'text.secondary' }}
              >
                <AppIcon name="chevron" size={18} />
              </Box>
            </Box>
          </li>
        )
      })}
    </Box>
  )
}
