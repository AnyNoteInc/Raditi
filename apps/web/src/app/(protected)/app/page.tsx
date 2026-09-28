import { BrandMark } from '@repo/ui/components'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

import { SignOutButton } from './sign-out-button'

export const metadata: Metadata = { title: 'Кабинет' }

export default async function CabinetPage() {
  // Pages render alongside their layout: the same cached lookup, checked here too.
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  const { name, email } = session.user

  return (
    <Box sx={{ minHeight: '100vh' }}>
      <Box component="header" sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Container
          maxWidth="lg"
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 2 }}
        >
          <BrandMark size={32} />
          <SignOutButton />
        </Container>
      </Box>
      <Container component="main" maxWidth="md" sx={{ py: { xs: 6, md: 10 } }}>
        <Stack spacing={3}>
          <Typography component="h1" variant="h3">
            Здравствуйте, {name || email}!
          </Typography>
          <Typography color="text.secondary">Вы вошли как {email}.</Typography>
          <Card>
            <CardContent sx={{ p: { xs: 3, md: 4 } }}>
              <Typography variant="h6" component="p">
                Здесь появится чат с ИИ-агентом.
              </Typography>
              <Typography color="text.secondary" sx={{ mt: 1 }}>
                Вы напишете, что поменять на сайте, а агент внесёт правку и покажет, что изменилось.
              </Typography>
            </CardContent>
          </Card>
        </Stack>
      </Container>
    </Box>
  )
}
