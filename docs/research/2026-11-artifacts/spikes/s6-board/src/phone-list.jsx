// Ар49: on a phone the canvas is a list of thumbnails (the first phone screen of every screen, 2×),
// tapping one opens the live frame full screen. Native scrolling; images load lazily.
import { useLayoutEffect, useRef } from 'react'
import { Card, CardActionArea, CardContent, Typography } from '@mui/material'
import { tracker, useOpen } from './shared.jsx'

export default function PhoneList({ screens, onReady }) {
  const ref = useRef(null)
  const open = useOpen()
  useLayoutEffect(() => {
    onReady({ getViewport: () => ({ x: 0, y: -ref.current.scrollTop, zoom: 1 }), setViewport: () => {}, element: ref.current })
  }, [])
  return (
    <div ref={ref} className="phone-list">
      {screens.map((s, i) => (
        <Card key={s.token} variant="outlined" sx={{ mb: 2, borderRadius: 3 }}>
          <CardActionArea onClick={() => open(`${s.token}@390`)}>
            <ListThumb s={s} eager={i < 2} />
            <CardContent sx={{ py: 1.5 }}><Typography variant="subtitle2">{s.title}</Typography></CardContent>
          </CardActionArea>
        </Card>
      ))}
    </div>
  )
}

function ListThumb({ s, eager }) {
  const id = `list:${s.token}`
  useLayoutEffect(() => { if (eager) tracker.begin(id, 'thumb'); return () => tracker.cancel(id) }, [id, eager])
  return (
    <img className="list-thumb" alt="" width={390} height={844} loading={eager ? 'eager' : 'lazy'} decoding="async"
      src={`/thumbs/${s.token}-list.png`}
      onLoad={(e) => { e.currentTarget.decode().catch(() => {}).finally(() => tracker.end(id)) }} />
  )
}
