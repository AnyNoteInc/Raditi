'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import Link from '@mui/material/Link'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useThemePreference } from '@repo/ui/providers'
import { brandColors } from '@repo/ui/theme/tokens'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useTRPC } from '@/trpc/client'

const MARKETING_SLUG = 'marketing-consent'
const themeOptions = [
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
  { value: 'system', label: 'Системная' },
] as const
/** «Системная» is 70px wide at the phone size of the label; the card's border adds 4px. */
const THEME_CARD_MIN_WIDTH = 76

function ThemePreview({ mode }: { mode: (typeof themeOptions)[number]['value'] }) {
  const schemes = mode === 'system' ? (['light', 'dark'] as const) : [mode]

  return (
    <Box
      aria-hidden="true"
      sx={{ position: 'relative', height: { xs: 72, sm: 100 }, overflow: 'hidden' }}
    >
      {schemes.map((scheme, index) => {
        const dark = scheme === 'dark'
        return (
          <Box
            key={scheme}
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              bgcolor: dark ? brandColors.ink : brandColors.paper,
              ...(index === 1 ? { clipPath: 'inset(0 0 0 50%)' } : {}),
            }}
          >
            <Box
              sx={{
                width: { xs: 16, sm: 24 },
                flexShrink: 0,
                bgcolor: dark ? brandColors.ink2 : brandColors.card,
                borderRight: 1,
                borderColor: dark ? brandColors.ruleInk : brandColors.rule,
              }}
            />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Box
                sx={{
                  height: { xs: 12, sm: 18 },
                  borderBottom: 1,
                  borderColor: dark ? brandColors.ruleInk : brandColors.rule,
                  bgcolor: dark ? brandColors.ink2 : brandColors.card,
                }}
              />
              <Stack spacing={0.75} sx={{ p: { xs: 1, sm: 1.5 } }}>
                <Box
                  sx={{
                    width: '48%',
                    height: 5,
                    mb: 0.5,
                    borderRadius: '2px', // impeccable-disable-line design-system-radius: miniature preview graphic
                    bgcolor: dark ? brandColors.snow : brandColors.ink,
                  }}
                />
                <Box
                  sx={{
                    width: '80%',
                    height: 4,
                    borderRadius: '2px', // impeccable-disable-line design-system-radius: miniature preview graphic
                    bgcolor: dark ? brandColors.ruleInk : brandColors.rule,
                  }}
                />
                <Box
                  sx={{
                    width: '62%',
                    height: 4,
                    borderRadius: '2px', // impeccable-disable-line design-system-radius: miniature preview graphic
                    bgcolor: dark ? brandColors.ruleInk : brandColors.rule,
                  }}
                />
              </Stack>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

export function SettingsPanel({ email }: { email: string }) {
  const { preference, setPreference } = useThemePreference()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const listOptions = trpc.consent.list.queryOptions()
  const consents = useQuery(listOptions)
  const marketing = consents.data?.find((consent) => consent.slug === MARKETING_SLUG)

  const saveMarketing = useMutation(
    trpc.consent.setMarketing.mutationOptions({
      onMutate: async () => {
        await queryClient.cancelQueries({ queryKey: listOptions.queryKey })
      },
      onSuccess: (_result, { granted }) => {
        queryClient.setQueryData(listOptions.queryKey, (previous) =>
          previous?.map((consent) =>
            consent.slug === MARKETING_SLUG
              ? {
                  ...consent,
                  accepted: granted,
                  acceptedVersion: granted ? consent.version : null,
                }
              : consent,
          ),
        )
        void queryClient.invalidateQueries({ queryKey: listOptions.queryKey })
      },
    }),
  )

  return (
    <Stack
      divider={<Divider />}
      sx={{
        mt: 4,
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        borderRadius: '14px',
      }}
    >
      <FormControl
        component="fieldset"
        sx={{ display: 'block', minWidth: 0, m: 0, p: { xs: 2.5, sm: 4 }, border: 0 }}
      >
        <Box>
          <Typography id="theme-label" component="h2" sx={{ fontWeight: 600, fontSize: 17 }}>
            Тема оформления
          </Typography>
          <Typography
            id="theme-description"
            color="text.secondary"
            variant="body2"
            sx={{ mt: 0.5 }}
          >
            Системная тема подстраивается под устройство.
          </Typography>
        </Box>
        <RadioGroup
          name="theme-preference"
          aria-labelledby="theme-label"
          aria-describedby="theme-description"
          value={preference}
          onChange={(_event, next) => {
            if (next === 'light' || next === 'dark' || next === 'system') setPreference(next)
          }}
          sx={{
            display: 'grid',
            // Three equal cards while each keeps the width of the longest label, «Системная»;
            // in a narrower column the last card wraps instead of clipping its label.
            gridTemplateColumns: `repeat(auto-fit, minmax(${THEME_CARD_MIN_WIDTH}px, 1fr))`,
            gap: { xs: 1, sm: 2 },
            mt: 3,
          }}
        >
          {themeOptions.map(({ value, label }) => (
            <Box
              component="label"
              key={value}
              sx={{
                minWidth: 0,
                overflow: 'hidden',
                border: '2px solid',
                borderColor: preference === value ? 'primary.main' : 'divider',
                borderRadius: '12px',
                cursor: 'pointer',
                '&:hover': { borderColor: 'primary.main' },
                '&:has(.Mui-focusVisible)': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: 3,
                },
              }}
            >
              <ThemePreview mode={value} />
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                sx={{
                  minHeight: { xs: 68, sm: 48 },
                  px: 0.5,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Radio value={value} size="small" sx={{ p: { xs: 0.5, sm: 0.75 } }} />
                <Typography component="span" sx={{ fontSize: { xs: 13, sm: 14 }, fontWeight: 500 }}>
                  {label}
                </Typography>
              </Stack>
            </Box>
          ))}
        </RadioGroup>
      </FormControl>

      <Box sx={{ p: { xs: 2.5, sm: 4 } }}>
        <Stack
          direction="row"
          spacing={2}
          sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}
        >
          <Box sx={{ maxWidth: 520 }}>
            <Typography id="marketing-label" component="h2" sx={{ fontWeight: 600, fontSize: 17 }}>
              Новости и предложения
            </Typography>
            <Typography
              id="marketing-description"
              color="text.secondary"
              variant="body2"
              sx={{ mt: 0.5 }}
            >
              Письма о новых возможностях и специальных предложениях Радити. Можно отключить в любой
              момент.
            </Typography>
            <Link
              href="/terms/marketing-consent"
              variant="body2"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: 44,
                mt: 0.5,
                textUnderlineOffset: '3px',
              }}
            >
              Согласие на рассылку
            </Link>
          </Box>
          {consents.isPending ? (
            <Skeleton variant="rounded" width={42} height={24} sx={{ mt: 1, flexShrink: 0 }} />
          ) : (
            <Switch
              checked={marketing?.accepted ?? false}
              disabled={saveMarketing.isPending || consents.isError || !marketing}
              onChange={(_event, granted) => saveMarketing.mutate({ granted })}
              slotProps={{
                input: {
                  'aria-labelledby': 'marketing-label',
                  'aria-describedby': 'marketing-description',
                },
              }}
              sx={{
                mt: -0.5,
                mr: -1,
                flexShrink: 0,
                height: 44,
                py: '15px',
                '& .MuiSwitch-switchBase': { top: 3 },
              }}
            />
          )}
        </Stack>
        <Box role="status" aria-live="polite">
          {consents.isPending ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              Загружаем настройки рассылки…
            </Typography>
          ) : saveMarketing.isPending ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              Сохраняем…
            </Typography>
          ) : saveMarketing.isSuccess ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              {saveMarketing.variables.granted ? 'Рассылка включена.' : 'Рассылка отключена.'}
            </Typography>
          ) : null}
        </Box>
        {consents.isError || (!consents.isPending && !marketing) ? (
          <Alert
            severity="error"
            sx={{ mt: 2 }}
            action={
              <Button
                color="inherit"
                size="small"
                loading={consents.isFetching}
                onClick={() => void consents.refetch()}
              >
                Повторить
              </Button>
            }
          >
            Не удалось загрузить настройку рассылки.
          </Alert>
        ) : null}
        {saveMarketing.isError ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            Не удалось сохранить настройку. Попробуйте переключить её ещё раз.
          </Alert>
        ) : null}
      </Box>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{
          p: { xs: 2.5, sm: 4 },
          justifyContent: 'space-between',
          alignItems: { sm: 'center' },
        }}
      >
        <Box sx={{ flexShrink: 0 }}>
          <Typography component="h2" sx={{ fontWeight: 600, fontSize: 17 }}>
            Электронная почта
          </Typography>
          <Typography color="text.secondary" variant="body2" sx={{ mt: 0.5 }}>
            Адрес для входа в аккаунт.
          </Typography>
        </Box>
        <Typography sx={{ overflowWrap: 'anywhere', textAlign: { sm: 'right' } }}>
          {email}
        </Typography>
      </Stack>
    </Stack>
  )
}
