import { BrandMark } from '@repo/ui/components'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'

export function PublicHeader() {
  return (
    <Box component="header" sx={{ borderBottom: 1, borderColor: 'divider' }}>
      <Container
        maxWidth="lg"
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 2 }}
      >
        <Link href="/" underline="none" aria-label="Радити — на главную" sx={{ color: 'inherit' }}>
          <BrandMark size={32} />
        </Link>
        <Stack direction="row" spacing={1}>
          <Button href="/sign-in" variant="text">
            Войти
          </Button>
          <Button
            href="/sign-up"
            variant="contained"
            sx={{ display: { xs: 'none', sm: 'inline-flex' } }}
          >
            Зарегистрироваться
          </Button>
        </Stack>
      </Container>
    </Box>
  )
}
