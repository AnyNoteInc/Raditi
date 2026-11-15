'use client'

import { agentSkillNameSchema, parseAgentSkillUrl } from '@repo/domain/agent/skills'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { fontFamilies } from '@repo/ui/theme/tokens'
import { useMutation } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'

import { callErrorText } from '@/components/chat/call-error'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { SiteCard } from './site-cards'

// «Навыки агента» (owner's request of 26.10.2026: «установи для агента по умолчанию следующие
// скилы и сделай возможность добавлять — context7, playwright»): the MCP servers the site's agent
// connects to besides Радити's own tools. The platform's two are on until an owner or an admin
// turns one off; they add a remote server by its full https address. A server may want a key in
// a header (docs/plan/80-mcp-server-credentials.md): the key is checked against the server, kept in
// Vault and never shown again; the agent never sees it — Радити adds it to the server's requests.
// The server checks every change again (`siteAgentSkills`).

export const skillsText = Object.freeze({
  title: 'Навыки агента',
  note: 'Навыки — внешние серверы MCP, которыми агент пользуется вместе с инструментами Радити: документация библиотек, браузер для страниц в интернете. Агент обращается к ним через интернет, поэтому ничего секретного им не передаётся.',
  readOnly: 'Включать, выключать и добавлять навыки могут владелец и администраторы.',
  platform: 'навык Радити',
  switchLabel: (title: string) => `Навык «${title}»`,
  remove: 'Удалить',
  addTitle: 'Добавить навык',
  name: 'Имя',
  nameHelp: 'Латинские буквы, цифры и дефис, например docs',
  url: 'Адрес сервера MCP',
  urlHelp: 'Полный адрес с путём, например https://mcp.example.com/v1/mcp. Ключ в адрес не пишите',
  add: 'Добавить',
  auth: 'Авторизация',
  authNone: 'Нет',
  authHeader: 'Ключ в заголовке',
  headerName: 'Заголовок',
  headerNameHelp: 'Например Authorization или X-Api-Key',
  headerValue: 'Ключ',
  headerValueHelp:
    'Уходит в защищённое хранилище и больше не показывается. Агент его не видит: заголовок к запросу добавляет Радити',
  keyed: (header: string) => `Ключ в заголовке ${header}`,
  keyRefused: 'Сервер не принял ключ — замените его',
  keyMissing: 'Ключа нет — задайте его заново',
  replaceKey: 'Заменить ключ',
  saveKey: 'Сохранить ключ',
  cancel: 'Отмена',
  keyInvalid: 'Укажите заголовок и ключ от 8 знаков одной строкой.',
  nameInvalid: 'Имя — латинские буквы, цифры и дефис, до 32 знаков, начинается с буквы.',
  urlInvalid:
    'Укажите адрес, который начинается с https://, без логина, ключа и параметров после «?».',
  full: 'Добавлено столько навыков, сколько можно. Чтобы добавить новый, удалите ненужный.',
})

export interface SkillView {
  name: string
  title: string
  description: string | null
  builtin: boolean
  url: string | null
  enabled: boolean
  auth: {
    kind: 'none' | 'header' | 'oauth'
    headerName: string | null
    state: 'ok' | 'needs_login' | 'failed'
    error: string | null
  }
}

export interface SkillsView {
  skills: SkillView[]
  canManage: boolean
  addable: number
}

