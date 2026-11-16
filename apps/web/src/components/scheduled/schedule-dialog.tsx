'use client'

import {
  hasScheduleTemplatePlaceholder,
  scheduleTemplatePlaceholderRange,
  scheduleTemplateOf,
  timezoneChoices,
  timezoneLabel,
  timezoneSuffix,
  type ScheduleTemplate,
} from '@repo/domain/schedule'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Collapse from '@mui/material/Collapse'
import Dialog from '@mui/material/Dialog'
import FormHelperText from '@mui/material/FormHelperText'
import MenuItem from '@mui/material/MenuItem'
import Switch from '@mui/material/Switch'
import TextareaAutosize from '@mui/material/TextareaAutosize'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { callErrorCode, callErrorText } from '@/components/chat/call-error'
import { newChatHref } from '@/components/chat/chat-address'
import { keepChatDraft } from '@/components/chat/chat-draft'
import { useRememberedEffort } from '@/components/chat/chat-effort'
import { EffortMenu } from '@/components/chat/effort-menu'
import { BrowserPushControl } from '@/components/notifications/browser-push-control'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { ScheduleCostLine } from './schedule-cost'
import {
  addedTriggerDraft,
  canAddTrigger,
  chatDraftOf,
  formNextRun,
  formOfSchedule,
  formOfTemplate,
  formProblems,
  frequenciesOf,
  hasProblems,
  nameLooksLikeSecret,
  newScheduleForm,
  nextRunText,
  triggersOfForm,
  type FormProblems,
  type ScheduleDetail,
  type ScheduleForm,
  type ScheduleItem,
} from './schedule-model'
import { scheduleDialogTexts } from './schedule-texts'
import { TriggerFields } from './trigger-fields'
import { useNow } from './use-now'

/** What the window opens with: a new task — by hand or from a template — or a task to change. */
export type ScheduleDialogOpening =
  | { kind: 'new'; template?: ScheduleTemplate }
  | { kind: 'edit'; schedule: ScheduleDetail | ScheduleItem }

type RefusedField = 'name' | 'instructions' | 'schedule'

/** The refusals of the server a field of the window answers for; the others go on top. */
const fieldOfCode: Readonly<Record<string, RefusedField>> = {
  TASK_TEXT_EMPTY: 'instructions',
  TASK_TEXT_TOO_LONG: 'instructions',
  TASK_TEXT_HAS_SECRET: 'instructions',
  TASK_TEXT_INVALID: 'instructions',
  SCHEDULE_TEMPLATE_PLACEHOLDER: 'instructions',
  SCHEDULE_TOO_OFTEN: 'schedule',
  SCHEDULE_IN_PAST: 'schedule',
}

interface ServerRefusal {
  field: RefusedField | null
  text: string
}

function refusalOf(error: unknown, form: ScheduleForm): ServerRefusal {
  const code = callErrorCode(error)
  if (code === 'TASK_TEXT_HAS_SECRET') {
    // One refusal for the name and the words, the name checked first: the one that reads as a
    // key is told by its field, in the window's words — the server's name the chat (Зп26).
    return nameLooksLikeSecret(form)
      ? { field: 'name', text: scheduleDialogTexts.nameSecret }
      : { field: 'instructions', text: scheduleDialogTexts.secret }
  }
  const field = code === null ? null : (fieldOfCode[code] ?? null)
  const text = callErrorText(error)
  return { field, text: field === null ? text : text.replace(/\.$/, '') }
}

/** The zones of the list (Зп12), with the zone of the task and of this browser when not in it. */
function zoneOptions(current: string): { id: string; label: string }[] {
  let browser: string | null = null
  try {
    browser = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    browser = null
  }
  const options = timezoneChoices.map((choice) => ({ id: choice.id, label: choice.label }))
  for (const zone of [current, browser]) {
    if (zone === null || options.some((option) => option.id === zone)) continue
    options.push({ id: zone, label: timezoneLabel(zone) })
  }
  return options.map((option) =>
    option.id === browser
      ? { ...option, label: scheduleDialogTexts.timezoneOfBrowser(option.label) }
      : option,
  )
}

