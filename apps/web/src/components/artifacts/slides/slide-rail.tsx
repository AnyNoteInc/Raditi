'use client'

import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import type { ArtifactSlide } from '@repo/domain/artifacts'
import { useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { slidesTexts } from './slides-texts'

// The rail of slides (docs/plan/93-artifacts-trim.md, АТ8): slim thumbnails with their numbers, a
// column beside the slide on a wide screen and a strip under it on a phone; the order is changed
// by the menu «⋯» of a thumbnail — «Выше», «Ниже», «Удалить» —, which a keyboard reaches as well.

const THUMB_WIDTH = 100
const THUMB_HEIGHT = Math.round((THUMB_WIDTH * 9) / 16)

export function SlideRail({
  slides,
  at,
  compact,
  thumbOf,
  canEdit,
  busy,
  onChoose,
  onMove,
  onRemove,
}: {
  slides: readonly ArtifactSlide[]
  at: number
  /** Always a strip under the slide (the pane beside a chat); otherwise a strip on a phone only. */
  compact: boolean
  thumbOf: (key: string) => string | null
  canEdit: boolean
  busy: boolean
  onChoose: (key: string) => void
  onMove: (index: number, direction: -1 | 1) => void
  onRemove: (index: number) => void
}) {
  const [menu, setMenu] = useState<{ anchor: HTMLElement; index: number } | null>(null)

  return (
    <Box
      component="nav"
      aria-label={slidesTexts.slides}
      sx={{
        minWidth: 0,
        overflow: 'auto',
        maxHeight: compact ? undefined : { md: '78vh' },
        // The focus ring of a thumbnail stays inside the scroll.
        p: 0.5,
      }}
    >
      <Box
        component="ol"
        sx={{
          listStyle: 'none',
          m: 0,
          p: 0,
          display: 'flex',
          flexDirection: compact ? 'row' : { xs: 'row', md: 'column' },
          gap: 1.25,
        }}
      >
        {slides.map((slide, index) => {
          const url = thumbOf(slide.key)
          const current = index === at
          return (
            <Box
              component="li"
              key={slide.key}
              sx={{
                position: 'relative',
                flex: '0 0 auto',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 0.75,
                '&:hover .slide-menu, &:focus-within .slide-menu': { opacity: 1 },
              }}
            >
              <Typography
                aria-hidden
                variant="caption"
                sx={{
                  width: 14,
                  textAlign: 'right',
                  color: current ? 'primary.main' : 'text.secondary',
                  fontWeight: current ? 650 : 400,
                  fontVariantNumeric: 'tabular-nums',
                  lineHeight: 1.6,
                }}
              >
                {index + 1}
              </Typography>
              <Box
                component="button"
                type="button"
                aria-current={current ? 'true' : undefined}
                aria-label={`${index + 1}. ${slide.name}`}
                title={slide.name}
                onClick={() => onChoose(slide.key)}
                sx={{
                  display: 'block',
                  p: 0,
                  width: THUMB_WIDTH,
                  height: THUMB_HEIGHT,
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: '6px',
                  overflow: 'hidden',
                  bgcolor: '#fff',
                  cursor: 'pointer',
                  outline: current ? '2px solid' : 'none',
                  outlineColor: 'primary.main',
                  outlineOffset: 1,
                  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
                }}
              >
                {url ? (
                  <Box
                    component="img"
                    src={url}
                    alt=""
                    sx={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <Typography
                    component="span"
                    sx={{
                      display: 'block',
                      px: 0.75,
                      pt: 0.5,
                      fontSize: 10,
                      lineHeight: 1.3,
                      color: 'text.secondary',
                      textAlign: 'left',
                      overflow: 'hidden',
                    }}
                  >
                    {slide.name}
                  </Typography>
                )}
              </Box>
              {canEdit && (
                <Tooltip title={slidesTexts.slideMenu(index + 1)}>
                  <IconButton
                    className="slide-menu"
                    size="small"
                    aria-label={slidesTexts.slideMenu(index + 1)}
                    aria-haspopup="menu"
                    onClick={(event) => setMenu({ anchor: event.currentTarget, index })}
                    sx={{
                      position: 'absolute',
                      top: 2,
                      right: 2,
                      p: 0.25,
                      bgcolor: 'background.paper',
                      boxShadow: 1,
                      opacity: current ? 1 : 0,
                      transition: 'opacity 120ms ease',
                      '&:hover': { bgcolor: 'background.paper' },
                    }}
                  >
                    <AppIcon name="more" size={16} />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
          )
        })}
      </Box>
      <Menu anchorEl={menu?.anchor ?? null} open={menu !== null} onClose={() => setMenu(null)}>
        <MenuItem
          disabled={busy || menu === null || menu.index === 0}
          onClick={() => {
            if (menu) onMove(menu.index, -1)
            setMenu(null)
          }}
        >
          {slidesTexts.up}
        </MenuItem>
        <MenuItem
          disabled={busy || menu === null || menu.index === slides.length - 1}
          onClick={() => {
            if (menu) onMove(menu.index, 1)
            setMenu(null)
          }}
        >
          {slidesTexts.down}
        </MenuItem>
        <MenuItem
          disabled={busy}
          onClick={() => {
            if (menu) onRemove(menu.index)
            setMenu(null)
          }}
          sx={{ color: 'error.main' }}
        >
          {slidesTexts.remove}
        </MenuItem>
      </Menu>
    </Box>
  )
}
