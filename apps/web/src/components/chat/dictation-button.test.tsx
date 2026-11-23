// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as Dictation from './dictation'
import { DictationAvailable, DictationButton, withDictatedWords } from './dictation-button'

// The microphone of the fields of notes (docs/plan/88-artifacts.md, Ар53; docs/plan/75, ВВ16).

const hook = vi.hoisted(() => ({
  state: 'idle' as 'idle' | 'recording' | 'recognizing',
  start: vi.fn(async () => {}),
  finish: vi.fn(async (): Promise<string | null> => 'добавить цены'),
}))

vi.mock('./dictation', async (original) => ({
  ...(await original<typeof Dictation>()),
  useDictation: () => ({
    state: hook.state,
    seconds: 3,
    notice: null,
    levels: [],
    start: hook.start,
    finish: hook.finish,
  }),
}))

afterEach(() => {
  hook.state = 'idle'
  hook.start.mockClear()
})

describe('the microphone of a field of notes', () => {
  it('is not there where dictation is not set up', () => {
    render(<DictationButton onWords={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Надиктовать' })).toBeNull()
  })

  it('starts a recording, then gives the words when it stops', async () => {
    const onWords = vi.fn()
    const { rerender } = render(
      <DictationAvailable.Provider value>
        <DictationButton onWords={onWords} />
      </DictationAvailable.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Надиктовать' }))
    expect(hook.start).toHaveBeenCalled()
    hook.state = 'recording'
    rerender(
      <DictationAvailable.Provider value>
        <DictationButton onWords={onWords} />
      </DictationAvailable.Provider>,
    )
    expect(screen.getByRole('status').textContent).toBe('Идёт запись, 3 с')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Остановить запись' }))
    })
    expect(onWords).toHaveBeenCalledWith('добавить цены')
  })

  it('puts the words after what is written, a space between', () => {
    expect(withDictatedWords('', 'цены')).toBe('цены')
    expect(withDictatedWords('Проверить  \n', 'цены')).toBe('Проверить цены')
  })
})