/** The fields that changed, for «Сохранить»: the schedules move the next run only when they do. */
function changeOf(form: ScheduleForm, was: ScheduleForm) {
  const triggers = triggersOfForm(form)
  return {
    ...(form.name.trim() === was.name ? {} : { name: form.name.trim() }),
    ...(form.instructions === was.instructions ? {} : { instructions: form.instructions }),
    ...(form.effort === was.effort ? {} : { effort: form.effort }),
    ...(JSON.stringify(triggers) === JSON.stringify(triggersOfForm(was)) ? {} : { triggers }),
    ...(form.timezone === was.timezone ? {} : { timezone: form.timezone }),
    ...(form.notify === was.notify ? {} : { notify: form.notify }),
  }
}

function ScheduleFormBody({
  opening,
  userId,
  phone,
  titleId,
  busyRef,
  onClose,
  onSaved,
}: {
  opening: ScheduleDialogOpening
  userId: string
  phone: boolean
  /** The id of the heading, which names the window. */
  titleId: string
  /** Whether a save is on its way: the window does not close then. */
  busyRef: RefObject<boolean>
  onClose: () => void
  onSaved?: (schedule: ScheduleDetail, created: boolean) => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const now = useNow()
  const [rememberedEffort] = useRememberedEffort()
  const list = useQuery(trpc.schedule.list.queryOptions())
  const template =
    opening.kind === 'new'
      ? opening.template
      : opening.schedule.templateSlug === null
        ? undefined
        : scheduleTemplateOf(opening.schedule.templateSlug)
  const [initial] = useState<ScheduleForm>(() => {
    const zone = list.data?.timezone ?? 'Europe/Moscow'
    if (opening.kind === 'edit') return formOfSchedule(opening.schedule, now)
    if (opening.template) return formOfTemplate(opening.template, zone, now)
    return newScheduleForm(zone, now, rememberedEffort)
  })
  const [form, setForm] = useState<ScheduleForm>(initial)
  const [submitted, setSubmitted] = useState(false)
  const [refusal, setRefusal] = useState<ServerRefusal | null>(null)
  const [more, setMore] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const instructionsRef = useRef<HTMLTextAreaElement>(null)
  const instructionsId = useId()
  const instructionsErrorId = useId()
  const placeholderHintId = useId()
  const whenId = useId()
  const scheduleErrorId = useId()
  const moreId = useId()
  const notifyId = useId()
  const notifyHintId = useId()
  const { setScrollBox, setScrollContent, measureScroll, scrolled, moreBelow } = useScrollEdges()

  // The zone of the browser came after the window opened: a new task takes it — and the next one
  // the list answers, once the cabinet remembered the browser's — until the client picks a zone.
  const listZone = list.data?.timezone
  const [zoneTouched, setZoneTouched] = useState(opening.kind === 'edit')
  if (!zoneTouched && listZone !== undefined && listZone !== form.timezone)
    setForm({ ...form, timezone: listZone })
  // A task being changed: its single runs in the past are told once its schedules change.
  const changing = opening.kind === 'edit' ? { saved: initial } : {}
  const problems: FormProblems = formProblems(form, now, { submitted, ...changing })
  const nextRun = formNextRun(form, now)
  const triggers = triggersOfForm(form)
  const create = useMutation(trpc.schedule.create.mutationOptions())
  const update = useMutation(trpc.schedule.update.mutationOptions())
  const pending = create.isPending || update.isPending

  useEffect(() => {
    busyRef.current = pending
  }, [busyRef, pending])

  // A template with a place to fill in opens on it, chosen to be written over (Зп9, Зп59).
  useEffect(() => {
    selectPlaceholder(instructionsRef.current)
  }, [])

  function change(next: Partial<ScheduleForm>) {
    setForm((was) => ({ ...was, ...next }))
    setRefusal(null)
  }

  function setInChat() {
    keepChatDraft(userId, chatDraftOf(form))
    router.push(newChatHref())
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setSubmitted(true)
    const shown = formProblems(form, now, { submitted: true, ...changing })
    if (hasProblems(shown)) {
      if (shown.name) nameRef.current?.focus()
      else if (shown.instructions) {
        // A place still to fill in: the focus back on it, chosen again (Зп59).
        if (!selectPlaceholder(instructionsRef.current)) instructionsRef.current?.focus()
      }
      return
    }
    setRefusal(null)
    try {
      const saved =
        opening.kind === 'edit'
          ? await update.mutateAsync({
              scheduleId: opening.schedule.id,
              ...changeOf(form, initial),
            })
          : await create.mutateAsync({
              name: form.name.trim(),
              instructions: form.instructions,
              effort: form.effort,
              triggers,
              timezone: form.timezone,
              notify: form.notify,
              templateSlug: form.templateSlug,
            })
      queryClient.setQueryData(trpc.schedule.get.queryKey({ scheduleId: saved.id }), saved)
      void queryClient.invalidateQueries({ queryKey: trpc.schedule.list.queryKey() })
      onSaved?.(saved, opening.kind === 'new')
      onClose()
    } catch (error) {
      setRefusal(refusalOf(error, form))
    }
  }

  const nextRunLine =
    nextRun !== null
      ? scheduleDialogTexts.next(
          `${nextRunText(nextRun, form.timezone, now)}${timezoneSuffix(form.timezone)}`,
        )
      : form.triggers.every((each) => each.frequency === 'manual')
        ? scheduleDialogTexts.manualOnly
        : null
  const nameError = problems.name ?? (refusal?.field === 'name' ? refusal.text : undefined)
  const instructionsError =
    problems.instructions ?? (refusal?.field === 'instructions' ? refusal.text : undefined)
  const scheduleError =
    problems.schedule ?? (refusal?.field === 'schedule' ? refusal.text : undefined)
  const topError = refusal?.field === null ? refusal.text : null
  const frequencies = frequenciesOf(form.triggers.length)
  const zones = zoneOptions(form.timezone)
  // A place of a template to fill in: said from the first look, quietly, until it is an error.
  const placeholderLeft = hasScheduleTemplatePlaceholder(form.instructions)

  return (
    <Box
      component="form"
      onSubmit={(event) => void save(event)}
      noValidate
      sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}
    >
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          columnGap: 2,
          rowGap: 0.5,
          px: { xs: 2, sm: 3 },
          pt: phone ? 'max(16px, env(safe-area-inset-top))' : 3,
          pb: 1.5,
          // A line once the body is scrolled: what scrolls up goes under it, not into the title.
          borderBottom: 1,
          borderColor: scrolled ? 'divider' : 'transparent',
          transition: 'border-color var(--raditi-motion-fast) var(--raditi-ease-out)',
        }}
      >
        <Typography
          component="h2"
          id={titleId}
          sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3, minWidth: 0 }}
        >
          {opening.kind === 'edit'
            ? scheduleDialogTexts.editTitle
            : scheduleDialogTexts.createTitle}
        </Typography>
        {opening.kind === 'new' ? (
          <Button
            size="small"
            onClick={setInChat}
            startIcon={<AppIcon name="chat" size={16} />}
            sx={{ minHeight: 40, ml: -1, px: 1.25, color: 'text.secondary' }}
          >
            {scheduleDialogTexts.inChat}
          </Button>
        ) : null}
      </Box>

      <Box
        ref={setScrollBox}
        onScroll={measureScroll}
        sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}
      >
        <Box
          ref={setScrollContent}
          sx={{
            px: { xs: 2, sm: 3 },
            pb: 2,
            display: 'flex',
            flexDirection: 'column',
            gap: 2.5,
          }}
        >
          {topError ? <Alert severity="error">{topError}</Alert> : null}

          <TextField
            inputRef={nameRef}
            // A new task by hand starts at its name; a template or a change is read first.
            autoFocus={opening.kind === 'new' && opening.template === undefined}
            label={scheduleDialogTexts.name}
            placeholder={scheduleDialogTexts.namePlaceholder}
            value={form.name}
            onChange={(event) => change({ name: event.target.value.replace(/[\r\n]/g, ' ') })}
            error={nameError !== undefined}
            helperText={nameError}
            slotProps={{ htmlInput: { maxLength: 80, autoComplete: 'off' } }}
            sx={{ mt: 0.75 }}
            fullWidth
          />

          <Box>
            <Typography
              component="label"
              htmlFor={instructionsId}
              variant="body2"
              sx={{ display: 'block', mb: 0.75, fontWeight: 500 }}
            >
              {scheduleDialogTexts.instructions}
            </Typography>
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 0.5,
                p: 1,
                borderRadius: '20px',
                bgcolor: 'var(--mui-palette-action-hover)',
                boxShadow: instructionsError
                  ? 'inset 0 0 0 1px var(--mui-palette-error-main)'
                  : 'none',
                transition: 'box-shadow var(--raditi-motion-fast) var(--raditi-ease-out)',
                '&:has(textarea:focus-visible)': {
                  boxShadow: instructionsError
                    ? 'inset 0 0 0 2px var(--mui-palette-error-main)'
                    : 'inset 0 0 0 1px rgba(var(--mui-palette-text-primaryChannel) / 0.24)',
                },
              }}
            >
              <Box
                component={TextareaAutosize}
                ref={instructionsRef}
                id={instructionsId}
                minRows={3}
                maxRows={12}
                value={form.instructions}
                placeholder={scheduleDialogTexts.instructionsPlaceholder}
                onChange={(event: { target: { value: string } }) =>
                  change({ instructions: event.target.value })
                }
                aria-invalid={instructionsError ? true : undefined}
                aria-describedby={
                  instructionsError
                    ? instructionsErrorId
                    : placeholderLeft
                      ? placeholderHintId
                      : undefined
                }
                sx={{
                  display: 'block',
                  width: '100%',
                  px: 1.25,
                  py: 1,
                  border: 0,
                  resize: 'none',
                  bgcolor: 'transparent',
                  color: 'text.primary',
                  font: 'inherit',
                  fontSize: 16,
                  lineHeight: 1.6,
                  outline: 'none',
                  '&&:focus-visible': { outline: 'none' },
                  '&::placeholder': { color: 'text.secondary', opacity: 1 },
                }}
              />
              {/*
                «Размышление» at the left of the frame (Зп55), its menu down; without the switch of
                the thoughts of a chat, which is not the task's.
              */}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <EffortMenu
                  value={form.effort}
                  onChange={(effort) => change({ effort })}
                  placement="down"
                  thinkingSwitch={false}
                />
              </Box>
            </Box>
            {instructionsError ? (
              <FormHelperText id={instructionsErrorId} error sx={{ mx: 1.5 }}>
                {instructionsError}
              </FormHelperText>
            ) : placeholderLeft ? (
              <FormHelperText id={placeholderHintId} sx={{ mx: 1.5 }}>
                {scheduleDialogTexts.placeholderHint}
              </FormHelperText>
            ) : null}
            {template?.hint ? (
              <FormHelperText sx={{ mx: 1.5 }}>{template.hint}</FormHelperText>
            ) : null}
          </Box>

          {/*
            Said with the window, not announced over it: a note, not an alert. Outlined on the
            paper, so it does not read as a field: the box of the instructions above is filled.
          */}
          <Alert
            severity="warning"
            variant="outlined"
            role="note"
            icon={<AppIcon name="warning" size={18} />}
            sx={{
              bgcolor: 'transparent',
              borderColor: 'divider',
              borderRadius: '14px',
              color: 'text.primary',
              '& .MuiAlert-icon': { color: 'warning.main' },
            }}
          >
            {nbsp(scheduleDialogTexts.warning)}
          </Alert>

          <Box component="fieldset" sx={{ m: 0, p: 0, border: 0, minWidth: 0 }}>
            <Typography
              component="legend"
              id={whenId}
              variant="body2"
              sx={{ p: 0, mb: 1.5, fontWeight: 500 }}
            >
              {scheduleDialogTexts.when}
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {form.triggers.map((draft, index) => (
                <Box
                  key={draft.key}
                  sx={
                    index > 0
                      ? { pt: 2, borderTop: 1, borderColor: 'divider', borderTopStyle: 'dashed' }
                      : undefined
                  }
                >
                  <TriggerFields
                    draft={draft}
                    index={index + 1}
                    frequencies={frequencies}
                    timezone={form.timezone}
                    now={now}
                    error={problems.triggers[draft.key] ?? null}
                    removable={index > 0}
                    onChange={(next) =>
                      change({
                        triggers: form.triggers.map((each) =>
                          each.key === next.key ? next : each,
                        ),
                      })
                    }
                    onRemove={() =>
                      change({ triggers: form.triggers.filter((each) => each.key !== draft.key) })
                    }
                  />
                </Box>
              ))}
            </Box>
            {canAddTrigger(form) ? (
              <Button
                onClick={() =>
                  change({ triggers: [...form.triggers, addedTriggerDraft(form, now)] })
                }
                startIcon={<AppIcon name="plus" size={16} />}
                sx={{ mt: 1.25, ml: -1, minHeight: 40, px: 1.25 }}
              >
                {scheduleDialogTexts.addTime}
              </Button>
            ) : null}
            {scheduleError ? (
              <FormHelperText id={scheduleErrorId} error role="alert" sx={{ mx: 0, mt: 1 }}>
                {scheduleError}
              </FormHelperText>
            ) : null}
            {/* Always there, so a change is announced; empty while the schedules say nothing. */}
            <Box aria-live="polite" sx={{ mt: 1.25 }}>
              {nextRunLine === null ? null : (
                <Typography
                  variant="body2"
                  sx={{ display: 'flex', alignItems: 'center', gap: 0.75, fontWeight: 500 }}
                >
                  <Box component="span" aria-hidden sx={{ display: 'flex', color: 'primary.main' }}>
                    <AppIcon name="timer" size={16} />
                  </Box>
                  {nextRunLine}
                </Typography>
              )}
            </Box>
          </Box>

          <ScheduleCostLine triggers={triggers} timezone={form.timezone} />

          {/*
            The switch in its column, its label and what is said under it in the next: the hint
            and the push of this browser start where the label does, in one quiet style.
          */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'auto minmax(0, 1fr)',
              alignItems: 'center',
              ml: -1,
            }}
          >
            <Switch
              id={notifyId}
              checked={form.notify}
              onChange={(event) => change({ notify: event.target.checked })}
              slotProps={{ input: { 'aria-describedby': notifyHintId } }}
            />
            <Typography
              component="label"
              htmlFor={notifyId}
              sx={{ fontSize: 15, lineHeight: 1.5, cursor: 'pointer' }}
            >
              {scheduleDialogTexts.notify}
            </Typography>
            <Box
              data-notify-notes=""
              sx={{ gridColumn: 2, display: 'flex', flexDirection: 'column', gap: 1.25 }}
            >
              <Typography id={notifyHintId} variant="body2" sx={{ color: 'text.secondary' }}>
                {nbsp(scheduleDialogTexts.notifyHint)}
              </Typography>
              {form.notify ? <BrowserPushControl /> : null}
            </Box>
          </Box>

          <Box>
            <ButtonBase
              aria-expanded={more}
              aria-controls={moreId}
              onClick={() => setMore(!more)}
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.75,
                minHeight: 40,
                px: 1,
                ml: -1,
                borderRadius: '10px',
                fontSize: 14,
                fontWeight: 500,
                color: 'text.secondary',
                '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
                '&.Mui-focusVisible': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: 2,
                },
              }}
            >
              <Box
                component="span"
                aria-hidden
                sx={{
                  display: 'flex',
                  transform: more ? 'rotate(90deg)' : 'none',
                  transition: 'transform 150ms ease',
                  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                }}
              >
                <AppIcon name="chevron" size={16} />
              </Box>
              {scheduleDialogTexts.more}
            </ButtonBase>
            <Collapse in={more} id={moreId}>
              <TextField
                select
                size="small"
                label={scheduleDialogTexts.timezone}
                value={form.timezone}
                onChange={(event) => {
                  setZoneTouched(true)
                  change({ timezone: event.target.value })
                }}
                sx={{ mt: 1.5, width: { xs: '100%', sm: 320 } }}
                slotProps={{
                  select: { MenuProps: { slotProps: { paper: { sx: { maxHeight: 360 } } } } },
                }}
              >
                {zones.map((zone) => (
                  <MenuItem key={zone.id} value={zone.id}>
                    {zone.label}
                  </MenuItem>
                ))}
              </TextField>
            </Collapse>
          </Box>
        </Box>
      </Box>

      <Box
        sx={(theme) => ({
          // Above the body: its shadow falls on what scrolls under it.
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 1,
          px: { xs: 2, sm: 3 },
          pt: 2,
          pb: phone ? 'max(16px, env(safe-area-inset-bottom))' : 3,
          borderTop: 1,
          borderColor: 'divider',
          // More of the form below: the end of the window is not where it looks finished.
          boxShadow: moreBelow ? '0 -8px 16px -4px rgba(0, 0, 0, 0.12)' : 'none',
          transition: 'box-shadow var(--raditi-motion-fast) var(--raditi-ease-out)',
          ...(moreBelow
            ? theme.applyStyles('dark', { boxShadow: '0 -8px 16px -4px rgba(0, 0, 0, 0.5)' })
            : {}),
          '& > *': phone ? { flex: '1 1 0' } : {},
        })}
      >
        <Button onClick={onClose} disabled={pending}>
          {scheduleDialogTexts.cancel}
        </Button>
        {/* Never disabled: with a place left to fill in it says why at the field (Зп59). */}
        <Button type="submit" variant="contained" loading={pending}>
          {opening.kind === 'edit' ? scheduleDialogTexts.save : scheduleDialogTexts.create}
        </Button>
      </Box>
    </Box>
  )
}

