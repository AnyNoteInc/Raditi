'use client'

import Box from '@mui/material/Box'
import Breadcrumbs from '@mui/material/Breadcrumbs'
import Typography from '@mui/material/Typography'

/** The project toolbar only describes location; the account menu lives in the rail. */
export function ApplicationToolbar() {
  return (
    <Box
      component="header"
      aria-label="Панель приложения"
      sx={{
        minHeight: 64,
        px: { xs: 2.5, sm: 4, lg: 6 },
        display: 'flex',
        alignItems: 'center',
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
    >
      <Breadcrumbs aria-label="Хлебные крошки">
        <Typography
          aria-current="page"
          variant="body2"
          sx={{ fontWeight: 500, color: 'text.primary' }}
        >
          Проекты
        </Typography>
      </Breadcrumbs>
    </Box>
  )
}
