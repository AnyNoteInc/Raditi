'use client'

import Box from '@mui/material/Box'
import { useEffect, useRef, useState } from 'react'

/** Where the cabinet serves the icon of a site: its own origin, never the site's. */
export const siteFaviconHref = (siteId: string) =>
  `/api/projects/${encodeURIComponent(siteId)}/favicon`

/**
 * The tile on top of the rail of a site: the site's /favicon.ico when it has one, else the first
 * character of its name. The letter stays until the icon has loaded, and comes back if it fails
 * to: a site without an icon, or one that is not an image, keeps its letter.
 */
export function SiteMark({ siteId, name, mark }: { siteId: string; name: string; mark: string }) {
  const [icon, setIcon] = useState<'pending' | 'loaded' | 'failed'>('pending')
  const image = useRef<HTMLImageElement>(null)

  // An icon from the browser's cache may load before React listens: read where it stands.
  useEffect(() => {
    const element = image.current
    if (!element?.complete) return
    setIcon(element.naturalWidth > 0 ? 'loaded' : 'failed')
  }, [])

  const loaded = icon === 'loaded'
  return (
    <Box
      role="img"
      aria-label={`Сайт ${name}`}
      sx={{
        position: 'relative',
        width: 44,
        height: 44,
        flex: 'none',
        mb: 1,
        borderRadius: '10px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        // An icon is drawn for a light page: on a light tile it reads in both schemes.
        bgcolor: loaded ? '#ffffff' : 'primary.main',
        border: loaded ? 1 : 0,
        borderColor: 'divider',
        color: 'primary.contrastText',
        fontWeight: 700,
        fontSize: 20,
      }}
    >
      {loaded ? null : mark}
      {icon === 'failed' ? null : (
        // eslint-disable-next-line @next/next/no-img-element -- A same-origin icon of a few bytes; the image optimiser would fetch it again for nothing.
        <img
          ref={image}
          src={siteFaviconHref(siteId)}
          alt=""
          width={28}
          height={28}
          decoding="async"
          onLoad={() => setIcon('loaded')}
          onError={() => setIcon('failed')}
          style={{
            position: loaded ? 'static' : 'absolute',
            width: 28,
            height: 28,
            objectFit: 'contain',
            opacity: loaded ? 1 : 0,
          }}
        />
      )}
    </Box>
  )
}
