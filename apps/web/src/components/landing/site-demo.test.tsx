// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { scenarioIds, scenarios, story } from './landing-story'
import { PHASE_MS } from './motion'
import { initialDemoState, reducer, SiteDemo, type DemoState } from './site-demo'

/** The text as it reads: the matchers below collapse a non-breaking space into a plain one. */
const plain = (text: string) => text.replaceAll('\u00a0', ' ')

/** A short preposition or conjunction before a plain space: a line may end with it. */
const HANGING =
  /(?<![\p{L}\p{N}-])(в|во|с|со|к|ко|о|об|у|и|а|но|на|до|за|по|не|ни|от|из|для|без|при|про|над|под) /iu

const phases = ['preparing', 'review', 'applying', 'applied', 'undone'] as const

describe('demo reducer', () => {
  it('starts a new revision when another scenario is chosen', () => {
    expect(reducer(initialDemoState, { type: 'choose', scenario: 'hours' })).toEqual({
      scenario: 'hours',
      phase: 'preparing',
      revision: 1,
    })
  })

  it('ignores choosing the current scenario in every phase', () => {
    for (const phase of phases) {
      const state: DemoState = { scenario: 'price', phase, revision: 3 }
      expect(reducer(state, { type: 'choose', scenario: 'price' })).toBe(state)
    }
  })

  it('applies only a prepared or an undone change', () => {
    for (const phase of phases) {
      const state: DemoState = { scenario: 'price', phase, revision: 0 }
      const next = reducer(state, { type: 'apply' })
      if (phase === 'review' || phase === 'undone') expect(next.phase).toBe('applying')
      else expect(next).toBe(state)
    }
  })

  it('undoes only an applied change', () => {
    for (const phase of phases) {
      const state: DemoState = { scenario: 'price', phase, revision: 0 }
      const next = reducer(state, { type: 'undo' })
      if (phase === 'applied') expect(next.phase).toBe('undone')
      else expect(next).toBe(state)
    }
  })

  it('finishes the busy phase it was started for', () => {
    const preparing: DemoState = { scenario: 'hours', phase: 'preparing', revision: 2 }
    expect(reducer(preparing, { type: 'finish', revision: 2, phase: 'preparing' }).phase).toBe(
      'review',
    )
    const applying: DemoState = { scenario: 'hours', phase: 'applying', revision: 2 }
    expect(reducer(applying, { type: 'finish', revision: 2, phase: 'applying' }).phase).toBe(
      'applied',
    )
  })

  it('drops a finish that belongs to an older revision or to another phase', () => {
    const state: DemoState = { scenario: 'hours', phase: 'preparing', revision: 2 }
    expect(reducer(state, { type: 'finish', revision: 1, phase: 'preparing' })).toBe(state)
    expect(reducer(state, { type: 'finish', revision: 2, phase: 'applying' })).toBe(state)
  })

  it('lets a choice made while applying win over the pending finish', () => {
    const applying: DemoState = { scenario: 'price', phase: 'applying', revision: 0 }
    const chosen = reducer(applying, { type: 'choose', scenario: 'promotion' })
    expect(chosen).toEqual({ scenario: 'promotion', phase: 'preparing', revision: 1 })
    expect(reducer(chosen, { type: 'finish', revision: 0, phase: 'applying' })).toBe(chosen)
  })
})

