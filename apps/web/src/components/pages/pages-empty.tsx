'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Typography from '@mui/material/Typography'
import { useRouter } from 'next/navigation'

import { AppIcon } from '@/components/application/app-icon'
import { keepChatDraft } from '@/components/chat/chat-draft'

import { pageEmptyTexts } from './page-labels'

const NEW_CHAT = '/chats/new'

/**
 * A site of pages, drawn: a browser window with its address and a home page that branches into
 * two pages (docs/plan/73-pages-sites.md, §7.1). Colours are the theme's, so it holds in the dark
 * theme too; its bars come in once, left to right, unless the viewer asked for less motion.
 */
function SiteMark() {
  return (
    <Box
      aria-hidden
      sx={{
        position: 'relative',
        width: 168,
        borderRadius: '14px',
        border: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        boxShadow: '0 1px 0 rgba(0,0,0,0.04)',
        overflow: 'hidden',
        '@keyframes pagesMarkBar': {
          from: { transform: 'scaleX(0)' },
          to: { transform: 'scaleX(1)' },
        },
        '& .bar': { transformOrigin: 'left center' },
        '@media (prefers-reduced-motion: no-preference)': {
          '& .bar': { animation: 'pagesMarkBar 600ms ease-out both' },
          '& .bar:nth-of-type(2)': { animationDelay: '120ms' },
          '& .bar:nth-of-type(3)': { animationDelay: '240ms' },
        },
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1.25,
          py: 0.75,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        {[0, 1, 2].map((dot) => (
          <Box
            key={dot}
            sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'divider', flexShrink: 0 }}
          />
        ))}
        <Typography
          component="span"
          sx={{
            ml: 0.75,
            fontSize: 9.5,
            lineHeight: 1.2,
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-jetbrains), monospace',
            color: 'text.secondary',
          }}
        >
          <Box component="span" sx={{ opacity: 0.6 }}>
            {pageEmptyTexts.address}
          </Box>
          .pages.raditi.ru
        </Typography>
      </Box>
      <Box sx={{ px: 1.5, py: 1.25 }}>
        <Box
          className="bar"
          sx={{ height: 8, width: '70%', borderRadius: 4, bgcolor: 'primary.main', mb: 1 }}
        />
        {[54, 72].map((width) => (
          <Box key={width} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.75 }}>
            <Box
              sx={{
                width: 10,
                height: 10,
                ml: 0.75,
                borderLeft: 1.5,
                borderBottom: 1.5,
                borderColor: 'divider',
                borderBottomLeftRadius: 3,
                flexShrink: 0,
              }}
            />
            <Box
              sx={{
                width: 14,
                height: 10,
                borderRadius: '2px',
                border: 1,
                borderColor: 'divider',
                flexShrink: 0,
              }}
            />
            <Box
              className="bar"
              sx={{ height: 6, width: `${width}%`, borderRadius: 3, bgcolor: 'divider' }}
            />
          </Box>
        ))}
      </Box>
    </Box>
  )
}

/**
 * «Страницы» before the first page (docs/plan/73-pages-sites.md, Дер6): no filters, no search,
 * no counts — what will be here, «Начать чат» and requests to begin with. A request goes into the
 * draft of a new chat the way the wizard keeps one (`keepChatDraft`): it is not sent by itself,
 * and the address carries nothing.
 */
export function PagesEmpty({ userId }: { userId: string }) {
  const router = useRouter()
  return (
    <Box
      component="section"
      aria-labelledby="pages-empty-title"
      sx={{
        maxWidth: 560,
        mx: 'auto',
        mt: { xs: 6, md: 10 },
        mb: 6,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
      }}
    >
      <SiteMark />
      <Typography
        id="pages-empty-title"
        component="h2"
        sx={{ mt: 3, fontSize: { xs: 22, md: 26 }, fontWeight: 600, lineHeight: 1.3 }}
      >
        {pageEmptyTexts.title}
      </Typography>
      <Typography sx={{ mt: 1.25, color: 'text.secondary', fontSize: { xs: 15, md: 16 } }}>
        {pageEmptyTexts.lead}
      </Typography>
      <Button variant="contained" href={NEW_CHAT} sx={{ mt: 3, minHeight: 44, px: 3 }}>
        {pageEmptyTexts.start}
      </Button>
      <Typography variant="caption" sx={{ mt: 4, mb: 1.25, color: 'text.secondary' }}>
        {pageEmptyTexts.examplesTitle}
      </Typography>
      <Box
        component="ul"
        sx={{
          listStyle: 'none',
          m: 0,
          p: 0,
          width: '100%',
          border: 1,
          borderColor: 'divider',
          borderRadius: '12px',
          overflow: 'hidden',
          bgcolor: 'background.paper',
        }}
      >
        {pageEmptyTexts.examples.map((example, index) => (
          <Box
            component="li"
            key={example.text}
            sx={index > 0 ? { borderTop: 1, borderColor: 'divider' } : undefined}
          >
            <ButtonBase
              onClick={() => {
                keepChatDraft(userId, example.text)
                router.push(NEW_CHAT)
              }}
              sx={{
                width: '100%',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 1.5,
                px: 2,
                py: 1.5,
                minHeight: 48,
                textAlign: 'left',
                justifyContent: 'flex-start',
                '&:hover, &.Mui-focusVisible': { bgcolor: 'action.hover' },
              }}
            >
              <Box sx={{ display: 'flex', color: 'text.secondary', pt: '2px' }} aria-hidden>
                <AppIcon name={example.icon} size={18} />
              </Box>
              <Typography component="span" sx={{ fontSize: 15, lineHeight: 1.45 }}>
                {example.text}
              </Typography>
            </ButtonBase>
          </Box>
        ))}
      </Box>
      <Typography variant="caption" sx={{ mt: 2, color: 'text.secondary' }}>
        {pageEmptyTexts.note}
      </Typography>
    </Box>
  )
}
