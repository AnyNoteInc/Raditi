import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

// A placeholder: the real landing (docs/landing) arrives with roadmap task M8.
export default function HomePage() {
  return (
    <Container maxWidth="md" sx={{ py: { xs: 8, md: 14 } }}>
      <Stack spacing={3} sx={{ alignItems: 'flex-start' }}>
        <Typography variant="overline" color="text.secondary">
          Радити — забота о сайтах малого бизнеса
        </Typography>
        <Typography component="h1" variant="h1" sx={{ fontSize: { xs: '2.25rem', md: '3rem' } }}>
          Напишите в чат — агент поправит сайт
        </Typography>
        <Typography variant="h6" component="p" color="text.secondary" sx={{ fontWeight: 400 }}>
          Напишите в веб-чат или в Telegram, что поменять на вашем сайте, и ИИ-агент Радити внесёт
          правку сам: перед изменением он сохраняет копию, а правку можно отменить в течение 7 дней.
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <Button href="/sign-up" variant="contained" size="large">
            Зарегистрироваться
          </Button>
          <Button href="/sign-in" variant="outlined" size="large">
            Войти
          </Button>
        </Stack>
      </Stack>
    </Container>
  )
}
