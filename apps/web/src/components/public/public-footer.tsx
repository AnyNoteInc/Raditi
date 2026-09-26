import { legalDocuments } from '@repo/domain'
import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

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
          </Box>
          <Typography variant="body2" color="text.secondary">
            © {new Date().getFullYear()} Радити
          </Typography>
        </Stack>
      </Container>
    </Box>
  )
}
