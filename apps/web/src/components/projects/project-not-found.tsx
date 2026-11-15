'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import Link from 'next/link'

import { PROJECTS_HREF, projectPageText, projectsText } from './project-texts'

/** «Такого проекта нет»: deleted, someone else's, or never was (docs/plan/84-projects.md, ПР1). */
export function ProjectNotFound() {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Typography component="h1" sx={{ fontSize: 26, fontWeight: 600 }}>
        {projectPageText.notFound}
      </Typography>
      <Typography color="text.secondary">{projectPageText.notFoundBody}</Typography>
      <Button
        component={Link}
        href={PROJECTS_HREF}
        variant="outlined"
        sx={{ alignSelf: 'flex-start', minHeight: 44 }}
      >
        {projectsText.title}
      </Button>
    </Box>
  )
}
