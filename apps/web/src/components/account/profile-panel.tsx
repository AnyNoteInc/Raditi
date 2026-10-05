'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import {
  NO_CONTROL_CHARACTERS,
  profileLastNameSchema,
  profileNameSchema,
} from '@repo/auth/profile-schema'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { z } from 'zod'

import { UserAvatar, type ApplicationUser } from '@/components/application/user-avatar'
import { useTRPC } from '@/trpc/client'
import { redirectToConsents } from '@/trpc/consent-redirect'

const MAX_PHOTO_BYTES = 5 * 1024 * 1024
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const avatarResponse = z.object({ image: z.string().startsWith('/api/profile/avatar/').nullable() })
const avatarErrorResponse = z.object({ message: z.string() })

export function ProfilePanel({ user }: { user: ApplicationUser }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const photoInputId = useId()
  const photoInput = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(user.name)
  const [lastName, setLastName] = useState(user.lastName ?? '')
  const [savedName, setSavedName] = useState(user.name)
  const [savedLastName, setSavedLastName] = useState(user.lastName ?? '')
  const [image, setImage] = useState(user.image ?? null)
  const [selectedPhoto, setSelectedPhoto] = useState<{ file: File; url: string } | null>(null)
  const [photoPending, setPhotoPending] = useState(false)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [photoNotice, setPhotoNotice] = useState<string | null>(null)
  const [profileNotice, setProfileNotice] = useState<string | null>(null)
  const meOptions = trpc.user.me.queryOptions()

  useEffect(() => {
    if (!selectedPhoto) return
    return () => URL.revokeObjectURL(selectedPhoto.url)
  }, [selectedPhoto])

  const refreshUser = (changes: Partial<ApplicationUser>) => {
    queryClient.setQueryData(meOptions.queryKey, (previous) =>
      previous ? { ...previous, ...changes } : previous,
    )
    void queryClient.invalidateQueries({ queryKey: meOptions.queryKey })
    router.refresh()
  }

  const saveProfile = useMutation(
    trpc.user.updateProfile.mutationOptions({
      onSuccess: (updated) => {
        setName(updated.name)
        setLastName(updated.lastName ?? '')
        setSavedName(updated.name)
        setSavedLastName(updated.lastName ?? '')
        setProfileNotice('Имя и фамилия сохранены.')
        refreshUser(updated)
      },
    }),
  )
  const busy = photoPending || saveProfile.isPending
  // The schemas user.updateProfile applies on the server; the pattern only picks the hint
  // about control characters (tab, line break inside, U+0000).
  const nameClean = NO_CONTROL_CHARACTERS.test(name.trim())
  const lastNameClean = NO_CONTROL_CHARACTERS.test(lastName.trim())
  const nameValid = profileNameSchema.safeParse(name).success
  const lastNameValid = profileLastNameSchema.safeParse(lastName).success
  const changed = name.trim() !== savedName || lastName.trim() !== savedLastName

  const choosePhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setPhotoError(null)
    setPhotoNotice(null)
    if (!PHOTO_TYPES.includes(file.type)) {
      setPhotoError('Выберите фото в формате JPG, PNG или WebP.')
      return
    }
    if (file.size === 0 || file.size > MAX_PHOTO_BYTES) {
      setPhotoError('Размер фото должен быть от 1 байта до 5 МБ.')
      return
    }
    setSelectedPhoto({ file, url: URL.createObjectURL(file) })
  }

  const changeAvatar = async (method: 'POST' | 'DELETE') => {
    if (busy || (method === 'POST' && !selectedPhoto)) return
    setPhotoPending(true)
    setPhotoError(null)
    setPhotoNotice(null)
    try {
      const form = new FormData()
      if (selectedPhoto) form.set('file', selectedPhoto.file)
      const response = await fetch('/api/profile/avatar', {
        method,
        credentials: 'same-origin',
        ...(method === 'POST' ? { body: form } : {}),
        signal: AbortSignal.timeout(30_000),
      })
      const body: unknown = await response.json()
      if (!response.ok) {
        // The documents changed while this page was open: accept them first, as with tRPC calls.
        if (response.status === 428) redirectToConsents()
        const error = avatarErrorResponse.safeParse(body)
        throw new Error(error.success ? error.data.message : 'Не удалось сохранить фото.')
      }
      const result = avatarResponse.parse(body)
      setImage(result.image)
      setSelectedPhoto(null)
      setPhotoNotice(method === 'POST' ? 'Фото профиля сохранено.' : 'Фото профиля удалено.')
      refreshUser({ image: result.image })
    } catch (error) {
      setPhotoError(
        error instanceof Error && error.name === 'Error'
          ? error.message
          : 'Не удалось сохранить фото. Попробуйте ещё раз.',
      )
    } finally {
      setPhotoPending(false)
    }
  }

  const submitProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || !changed || !nameValid || !lastNameValid) return
    setProfileNotice(null)
    saveProfile.mutate({ name: name.trim(), lastName: lastName.trim() })
  }

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
      <Box sx={{ p: { xs: 2.5, sm: 4 } }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={3}
          sx={{ alignItems: { xs: 'flex-start', sm: 'center' } }}
        >
          <Box sx={{ position: 'relative', flexShrink: 0 }}>
            <UserAvatar
              user={{ name, lastName, email: user.email, image: selectedPhoto?.url ?? image }}
              size={104}
            />
            {photoPending && (
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  display: 'grid',
                  placeItems: 'center',
                  bgcolor: 'background.paper',
                  opacity: 0.8,
                  borderRadius: '50%',
                }}
              >
                <CircularProgress size={30} aria-label="Сохранение фото" />
              </Box>
            )}
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography component="h2" sx={{ fontSize: 17, fontWeight: 600 }}>
              Фото профиля
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              JPG, PNG или WebP, до 5 МБ.
            </Typography>
            <input
              ref={photoInput}
              id={photoInputId}
              type="file"
              accept={PHOTO_TYPES.join(',')}
              aria-label="Выбрать фото профиля"
              disabled={busy}
              onChange={choosePhoto}
              hidden
            />
            <Stack direction="row" useFlexGap spacing={1} sx={{ mt: 2, flexWrap: 'wrap' }}>
              <Button
                variant="outlined"
                disabled={busy}
                onClick={() => photoInput.current?.click()}
              >
                {image ? 'Заменить фото' : 'Выбрать фото'}
              </Button>
              {selectedPhoto ? (
                <>
                  <Button
                    variant="contained"
                    disabled={busy}
                    onClick={() => void changeAvatar('POST')}
                  >
                    {photoPending ? 'Сохраняем…' : 'Сохранить фото'}
                  </Button>
                  <Button
                    color="inherit"
                    disabled={busy}
                    onClick={() => {
                      setSelectedPhoto(null)
                      setPhotoError(null)
                    }}
                  >
                    Отмена
                  </Button>
                </>
              ) : image ? (
                <Button color="inherit" disabled={busy} onClick={() => void changeAvatar('DELETE')}>
                  Удалить фото
                </Button>
              ) : null}
            </Stack>
            {selectedPhoto && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                Предпросмотр. Фото ещё не сохранено.
              </Typography>
            )}
          </Box>
        </Stack>
        {photoError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {photoError}
          </Alert>
        )}
        {photoNotice && (
          <Alert severity="success" role="status" sx={{ mt: 2 }}>
            {photoNotice}
          </Alert>
        )}
      </Box>
      <Box component="form" onSubmit={submitProfile} sx={{ p: { xs: 2.5, sm: 4 } }}>
        <Typography component="h2" sx={{ fontSize: 17, fontWeight: 600, mb: 2.5 }}>
          Личные данные
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
          <TextField
            label="Имя"
            name="name"
            autoComplete="given-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setProfileNotice(null)
              saveProfile.reset()
            }}
            disabled={busy}
            required
            error={!nameValid}
            helperText={
              !nameClean
                ? 'Уберите из имени табуляцию и другие служебные знаки.'
                : !nameValid
                  ? 'Укажите имя, не длиннее 255 символов.'
                  : undefined
            }
            slotProps={{ htmlInput: { maxLength: 255 } }}
            fullWidth
          />
          <TextField
            label="Фамилия"
            name="lastName"
            autoComplete="family-name"
            value={lastName}
            onChange={(event) => {
              setLastName(event.target.value)
              setProfileNotice(null)
              saveProfile.reset()
            }}
            disabled={busy}
            error={!lastNameClean}
            helperText={
              lastNameClean
                ? 'Необязательно'
                : 'Уберите из фамилии табуляцию и другие служебные знаки.'
            }
            slotProps={{ htmlInput: { maxLength: 255 } }}
            fullWidth
          />
        </Box>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mt: 1.5, overflowWrap: 'anywhere' }}
        >
          {user.email}
        </Typography>
        {saveProfile.isError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            Не удалось сохранить профиль. Попробуйте ещё раз.
          </Alert>
        )}
        {profileNotice && (
          <Alert severity="success" role="status" sx={{ mt: 2 }}>
            {profileNotice}
          </Alert>
        )}
        <Button
          type="submit"
          variant="contained"
          disabled={busy || !changed || !nameValid || !lastNameValid}
          sx={{ mt: 3 }}
        >
          {saveProfile.isPending ? 'Сохраняем…' : 'Сохранить'}
        </Button>
      </Box>
    </Stack>
  )
}
