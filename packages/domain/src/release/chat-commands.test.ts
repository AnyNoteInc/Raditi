import { describe, expect, it } from 'vitest'

import { taskStatuses } from '../tasks/task-status.ts'
import {
  chatCommandAvailability,
  chatCommandIds,
  chatCommandRefusals,
  chatCommandRefusalText,
  chatCommands,
  matchChatCommands,
  parseChatCommand,
  type ChatCommandFacts,
} from './chat-commands.ts'

const waiting: ChatCommandFacts = {
  taskStatus: 'awaiting_approval',
  role: 'owner',
  candidate: { status: 'current', baseIsMain: true, checksFailed: false },
  preview: { status: 'ready' },
  releaseInProgress: false,
  undo: null,
  retry: 'nothing_to_retry',
}
const verdict = (facts: ChatCommandFacts) =>
  Object.fromEntries(chatCommandAvailability(facts).map((item) => [item.id, item.refusal]))

describe('the commands of a dialog', () => {
  it('lists the seven commands with the labels of the plan', () => {
    expect(chatCommandIds).toEqual([
      'release',
      'preview',
      'reset',
      'update',
      'retry',
      'cancel',
      'undo',
    ])
    expect(
      Object.fromEntries(
        chatCommandIds.map((id) => [chatCommands[id].slash, chatCommands[id].label]),
      ),
    ).toEqual({
      '/release': 'Выпустить новую версию',
      '/preview': 'Открыть предпросмотр',
      '/reset': 'Сбросить данные предпросмотра',
      '/update': 'Обновить рабочую копию',
      '/retry': 'Попробовать ещё',
      '/cancel': 'Отменить диалог',
      '/undo': 'Отменить выпуск',
    })
  })

  it('speaks to the client in Russian, without Latin words', () => {
    for (const id of chatCommandIds) {
      expect(chatCommands[id].label).not.toMatch(/[A-Za-z]/)
      expect(chatCommands[id].description).not.toMatch(/[A-Za-z]/)
    }
    expect(Object.keys(chatCommandRefusalText).sort()).toEqual([...chatCommandRefusals].sort())
    for (const text of Object.values(chatCommandRefusalText)) expect(text).not.toMatch(/[A-Za-z]/)
  })

  it('reads a command only when it is the whole input', () => {
    expect(parseChatCommand('/release')).toBe('release')
    expect(parseChatCommand('  /cancel \n')).toBe('cancel')
    for (const text of ['/release сейчас', 'release', '/Release', '/deploy', ''])
      expect(parseChatCommand(text)).toBeNull()
    expect(matchChatCommands('/')).toEqual([...chatCommandIds])
    expect(matchChatCommands('/re')).toEqual(['release', 'reset', 'retry'])
    expect(matchChatCommands('re')).toEqual([])
  })
})

