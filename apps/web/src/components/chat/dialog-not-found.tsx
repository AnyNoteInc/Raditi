import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import Link from 'next/link'

import { dialogText } from './chat-texts'

/**
 * «Такого диалога нет»: a dialog that was deleted, that is of another site or never was. The page
 * of a dialog says it when the server finds none, its view when the feed comes back without it.
 */
export function DialogNotFound({ listHref }: { listHref: string }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Typography component="h1" sx={{ fontSize: 26, fontWeight: 600 }}>
        {dialogText.notFound}
      </Typography>
      <Typography color="text.secondary">{dialogText.notFoundHint}</Typography>
      <Button component={Link} href={listHref} variant="outlined" sx={{ alignSelf: 'flex-start' }}>
        {dialogText.toList}
      </Button>
    </Box>
  )
}
