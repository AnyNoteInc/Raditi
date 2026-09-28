'use client'

import { useId, type ReactNode, type Ref } from 'react'

import {
  Checkbox,
  FormControl,
  FormControlLabel,
  FormHelperText,
  Link,
  Stack,
  Typography,
} from '../../components/index.ts'

/** Links to the legal documents: the four required ones plus the marketing consent. */
export type ConsentDocumentLinks = {
  userAgreement: string
  publicOffer: string
  privacyPolicy: string
  /** The separate consent to personal data processing. */
  piiProcessing: string
  marketing: string
}

export type ConsentsCheckboxesProps = {
  documents: ConsentDocumentLinks
  /** Required: user agreement, public offer and acknowledgement of the privacy policy. */
  acceptTerms: boolean
  onAcceptTermsChange: (accepted: boolean) => void
  acceptTermsError?: string
  /** Lets react-hook-form focus the checkbox when it is invalid. */
  acceptTermsInputRef?: Ref<HTMLInputElement>
  /** Required, given apart from the other documents (152-FZ): personal data processing. */
  acceptPersonalData: boolean
  onAcceptPersonalDataChange: (accepted: boolean) => void
  acceptPersonalDataError?: string
  acceptPersonalDataInputRef?: Ref<HTMLInputElement>
  /** Optional: informational and promotional mailings. */
  marketing: boolean
  onMarketingChange: (accepted: boolean) => void
  disabled?: boolean
}

function DocumentLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </Link>
  )
}

type ConsentCheckboxProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  required?: boolean
  error?: string
  inputRef?: Ref<HTMLInputElement>
  disabled?: boolean
}

/** One checkbox with its own label, error message and aria wiring. */
function ConsentCheckbox({
  checked,
  onChange,
  label,
  required,
  error,
  inputRef,
  disabled,
}: ConsentCheckboxProps) {
  const errorId = useId()

  return (
    <FormControl error={Boolean(error)}>
      <FormControlLabel
        sx={{ alignItems: 'flex-start', mx: 0, gap: 1 }}
        disabled={disabled}
        control={
          <Checkbox
            checked={checked}
            onChange={(_event, value) => onChange(value)}
            sx={{ p: 0.25, mt: -0.25 }}
            slotProps={{
              input: {
                ref: inputRef,
                required,
                'aria-invalid': error ? true : undefined,
                'aria-describedby': error ? errorId : undefined,
              },
            }}
          />
        }
        label={label}
      />
      {error ? (
        <FormHelperText id={errorId} sx={{ mx: 0 }}>
          {error}
        </FormHelperText>
      ) : null}
    </FormControl>
  )
}

/**
 * Sign-up consents as three separate checkboxes: the terms (required), the consent to
 * personal data processing (required, on its own as 152-FZ demands since 1 September 2025)
 * and mailings (optional).
 */
export function ConsentsCheckboxes({
  documents,
  acceptTerms,
  onAcceptTermsChange,
  acceptTermsError,
  acceptTermsInputRef,
  acceptPersonalData,
  onAcceptPersonalDataChange,
  acceptPersonalDataError,
  acceptPersonalDataInputRef,
  marketing,
  onMarketingChange,
  disabled,
}: ConsentsCheckboxesProps) {
  return (
    <Stack spacing={2}>
      <ConsentCheckbox
        checked={acceptTerms}
        onChange={onAcceptTermsChange}
        required
        error={acceptTermsError}
        inputRef={acceptTermsInputRef}
        disabled={disabled}
        label={
          <Typography variant="body2">
            Я принимаю{' '}
            <DocumentLink href={documents.userAgreement}>Пользовательское соглашение</DocumentLink>{' '}
            и <DocumentLink href={documents.publicOffer}>Публичную оферту</DocumentLink> и
            ознакомлен(а) с{' '}
            <DocumentLink href={documents.privacyPolicy}>
              Политикой обработки персональных данных
            </DocumentLink>
          </Typography>
        }
      />
      <ConsentCheckbox
        checked={acceptPersonalData}
        onChange={onAcceptPersonalDataChange}
        required
        error={acceptPersonalDataError}
        inputRef={acceptPersonalDataInputRef}
        disabled={disabled}
        label={
          <Typography variant="body2">
            Я даю{' '}
            <DocumentLink href={documents.piiProcessing}>
              согласие на обработку персональных данных
            </DocumentLink>
          </Typography>
        }
      />
      <ConsentCheckbox
        checked={marketing}
        onChange={onMarketingChange}
        disabled={disabled}
        label={
          <Typography variant="body2" color="text.secondary">
            Я согласен(на) получать{' '}
            <DocumentLink href={documents.marketing}>
              информационные и рекламные рассылки
            </DocumentLink>
          </Typography>
        }
      />
    </Stack>
  )
}
