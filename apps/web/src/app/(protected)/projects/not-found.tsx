import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

/** A site of someone else and a site that does not exist look the same from here. */
export default function ProjectNotFound() {
  return (
    <Container component="main" maxWidth="sm" sx={{ py: { xs: 8, md: 14 } }}>
      <Stack spacing={2.5} sx={{ alignItems: 'flex-start' }}>
        <Typography component="h1" variant="h3">
          Такого проекта нет
        </Typography>
        <Typography color="text.secondary">
          Возможно, ссылка устарела или проект принадлежит другому аккаунту.
        </Typography>
        <Button href="/projects" variant="outlined">
          К проектам
        </Button>
      </Stack>
    </Container>
  )
}
