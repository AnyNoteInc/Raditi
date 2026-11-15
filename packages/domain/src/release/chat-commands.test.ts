import { describe, expect, it } from 'vitest'

import { taskStatuses } from '../tasks/task-status.ts'
import {
  chatCommandAvailability,
  chatCommandIds,
  chatCommandRefusalText,
  chatCommands,
  historicFeedCommandIds,
  matchChatCommands,
  parseChatCommand,
  serverCommandIds,
  type ChatCommandFacts,
} from './chat-commands.ts'

const facts = (over: Partial<ChatCommandFacts> = {}): ChatCommandFacts => ({
  taskStatus: 'awaiting_user',
  role: 'owner',
  cancelPending: false,
  turnUndo: null,
  turnRedo: 'nothing_to_redo',
  compaction: true,
  agentBrowser: null,
  compactRefusal: null,
  ...over,
})

const refusal = (f: ChatCommandFacts, id: string) =>
  chatCommandAvailability(f).find((item) => item.id === id)?.refusal ?? null

describe('the commands of a chat (plan 83, БП7)', () => {
  it('has no command of a site: they went with projects', () => {
    for (const gone of ['release', 'preview', 'update', 'reset', 'undo', 'init', 'retry'])
      expect(chatCommandIds).not.toContain(gone)
    expect(serverCommandIds).toEqual(['compact', 'turn_undo', 'turn_redo', 'cancel'])
    expect(new Set(Object.values(chatCommands).map((command) => command.group))).toEqual(
      new Set(['agent', 'chat']),
    )
  })

  it('reads the rows of the feed written with the commands of a site', () => {
    for (const id of ['release', 'undo', 'init', ...serverCommandIds])
      expect(historicFeedCommandIds).toContain(id)
  })

  it('takes `/compact`, `/undo` and `/cancel` while the chat waits', () => {
    const verdicts = chatCommandAvailability(facts())
    expect(verdicts.filter((item) => item.available).map((item) => item.id)).toEqual([
      'compact',
      'turn_undo',
      'cancel',
    ])
    expect(refusal(facts(), 'turn_redo')).toBe('nothing_to_redo')
    expect(refusal(facts({ turnRedo: null }), 'turn_redo')).toBeNull()
  })

  it('waits while the agent works and closes everything once the chat has ended', () => {
    expect(refusal(facts({ taskStatus: 'running' }), 'compact')).toBe('busy')
    expect(refusal(facts({ taskStatus: 'running' }), 'turn_undo')).toBe('busy')
    expect(refusal(facts({ taskStatus: 'running' }), 'cancel')).toBeNull()
    for (const id of serverCommandIds)
      expect(refusal(facts({ taskStatus: 'done' }), id)).toBe('finished')
  })

  it('takes nothing but `/cancel` while core closes a chat with a browser (Б24)', () => {
    const pending = facts({ cancelPending: true })
    expect(refusal(pending, 'cancel')).toBeNull()
    expect(refusal(pending, 'compact')).toBe('finished')
  })

  it('names a driver without the compaction before any other refusal', () => {
    expect(refusal(facts({ compaction: false, taskStatus: 'done' }), 'compact')).toBe(
      'no_compaction',
    )
    expect(refusal(facts({ compactRefusal: 'browser_with_client' }), 'compact')).toBe(
      'browser_with_client',
    )
  })

  it('answers every status of spec §7', () => {
    for (const taskStatus of taskStatuses)
      expect(chatCommandAvailability(facts({ taskStatus }))).toHaveLength(serverCommandIds.length)
  })

  it('speaks to the client in Russian, without Latin words', () => {
    for (const text of [
      ...Object.values(chatCommandRefusalText),
      ...Object.values(chatCommands).flatMap((command) => [command.label, command.description]),
    ])
      expect(text).not.toMatch(/[A-Za-z]/)
  })

  it('reads a command only when it is the whole input, by its slash and its other words', () => {
    expect(parseChatCommand(' /compact ')).toBe('compact')
    expect(parseChatCommand('/summarize')).toBe('compact')
    expect(parseChatCommand('/compact please')).toBeNull()
    expect(parseChatCommand('/release')).toBeNull()
    expect(matchChatCommands('/un')).toEqual(['turn_undo'])
  })
})
