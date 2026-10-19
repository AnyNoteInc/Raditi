'use client'

import Box from '@mui/material/Box'
import MenuItem from '@mui/material/MenuItem'
import TextField, { type TextFieldProps } from '@mui/material/TextField'
import type { ConnectionTls } from '@repo/domain'
import type { ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'

// The pieces both access forms share: a field of a technical value and the choice of how a
// connection is protected.

/**
 * A field the browser must neither fill in nor remember: an address, a user, a folder of the
 * client's server. A password field asks for `new-password`, which keeps the browser from
 * offering the cabinet's own password. MUI ties the helper text to the input
 * (`aria-describedby`) and marks an error (`aria-invalid`) when the field has an id.
 */
export function AccessField({
  id,
  secret = false,
  code = false,
  error,
  helperText,
  slotProps,
  ...props
}: Omit<TextFieldProps, 'id' | 'error'> & {
  id: string
  /** A password, a key or its phrase. */
  secret?: boolean
  /** An address, a port, a folder: no capitals, no spelling, no translation. */
  code?: boolean
  error?: string
}) {
  return (
    <TextField
      id={id}
      fullWidth
      autoComplete={secret ? 'new-password' : 'off'}
      error={error !== undefined}
      helperText={error ?? helperText}
      slotProps={{
        ...slotProps,
        htmlInput: {
          spellCheck: false,
          autoCapitalize: 'none',
          autoCorrect: 'off',
          ...(code || secret ? { translate: 'no' } : {}),
          ...(slotProps?.htmlInput as object | undefined),
        },
      }}
      {...props}
    />
  )
}

/** The port: digits only, a narrow box. */
export function PortField(props: Omit<Parameters<typeof AccessField>[0], 'label'>) {
  return (
    <AccessField
      label="Порт"
      code
      required
      {...props}
      slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 5 } }}
    />
  )
}

const tlsWords = {
  file: { verified: 'FTPS с проверкой сертификата', unverified: 'FTPS без проверки сертификата' },
  database: { verified: 'TLS с проверкой сертификата', unverified: 'TLS без проверки сертификата' },
} as const

/** Why a weaker protection is weaker; the strongest one is the default and needs no word. */
const tlsWarnings: Record<Exclude<ConnectionTls, 'verified'>, string> = {
  unverified:
    'Соединение зашифровано, но мы не сможем убедиться, что подключились именно к вашему серверу. Выбирайте, только если хостинг не выдаёт сертификат для этого адреса.',
  plain:
    'Пароль и данные будут передаваться открыто. Выбирайте, только если хостинг не поддерживает шифрование.',
}

/** A calm note: an icon and a sentence, not an alarm. */
function Caution({ children }: { children: ReactNode }) {
  return (
    <Box component="span" sx={{ display: 'flex', gap: 0.75, alignItems: 'flex-start' }}>
      <Box component="span" sx={{ color: 'warning.main', display: 'flex', mt: '1px' }}>
        <AppIcon name="warning" size={16} />
      </Box>
      <span>{children}</span>
    </Box>
  )
}

/**
 * «Защита соединения»: the verified mode first and by default, the two weaker ones only by an
 * explicit choice, each with what it gives up said under the field.
 */
export function TlsField({
  id,
  of,
  value,
  onChange,
  disabled,
}: {
  id: string
  of: 'file' | 'database'
  value: ConnectionTls
  onChange: (value: ConnectionTls) => void
  disabled: boolean
}) {
  const words = tlsWords[of]
  return (
    <TextField
      id={id}
      select
      fullWidth
      label="Защита соединения"
      value={value}
      onChange={(event) => onChange(event.target.value as ConnectionTls)}
      disabled={disabled}
      helperText={
        value === 'verified' ? (
          'Рекомендуем: данные зашифрованы, а сервер подтверждает свой адрес.'
        ) : (
          <Caution>{tlsWarnings[value]}</Caution>
        )
      }
    >
      <MenuItem value="verified">{words.verified}</MenuItem>
      <MenuItem value="unverified">{words.unverified}</MenuItem>
      <MenuItem value="plain">Без шифрования</MenuItem>
    </TextField>
  )
}
