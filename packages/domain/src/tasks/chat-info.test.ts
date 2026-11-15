import { describe, expect, it } from 'vitest'

import { chatInfoLines, tokensShort, type ChatInfo } from './chat-info.ts'

const usage: ChatInfo['usage'] = {
  plan: 'Старт',
  total: 143,
  tariff: 120,
  gift: 23,
  pack: 0,
  week: { limit: 73, used: 30, left: 43, resetsAt: new Date('2026-11-18T11:00:00Z') },
  chat: 12,
}

const info: ChatInfo = {
  usage,
  status: {
    title: 'Новость о скидках',
    status: 'Агент работает',
    model: 'GLM-5.3',
    effort: 'high',
    queued: 2,
    browser: true,
  },
  context: { used: 182_400, window: 1_000_000 },
}

describe('/usage, /status and /context', () => {
  it('tells the credits by account, the week and the chat', () => {
    expect(chatInfoLines('usage', info)).toEqual({
      title: 'Использование',
      lines: [
        'Осталось 143 кредита: тариф «Старт» — 120, подарок — 23.',
        'За неделю потрачено 30 из 73, осталось 43. Лимит обновится 18 ноября в 14:00 по Москве.',
        'Этот чат: 12 кредитов.',
      ],
    })
  })

  it('names the pack without a tariff, and no week or chat when there is none', () => {
    const lines = chatInfoLines('usage', {
      ...info,
      usage: { ...usage, plan: null, total: 50, tariff: 0, gift: 50, week: null, chat: null },
    }).lines
    expect(lines).toEqual(['Осталось 50 кредитов: подарок — 50, пакет — 0.'])
  })

  it('tells where the chat stands', () => {
    expect(chatInfoLines('status', info).lines).toEqual([
      'Чат «Новость о скидках».',
      'Агент работает.',
      'Модель — GLM-5.3, размышление — высокое.',
      'В очереди 2 сообщения — агент возьмёт их, когда закончит.',
      'Браузер агента открыт.',
    ])
    expect(
      chatInfoLines('status', {
        ...info,
        status: {
          ...info.status!,
          title: null,
          model: null,
          queued: 0,
          browser: false,
        },
      }).lines,
    ).toEqual(['Агент работает.', 'Размышление — высокое.'])
    expect(chatInfoLines('status', { ...info, status: null }).lines).toEqual([
      'Чат ещё не начат: напишите, что сделать.',
    ])
  })

  it('measures the context by the last request against the window of its model', () => {
    expect(chatInfoLines('context', info).lines).toEqual([
      'Занято 182 тыс. из 1 млн токенов — 18 %.',
      'Когда контекст заполнится, агент сам сожмёт переписку. Сжать сейчас — команда /compact.',
    ])
    expect(
      chatInfoLines('context', { ...info, context: { used: 900, window: null } }).lines[0],
    ).toBe('Последний запрос агента к модели — 900 токенов.')
    expect(
      chatInfoLines('context', { ...info, context: { used: null, window: null } }).lines,
    ).toEqual(['Агент в этом чате ещё не работал — контекст пуст.'])
  })

  it('writes token counts short', () => {
    expect(tokensShort(850)).toBe('850')
    expect(tokensShort(182_400)).toBe('182 тыс.')
    expect(tokensShort(1_000_000)).toBe('1 млн')
    expect(tokensShort(1_240_000)).toBe('1,2 млн')
  })
})
