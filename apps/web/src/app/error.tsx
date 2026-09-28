'use client'

import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useEffect } from 'react'

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <Container component="main" maxWidth="sm" sx={{ py: { xs: 8, md: 14 } }}>
      <Stack spacing={2.5} sx={{ alignItems: 'flex-start' }}>
        <Typography variant="overline" color="text.secondary">
          Ошибка
        </Typography>
        <Typography component="h1" variant="h3">
          Что-то пошло не так
        </Typography>
        <Typography color="text.secondary">
          Мы уже разбираемся. Попробуйте обновить страницу немного позже.
        </Typography>
        {error.digest ? (
          <Typography variant="body2" color="text.secondary">
            Код ошибки для поддержки: {error.digest}
          </Typography>
        ) : null}
        <Stack direction="row" spacing={1.5}>
          <Button onClick={reset} variant="contained">
            Попробовать ещё раз
          </Button>
          <Button href="/" variant="outlined">
            На главную
          </Button>
        </Stack>
      </Stack>
    </Container>
  )
}
