'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import Typography from '@mui/material/Typography'
import { ARTIFACT_SANDBOX, artifactBridgeMessageSchema } from '@repo/domain/artifacts'
import { useEffect, useRef, useState } from 'react'

import { mockupTexts } from './mockup-texts'

// The frame of a mockup in view (docs/plan/88-artifacts.md, Ар28, Ар29): `/v/<token>` on the root
// of the domain of pages, sandboxed `allow-scripts` alone — the attribute and the CSP say the same.
// Its messages are data of the artifact: only those of the white list, by their schema, from this
// frame's window; the height is taken only when it was measured at the width of the device. A link
// is opened by the cabinet after the person agrees, never by the frame.

/** The height of the view before the frame said its own (Ар8): the window of the device. */
export const deviceHeights: Readonly<Record<number, number>> = Object.freeze({
  1440: 900,
  768: 1024,
  390: 844,
})

const MAX_HEIGHT = 20_000

export function ViewFrame({
  src,
  width,
  scale,
  title,
}: {
  src: string
  width: number
  scale: number
  title: string
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(deviceHeights[width] ?? 900)
  const [link, setLink] = useState<string | null>(null)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // The one check that means something: the message came from this frame's window.
      if (event.source === null || event.source !== ref.current?.contentWindow) return
      const message = artifactBridgeMessageSchema.safeParse(event.data)
      if (!message.success) return
      if (message.data.type === 'size' && message.data.width === width)
        setHeight(Math.min(Math.max(message.data.height, 100), MAX_HEIGHT))
      if (message.data.type === 'link') setLink(message.data.href)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [width, src])

  return (
    <>
      <Box sx={{ width: width * scale, height: height * scale, overflow: 'hidden', mx: 'auto' }}>
        <iframe
          ref={ref}
          key={src}
          src={src}
          title={title}
          sandbox={ARTIFACT_SANDBOX}
          referrerPolicy="no-referrer"
          data-artifact-frame="view"
          style={{
            width,
            height,
            border: 0,
            display: 'block',
            transform: scale === 1 ? undefined : `scale(${scale})`,
            transformOrigin: '0 0',
            background: '#fff',
          }}
        />
      </Box>
      <Dialog
        open={link !== null}
        onClose={() => setLink(null)}
        aria-labelledby="mockup-link-title"
      >
        <DialogTitle id="mockup-link-title">{mockupTexts.linkTitle}</DialogTitle>
        <DialogContent>
          <DialogContentText>{mockupTexts.linkBody}</DialogContentText>
          <Typography
            component="p"
            sx={{ fontFamily: 'monospace', wordBreak: 'break-all', my: 1.5 }}
            data-testid="mockup-link-address"
          >
            {link}
          </Typography>
          <DialogContentText variant="body2">{mockupTexts.linkWarning}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLink(null)}>{mockupTexts.cancel}</Button>
          <Button
            variant="contained"
            onClick={() => {
              if (link) window.open(link, '_blank', 'noopener,noreferrer')
              setLink(null)
            }}
          >
            {mockupTexts.linkOpen}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
