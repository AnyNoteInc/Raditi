'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { artifactLinkTokenSchema } from '@repo/domain/artifacts'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

export const shareLandingTexts = Object.freeze({
  title: 'Вам открыли доступ в Радити',
  signedOut: 'Войдите или зарегистрируйтесь, чтобы открыть то, чем с вами поделились.',
  signIn: 'Войти',
  signUp: 'Зарегистрироваться',
  consent: 'Ваше имя увидят владелец и все, у кого есть доступ; почту — владелец.',
  open: 'Открыть',
  opening: 'Открываем…',
  gone: 'Ссылка больше не работает. Попросите владельца прислать новую.',
  many: 'Слишком много попыток. Попробуйте через час.',
  consents: 'Сначала примите документы сервиса — потом откройте ссылку ещё раз.',
  nothing: 'В адресе нет ссылки. Откройте ссылку из письма или сообщения ещё раз.',
  closed: 'Ссылки на артефакты пока не работают.',
})

type Problem = 'gone' | 'many' | 'consents' | 'nothing' | null

/**
 * The page /a (docs/plan/88-artifacts.md, Ар33; spike 8): the token is read from the fragment and
 * erased at once (`history.replaceState`), before any navigation could carry it on. Signed out —
 * it waits an hour in an HttpOnly cookie for the sign-in; signed in — «Открыть» after the words of
 * consent. Neither the owner's name nor a title before that.
 */
export function ShareLanding({
  open,
  signedIn,
  held,
}: {
  open: boolean
  signedIn: boolean
  held: boolean
}) {
  const [token, setToken] = useState<string | null>(null)
  const [read, setRead] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem>(null)
  const router = useRouter()

  useEffect(() => {
    const raw = window.location.hash.slice(1)
    if (raw !== '') window.history.replaceState(null, '', '/a')
    const parsed = artifactLinkTokenSchema.safeParse(raw)
    const found = parsed.success ? parsed.data : null
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(found)
    setRead(true)
    if (found !== null && !signedIn)
      void fetch('/api/artifact-share/hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: found }),
      })
  }, [signedIn])

  async function openIt() {
    setBusy(true)
    setProblem(null)
    try {
      const response = await fetch('/api/artifact-share/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(token === null ? {} : { token }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        artifactId?: string
        code?: string
      }
      if (response.ok && body.artifactId) {
        router.push(`/artifacts/${body.artifactId}`)
        return
      }
      setProblem(
        response.status === 429
          ? 'many'
          : body.code === 'FORBIDDEN' || body.code === 'PRECONDITION_FAILED'
            ? 'consents'
            : 'gone',
      )
    } catch {
      setProblem('gone')
    } finally {
      setBusy(false)
    }
  }

  const next = encodeURIComponent('/a')
  return (
    <Box
      component="main"
      sx={{ maxWidth: 480, mx: 'auto', px: 2, py: { xs: 6, sm: 10 }, display: 'grid', gap: 2 }}
    >
      <Typography component="h1" variant="h5">
        {shareLandingTexts.title}
      </Typography>
      {!open ? (
        <Typography color="text.secondary">{shareLandingTexts.closed}</Typography>
      ) : !read ? null : !signedIn ? (
        <>
          <Typography color="text.secondary">
            {token === null && !held ? shareLandingTexts.nothing : shareLandingTexts.signedOut}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Button variant="contained" href={`/sign-in?next=${next}`}>
              {shareLandingTexts.signIn}
            </Button>
            <Button variant="outlined" href={`/sign-up?next=${next}`}>
              {shareLandingTexts.signUp}
            </Button>
          </Box>
        </>
      ) : token === null && !held ? (
        <Typography color="text.secondary">{shareLandingTexts.nothing}</Typography>
      ) : (
        <>
          <Typography>{shareLandingTexts.consent}</Typography>
          <Box>
            <Button variant="contained" onClick={() => void openIt()} disabled={busy}>
              {busy ? shareLandingTexts.opening : shareLandingTexts.open}
            </Button>
          </Box>
        </>
      )}
      {problem && <Alert severity="warning">{shareLandingTexts[problem]}</Alert>}
    </Box>
  )
}
