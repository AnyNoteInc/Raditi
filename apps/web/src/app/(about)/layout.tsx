import Box from '@mui/material/Box'
import type { ReactNode } from 'react'

import { PublicFooter } from '@/components/public/public-footer'
import { PublicHeader } from '@/components/public/public-header'

export default function AboutLayout({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <PublicHeader />
      <Box component="main" sx={{ flex: 1 }}>
        {children}
      </Box>
      <PublicFooter />
    </Box>
  )
}
