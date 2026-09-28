'use client'

import { AuthHeader, ConsentsCheckboxes, type ConsentDocumentLinks } from '@repo/ui/widgets/auth'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'

import { useTRPC } from '@/trpc/client'

const TERMS_REQUIRED = 'Чтобы продолжить, примите условия'
const PERSONAL_DATA_REQUIRED = 'Нужно дать согласие на обработку персональных данных'
const SAVE_FAILED = 'Не получилось сохранить согласие. Попробуйте ещё раз немного позже.'

export function ConsentsForm({ documents }: { documents: ConsentDocumentLinks }) {
  const router = useRouter()
  const trpc = useTRPC()
  const [acceptTerms, setAcceptTerms] = useState(false)
  const [acceptPersonalData, setAcceptPersonalData] = useState(false)
  const [marketing, setMarketing] = useState(false)
  const [showErrors, setShowErrors] = useState(false)

  const accept = useMutation(
    trpc.consent.acceptRequired.mutationOptions({
      onSuccess: () => {
        router.replace('/app')
        router.refresh()
      },
    }),
  )

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!acceptTerms || !acceptPersonalData) {
      setShowErrors(true)
      return
    }
    // Two separate required consents (152-FZ); the server checks both again.
    accept.mutate({ acceptTerms: true, acceptPersonalData: true, marketing })
  }

  const busy = accept.isPending || accept.isSuccess

  return (
    <Stack component="form" noValidate spacing={3} onSubmit={submit}>
      <AuthHeader
        title="Примите условия"
        subtitle="Чтобы пользоваться кабинетом, нужно согласие с действующими редакциями документов."
      />
      <ConsentsCheckboxes
        documents={documents}
        acceptTerms={acceptTerms}
        onAcceptTermsChange={setAcceptTerms}
        acceptTermsError={showErrors && !acceptTerms ? TERMS_REQUIRED : undefined}
        acceptPersonalData={acceptPersonalData}
        onAcceptPersonalDataChange={setAcceptPersonalData}
        acceptPersonalDataError={
          showErrors && !acceptPersonalData ? PERSONAL_DATA_REQUIRED : undefined
        }
        marketing={marketing}
        onMarketingChange={setMarketing}
        disabled={busy}
      />
      {accept.isError ? <Alert severity="error">{SAVE_FAILED}</Alert> : null}
      <Button
        type="submit"
        variant="contained"
        size="large"
        fullWidth
        disabled={!acceptTerms || !acceptPersonalData}
        loading={busy}
      >
        Продолжить
      </Button>
    </Stack>
  )
}
