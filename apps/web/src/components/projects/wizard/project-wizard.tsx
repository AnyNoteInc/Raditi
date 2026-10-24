'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import MenuItem from '@mui/material/MenuItem'
import Step from '@mui/material/Step'
import StepLabel from '@mui/material/StepLabel'
import Stepper from '@mui/material/Stepper'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { stackLabels, type ProjectStack } from '../project-labels'
import { CheckProblem, HostKeyPanel, type HostKeyPrompt } from './check-panels'
import { databaseFieldId, DatabaseFields } from './database-fields'
import { callErrorText, databaseReasonText, domainCodeOf, sourceReasonText } from './reason-text'
import { sourceFieldId, SourceFields } from './source-fields'
import {
  basicsErrors,
  databaseErrors,
  databaseFieldOrder,
  databaseInput,
  emptyDatabase,
  emptySource,
  firstProblem,
  newRequestKey,
  normalizeSiteUrl,
  sourceErrors,
  sourceFieldOrder,
  sourceInput,
  type BasicsField,
  type CheckRefusal,
  type DatabaseDraft,
  type SourceDraft,
} from './wizard-model'

/** How long the wizard waits before it sends a creation the server is still busy with again. */
export const CREATE_RESEND_MS = 2_000
/** How many times; the same request key each time, so a resend can never make a second project. */
export const CREATE_RESENDS = 5

type StepIndex = 0 | 1 | 2

const steps: readonly { title: string; note: string }[] = [
  {
    title: 'Основные данные',
    note: 'Как проект будет называться в кабинете и по какому адресу открывается сайт.',
  },
  {
    title: 'Доступ к файлам',
    note: 'По этому доступу мы скопируем файлы сайта и сохраним его первоначальную версию. На сервер мы ничего не записываем.',
  },
  {
    title: 'База данных',
    note: 'Подключать базу данных необязательно. Если подключите, мы только проверим, что к ней можно подключиться.',
  },
]

/** «Доступ к файлам» where the wizard also offers the browser alone (docs/plan/57, Б8). */
const SOURCE_NOTE_WITH_BROWSER =
  'Выберите, как агент будет работать с сайтом. По доступу SSH или FTP мы скопируем файлы сайта и сохраним его первоначальную версию. На сервер мы ничего не записываем.'

/** What a site without access to its files can and cannot get, in the owner's words. */
const BROWSER_ACCESS_POINTS = [
  'Агент меняет записи, страницы и медиафайлы в админке сайта — через браузер, и вы видите каждый шаг.',
  'В админку входите вы сами, прямо в окне задачи. Пароль от админки нам сообщать не нужно.',
  // The settings stay closed with access to the files too (docs/plan/57-browser-tasks.md, Б21):
  // only the code, the theme and the plugins need it.
  'Настройки сайта и пользователей агент менять не сможет. Код, тему и плагины — тоже: для них нужен доступ по SSH или FTP.',
  'Изменения появляются на сайте сразу, без предпросмотра и выпуска версии. Первоначальную версию сайта мы не сохраним.',
] as const

const NOTES_FIELD = 'wizard-agent-notes'

const busyTexts = {
  basics: 'Проверяем данные…',
  source: 'Проверяем подключение…',
  create: 'Проверяем подключение и добавляем проект…',
  created: 'Проект добавлен. Открываем его страницу…',
} as const
type Busy = keyof typeof busyTexts

/** Refusals of `project.create` that only the first step can cure. */
const basicsCodes = new Set([
  'PROJECT_ALREADY_EXISTS',
  'SITE_ADDRESS_NOT_PUBLIC',
  'SITE_ADDRESS_NOT_SECURE',
  'SITE_STACK_NOT_CONNECTABLE',
])

const STEP_TITLE = 'wizard-step-title'
const PROBLEM = 'wizard-problem'
const HOST_KEY_TITLE = 'wizard-host-key-title'
const SOURCE = 'wizard-source'
const DATABASE = 'wizard-database'

/** What the first step passed with: the server's own form of the name and the address. */
interface CheckedBasics {
  name: string
  url: string
  stack: ProjectStack
}