export function SiteAgentSkills({ siteId, initial }: { siteId: string; initial: SkillsView }) {
  const trpc = useTRPC()
  const switchSkill = useMutation(trpc.siteAgentSkills.switch.mutationOptions())
  const addSkill = useMutation(trpc.siteAgentSkills.add.mutationOptions())
  const removeSkill = useMutation(trpc.siteAgentSkills.remove.mutationOptions())
  const replaceKey = useMutation(trpc.siteAgentSkills.key.mutationOptions())
  const [view, setView] = useState(initial)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [keyed, setKeyed] = useState(false)
  const [headerName, setHeaderName] = useState('Authorization')
  const [headerValue, setHeaderValue] = useState('')
  // The server whose key is being replaced, and the new one; nothing of the old key is known here.
  const [replacing, setReplacing] = useState<{
    name: string
    headerName: string
    value: string
  } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const formId = useId()
  const busy =
    switchSkill.isPending || addSkill.isPending || removeSkill.isPending || replaceKey.isPending

  const run = async (call: () => Promise<SkillsView>) => {
    setProblem(null)
    try {
      setView(await call())
      return true
    } catch (failure) {
      setProblem(callErrorText(failure))
      return false
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const cleanName = name.trim().toLowerCase()
    if (!agentSkillNameSchema.safeParse(cleanName).success) {
      setProblem(skillsText.nameInvalid)
      return
    }
    if (parseAgentSkillUrl(url.trim()) === null) {
      setProblem(skillsText.urlInvalid)
      return
    }
    if (keyed && (headerName.trim() === '' || headerValue.length < 8)) {
      setProblem(skillsText.keyInvalid)
      return
    }
    const header = keyed ? { headerName: headerName.trim(), value: headerValue } : undefined
    if (
      await run(() =>
        addSkill.mutateAsync({
          siteId,
          name: cleanName,
          url: url.trim(),
          ...(header ? { header } : {}),
        }),
      )
    ) {
      setName('')
      setUrl('')
      setHeaderValue('')
      setKeyed(false)
    }
  }
  const saveKey = async (event: FormEvent) => {
    event.preventDefault()
    if (replacing === null) return
    if (replacing.headerName.trim() === '' || replacing.value.length < 8) {
      setProblem(skillsText.keyInvalid)
      return
    }
    if (
      await run(() =>
        replaceKey.mutateAsync({
          siteId,
          name: replacing.name,
          header: { headerName: replacing.headerName.trim(), value: replacing.value },
        }),
      )
    )
      setReplacing(null)
  }

  return (
    <SiteCard title={skillsText.title} note={nbsp(skillsText.note)}>
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {view.skills.map((skill) => (
          <Box
            component="li"
            key={skill.name}
            sx={{
              px: { xs: 2, sm: 2.75 },
              py: 1.75,
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              borderBottom: 1,
              borderColor: 'divider',
            }}
          >
            <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
              <Typography sx={{ fontWeight: 600 }} translate="no">
                {skill.title}
                {skill.builtin ? (
                  <Typography
                    component="span"
                    variant="body2"
                    color="text.secondary"
                    sx={{ fontWeight: 400 }}
                  >
                    {' · '}
                    {skillsText.platform}
                  </Typography>
                ) : null}
              </Typography>
              {skill.description ? (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                  {nbsp(skill.description)}
                </Typography>
              ) : null}
              {skill.url ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  translate="no"
                  sx={{ mt: 0.25, fontFamily: fontFamilies.mono, overflowWrap: 'anywhere' }}
                >
                  {skill.url}
                </Typography>
              ) : null}
              {skill.auth.kind === 'header' && skill.auth.headerName ? (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                  {skillsText.keyed(skill.auth.headerName)}
                </Typography>
              ) : null}
              {skill.auth.kind !== 'none' && skill.auth.state !== 'ok' ? (
                <Typography variant="body2" color="error" sx={{ mt: 0.25 }}>
                  {skill.auth.error === 'secret_missing'
                    ? skillsText.keyMissing
                    : skillsText.keyRefused}
                </Typography>
              ) : null}
              {replacing?.name === skill.name ? (
                <Box
                  component="form"
                  noValidate
                  aria-label={skillsText.replaceKey}
                  onSubmit={(event) => void saveKey(event)}
                  sx={{
                    mt: 1.25,
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'flex-start',
                    gap: 1.25,
                  }}
                >
                  <TextField
                    size="small"
                    label={skillsText.headerName}
                    value={replacing.headerName}
                    onChange={(event) =>
                      setReplacing({ ...replacing, headerName: event.target.value })
                    }
                    slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off' } }}
                    sx={{ flex: '1 1 160px' }}
                  />
                  <TextField
                    size="small"
                    type="password"
                    label={skillsText.headerValue}
                    value={replacing.value}
                    autoComplete="off"
                    onChange={(event) => setReplacing({ ...replacing, value: event.target.value })}
                    sx={{ flex: '2 1 220px' }}
                  />
                  <Button type="submit" variant="contained" disabled={busy} sx={{ minHeight: 40 }}>
                    {skillsText.saveKey}
                  </Button>
                  <Button disabled={busy} onClick={() => setReplacing(null)} sx={{ minHeight: 40 }}>
                    {skillsText.cancel}
                  </Button>
                </Box>
              ) : null}
            </Box>
            {skill.auth.kind === 'header' && view.canManage && replacing?.name !== skill.name ? (
              <Button
                size="small"
                disabled={busy}
                sx={{ minHeight: 44, flexShrink: 0 }}
                onClick={() =>
                  setReplacing({
                    name: skill.name,
                    headerName: skill.auth.headerName ?? '',
                    value: '',
                  })
                }
              >
                {skillsText.replaceKey}
              </Button>
            ) : null}
            {!skill.builtin && view.canManage ? (
              <Button
                size="small"
                color="error"
                disabled={busy}
                sx={{ minHeight: 44, flexShrink: 0 }}
                onClick={() =>
                  void run(() => removeSkill.mutateAsync({ siteId, name: skill.name }))
                }
              >
                {skillsText.remove}
              </Button>
            ) : null}
            <Switch
              checked={skill.enabled}
              disabled={!view.canManage || busy}
              onChange={(event) =>
                void run(() =>
                  switchSkill.mutateAsync({
                    siteId,
                    name: skill.name,
                    enabled: event.target.checked,
                  }),
                )
              }
              slotProps={{ input: { 'aria-label': skillsText.switchLabel(skill.title) } }}
              sx={{ flexShrink: 0 }}
            />
          </Box>
        ))}
      </Box>
      <Box
        sx={{ px: { xs: 2, sm: 2.75 }, py: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}
      >
        {!view.canManage ? (
          <Typography variant="body2" color="text.secondary">
            {skillsText.readOnly}
          </Typography>
        ) : view.addable === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {skillsText.full}
          </Typography>
        ) : (
          <Box
            component="form"
            noValidate
            aria-labelledby={`${formId}-title`}
            onSubmit={(event) => void submit(event)}
            sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}
          >
            <Typography id={`${formId}-title`} component="h3" sx={{ fontWeight: 600 }}>
              {skillsText.addTitle}
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 1.5 }}>
              <TextField
                label={skillsText.name}
                helperText={skillsText.nameHelp}
                value={name}
                onChange={(event) => setName(event.target.value)}
                slotProps={{
                  htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' },
                }}
                sx={{ flex: '1 1 180px', minWidth: 0 }}
              />
              <TextField
                label={skillsText.url}
                helperText={skillsText.urlHelp}
                value={url}
                type="url"
                onChange={(event) => setUrl(event.target.value)}
                slotProps={{
                  htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' },
                }}
                sx={{ flex: '3 1 320px', minWidth: 0 }}
              />
            </Box>
            <RadioGroup
              row
              aria-label={skillsText.auth}
              value={keyed ? 'header' : 'none'}
              onChange={(event) => setKeyed(event.target.value === 'header')}
            >
              <FormControlLabel value="none" control={<Radio />} label={skillsText.authNone} />
              <FormControlLabel value="header" control={<Radio />} label={skillsText.authHeader} />
            </RadioGroup>
            {keyed ? (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 1.5 }}>
                <TextField
                  label={skillsText.headerName}
                  helperText={skillsText.headerNameHelp}
                  value={headerName}
                  onChange={(event) => setHeaderName(event.target.value)}
                  slotProps={{
                    htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' },
                  }}
                  sx={{ flex: '1 1 180px', minWidth: 0 }}
                />
                <TextField
                  label={skillsText.headerValue}
                  helperText={skillsText.headerValueHelp}
                  value={headerValue}
                  type="password"
                  autoComplete="off"
                  onChange={(event) => setHeaderValue(event.target.value)}
                  sx={{ flex: '3 1 320px', minWidth: 0 }}
                />
              </Box>
            ) : null}
            <Box>
              <Button type="submit" variant="contained" disabled={busy} sx={{ minHeight: 44 }}>
                {skillsText.add}
              </Button>
            </Box>
          </Box>
        )}
        {problem ? (
          <Alert severity="error" role="alert">
            {problem}
          </Alert>
        ) : null}
      </Box>
    </SiteCard>
  )
}