describe('SiteDemo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('names the choice of a request, the author of the message and what the demo is', () => {
    render(<SiteDemo />)

    const choice = screen.getByRole('group', { name: 'Выберите, что попросить:' })
    expect(
      within(choice)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(scenarioIds.map((id) => scenarios[id].label))
    expect(screen.getByText('Вы')).toBeInTheDocument()
    expect(screen.getByText('ИИ-помощник для вашего сайта')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Это вымышленная кофейня, просьбы готовые. Попробуйте применить правку и отменить её — ваш сайт не изменится.',
      ),
    ).toBeInTheDocument()
  })

  it('keeps a check mark in every request and shows the choice with aria-pressed', () => {
    render(<SiteDemo />)

    const choice = screen.getByRole('group', { name: 'Выберите, что попросить:' })
    const buttons = within(choice).getAllByRole('button')
    // The mark is in every button, so choosing another request moves nothing; CSS shows it in
    // the pressed one. It is hidden from a screen reader, which hears the pressed state.
    for (const button of buttons) {
      const marks = button.querySelectorAll('svg')
      expect(marks).toHaveLength(1)
      expect(marks[0]).toHaveAttribute('aria-hidden', 'true')
    }
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ])

    fireEvent.click(within(choice).getByRole('button', { name: 'Акция' }))
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
    ])
  })

  it('applies a change after its pause and undoes it at once', () => {
    render(<SiteDemo />)
    expect(screen.getByText('До правки')).toBeInTheDocument()

    const apply = screen.getByRole('button', { name: 'Применить правку' })
    expect(apply).toHaveAttribute('aria-disabled', 'false')
    apply.focus()
    fireEvent.click(apply)
    const busy = screen.getByRole('button', { name: 'Применяю…' })
    // Busy, not disabled: a disabled button would drop the focus of the keyboard. jsdom keeps
    // the focus on a disabled button too, so the attributes are what is checked.
    expect(busy).not.toBeDisabled()
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toHaveFocus()
    // A second click during the pause must neither finish nor undo the change.
    fireEvent.click(busy)
    act(() => {
      vi.advanceTimersByTime(PHASE_MS.applying - 1)
    })
    expect(screen.getByText('До правки')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText('Изменено')).toBeInTheDocument()
    expect(screen.getByText('Готово. В меню уже новая цена.')).toBeInTheDocument()
    const undo = screen.getByRole('button', { name: 'Отменить правку' })
    expect(undo).toHaveAttribute('aria-disabled', 'false')
    expect(undo).toHaveFocus()

    fireEvent.click(undo)
    expect(screen.getByText('Возвращено')).toBeInTheDocument()
    const again = screen.getByRole('button', { name: 'Применить снова' })
    expect(again).toBeEnabled()
    expect(again).toHaveAttribute('aria-disabled', 'false')
  })

  it('tells the change in words, and in the status only while it waits for the decision', () => {
    render(<SiteDemo />)

    expect(screen.getByText('Было:').parentElement).toHaveTextContent(
      `Было: ${plain(story.before)}`,
    )
    expect(screen.getByText('Станет:').parentElement).toHaveTextContent(
      `Станет: ${plain(story.after)}`,
    )
    const status = screen.getByText(/^Подготовил правку/)
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('aria-atomic', 'true')
    expect(status).toHaveTextContent(
      plain(
        `Подготовил правку. Посмотрите: ${story.field}: было ${story.before}, станет ${story.after}.`,
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Применить правку' }))
    expect(status).toHaveTextContent(/^Сохраняю копию и применяю правку…$/)
    act(() => {
      vi.advanceTimersByTime(PHASE_MS.applying)
    })
    // «Готово» must not be followed by the change it has already made.
    expect(plain(status.textContent)).toBe(plain(story.result))
    fireEvent.click(screen.getByRole('button', { name: 'Отменить правку' }))
    expect(status).toHaveTextContent(/^Вернул как было\. Всё под контролем\.$/)
    // The preposition stays with its word: on a narrow phone the status takes two lines.
    expect(status.textContent).toContain('под\u00a0контролем')
    expect(status.textContent).not.toMatch(HANGING)

    fireEvent.click(screen.getByRole('button', { name: 'График' }))
    expect(status).toHaveTextContent(/^Нахожу нужное место на странице…$/)
    act(() => {
      vi.advanceTimersByTime(PHASE_MS.preparing)
    })
    const { hours } = scenarios
    expect(status).toHaveTextContent(
      plain(
        `Подготовил правку. Посмотрите: ${hours.field}: было ${hours.before}, станет ${hours.after}.`,
      ),
    )
  })

  it('puts a sign before the status of a phase, for the eye only', () => {
    render(<SiteDemo />)
    const status = screen.getByText(/^Подготовил правку/)
    const signs = () => [...status.querySelectorAll(':scope > svg, :scope > span:empty')]
    const outline = () => status.querySelector('svg path')?.getAttribute('d')
    // The offer waits for the decision without a sign.
    expect(signs()).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Применить правку' }))
    expect(signs()).toHaveLength(1)
    expect(signs()[0]).toHaveAttribute('aria-hidden', 'true')
    expect(signs()[0]?.localName).toBe('span')
    act(() => {
      vi.advanceTimersByTime(PHASE_MS.applying)
    })
    expect(signs()).toHaveLength(1)
    expect(signs()[0]).toHaveAttribute('aria-hidden', 'true')
    const check = outline()

    // The undo has a sign of its own, the turn back; the region still says one sentence.
    fireEvent.click(screen.getByRole('button', { name: 'Отменить правку' }))
    expect(signs()).toHaveLength(1)
    expect(signs()[0]).toHaveAttribute('aria-hidden', 'true')
    expect(outline()).not.toBe(check)
    // The same turn back as on the action that undid the change.
    expect(outline()).toBe('m9 5-5 5 5 5')
    expect(plain(status.textContent)).toBe('Вернул как было. Всё под контролем.')
  })

  it('draws the value of the field anew when it is changed and when it is returned', () => {
    const { container } = render(<SiteDemo />)
    // The value of the price row in the window of the site: a new node plays its gesture.
    const value = () => container.querySelector('[data-selected="true"] strong')
    const before = value()
    expect(before).toHaveTextContent(plain(story.before))

    fireEvent.click(screen.getByRole('button', { name: 'Применить правку' }))
    // Nothing is drawn anew while the change is only being applied.
    expect(value()).toBe(before)
    act(() => {
      vi.advanceTimersByTime(PHASE_MS.applying)
    })
    const applied = value()
    expect(applied).toHaveTextContent(plain(story.after))
    expect(applied).not.toBe(before)

    fireEvent.click(screen.getByRole('button', { name: 'Отменить правку' }))
    const returned = value()
    expect(returned).toHaveTextContent(plain(story.before))
    expect(returned).not.toBe(applied)
    expect(container.querySelector('[data-phase]')).toHaveAttribute('data-phase', 'undone')

    fireEvent.click(screen.getByRole('button', { name: 'Применить снова' }))
    expect(value()).toBe(returned)
  })

  it('hands the length of a busy phase to the styles of the stage', () => {
    const { container } = render(<SiteDemo />)
    const stage = container.querySelector<HTMLElement>('[data-phase]')
    const length = () => stage?.style.getPropertyValue('--demo-phase')
    // The timer and the animations of a phase read one number; a phase that waits has none.
    expect(length()).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Применить правку' }))
    expect(length()).toBe(`${PHASE_MS.applying}ms`)
    act(() => {
      vi.advanceTimersByTime(PHASE_MS.applying)
    })
    expect(length()).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'График' }))
    expect(length()).toBe(`${PHASE_MS.preparing}ms`)
    act(() => {
      vi.advanceTimersByTime(PHASE_MS.preparing)
    })
    expect(length()).toBe('')
  })

  it('names the window of the site and the chat as groups', () => {
    render(<SiteDemo />)

    const site = screen.getByRole('group', { name: 'Пример сайта кофейни' })
    expect(within(site).getByText('КРОШКА')).toBeInTheDocument()
    const chat = screen.getByRole('group', { name: 'Демонстрационный чат' })
    expect(within(chat).getByRole('button', { name: 'Применить правку' })).toBeInTheDocument()
    // The dot in the header of the chat is a decoration: the name is on the group.
    expect(chat.querySelectorAll('[aria-label]')).toHaveLength(0)
  })

  it('keeps an applied change when its scenario is chosen again', () => {
    render(<SiteDemo />)
    fireEvent.click(screen.getByRole('button', { name: 'Применить правку' }))
    act(() => {
      vi.advanceTimersByTime(PHASE_MS.applying)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Цена' }))
    expect(screen.getByText('Изменено')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Цена' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('prepares another scenario for its pause before offering the change', () => {
    render(<SiteDemo />)
    fireEvent.click(screen.getByRole('button', { name: 'График' }))
    const busy = screen.getByRole('button', { name: 'Готовлю правку…' })
    expect(busy).not.toBeDisabled()
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    // A click before the change is ready applies nothing.
    fireEvent.click(busy)
    act(() => {
      vi.advanceTimersByTime(PHASE_MS.preparing)
    })
    expect(screen.getByRole('button', { name: 'Применить правку' })).toHaveAttribute(
      'aria-disabled',
      'false',
    )
    expect(screen.getByText('До правки')).toBeInTheDocument()
    expect(screen.getByText(plain(scenarios.hours.request))).toBeInTheDocument()
  })
})
