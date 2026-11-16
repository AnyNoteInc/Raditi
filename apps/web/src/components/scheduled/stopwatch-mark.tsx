import Box from '@mui/material/Box'

/**
 * A stopwatch, drawn (docs/plan/82-scheduled-tasks.md, Зп4): a dial with its marks, a crown and a
 * button, and an orange hand that goes round once unless the viewer asked for less motion. The
 * colours are the theme's, so it holds in the dark theme too; it only decorates.
 */
export function StopwatchMark({ size = 112 }: { size?: number }) {
  const marks = Array.from({ length: 12 }, (_, index) => index * 30)
  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        color: 'text.secondary',
        '@keyframes scheduledHand': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        '& .hand': { transformOrigin: '60px 66px', transformBox: 'view-box' },
        '@media (prefers-reduced-motion: no-preference)': {
          '& .hand': { animation: 'scheduledHand 1600ms cubic-bezier(0.45, 0, 0.2, 1) 200ms both' },
        },
      }}
    >
      <svg width={size} height={size} viewBox="0 0 120 120" fill="none" focusable="false">
        {/* The face: the paper of a card, its rim, and the marks of the hours. */}
        <Box
          component="circle"
          cx="60"
          cy="66"
          r="40"
          sx={{ fill: 'var(--mui-palette-background-paper)', stroke: 'var(--mui-palette-divider)' }}
          strokeWidth="2"
        />
        {marks.map((angle) => (
          <line
            key={angle}
            x1="60"
            y1={angle % 90 === 0 ? 32 : 34}
            x2="60"
            y2="38"
            stroke="currentColor"
            strokeOpacity={angle % 90 === 0 ? 0.7 : 0.35}
            strokeWidth={angle % 90 === 0 ? 2.4 : 1.6}
            strokeLinecap="round"
            transform={`rotate(${angle} 60 66)`}
          />
        ))}
        {/* The crown on top and the button at its side. */}
        <rect x="52" y="14" width="16" height="7" rx="3" fill="currentColor" fillOpacity="0.55" />
        <rect x="57" y="20" width="6" height="7" rx="1.5" fill="currentColor" fillOpacity="0.4" />
        <rect
          x="92"
          y="24"
          width="7"
          height="10"
          rx="2"
          fill="currentColor"
          fillOpacity="0.35"
          transform="rotate(45 95.5 29)"
        />
        <Box component="g" className="hand">
          <Box
            component="line"
            x1="60"
            y1="66"
            x2="60"
            y2="38"
            strokeWidth="3"
            strokeLinecap="round"
            sx={{ stroke: 'var(--raditi-accent)' }}
          />
        </Box>
        <Box component="circle" cx="60" cy="66" r="4.5" sx={{ fill: 'var(--raditi-accent)' }} />
      </svg>
    </Box>
  )
}
