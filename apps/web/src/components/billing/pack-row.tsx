'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'

import { nbsp } from '@/lib/nbsp'
import { formatRubles } from '@/lib/rubles'

import type { PackOffer } from './billing-types'
import { packOffer } from './plan-format'

/**
 * The pack of credits on sale, as a row under the tariffs: its name and price, what it gives,
 * and the button that opens its dialog. Drawn only for a customer who may buy it.
 */
export function PackRow({ pack, onBuy }: { pack: PackOffer; onBuy: () => void }) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px 24px',
        mt: 3,
        pt: 2,
        borderTop: 1,
        borderColor: 'divider',
      }}
    >
      <Box sx={{ flex: '1 1 280px', minWidth: 0 }}>
        <Typography
          component="h3"
          sx={{ fontSize: 15, fontWeight: 500, lineHeight: 1.4, overflowWrap: 'anywhere' }}
        >
          {nbsp(`${pack.name} — ${formatRubles(pack.price)} ₽`)}
        </Typography>
        <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
          {nbsp(packOffer(pack.credits))}
        </Typography>
      </Box>
      <Button variant="outlined" onClick={onBuy}>
        Купить пакет
      </Button>
    </Box>
  )
}
