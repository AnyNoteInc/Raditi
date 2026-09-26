import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Страница не найдена' }

export default function NotFound() {
  return (
    <Container component="main" maxWidth="sm" sx={{ py: { xs: 8, md: 14 } }}>
      <Stack spacing={2.5} sx={{ alignItems: 'flex-start' }}>
        <Typography variant="overline" color="text.secondary">
          Ошибка 404
        </Typography>
        <Typography component="h1" variant="h3">
          Страница не найдена
        </Typography>
        <Typography color="text.secondary">
          Возможно, в адресе опечатка или страницу перенесли. Начните с главной.
        </Typography>
        <Button href="/" variant="contained">
          На главную
        </Button>
      </Stack>
    </Container>
  )
}
