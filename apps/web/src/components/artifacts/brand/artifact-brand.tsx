'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import {
  artifactRoleAtLeast,
  brandColorTokens,
  brandFonts,
  brandTokenLabels,
  brandTokensOf,
} from '@repo/domain/artifacts'

import { ArtifactDocument } from '../artifact-document'
import type { ArtifactBodyProps } from '../artifact-body-props'
import { MockupSettings } from '../mockup/mockup-settings'

// «Фирменный стиль» (docs/plan/88-artifacts.md, §4, Ар25, Ар42; slice 88.15а): its colours, fonts and
// words as the form «Настройки» of its tokens, a sample of how they look, and the tone of the texts.
// Every mockup and canvas of its project draws with these colours as CSS variables; the agent of
// every turn of the project reads them. It never opens to others with «Правит» (Ар25).

export const brandTexts = Object.freeze({
  tokens: 'Цвета, шрифты и слова',
  sample: 'Как это выглядит',
  sampleTitle: 'Заголовок страницы',
  sampleText: 'Так выглядит обычный текст на вашем сайте.',
  sampleButton: 'Записаться',
  about:
    'Эти цвета и шрифты получают все макеты и холсты проекта, а агент учитывает тон и запретные слова в каждом ходе проекта.',
  noProject:
    'Фирменный стиль действует в проекте: перенесите его в проект, чтобы макеты и холсты проекта его получили.',
  empty: 'Здесь пока нет настроек. Попросите агента собрать фирменный стиль по вашему сайту.',
  tone: 'Тон текстов',
})

export function ArtifactBrand(props: ArtifactBodyProps & { onAccessLost: () => void }) {
  const { artifact, onChanged } = props
  const canEdit = artifactRoleAtLeast(artifact.role, 'edit')
  const settings =
    artifact.blocks.find((block) => block.kind === 'settings' && block.parent === null) ?? null
  const tokens = brandTokensOf(settings?.content ?? null)
  const color = (token: (typeof brandColorTokens)[number], fallback: string) =>
    tokens.colors[token] ?? fallback
  const font = (name: string | null) => (name ? brandFonts[name] : undefined)
  const hasSections = artifact.blocks.some((block) => block.kind === 'section')

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {brandTexts.about}
      </Typography>
      {artifact.project === null && <Alert severity="info">{brandTexts.noProject}</Alert>}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'flex-start' }}>
        <Box
          component="section"
          aria-label={brandTexts.tokens}
          sx={{ flex: '1 1 320px', borderRadius: '12px', border: 1, borderColor: 'divider', p: 2 }}
        >
          {settings ? (
            <MockupSettings
              artifact={artifact}
              block={settings}
              canEdit={canEdit}
              onChanged={onChanged}
              labels={brandTokenLabels}
            />
          ) : (
            <Typography sx={{ color: 'text.secondary' }}>{brandTexts.empty}</Typography>
          )}
        </Box>
        <Box
          component="section"
          aria-label={brandTexts.sample}
          data-testid="brand-sample"
          sx={{
            flex: '1 1 320px',
            borderRadius: `${tokens.radius ?? 12}px`,
            border: 1,
            borderColor: 'divider',
            p: 3,
            bgcolor: color('background', '#ffffff'),
            color: color('text', '#1f2421'),
            fontFamily: font(tokens.bodyFont),
          }}
        >
          <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
            {brandColorTokens.map((token) => (
              <Box
                key={token}
                title={brandTokenLabels[token]}
                aria-label={`${brandTokenLabels[token]}: ${tokens.colors[token] ?? '—'}`}
                role="img"
                sx={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  border: 1,
                  borderColor: 'divider',
                  bgcolor: tokens.colors[token] ?? 'transparent',
                }}
              />
            ))}
          </Box>
          <Typography
            component="p"
            sx={{
              fontSize: 26,
              fontWeight: 700,
              mb: 1,
              color: color('primary', '#2f5d50'),
              fontFamily: font(tokens.headingFont),
            }}
          >
            {brandTexts.sampleTitle}
          </Typography>
          <Box
            sx={{
              p: 2,
              mb: 2,
              borderRadius: `${tokens.radius ?? 12}px`,
              bgcolor: color('surface', '#f6f3ee'),
            }}
          >
            <Typography sx={{ fontFamily: 'inherit' }}>{brandTexts.sampleText}</Typography>
            <Typography
              variant="body2"
              sx={{ color: color('muted', '#6b706c'), fontFamily: 'inherit' }}
            >
              {tokens.tone ?? ''}
            </Typography>
          </Box>
          <Box
            component="span"
            sx={{
              display: 'inline-block',
              px: 2.5,
              py: 1.25,
              borderRadius: `${tokens.radius ?? 12}px`,
              bgcolor: color('accent', '#e07a3f'),
              color: '#fff',
              fontWeight: 600,
            }}
          >
            {brandTexts.sampleButton}
          </Box>
        </Box>
      </Box>
      {hasSections && (
        <Box component="section" aria-label={brandTexts.tone}>
          <ArtifactDocument
            artifact={artifact}
            presence={props.presence}
            onChanged={onChanged}
            onAccessLost={props.onAccessLost}
            onEditing={props.onEditing}
          />
        </Box>
      )}
    </Box>
  )
}
