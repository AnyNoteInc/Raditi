import { describe, expect, it } from 'vitest'

import { taskStatuses } from '../tasks/task-status.ts'
import {
  CLOSED_PROJECT_TEXT,
  chatCommandAvailability,
  chatCommandGroupLabel,
  chatCommandIds,
  chatCommandRefusals,
  chatCommandRefusalText,
  chatCommands,
  isCommandToCome,
  matchChatCommands,
  offeredCommandIds,
  parseChatCommand,
  serverCommandIds,
  type ChatCommandFacts,
} from './chat-commands.ts'

const waiting: ChatCommandFacts = {
  taskStatus: 'awaiting_approval',
  repository: true,
  role: 'owner',
  candidate: { status: 'current', baseIsMain: true, checksFailed: false },
  preview: { status: 'ready' },
  releaseInProgress: false,
  undo: null,
  retry: 'nothing_to_retry',
  cancelPending: false,
  browserWrote: false,
  projectClosed: false,
  turnUndo: 'nothing_to_undo',
  turnRewinding: false,
}
const verdict = (facts: ChatCommandFacts) =>
  Object.fromEntries(chatCommandAvailability(facts).map((item) => [item.id, item.refusal]))

describe('the commands of a dialog', () => {
  it('takes nothing but `/cancel` while core closes a chat with a browser (Б24)', () => {
    const pressed = { ...waiting, cancelPending: true, retry: null }
    expect(verdict(pressed)).toMatchObject({
      release: 'finished',
      preview: 'finished',
      reset: 'finished',
      update: 'finished',
      retry: 'finished',
      cancel: null,
    })
    // The same chat before the press: `/release` is on offer.
    expect(verdict({ ...pressed, cancelPending: false }).release).toBeNull()
  })

  // docs/plan/61-chats-first.md, К31: a pass of the agent, as the next words would be.
  describe('`/init`', () => {
    const init = (patch: Partial<ChatCommandFacts>) => verdict({ ...waiting, ...patch }).init

    it('takes a chat with the code that waits, with a candidate or without', () => {
      expect(init({})).toBeNull()
      expect(init({ taskStatus: 'awaiting_user', candidate: null })).toBeNull()
      expect(init({ role: 'member' })).toBeNull()
    })

    it('has nothing to study in a chat without the code', () => {
      expect(init({ repository: false })).toBe('no_repository')
      expect(chatCommandRefusalText.no_repository).toBe('В этом чате нет кода проекта.')
    })

    it('waits for the agent and for a release, and a chat that ended takes none', () => {
      for (const taskStatus of ['queued', 'preparing', 'running'] as const)
        expect(init({ taskStatus })).toBe('busy')
      expect(init({ taskStatus: 'deploying' })).toBe('release_in_progress')
      expect(init({ releaseInProgress: true })).toBe('release_in_progress')
      expect(init({ taskStatus: 'done' })).toBe('finished')
      expect(init({ cancelPending: true })).toBe('finished')
    })
  })

  // docs/plan/61-chats-first.md, К39: the chat of a closed project is read, not worked in.
  describe('of a closed project', () => {
    const closed = { ...waiting, projectClosed: true, retry: null }
    const installed = {
      installedNow: true,
      undone: false,
      expired: false,
      siteReleasing: false,
      siteHeld: false,
      siteActive: false,
    }

    it('refuses every command but «Отменить чат» and «Отменить выпуск»', () => {
      expect(verdict(closed)).toEqual({
        release: 'project_closed',
        preview: 'project_closed',
        reset: 'project_closed',
        update: 'project_closed',
        init: 'project_closed',
        retry: 'project_closed',
        cancel: null,
        undo: 'no_release',
        turn_undo: 'project_closed',
        turn_redo: 'project_closed',
      })
    })

    it('stops what works, and the words of «Отменить выпуск» stay its own', () => {
      const running = { ...closed, taskStatus: 'running' as const }
      expect(verdict(running)).toMatchObject({ cancel: null, release: 'project_closed' })
      expect(verdict({ ...closed, releaseInProgress: true }).cancel).toBe('release_in_progress')
      const done = { ...closed, taskStatus: 'done' as const, undo: installed }
      expect(verdict(done)).toMatchObject({ undo: 'site_inactive', cancel: 'finished' })
    })

    it('closes `/preview` of a chat that has ended, and a press of `/cancel` changes nothing', () => {
      const ended = { ...closed, taskStatus: 'cancelled' as const }
      expect(verdict({ ...ended, projectClosed: false }).preview).toBeNull()
      expect(verdict(ended)).toMatchObject({ preview: 'project_closed', release: 'project_closed' })
      expect(verdict({ ...closed, cancelPending: true })).toMatchObject({
        release: 'project_closed',
        cancel: null,
      })
    })

    it('says one sentence, and a project that is not closed is not refused by it', () => {
      expect(chatCommandRefusalText.project_closed).toBe(CLOSED_PROJECT_TEXT)
      expect(CLOSED_PROJECT_TEXT).toBe('Сайт на паузе или отключён.')
      expect(Object.values(verdict({ ...closed, projectClosed: false }))).not.toContain(
        'project_closed',
      )
    })
  })

  it('lists the nineteen commands of the plan, each with its slash, words and group', () => {
    const release =
      'Установить проверенные изменения на сайт: с резервной копией и проверкой после.'
    const compact = 'Агент заменит длинную историю кратким пересказом и продолжит с ним.'
    const turnUndo =
      'Изменения файлов вернутся. То, что агент сделал на сайте через браузер, останется.'
    expect(
      chatCommandIds.map((id) => {
        const { slash, label, description, group } = chatCommands[id]
        return [id, slash, label, description, group]
      }),
    ).toEqual([
      ['release', '/release', 'Выпустить новую версию', release, 'site'],
      [
        'preview',
        '/preview',
        'Открыть предпросмотр',
        'Показать рабочую копию сайта с изменениями этого чата.',
        'site',
      ],
      [
        'update',
        '/update',
        'Обновить рабочую копию',
        'Перенести изменения этого чата на текущую версию сайта.',
        'site',
      ],
      [
        'reset',
        '/reset',
        'Сбросить данные предпросмотра',
        'Вернуть рабочую копию к последним изменениям агента.',
        'site',
      ],
      [
        'undo',
        '/rollback',
        'Отменить выпуск',
        'Вернуть файлы и записи к версии до выпуска этого чата.',
        'site',
      ],
      [
        'init',
        '/init',
        'Описать проект для агента',
        'Агент изучит код и подготовит правила работы с проектом.',
        'site',
      ],
      ['compact', '/compact', 'Сжать переписку', compact, 'agent'],
      ['turn_undo', '/undo', 'Отменить последний запрос', turnUndo, 'agent'],
      [
        'turn_redo',
        '/redo',
        'Вернуть отменённый запрос',
        'Снова применить то, что вы отменили.',
        'agent',
      ],
      [
        'retry',
        '/retry',
        'Попробовать ещё',
        'Повторить просьбу, на которой работа оборвалась.',
        'agent',
      ],
      ['cancel', '/cancel', 'Отменить чат', 'Завершить чат и остановить агента.', 'agent'],
      ['new', '/new', 'Новый чат', 'Начать другой разговор.', 'chat'],
      ['sessions', '/sessions', 'Все чаты', 'Перейти к списку чатов.', 'chat'],
      // Not «файлом Markdown» of the plan: no Latin in the words of the client (§10).
      ['export', '/export', 'Скачать переписку', 'Сохранить чат текстовым файлом.', 'chat'],
      [
        'models',
        '/models',
        'Модель и размышление',
        'Посмотреть модель и выбрать уровень размышления.',
        'chat',
      ],
      [
        'details',
        '/details',
        'Подробности работы',
        'Показывать или скрывать команды и инструменты агента.',
        'chat',
      ],
      [
        'thinking',
        '/thinking',
        'Размышления агента',
        'Показывать или скрывать ход мыслей агента.',
        'chat',
      ],
      ['themes', '/themes', 'Оформление', 'Светлая, тёмная или как в системе.', 'chat'],
      ['help', '/help', 'Справка', 'Что умеют команды.', 'chat'],
    ])
    expect(Object.values(chatCommandGroupLabel)).toEqual(['Сайт', 'Агент', 'Чат'])
  })

  it('says the refusals of `/undo`, `/redo` and `/compact` in the words of the plan', () => {
    expect(chatCommandRefusalText.nothing_to_undo).toBe('Отменять пока нечего.')
    expect(chatCommandRefusalText.undo_past_update).toBe(
      'Этот запрос отменить нельзя: после него рабочая копия перешла на новую версию сайта.',
    )
    expect(chatCommandRefusalText.content_written).toBe(
      'Этот запрос отменить нельзя: он изменил содержимое сайта.',
    )
    expect(chatCommandRefusalText.nothing_to_redo).toBe('Возвращать нечего.')
    expect(chatCommandRefusalText.nothing_to_compact).toBe('Сжимать пока нечего.')
  })

  it('keeps the commands of the site and `/retry` to a chat with the repository (К27)', () => {
    expect(chatCommandIds.filter((id) => chatCommands[id].needs === 'repository')).toEqual([
      'release',
      'preview',
      'update',
      'reset',
      'undo',
      'init',
      'retry',
    ])
    for (const id of chatCommandIds)
      if (chatCommands[id].group === 'site') expect(chatCommands[id].needs).toBe('repository')
  })

  it('leaves what the page runs by itself to the page: no verdict, no row of the feed', () => {
    expect(serverCommandIds).toEqual(
      chatCommandIds.filter((id) => chatCommands[id].scope === 'server'),
    )
    expect(chatCommandIds.filter((id) => chatCommands[id].scope === 'client')).toEqual([
      'new',
      'sessions',
      'export',
      'models',
      'details',
      'thinking',
      'themes',
      'help',
    ])
    expect(chatCommandAvailability(waiting).map((item) => item.id)).toEqual(offeredCommandIds)
    expect(offeredCommandIds).toEqual(serverCommandIds.filter((id) => !isCommandToCome(id)))
  })

  it('moves «Отменить выпуск» to `/rollback`: `/undo` is the last request now (К28)', () => {
    expect(parseChatCommand('/rollback')).toBe('undo')
    expect(parseChatCommand('/undo')).toBe('turn_undo')
    expect(chatCommands.undo.description).toBe(
      'Вернуть файлы и записи к версии до выпуска этого чата.',
    )
    expect(chatCommands.turn_undo.descriptionPlain).toBe(
      'Агент забудет последний запрос и ответ на него.',
    )
  })

  it('takes `/undo` by the facts of its turn, while nothing works or is released', () => {
    const open: ChatCommandFacts = {
      ...waiting,
      taskStatus: 'awaiting_user',
      repository: false,
      candidate: null,
      preview: null,
      turnUndo: null,
    }
    expect(verdict(open).turn_undo).toBeNull()
    for (const refusal of [
      'nothing_to_undo',
      'undo_past_update',
      'content_written',
      'awaiting_answer',
    ] as const)
      expect(verdict({ ...open, turnUndo: refusal }).turn_undo).toBe(refusal)
    for (const taskStatus of ['queued', 'preparing', 'running'] as const)
      expect(verdict({ ...open, taskStatus }).turn_undo).toBe('busy')
    for (const taskStatus of ['deploying', 'verifying'] as const)
      expect(verdict({ ...open, taskStatus }).turn_undo).toBe('release_in_progress')
    expect(verdict({ ...open, releaseInProgress: true }).turn_undo).toBe('release_in_progress')
    // core is taking a turn back: only the preview and «Отменить чат» stay.
    const rewinding = verdict({ ...open, preview: { status: 'ready' }, turnRewinding: true })
    expect(rewinding).toMatchObject({
      release: 'turn_rewinding',
      update: 'turn_rewinding',
      reset: 'turn_rewinding',
      init: 'turn_rewinding',
      turn_undo: 'turn_rewinding',
      preview: null,
      cancel: null,
    })
    // The agent is not at work then: the words say what is under way.
    expect(chatCommandRefusalText.turn_rewinding).toBe(
      'Подождите: последний запрос ещё отменяется.',
    )
  })

  it('closes `/redo` until its slice, a project that is closed before `/undo` and `/redo`', () => {
    expect(verdict(waiting)).toMatchObject({
      turn_undo: 'nothing_to_undo',
      turn_redo: 'nothing_to_redo',
    })
    // The exception of К39 is the id `undo` of `/rollback`, not `/undo`.
    expect(verdict({ ...waiting, projectClosed: true })).toMatchObject({
      turn_undo: 'project_closed',
      turn_redo: 'project_closed',
    })
    const ended = { ...waiting, taskStatus: 'done' as const }
    expect(verdict(ended)).toMatchObject({ turn_undo: 'finished', turn_redo: 'finished' })
    expect(verdict({ ...waiting, cancelPending: true })).toMatchObject({
      turn_undo: 'finished',
      turn_redo: 'finished',
    })
  })

  it('promises no more of `/cancel` than it does: what happens to the changes depends on the chat', () => {
    expect(chatCommands.cancel.description).toBe('Завершить чат и остановить агента.')
  })

  it('speaks to the client in Russian, without Latin words', () => {
    for (const id of chatCommandIds) {
      expect(chatCommands[id].label).not.toMatch(/[A-Za-z]/)
      expect(chatCommands[id].description).not.toMatch(/[A-Za-z]/)
      expect(chatCommands[id].descriptionPlain ?? '').not.toMatch(/[A-Za-z]/)
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
    expect(matchChatCommands('re')).toEqual([])
  })

  it('finds a command by its slash and its other words, not by its id', () => {
    expect(matchChatCommands('/re')).toEqual(['release', 'reset', 'turn_redo', 'retry', 'sessions'])
    expect(matchChatCommands('/turn')).toEqual([])
    expect(matchChatCommands('/ro')).toEqual(['undo'])
    expect(matchChatCommands('/MO')).toEqual(['models'])
    expect(['/summarize', '/clear', '/resume', '/continue', '/mo'].map(parseChatCommand)).toEqual([
      'compact',
      'new',
      'sessions',
      'sessions',
      'models',
    ])
    expect(parseChatCommand('/turn_undo')).toBeNull()
  })
})

describe('availability', () => {
  it('offers everything but «update» to an owner looking at a fresh candidate', () => {
    expect(verdict(waiting)).toEqual({
      release: null,
      preview: null,
      reset: null,
      update: 'up_to_date',
      init: null,
      retry: 'nothing_to_retry',
      cancel: null,
      undo: 'no_release',
      turn_undo: 'nothing_to_undo',
      turn_redo: 'nothing_to_redo',
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
    // Asked for while it is made, the preview is shown once it is ready; nothing to reset in it yet.
    expect(verdict({ ...waiting, preview: { status: 'building' } })).toMatchObject({
      preview: null,
      reset: 'preview_not_ready',
    })
    expect(verdict({ ...waiting, preview: { status: 'pending' } }).preview).toBe(null)
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
        init: 'finished',
        retry: 'finished',
        cancel: 'finished',
        undo: 'no_release',
        turn_undo: 'finished',
        turn_redo: 'finished',
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
        offeredCommandIds.length,
      )
  })
})
