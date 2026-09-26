import { findLegalDocument, legalDocuments, type LegalDocumentSlug } from '@repo/domain'
import Container from '@mui/material/Container'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { formatEditionDate } from '@/lib/legal'

import { legalContent } from './content'

// Only the documents of the registry exist; anything else is a 404.
export const dynamicParams = false

export function generateStaticParams() {
  return legalDocuments.map((document) => ({ document: document.slug }))
}

function lookup(slug: string) {
  const document = findLegalDocument(slug)
  if (!document || !Object.hasOwn(legalContent, slug)) return null
  return { document, Content: legalContent[slug as LegalDocumentSlug] }
}

export async function generateMetadata({
  params,
}: PageProps<'/terms/[document]'>): Promise<Metadata> {
  const found = lookup((await params).document)
  if (!found) return { title: 'Документ не найден' }
  const { document } = found
  return {
    title: document.title,
    description: `${document.title} сервиса «Радити», редакция от ${formatEditionDate(document.version)}.`,
  }
}

export default async function LegalDocumentPage({ params }: PageProps<'/terms/[document]'>) {
  const found = lookup((await params).document)
  if (!found) notFound()
  const { document, Content } = found

  return (
    <Container component="article" maxWidth="md" sx={{ py: { xs: 5, md: 8 } }}>
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ mb: 3, alignItems: 'baseline', flexWrap: 'wrap', rowGap: 0.5 }}
      >
        <Link href="/terms" variant="body2">
          Все документы
        </Link>
        <Typography variant="body2" color="text.secondary">
          Действующая редакция от {formatEditionDate(document.version)}
        </Typography>
      </Stack>
      <Content />
    </Container>
  )
}
