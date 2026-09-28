import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

/** Shown instead of a page when the database or another dependency does not answer. */
export function ServiceUnavailable() {
  return (
    <Container component="main" maxWidth="sm" sx={{ py: { xs: 8, md: 14 } }}>
      <Stack spacing={2.5} sx={{ alignItems: 'flex-start' }}>
        <Typography variant="overline" color="text.secondary">
          Технические работы
        </Typography>
        <Typography component="h1" variant="h3">
          Кабинет временно недоступен
        </Typography>
        <Typography color="text.secondary">
          Мы уже разбираемся. Ваши данные и сайты в сохранности. Обновите страницу через пару минут.
        </Typography>
        <Button href="/" variant="outlined">
          На главную
        </Button>
      </Stack>
    </Container>
  )
}
