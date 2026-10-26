'use client'

import { agentSkillNameSchema, parseAgentSkillUrl } from '@repo/domain/agent/skills'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
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
// turns one off; they add a remote server by its https address. The server checks every change
// again (`siteAgentSkills`), and a skill holds nothing secret.

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
  urlHelp: 'Начинается с https://, без логина, ключа и параметров после «?»',
  add: 'Добавить',
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
  const [view, setView] = useState(initial)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const formId = useId()
  const busy = switchSkill.isPending || addSkill.isPending || removeSkill.isPending

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
    if (await run(() => addSkill.mutateAsync({ siteId, name: cleanName, url: url.trim() }))) {
      setName('')
      setUrl('')
    }
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
            </Box>
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
              <Button
                type="submit"
                variant="contained"
                disabled={busy}
                sx={{ minHeight: 44, mt: 0.5 }}
              >
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
