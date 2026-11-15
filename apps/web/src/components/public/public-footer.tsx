'use client'

import { legalDocuments } from '@repo/domain'
import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import { COOKIE_SETTINGS_OPEN_EVENT } from '@/lib/cookie-consent'
import { legalDocumentHref } from '@/lib/legal'

export function PublicFooter() {
  return (
    <Box component="footer" sx={{ borderTop: 1, borderColor: 'divider', mt: 'auto' }}>
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Stack spacing={2}>
          <Box
            component="nav"
            aria-label="Документы"
            sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 3, rowGap: 1 }}
          >
            {legalDocuments.map((document) => (
              <Link
                key={document.slug}
                href={legalDocumentHref(document.slug)}
                variant="body2"
                color="text.secondary"
              >
                {document.title}
              </Link>
            ))}
            <Link
              component="button"
              type="button"
              variant="body2"
              color="text.secondary"
              onClick={() => window.dispatchEvent(new Event(COOKIE_SETTINGS_OPEN_EVENT))}
            >
              Настройки cookie
            </Link>
          </Box>
          <Typography variant="body2" color="text.secondary">
            © {new Date().getFullYear()} Радити
          </Typography>
        </Stack>
      </Container>
    </Box>
  )
}
