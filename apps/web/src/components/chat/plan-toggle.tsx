'use client'

import ButtonBase from '@mui/material/ButtonBase'
import { useCallback, useSyncExternalStore } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { fieldControl } from './composer'

// «Сначала план» (docs/plan/75-chat-input-output.md, ВВ12): the next words ask the agent for a
// plan before any change. The choice of this viewer is kept in `localStorage`, as «Размышление» is
// (plan 66): a client who plans first plans first in the next chat too. A blocked storage — off.

const KEY = 'raditi-chat-plan'

export const planText = Object.freeze({
  label: 'Сначала план',
  on: 'Сначала план: включено. Агент пришлёт план и ничего не изменит, пока вы его не одобрите',
  off: 'Сначала план: выключено',
  execute: 'Выполнить план',
  revise: 'Поправить план',
  /** The words «Выполнить план» sends: the agent goes on in the same session, with the plan. */
  executeWords: 'Выполните этот план.',
  /** The title of the answer of a pass of «Сначала план». */
  title: 'План',
})

const listeners = new Set<() => void>()
let held: boolean | null = null

function read(): boolean {
  if (held !== null) return held
  try {
    return window.localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function rememberPlan(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? '1' : '0')
    held = null
  } catch {
    held = on
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The remembered choice and its setter; the server draws it off. */
export function useRememberedPlan(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, () => false)
  const choose = useCallback((next: boolean) => rememberPlan(next), [])
  return [on, choose]
}

export function PlanToggle({
  on,
  onChange,
  disabled = false,
}: {
  on: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
}) {
  return (
    <ButtonBase
      aria-pressed={on}
      aria-label={on ? planText.on : planText.off}
      disabled={disabled}
      onClick={() => onChange(!on)}
      sx={{
        ...fieldControl(on ? 'var(--mui-palette-action-selected)' : 'transparent'),
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        pl: 0.875,
        pr: 1,
        borderRadius: '999px',
        fontSize: 13,
        color: on ? 'text.primary' : 'text.secondary',
        whiteSpace: 'nowrap',
        '&:hover': { bgcolor: 'transparent', color: 'text.primary' },
        '&:hover::before': { bgcolor: 'action.hover' },
        '&.Mui-disabled': { opacity: 0.5 },
      }}
    >
      <AppIcon name="contents" size={17} />
      {planText.label}
    </ButtonBase>
  )
}
