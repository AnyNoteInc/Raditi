import { afterEach, describe, expect, it } from 'vitest'

import { forgetNewDialog, isNewDialog, markNewDialog, NEW_DIALOG_MS } from './new-dialog-hint'

const TASK = '0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17'
const OTHER = '0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b18'
const AT = Date.parse('2026-10-29T10:00:00.000Z')

afterEach(() => {
  forgetNewDialog(TASK)
  forgetNewDialog(OTHER)
})

describe('the start of a dialog (docs/plan/59, И3)', () => {
  it('says nothing of a dialog nobody started here', () => {
    expect(isNewDialog(TASK, AT)).toBe(false)
  })

  it('tells the dialog it was started a moment ago, and only that dialog', () => {
    markNewDialog(TASK, AT)
    expect(isNewDialog(TASK, AT + 1_000)).toBe(true)
    expect(isNewDialog(OTHER, AT + 1_000)).toBe(false)
  })

  it('is read, not taken: a second mount of Strict Mode reads the same', () => {
    markNewDialog(TASK, AT)
    expect(isNewDialog(TASK, AT)).toBe(true)
    expect(isNewDialog(TASK, AT)).toBe(true)
  })

  it('speaks for a minute, not longer', () => {
    markNewDialog(TASK, AT)
    expect(isNewDialog(TASK, AT + NEW_DIALOG_MS)).toBe(true)
    expect(isNewDialog(TASK, AT + NEW_DIALOG_MS + 1)).toBe(false)
  })

  it('is forgotten once the first answer is in, and only for its dialog', () => {
    markNewDialog(TASK, AT)
    forgetNewDialog(OTHER)
    expect(isNewDialog(TASK, AT)).toBe(true)
    forgetNewDialog(TASK)
    expect(isNewDialog(TASK, AT)).toBe(false)
  })

  it('holds the latest start alone', () => {
    markNewDialog(TASK, AT)
    markNewDialog(OTHER, AT + 5_000)
    expect(isNewDialog(TASK, AT + 5_000)).toBe(false)
    expect(isNewDialog(OTHER, AT + 5_000)).toBe(true)
  })
})
