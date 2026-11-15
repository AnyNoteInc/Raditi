import { describe, expect, it } from 'vitest'

import { messageCommand, messageWords, readTelegramUpdate } from './update.ts'

const message = (fields: Record<string, unknown>) => ({
  update_id: 7,
  message: {
    message_id: 1,
    date: 1_794_700_000,
    chat: { id: 42, type: 'private' },
    from: { id: 42, is_bot: false, username: 'client', first_name: 'К' },
    ...fields,
  },
})

describe('readTelegramUpdate', () => {
  it('reads a message of a private chat with its topic and drops unknown fields', () => {
    const update = readTelegramUpdate(
      message({
        text: 'Поменяйте заголовок',
        message_thread_id: 5,
        is_topic_message: true,
        extra: 1,
      }),
    )
    expect(update).toMatchObject({
      updateId: 7,
      kind: 'message',
      message: { text: 'Поменяйте заголовок', message_thread_id: 5 },
    })
  })

  it('takes a voice, a photo and a document', () => {
    const update = readTelegramUpdate(
      message({
        voice: { file_id: 'v1', duration: 70, mime_type: 'audio/ogg' },
        photo: [{ file_id: 'p1', width: 90, height: 90 }],
        document: { file_id: 'd1', file_name: 'прайс.pdf' },
        caption: 'вот',
      }),
    )
    expect(update?.kind).toBe('message')
    if (update?.kind === 'message') expect(messageWords(update.message)).toBe('вот')
  })

  it('skips groups and bots, and reads a press of a button', () => {
    expect(readTelegramUpdate(message({ chat: { id: -5, type: 'group' }, text: 'x' }))?.kind).toBe(
      'other',
    )
    expect(readTelegramUpdate(message({ from: { id: 9, is_bot: true }, text: 'x' }))?.kind).toBe(
      'other',
    )
    expect(
      readTelegramUpdate({
        update_id: 8,
        callback_query: {
          id: 'q',
          from: { id: 42 },
          data: 'stop:1',
          message: { message_id: 3, chat: { id: 42, type: 'private' } },
        },
      }),
    ).toMatchObject({ kind: 'press', press: { data: 'stop:1' } })
  })

  it('keeps the id of an update it cannot read, and refuses what is no update', () => {
    expect(readTelegramUpdate({ update_id: 9, message: { broken: true } })).toEqual({
      updateId: 9,
      kind: 'other',
    })
    expect(readTelegramUpdate({ hello: 1 })).toBeNull()
  })
})

describe('messageCommand', () => {
  const of = (text: string) => {
    const update = readTelegramUpdate(message({ text }))
    if (update?.kind !== 'message') throw new Error('not a message')
    return messageCommand(update.message)
  }

  it('reads a command, its argument and the name of the bot', () => {
    expect(of('/start ABCD2345')).toEqual({ name: 'start', arg: 'ABCD2345' })
    expect(of('/new@raditi_bot')).toEqual({ name: 'new', arg: '' })
    expect(of('просто текст')).toBeNull()
    expect(of('/путь/к/файлу')).toBeNull()
  })
})
