'use client'

import Box from '@mui/material/Box'
import FormControl from '@mui/material/FormControl'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Typography from '@mui/material/Typography'

import { AccessField, PortField, TlsField } from './fields'
import {
  chooseDatabase,
  type DatabaseChoice,
  type DatabaseDraft,
  type DatabaseField,
  type FieldErrors,
} from './wizard-model'

const choices: readonly { value: DatabaseChoice; label: string; note: string }[] = [
  { value: 'none', label: 'Без базы данных', note: 'Проект добавится без неё' },
  { value: 'postgres', label: 'PostgreSQL', note: 'Порт обычно 5432' },
  { value: 'mysql', label: 'MySQL', note: 'Порт обычно 3306' },
]

export const databaseFieldId = (prefix: string, field: DatabaseField) => `${prefix}-${field}`

/**
 * «База данных»: none by default; the fields appear only for a chosen provider. `required` — the
 * database of a working site changes its access: «Без базы данных» is not offered.
 */
export function DatabaseFields({
  idPrefix,
  value,
  onChange,
  errors,
  disabled,
  required = false,
}: {
  idPrefix: string
  value: DatabaseDraft
  onChange: (next: DatabaseDraft) => void
  errors: FieldErrors<DatabaseField>
  disabled: boolean
  required?: boolean
}) {
  const id = (field: DatabaseField) => databaseFieldId(idPrefix, field)
  const set = (patch: Partial<DatabaseDraft>) => onChange({ ...value, ...patch })
  const labelId = `${idPrefix}-engine-label`

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      <FormControl component="fieldset" disabled={disabled} sx={{ m: 0, minWidth: 0 }}>
        <Typography id={labelId} component="legend" sx={{ fontSize: 14, fontWeight: 500, mb: 1 }}>
          База данных сайта
        </Typography>
        <RadioGroup
          name={`${idPrefix}-engine`}
          aria-labelledby={labelId}
          value={value.engine}
          onChange={(_event, engine) => onChange(chooseDatabase(value, engine as DatabaseChoice))}
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))',
            gap: 1.25,
          }}
        >
          {(required ? choices.filter((choice) => choice.value !== 'none') : choices).map(
            (choice) => {
              const selected = value.engine === choice.value
              return (
                <Box
                  component="label"
                  key={choice.value}
                  sx={{
                    minWidth: 0,
                    minHeight: 64,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5,
                    pr: 1.5,
                    border: '2px solid',
                    borderColor: selected ? 'primary.main' : 'divider',
                    borderRadius: '12px',
                    cursor: disabled ? 'default' : 'pointer',
                    '&:hover': disabled ? undefined : { borderColor: 'primary.main' },
                    '&:has(.Mui-focusVisible)': {
                      outline: '2px solid',
                      outlineColor: 'primary.main',
                      outlineOffset: 3,
                    },
                  }}
                >
                  <Radio value={choice.value} />
                  <Box sx={{ minWidth: 0, py: 1 }}>
                    <Typography component="span" sx={{ display: 'block', fontWeight: 600 }}>
                      {choice.label}
                    </Typography>
                    <Typography component="span" variant="caption" color="text.secondary">
                      {choice.note}
                    </Typography>
                  </Box>
                </Box>
              )
            },
          )}
        </RadioGroup>
      </FormControl>

      {value.engine === 'none' ? null : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) 132px' },
              gap: 2.5,
            }}
          >
            <AccessField
              id={id('host')}
              label="Сервер"
              code
              required
              value={value.host}
              onChange={(event) => set({ host: event.target.value })}
              disabled={disabled}
              error={errors.host}
              helperText="Адрес сервера базы данных из панели хостинга"
              slotProps={{ htmlInput: { maxLength: 253, inputMode: 'url' } }}
            />
            <PortField
              id={id('port')}
              value={value.port}
              onChange={(event) => set({ port: event.target.value, portTouched: true })}
              disabled={disabled}
              error={errors.port}
            />
          </Box>
          <AccessField
            id={id('database')}
            label="Имя базы"
            code
            required
            value={value.database}
            onChange={(event) => set({ database: event.target.value })}
            disabled={disabled}
            error={errors.database}
            slotProps={{ htmlInput: { maxLength: 64 } }}
          />
          <AccessField
            id={id('username')}
            label="Пользователь"
            code
            required
            value={value.username}
            onChange={(event) => set({ username: event.target.value })}
            disabled={disabled}
            error={errors.username}
            helperText="Пользователь базы данных из панели хостинга"
            slotProps={{ htmlInput: { maxLength: 128 } }}
          />
          <AccessField
            id={id('password')}
            label="Пароль"
            secret
            required
            type="password"
            value={value.password}
            onChange={(event) => set({ password: event.target.value })}
            disabled={disabled}
            error={errors.password}
            helperText="Мы сохраним пароль в защищённом хранилище и больше не покажем."
          />
          <TlsField
            id={`${idPrefix}-tls`}
            of="database"
            value={value.tls}
            onChange={(tls) => set({ tls })}
            disabled={disabled}
          />
        </Box>
      )}
    </Box>
  )
}
