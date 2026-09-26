import { legalDocuments } from '@repo/domain'
import Container from '@mui/material/Container'
import Link from '@mui/material/Link'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { Metadata } from 'next'

import { formatEditionDate, legalDocumentHref } from '@/lib/legal'

export const metadata: Metadata = {
  title: 'Документы',
  description: 'Пользовательское соглашение, оферта, политика и согласия сервиса «Радити».',
}

export default function TermsPage() {
  return (
    <Container maxWidth="md" sx={{ py: { xs: 6, md: 10 } }}>
      <Stack spacing={3}>
        <Typography component="h1" variant="h2">
          Документы
        </Typography>
        <Typography color="text.secondary">
          Условия, на которых работает Радити, и то, как мы обращаемся с персональными данными.
        </Typography>
        <List disablePadding>
          {legalDocuments.map((document) => (
            <ListItem
              key={document.slug}
              disableGutters
              divider
              sx={{ flexDirection: 'column', alignItems: 'flex-start', py: 2 }}
            >
              <Link href={legalDocumentHref(document.slug)} variant="h6" underline="hover">
                {document.title}
              </Link>
              <Typography variant="body2" color="text.secondary">
                Редакция от {formatEditionDate(document.version)}
              </Typography>
            </ListItem>
          ))}
        </List>
      </Stack>
    </Container>
  )
}
