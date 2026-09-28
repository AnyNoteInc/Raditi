'use client'

import { useState, type ReactNode } from 'react'
import { useController, type Control, type FieldPath, type FieldValues } from 'react-hook-form'

import {
  IconButton,
  InputAdornment,
  TextField,
  VisibilityIcon,
  VisibilityOffIcon,
} from '../../components/index.ts'

type FormTextFieldProps<TInput extends FieldValues, TOutput> = {
  control: Control<TInput, unknown, TOutput>
  name: FieldPath<TInput>
  label: string
  type?: 'text' | 'email' | 'password'
  autoComplete: string
  helperText?: ReactNode
  disabled?: boolean
}

/** MUI TextField bound to react-hook-form; password fields get a show/hide button. */
export function FormTextField<TInput extends FieldValues, TOutput>({
  control,
  name,
  label,
  type = 'text',
  autoComplete,
  helperText,
  disabled,
}: FormTextFieldProps<TInput, TOutput>) {
  const { field, fieldState } = useController({ control, name })
  const [revealed, setRevealed] = useState(false)
  const isPassword = type === 'password'

  const revealButton = isPassword ? (
    <InputAdornment position="end">
      <IconButton
        edge="end"
        aria-label={revealed ? 'Скрыть пароль' : 'Показать пароль'}
        onClick={() => setRevealed((value) => !value)}
        onMouseDown={(event) => event.preventDefault()}
        disabled={disabled}
      >
        {revealed ? <VisibilityOffIcon /> : <VisibilityIcon />}
      </IconButton>
    </InputAdornment>
  ) : null

  return (
    <TextField
      name={field.name}
      value={field.value ?? ''}
      onChange={field.onChange}
      onBlur={field.onBlur}
      inputRef={field.ref}
      label={label}
      type={isPassword && revealed ? 'text' : type}
      autoComplete={autoComplete}
      disabled={disabled}
      fullWidth
      error={Boolean(fieldState.error)}
      helperText={fieldState.error?.message ?? helperText}
      slotProps={{
        input: revealButton ? { endAdornment: revealButton } : undefined,
        htmlInput:
          type === 'email'
            ? { inputMode: 'email', autoCapitalize: 'none', spellCheck: false }
            : undefined,
      }}
    />
  )
}