/**
 * Puts the focus on the first place of a template left to fill in, `[впишите …]`, and selects it:
 * what the client types writes it over (Зп59). Whether there was one.
 */
function selectPlaceholder(field: HTMLTextAreaElement | null): boolean {
  const range = field === null ? null : scheduleTemplatePlaceholderRange(field.value)
  if (field === null || range === null) return false
  field.focus()
  field.setSelectionRange(range.start, range.end)
  return true
}

/**
 * Whether the body of the window has more above and below what it shows: its form scrolls between
 * the title and the buttons, and with no cue a fold in a gap of the form looks like its end — a
 * line under the title once it is scrolled, a shadow over the buttons while more is below. Read on
 * a scroll and whenever the body or its content changes size (a field opens, a time is added, an
 * error comes).
 */
function useScrollEdges() {
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const [edges, setEdges] = useState({ scrolled: false, moreBelow: false })
  const measure = useCallback(() => {
    if (box === null) return
    const scrolled = box.scrollTop > 0
    // A pixel of rounding is not more of the form.
    const moreBelow = box.scrollTop + box.clientHeight < box.scrollHeight - 1
    setEdges((was) =>
      was.scrolled === scrolled && was.moreBelow === moreBelow ? was : { scrolled, moreBelow },
    )
  }, [box])
  useEffect(() => {
    if (box === null || typeof ResizeObserver === 'undefined') return
    // Its first report comes as soon as it observes: the window is measured as it opens.
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    if (content !== null) observer.observe(content)
    return () => observer.disconnect()
  }, [box, content, measure])
  return { setScrollBox: setBox, setScrollContent: setContent, measureScroll: measure, ...edges }
}