/** A message on one step; it goes away when the user leaves the step or edits it. */
interface Problem {
  step: StepIndex
  text: string
  suggestedRoot?: string
  /**
   * This opening already added a project at another address (`PROJECT_REQUEST_CONFLICT`): no
   * edit cures it, so the message offers the list of projects and a fresh start.
   */
  startOver?: true
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The wizard of a new project (spec §12): the name and the address, the access to the files,
 * the database. Each step is checked by the server before the next one opens; the last one
 * creates the project, and the project page then shows how its files are being copied.
 *
 * Everything typed stays in this component's memory: never in the address, browser storage or
 * the query cache — the mutations are dropped from it as soon as their answer is read — and
 * nothing comes back from the server to fill a field. «Назад» keeps what was typed; an edit
 * makes the check of its step count no longer.
 */
export function ProjectWizard({
  stacks,
  browserAccess = false,
}: {
  stacks: readonly ProjectStack[]
  /** The platform has a browser for tasks: a site may be added without access to its files. */
  browserAccess?: boolean
}) {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  // One per opening of the wizard: a creation sent again after a lost answer finds its project.
  // «Начать заново» is a new opening.
  const [requestKey, setRequestKey] = useState(newRequestKey)

  const [step, setStep] = useState<StepIndex>(0)
  const [basics, setBasics] = useState({ name: '', url: '', stack: stacks[0] ?? 'wordpress' })
  const [checkedBasics, setCheckedBasics] = useState<CheckedBasics | null>(null)
  const [source, setSource] = useState<SourceDraft>(() => emptySource())
  /** The host key the user confirmed; sent with every check and with the creation. */
  const [hostKey, setHostKey] = useState<string | null>(null)
  const [keyPrompt, setKeyPrompt] = useState<HostKeyPrompt | null>(null)
  const [sourcePassed, setSourcePassed] = useState(false)
  const [database, setDatabase] = useState<DatabaseDraft>(emptyDatabase)
  /** No access to the files: the agent works through the browser (Б8). */
  const [browserOnly, setBrowserOnly] = useState(false)
  /** Hints for the agent of a site in the browser: where to sign in, never a secret. */
  const [agentNotes, setAgentNotes] = useState('')
  /** Field problems show after the first «Далее» of their step and follow the edits after it. */
  const [shown, setShown] = useState<Record<StepIndex, boolean>>({ 0: false, 1: false, 2: false })
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState<Busy | null>(null)

  // A second press, or Enter while a check runs, must not send a second request: the state of
  // this render may not show the first one yet, a ref does.
  const busyRef = useRef<Busy | null>(null)
  const alive = useRef(true)
  /** The id of the element the focus goes to after the next render. */
  const focusNext = useRef<string | null>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    const id = focusNext.current
    if (id === null) return
    focusNext.current = null
    document.getElementById(id)?.focus()
  })

  const gcTime = { gcTime: 0 }
  const checkBasics = useMutation(trpc.siteConnection.checkBasics.mutationOptions(gcTime))
  const checkSource = useMutation(trpc.siteConnection.checkSource.mutationOptions(gcTime))
  const createProject = useMutation(trpc.project.create.mutationOptions(gcTime))

  const platform = stackLabels[basics.stack]
  const basicsShown = shown[0] ? basicsErrors(basics) : {}
  const sourceShown = shown[1] ? sourceErrors(source) : {}
  const databaseShown = shown[2] ? databaseErrors(database) : {}
  const stepProblem = problem?.step === step ? problem : null

  function begin(kind: Busy): boolean {
    if (busyRef.current !== null) return false
    busyRef.current = kind
    setBusy(kind)
    return true
  }
  function end() {
    busyRef.current = null
    setBusy(null)
  }

  function goTo(next: StepIndex, nextProblem: Problem | null = null) {
    setStep(next)
    setKeyPrompt(null)
    setProblem(nextProblem)
    focusNext.current = nextProblem ? PROBLEM : STEP_TITLE
  }

  function showProblem(next: Problem) {
    setProblem(next)
    focusNext.current = PROBLEM
  }

  function editBasics(patch: Partial<typeof basics>) {
    setBasics((previous) => ({ ...previous, ...patch }))
    setCheckedBasics(null)
    setProblem(null)
    // The folder of the site is checked for the files of its platform.
    if (patch.stack !== undefined) setSourcePassed(false)
  }

  function editSource(next: SourceDraft) {
    // Another server is another key: the one confirmed belongs to the host and port it came from.
    if (next.sftp.host !== source.sftp.host || next.sftp.port !== source.sftp.port) {
      setHostKey(null)
    }
    setSource(next)
    setSourcePassed(false)
    setKeyPrompt(null)
    setProblem(null)
  }

  function editDatabase(next: DatabaseDraft) {
    setDatabase(next)
    setProblem(null)
  }

  /** A refusal of the source, by the check or by the creation: a key to compare, or a reason. */
  function refuseSource(refusal: CheckRefusal) {
    setSourcePassed(false)
    if (
      (refusal.reason === 'host_key_unknown' || refusal.reason === 'host_key_changed') &&
      refusal.hostKey
    ) {
      setProblem(null)
      setKeyPrompt({
        kind: refusal.reason === 'host_key_unknown' ? 'unknown' : 'changed',
        hostKey: refusal.hostKey,
      })
      focusNext.current = HOST_KEY_TITLE
      return
    }
    showProblem({
      step: 1,
      text: sourceReasonText(refusal.reason, { kind: source.kind, platform }),
      ...(refusal.reason === 'not_site_root' && refusal.suggestedRoot
        ? { suggestedRoot: refusal.suggestedRoot }
        : {}),
    })
  }

  /**
   * «Начать заново»: a new opening on the same page, with a new request key. The name, the address
   * and the platform stay, to be checked again; the access, its key and the database — nothing
   * secret — are typed anew.
   */
  function startOver() {
    if (busyRef.current !== null) return
    setRequestKey(newRequestKey())
    setCheckedBasics(null)
    setSource(emptySource())
    setHostKey(null)
    setSourcePassed(false)
    setDatabase(emptyDatabase())
    setBrowserOnly(false)
    setAgentNotes('')
    setShown({ 0: false, 1: false, 2: false })
    goTo(0)
  }

  async function submitBasics() {
    setShown((previous) => ({ ...previous, 0: true }))
    const errors = basicsErrors(basics)
    const field = firstProblem<BasicsField>(['name', 'url'], errors)
    if (field) {
      focusNext.current = field === 'name' ? 'project-name' : 'project-url'
      setProblem(null)
      return
    }
    if (checkedBasics) return goTo(1)
    if (!begin('basics')) return
    setProblem(null)
    try {
      const checked = await checkBasics.mutateAsync({
        name: basics.name.trim(),
        url: normalizeSiteUrl(basics.url) ?? basics.url,
        stack: basics.stack,
      })
      if (!alive.current) return
      setCheckedBasics({ name: checked.name, url: checked.url, stack: checked.stack })
      goTo(1)
    } catch (error) {
      if (!alive.current) return
      showProblem({
        step: 0,
        text: callErrorText(error, {
          invalid: 'Проверьте название и адрес сайта. Нужен полный адрес без пути к странице.',
          failed: 'Не удалось проверить данные. Попробуйте ещё раз.',
        }),
      })
    } finally {
      checkBasics.reset()
      end()
    }
  }

  async function runSourceCheck(key: string | null) {
    if (!begin('source')) return
    setProblem(null)
    setKeyPrompt(null)
    try {
      const outcome = await checkSource.mutateAsync({
        stack: basics.stack,
        source: sourceInput(source, key),
      })
      if (!alive.current) return
      if (outcome.ok) {
        if (source.kind === 'sftp') setHostKey(outcome.hostKey ?? key)
        setSourcePassed(true)
        goTo(2)
      } else {
        refuseSource(outcome)
      }
    } catch (error) {
      if (!alive.current) return
      showProblem({
        step: 1,
        text: callErrorText(error, {
          invalid: 'Проверьте данные доступа: сервер, порт, пользователя и папку сайта.',
          failed: 'Не удалось проверить подключение. Попробуйте ещё раз.',
        }),
      })
    } finally {
      checkSource.reset()
      end()
    }
  }

  function submitSource() {
    if (browserAccess && browserOnly) return void submitCreate()
    setShown((previous) => ({ ...previous, 1: true }))
    const field = firstProblem(sourceFieldOrder, sourceErrors(source))
    if (field) {
      focusNext.current = sourceFieldId(SOURCE, field)
      setProblem(null)
      return
    }
    if (sourcePassed) return goTo(2)
    void runSourceCheck(source.kind === 'sftp' ? hostKey : null)
  }

  function acceptHostKey() {
    if (!keyPrompt || busyRef.current !== null) return
    setHostKey(keyPrompt.hostKey)
    void runSourceCheck(keyPrompt.hostKey)
  }

  async function submitCreate() {
    // Without access to the files there is nothing to check on a server and no database step.
    const viaBrowser = browserAccess && browserOnly
    // The step the refusals of this creation are told on.
    const at: StepIndex = viaBrowser ? 1 : 2
    if (!viaBrowser) {
      setShown((previous) => ({ ...previous, 2: true }))
      const field = firstProblem(databaseFieldOrder, databaseErrors(database))
      if (field) {
        focusNext.current = databaseFieldId(DATABASE, field)
        setProblem(null)
        return
      }
    }
    if (!checkedBasics) return goTo(0)
    if (!viaBrowser && !sourcePassed) return goTo(1)
    if (!begin('create')) return
    setProblem(null)
    const notes = agentNotes.trim()
    const input = viaBrowser
      ? {
          requestKey,
          name: checkedBasics.name,
          url: checkedBasics.url,
          stack: checkedBasics.stack,
          access: 'browser' as const,
          ...(notes === '' ? {} : { agentNotes: notes }),
        }
      : {
          requestKey,
          name: checkedBasics.name,
          url: checkedBasics.url,
          stack: checkedBasics.stack,
          source: sourceInput(source, hostKey),
          database: databaseInput(database),
        }
    let created = false
    try {
      for (let resent = 0; ; resent += 1) {
        try {
          const outcome = await createProject.mutateAsync(input)
          if (!alive.current) return
          if (outcome.outcome === 'created') {
            created = true
            busyRef.current = 'created'
            setBusy('created')
            void queryClient.invalidateQueries({ queryKey: trpc.project.list.queryKey() })
            router.push(`/projects/${outcome.project.id}`)
          } else if (outcome.outcome === 'source_refused') {
            goTo(1)
            refuseSource(outcome)
          } else {
            showProblem({ step: at, text: databaseReasonText(outcome.reason) })
          }
          return
        } catch (error) {
          // Another request with this key is creating the project right now: its answer is the
          // one to wait for, and the same key finds it once it is done.
          if (domainCodeOf(error) !== 'PROJECT_CREATION_IN_PROGRESS' || resent >= CREATE_RESENDS) {
            throw error
          }
          createProject.reset()
          await wait(CREATE_RESEND_MS)
          if (!alive.current) return
        }
      }
    } catch (error) {
      if (!alive.current) return
      const text = callErrorText(error, {
        invalid: 'Проверьте введённые данные на всех шагах.',
        failed: 'Не удалось добавить проект. Попробуйте ещё раз.',
      })
      const code = domainCodeOf(error)
      if (code === 'PROJECT_REQUEST_CONFLICT') {
        showProblem({ step: at, text, startOver: true })
      } else if (code !== null && basicsCodes.has(code)) {
        setCheckedBasics(null)
        goTo(0, { step: 0, text })
      } else {
        showProblem({ step: at, text })
        // A hint the server refused: the field is where it is cured.
        if (code?.startsWith('PROJECT_NOTES_')) focusNext.current = NOTES_FIELD
      }
    } finally {
      createProject.reset()
      // A created project leaves the page: the buttons stay off until it is gone.
      if (!created) end()
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busyRef.current !== null) return
    if (step === 0) void submitBasics()
    else if (step === 1) submitSource()
    else void submitCreate()
  }

  const disabled = busy !== null
  const current = steps[step]!
  const viaBrowser = browserAccess && browserOnly
  const stepNote = step === 1 && browserAccess ? SOURCE_NOTE_WITH_BROWSER : current.note

  return (
    <Box sx={{ maxWidth: 760, mx: 'auto' }}>
      <Typography
        component="h1"
        sx={{
          fontSize: { xs: 28, md: 32 },
          fontWeight: 600,
          letterSpacing: '-0.025em',
          lineHeight: 1.25,
        }}
      >
        Новый проект
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 1, textWrap: 'pretty' }}>
        Три шага: основные данные, доступ к файлам и, если нужно, база данных.
      </Typography>

      <Box
        sx={{
          mt: { xs: 3, md: 4 },
          border: 1,
          borderColor: 'divider',
          borderRadius: '14px',
          bgcolor: 'background.default',
        }}
      >
        <Box sx={{ px: { xs: 1, sm: 3 }, pt: 2.5, pb: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Stepper
            activeStep={step}
            alternativeLabel
            sx={{
              '& .MuiStepLabel-label': { fontSize: 13, lineHeight: 1.35, textWrap: 'balance' },
              '& .MuiStepLabel-label.MuiStepLabel-alternativeLabel': { mt: 1 },
            }}
          >
            {steps.map((item) => (
              <Step key={item.title}>
                <StepLabel>{item.title}</StepLabel>
              </Step>
            ))}
          </Stepper>
        </Box>

        <Box
          component="form"
          noValidate
          onSubmit={submit}
          aria-labelledby={STEP_TITLE}
          sx={{ p: { xs: 2, sm: 3.5 }, display: 'flex', flexDirection: 'column', gap: 2.5 }}
        >
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500 }}>
              Шаг {step + 1} из {steps.length}
            </Typography>
            <Typography
              component="h2"
              id={STEP_TITLE}
              tabIndex={-1}
              sx={{ fontSize: 20, fontWeight: 600, mt: 0.25, outline: 'none' }}
            >
              {current.title}
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 0.75, lineHeight: 1.6, textWrap: 'pretty' }}
            >
              {stepNote}
            </Typography>
          </Box>

          {step === 0 ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
              <TextField
                autoFocus
                id="project-name"
                label="Название проекта"
                placeholder="Например, сайт кофейни"
                value={basics.name}
                onChange={(event) => editBasics({ name: event.target.value })}
                disabled={disabled}
                error={basicsShown.name !== undefined}
                helperText={basicsShown.name ?? 'Так проект будет называться в кабинете.'}
                required
                fullWidth
                autoComplete="off"
                slotProps={{ htmlInput: { maxLength: 255 } }}
              />
              <TextField
                id="project-url"
                label="Адрес сайта"
                placeholder="https://example.ru"
                value={basics.url}
                onChange={(event) => editBasics({ url: event.target.value })}
                disabled={disabled}
                error={basicsShown.url !== undefined}
                helperText={basicsShown.url ?? 'Адрес главной страницы, без пути и параметров.'}
                required
                fullWidth
                autoComplete="off"
                slotProps={{
                  htmlInput: {
                    maxLength: 512,
                    inputMode: 'url',
                    autoCapitalize: 'none',
                    spellCheck: false,
                  },
                }}
              />
              {stacks.length > 1 ? (
                <TextField
                  id="project-platform"
                  select
                  label="Платформа сайта"
                  value={basics.stack}
                  onChange={(event) => editBasics({ stack: event.target.value as ProjectStack })}
                  disabled={disabled}
                  fullWidth
                >
                  {stacks.map((value) => (
                    <MenuItem key={value} value={value}>
                      {stackLabels[value]}
                    </MenuItem>
                  ))}
                </TextField>
              ) : (
                <Box>
                  <Typography variant="caption" color="text.secondary" component="p">
                    Платформа сайта
                  </Typography>
                  <Typography sx={{ fontWeight: 500 }}>{platform}</Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                    Сейчас подключаем сайты на {platform}.
                  </Typography>
                </Box>
              )}
            </Box>
          ) : step === 1 ? (
            <SourceFields
              idPrefix={SOURCE}
              value={source}
              onChange={editSource}
              errors={sourceShown}
              disabled={disabled}
              browser={
                browserAccess
                  ? {
                      selected: browserOnly,
                      onSelect: (selected) => {
                        setBrowserOnly(selected)
                        setProblem(null)
                        setKeyPrompt(null)
                      },
                      panel: (
                        <BrowserAccessPanel
                          notes={agentNotes}
                          onNotes={(next) => {
                            setAgentNotes(next)
                            setProblem(null)
                          }}
                          disabled={disabled}
                        />
                      ),
                    }
                  : undefined
              }
            />
          ) : (
            <DatabaseFields
              idPrefix={DATABASE}
              value={database}
              onChange={editDatabase}
              errors={databaseShown}
              disabled={disabled}
            />
          )}

          {step === 1 && keyPrompt && !viaBrowser ? (
            <HostKeyPanel
              titleId={HOST_KEY_TITLE}
              prompt={keyPrompt}
              onAccept={acceptHostKey}
              disabled={disabled}
            />
          ) : null}
          {stepProblem ? (
            <CheckProblem
              id={PROBLEM}
              text={stepProblem.text}
              suggestedRoot={stepProblem.suggestedRoot}
              onUseRoot={(root) => {
                editSource(
                  source.kind === 'ftp'
                    ? { ...source, ftp: { ...source.ftp, rootPath: root } }
                    : { ...source, sftp: { ...source.sftp, rootPath: root } },
                )
                focusNext.current = sourceFieldId(SOURCE, 'rootPath')
              }}
              disabled={disabled}
            >
              {stepProblem.startOver ? (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1.5 }}>
                  <Button color="inherit" variant="outlined" href="/projects" disabled={disabled}>
                    Открыть список проектов
                  </Button>
                  <Button
                    color="inherit"
                    variant="outlined"
                    onClick={startOver}
                    disabled={disabled}
                  >
                    Начать заново
                  </Button>
                </Box>
              ) : null}
            </CheckProblem>
          ) : null}

          <Box
            sx={{
              display: 'flex',
              flexDirection: { xs: 'column-reverse', sm: 'row' },
              alignItems: { xs: 'stretch', sm: 'center' },
              gap: 1.5,
              pt: 1,
            }}
          >
            {step === 0 ? (
              <Button color="inherit" href="/projects" disabled={disabled}>
                Отмена
              </Button>
            ) : (
              <Button
                color="inherit"
                onClick={() => goTo((step - 1) as StepIndex)}
                disabled={disabled}
                startIcon={<AppIcon name="back" size={18} />}
              >
                Назад
              </Button>
            )}
            <Typography
              role="status"
              variant="body2"
              color="text.secondary"
              sx={{ flex: 1, textAlign: { xs: 'center', sm: 'right' }, minHeight: '1.43em' }}
            >
              {busy ? busyTexts[busy] : ''}
            </Typography>
            <Button type="submit" variant="contained" loading={disabled} loadingPosition="end">
              {step === 2 || (step === 1 && viaBrowser) ? 'Добавить проект' : 'Далее'}
            </Button>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