describe('availability', () => {
  it('offers everything but «update» to an owner looking at a fresh candidate', () => {
    expect(verdict(waiting)).toEqual({
      release: null,
      preview: null,
      reset: null,
      update: 'up_to_date',
      retry: 'nothing_to_retry',
      cancel: null,
      undo: 'no_release',
    })
  })

  // docs/plan/53, «Попробовать ещё (18.10)»: the server's `retryVerdict`, as a command.
  it('offers «Попробовать ещё» by the verdict on the failure of the dialog', () => {
    expect(verdict({ ...waiting, retry: null }).retry).toBeNull()
    expect(verdict({ ...waiting, taskStatus: 'running', retry: 'busy' }).retry).toBe('busy')
    expect(verdict({ ...waiting, taskStatus: 'failed', retry: 'finished' }).retry).toBe('finished')
  })

  it('lets only an owner or an admin release', () => {
    expect(verdict({ ...waiting, role: 'member' }).release).toBe('not_allowed')
    expect(verdict({ ...waiting, role: 'admin' }).release).toBeNull()
  })

  it('wants «update» first when the site moved on', () => {
    const moved = {
      ...waiting,
      candidate: { status: 'current' as const, baseIsMain: false, checksFailed: false },
    }
    expect(verdict(moved)).toMatchObject({ release: 'needs_update', update: null })
    expect(
      verdict({ ...waiting, candidate: { status: 'stale', baseIsMain: true, checksFailed: false } })
        .release,
    ).toBe('needs_update')
  })

  it('waits while the agent works and while a release goes on', () => {
    expect(verdict({ ...waiting, taskStatus: 'running' })).toMatchObject({
      release: 'busy',
      reset: 'busy',
      update: 'busy',
      cancel: null,
    })
    expect(verdict({ ...waiting, taskStatus: 'deploying' })).toMatchObject({
      release: 'release_in_progress',
      cancel: 'release_in_progress',
      preview: null,
    })
  })

  it('has nothing to release without a candidate and nothing to show without a preview', () => {
    expect(verdict({ ...waiting, candidate: null, taskStatus: 'awaiting_user' })).toMatchObject({
      release: 'no_candidate',
      update: 'no_candidate',
    })
    expect(verdict({ ...waiting, preview: null })).toMatchObject({
      preview: 'no_preview',
      reset: 'no_preview',
    })
    // A question of the agent is open beside the candidate: answered first.
    const stale = { status: 'stale' as const, baseIsMain: false, checksFailed: false }
    expect(verdict({ ...waiting, taskStatus: 'awaiting_user', candidate: stale })).toMatchObject({
      release: 'awaiting_answer',
      update: 'awaiting_answer',
      reset: null,
      cancel: null,
    })
    expect(verdict({ ...waiting, preview: { status: 'unavailable' } }).preview).toBe(
      'preview_unavailable',
    )
    expect(verdict({ ...waiting, preview: { status: 'building' } }).preview).toBe(
      'preview_not_ready',
    )
    expect(verdict({ ...waiting, preview: { status: 'failed' } })).toMatchObject({
      preview: 'preview_failed',
      reset: null,
    })
  })

  it('opens a stopped preview, which builds it again, and points a broken one to the reset', () => {
    expect(verdict({ ...waiting, preview: { status: 'expired' } })).toMatchObject({
      preview: null,
      reset: null,
    })
    expect(chatCommandRefusalText.preview_failed).toContain('Сбросьте данные предпросмотра')
    expect(chatCommandRefusalText.preview_failed).not.toContain('готовится')
    // A dialog that has ended resets nothing: its broken preview is just unavailable.
    expect(
      verdict({ ...waiting, taskStatus: 'done', preview: { status: 'failed' } }),
    ).toMatchObject({ preview: 'preview_unavailable', reset: 'finished' })
    expect(
      verdict({ ...waiting, taskStatus: 'done', preview: { status: 'expired' } }).preview,
    ).toBe(null)
  })

  it('closes every command but the preview once the dialog has ended', () => {
    for (const status of ['done', 'failed', 'rolled_back', 'cancelled'] as const)
      expect(verdict({ ...waiting, taskStatus: status })).toEqual({
        release: 'finished',
        preview: null,
        reset: 'finished',
        update: 'finished',
        retry: 'finished',
        cancel: 'finished',
        undo: 'no_release',
      })
  })

  it('undoes the version this dialog installed: once, within seven days, on a free site', () => {
    const installed = {
      ...waiting,
      taskStatus: 'done' as const,
      candidate: null,
      undo: {
        installedNow: true,
        undone: false,
        expired: false,
        siteReleasing: false,
        siteHeld: false,
        siteActive: true,
      },
    }
    const undo = (facts: Partial<ChatCommandFacts>, undoFacts = {}) =>
      verdict({ ...installed, ...facts, undo: { ...installed.undo, ...undoFacts } }).undo
    expect(verdict(installed)).toMatchObject({ undo: null, release: 'finished' })
    expect(undo({ role: 'member' })).toBe('not_allowed')
    expect(undo({ role: 'admin' })).toBeNull()
    expect(undo({}, { undone: true, installedNow: false })).toBe('already_undone')
    expect(undo({}, { installedNow: false })).toBe('not_installed')
    expect(undo({}, { expired: true })).toBe('undo_expired')
    expect(undo({}, { siteReleasing: true })).toBe('release_in_progress')
    expect(undo({}, { siteHeld: true })).toBe('site_held')
    expect(undo({}, { siteActive: false })).toBe('site_inactive')
    // Between the installation and the charge the dialog stands in `verifying` for a moment.
    expect(undo({ taskStatus: 'verifying' })).toBe('busy')
    expect(chatCommandRefusalText.undo_expired).toContain('7 дней')
  })

  it('answers every status of spec §7', () => {
    for (const taskStatus of taskStatuses)
      expect(chatCommandAvailability({ ...waiting, taskStatus })).toHaveLength(
        chatCommandIds.length,
      )
  })
})