/**
 * «Новая запланированная задача» and «Изменить задачу» (docs/plan/82-scheduled-tasks.md, Зп7–Зп10,
 * Зп12, Зп28, Зп30, Зп36, Зп55, Зп56, Зп59): the name; the instructions with «Размышление» in the
 * same frame; the warning of a run without the client; up to five schedules with the next run said
 * as they change; the cost; the notice and the push of this browser; the zone under «Дополнительные
 * настройки». Full screen on a phone, its buttons at the bottom. A refusal of the server is told by
 * the field it is about, or on top. When it closes, the focus goes back to `returnFocus` — the
 * button the client opened it with, also when that was an item of a menu that is gone.
 */
export function ScheduleDialog({
  opening,
  userId,
  onClose,
  onSaved,
  returnFocus,
}: {
  /** null — closed. */
  opening: ScheduleDialogOpening | null
  userId: string
  onClose: () => void
  onSaved?: (schedule: ScheduleDetail, created: boolean) => void
  returnFocus?: () => HTMLElement | null | undefined
}) {
  const theme = useTheme()
  const phone = useMediaQuery(theme.breakpoints.down('sm'))
  const titleId = useId()
  const busy = useRef(false)
  // The window keeps what it showed while it closes; each opening starts its fields anew.
  const [shown, setShown] = useState<{ opening: ScheduleDialogOpening; key: number } | null>(null)
  if (opening !== null && opening !== shown?.opening)
    setShown({ opening, key: (shown?.key ?? 0) + 1 })
  return (
    <Dialog
      open={opening !== null}
      onClose={() => {
        if (!busy.current) onClose()
      }}
      aria-labelledby={titleId}
      fullScreen={phone}
      maxWidth={false}
      disableRestoreFocus={returnFocus !== undefined}
      slotProps={{
        transition: { onExited: () => returnFocus?.()?.focus() },
        paper: {
          sx: phone
            ? { display: 'flex', flexDirection: 'column' }
            : {
                width: '100%',
                maxWidth: 640,
                maxHeight: 'calc(100% - 48px)',
                m: 3,
                display: 'flex',
                flexDirection: 'column',
                border: 1,
                borderColor: 'divider',
                borderRadius: '14px',
              },
        },
      }}
    >
      {shown ? (
        <ScheduleFormBody
          key={shown.key}
          opening={shown.opening}
          userId={userId}
          phone={phone}
          titleId={titleId}
          busyRef={busy}
          onClose={onClose}
          {...(onSaved ? { onSaved } : {})}
        />
      ) : null}
    </Dialog>
  )
}