/**
 * «Без доступа к файлам» (docs/plan/57-browser-tasks.md, Б8): what the site gets and what it
 * does not, and hints for the agent — where to sign in, never a password.
 */
function BrowserAccessPanel({
  notes,
  onNotes,
  disabled,
}: {
  notes: string
  onNotes: (next: string) => void
  disabled: boolean
}) {
  return (
    <>
      <Typography variant="body2" color="text.secondary" sx={{ textWrap: 'pretty' }}>
        Агент работает только через браузер — в админке сайта.
      </Typography>
      <Box
        component="section"
        aria-labelledby="wizard-browser-title"
        sx={{
          p: { xs: 2, sm: 2.5 },
          border: 1,
          borderColor: 'divider',
          borderRadius: '12px',
          bgcolor: 'background.paper',
        }}
      >
        <Typography
          id="wizard-browser-title"
          component="h3"
          sx={{ fontSize: 16, fontWeight: 600, mb: 1 }}
        >
          Что будет без доступа к файлам
        </Typography>
        <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.75 }}>
          {BROWSER_ACCESS_POINTS.map((point) => (
            <Typography component="li" variant="body2" key={point} sx={{ lineHeight: 1.6 }}>
              {point}
            </Typography>
          ))}
        </Box>
      </Box>
      <TextField
        id={NOTES_FIELD}
        label="Подсказки для агента (необязательно)"
        placeholder="Например: вход в админку — по адресу /login"
        value={notes}
        onChange={(event) => onNotes(event.target.value)}
        disabled={disabled}
        multiline
        minRows={3}
        maxRows={8}
        fullWidth
        autoComplete="off"
        helperText="Где страница входа, как устроен сайт. Не пишите сюда пароли и коды — в админку вы войдёте сами."
        slotProps={{ htmlInput: { maxLength: 2000 } }}
      />
    </>
  )
}
