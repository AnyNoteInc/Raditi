import Box from '@mui/material/Box'
import Divider from '@mui/material/Divider'
import Link from '@mui/material/Link'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import type { MDXComponents } from 'mdx/types'

import { resolveDocumentLink } from '@/lib/links'

// Not a client module: the legal pages render MDX on the server. Only serialisable props
// (strings, plain `sx` objects) cross into the MUI client components.
export const mdxComponents: MDXComponents = {
  h1: ({ children }) => (
    <Typography variant="h3" component="h1" sx={{ mt: 0, mb: 3, overflowWrap: 'anywhere' }}>
      {children}
    </Typography>
  ),
  h2: ({ children }) => (
    <Typography variant="h5" component="h2" sx={{ mt: 5, mb: 2 }}>
      {children}
    </Typography>
  ),
  h3: ({ children }) => (
    <Typography variant="h6" component="h3" sx={{ mt: 3.5, mb: 1.5 }}>
      {children}
    </Typography>
  ),
  h4: ({ children }) => (
    <Typography variant="subtitle1" component="h4" sx={{ mt: 3, mb: 1, fontWeight: 600 }}>
      {children}
    </Typography>
  ),
  p: ({ children }) => (
    <Typography variant="body1" sx={{ mb: 1.75, lineHeight: 1.7 }}>
      {children}
    </Typography>
  ),
  ul: ({ children }) => (
    <Box component="ul" sx={{ pl: 3, mt: 0, mb: 2 }}>
      {children}
    </Box>
  ),
  ol: ({ children, start }) => (
    <Box component="ol" start={start} sx={{ pl: 3, mt: 0, mb: 2 }}>
      {children}
    </Box>
  ),
  li: ({ children }) => (
    <Typography component="li" variant="body1" sx={{ mb: 0.75, lineHeight: 1.7 }}>
      {children}
    </Typography>
  ),
  a: ({ children, href }) => {
    const link = resolveDocumentLink(href)
    return link.external ? (
      <Link href={link.href} target="_blank" rel="noopener noreferrer">
        {children}
      </Link>
    ) : (
      <Link href={link.href}>{children}</Link>
    )
  },
  hr: () => <Divider sx={{ my: 4 }} />,
  blockquote: ({ children }) => (
    <Box
      component="blockquote"
      sx={{ mx: 0, my: 2, pl: 2, borderLeft: 3, borderColor: 'divider', color: 'text.secondary' }}
    >
      {children}
    </Box>
  ),
  code: ({ children }) => (
    <Box
      component="code"
      sx={{ fontFamily: 'monospace', fontSize: '0.92em', px: 0.5, borderRadius: 1 }}
    >
      {children}
    </Box>
  ),
  table: ({ children }) => (
    <TableContainer
      sx={{ mb: 3, border: 1, borderColor: 'divider', borderRadius: 2, overflowX: 'auto' }}
    >
      <Table size="small">{children}</Table>
    </TableContainer>
  ),
  thead: ({ children }) => <TableHead>{children}</TableHead>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children, style }) => (
    <TableCell style={style} sx={{ fontWeight: 600, verticalAlign: 'top' }}>
      {children}
    </TableCell>
  ),
  td: ({ children, style }) => (
    <TableCell style={style} sx={{ verticalAlign: 'top' }}>
      {children}
    </TableCell>
  ),
}

/** Components for every MDX file (@next/mdx requires this file in App Router). */
export function useMDXComponents(overrides: MDXComponents = {}): MDXComponents {
  return { ...mdxComponents, ...overrides }
}
