'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import FormControlLabel from '@mui/material/FormControlLabel'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import {
  artifactSettingIsColor,
  artifactSettingsFields,
  type ArtifactSettingValue,
} from '@repo/domain/artifacts'
import { useMutation } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC } from '@/trpc/client'

import type { CabinetArtifact } from '../use-artifact'
import { frameTexts } from './frame-texts'

type Block = CabinetArtifact['blocks'][number]

/**
 * «Настройки» of a canvas (Ар9, АТ6): the numbers, texts, colours and switches of its `settings` block,
 * which its script reads from `#raditi-settings`. Only the scalars of the top level are a form; the
 * rest of the JSON stays as it is. Saved as a `replace` of the block under the revision read.
 */
export function FrameSettings({
  artifact,
  block,
  canEdit,
  onChanged,
}: {
  artifact: CabinetArtifact
  block: Block
  canEdit: boolean
  onChanged: () => void
}) {
  const trpc = useTRPC()
  const write = useMutation(trpc.artifact.write.mutationOptions())
  const fields = useMemo(() => artifactSettingsFields(block.content ?? '{}') ?? [], [block.content])
  const [draft, setDraft] = useState<Record<string, string | boolean>>({})
  const [outcome, setOutcome] = useState<'saved' | 'failed' | 'secret' | null>(null)
  const valueOf = (key: string, value: ArtifactSettingValue) =>
    key in draft ? draft[key]! : typeof value === 'boolean' ? value : String(value)
  const invalid = fields.some(
    (field) =>
      typeof field.value === 'number' &&
      field.key in draft &&
      !Number.isFinite(Number(String(draft[field.key]).replace(',', '.'))),
  )

  async function save() {
    let current: Record<string, unknown>
    try {
      current = JSON.parse(block.content ?? '{}') as Record<string, unknown>
    } catch {
      current = {}
    }
    for (const field of fields) {
      if (!(field.key in draft)) continue
      const value = draft[field.key]!
      current[field.key] =
        typeof field.value === 'number' ? Number(String(value).replace(',', '.')) : value
    }
    try {
      await write.mutateAsync({
        batch: {
          artifactId: artifact.id,
          opId: uuidv7(),
          ops: [
            {
              op: 'replace',
              block: block.key,
              ifRev: block.rev,
              content: JSON.stringify(current, null, 2),
            },
          ],
        },
      })
      setDraft({})
      setOutcome('saved')
      onChanged()
    } catch (error) {
      const code = (error as { data?: { domainCode?: string } } | null)?.data?.domainCode
      setOutcome(code === 'ARTIFACT_SECRET_SHAPE' ? 'secret' : 'failed')
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box>
        <Typography component="h2" sx={{ fontSize: 16, fontWeight: 650 }}>
          {frameTexts.settings}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {frameTexts.settingsHint}
        </Typography>
      </Box>
      {fields.map((field) => {
        const value = valueOf(field.key, field.value)
        if (typeof field.value === 'boolean')
          return (
            <FormControlLabel
              key={field.key}
              control={
                <Switch
                  checked={value === true}
                  disabled={!canEdit}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.checked })}
                />
              }
              label={field.key}
            />
          )
        const color = artifactSettingIsColor(field.value)
        const number = typeof field.value === 'number'
        const bad = number && !Number.isFinite(Number(String(value).replace(',', '.')))
        return (
          <TextField
            key={field.key}
            size="small"
            label={field.key}
            value={value}
            disabled={!canEdit}
            error={bad}
            helperText={bad ? frameTexts.settingsNotNumber : undefined}
            slotProps={{
              htmlInput: {
                ...(number ? { inputMode: 'decimal' } : {}),
                ...(color ? { type: 'color' } : {}),
              },
            }}
            onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
          />
        )
      })}
      {fields.length === 0 && (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {frameTexts.settingsOther}
        </Typography>
      )}
      {canEdit && fields.length > 0 && (
        <Button
          variant="contained"
          disabled={Object.keys(draft).length === 0 || invalid || write.isPending}
          onClick={() => void save()}
        >
          {frameTexts.settingsSave}
        </Button>
      )}
      {outcome === 'saved' && <Alert severity="success">{frameTexts.settingsSaved}</Alert>}
      {outcome === 'failed' && <Alert severity="error">{frameTexts.settingsFailed}</Alert>}
      {outcome === 'secret' && <Alert severity="error">{frameTexts.secretShape}</Alert>}
    </Box>
  )
}
