import { signupGiftCredits } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { mailKinds, type MailData, type MailKind } from './schemas.ts'
import { renderTemplate } from './index.ts'
import { signupGiftLine } from './welcome.ts'

const EXPIRES_AT = '2026-09-26T18:00:00.000Z' // 21:00 in Moscow

const samples: MailData = {
  'verify-email': {
    url: 'https://raditi.ru/api/auth/verify-email?token=abc&callbackURL=%2Fapp',
    expiresAt: EXPIRES_AT,
  },
  'reset-password': {
    url: 'https://raditi.ru/reset-password?token=xyz',
    expiresAt: EXPIRES_AT,
  },
  welcome: { name: 'Анна', appUrl: 'https://raditi.ru/app' },
  'payment-succeeded': {
    item: 'plan',
    planName: 'Бизнес',
    amount: '12900.00',
    periodEnd: '2026-10-18T09:30:00.000Z',
    credits: 800,
    appUrl: 'https://raditi.ru',
  },
  'renewal-notice': {
    planName: 'Бизнес',
    amount: '12900.00',
    chargeAt: '2026-10-18T09:30:00.000Z',
    paymentMethod: 'Карта «Мир» ••\u00a04444',
    appUrl: 'https://raditi.ru',
  },
  'payment-failed': {
    planName: 'Бизнес',
    amount: '12900.00',
    paymentMethod: 'Карта «Мир» ••\u00a04444',
    giftCreditsLeft: 35,
    appUrl: 'https://raditi.ru',
  },
  'subscription-ended': {
    planName: 'Бизнес',
    endedAt: '2026-10-18T09:30:00.000Z',
    packCreditsLeft: 7,
    giftCreditsLeft: 35,
    appUrl: 'https://raditi.ru',
  },
  'chat-waiting': {
    kind: 'question',
    url: 'https://raditi.ru/chats/0199a3f2-0000-7000-8000-000000000001',
    settingsUrl: 'https://raditi.ru/settings',
  },
  'artifact-notice': {
    kind: 'artifact_comment',
    url: 'https://raditi.ru/artifacts/0199a3f2-0000-7000-8000-000000000001',
    settingsUrl: 'https://raditi.ru/settings',
  },
  'artifact-invite': {
    inviterName: 'Анна Петрова',
    kindWord: 'документ',
    url: 'https://raditi.ru/artifacts?invites=1',
  },
}

function linkOf(kind: MailKind): string {
  const data = samples[kind]
  if ('url' in data) return data.url
  // The welcome letter opens the app itself, the billing letters its «Тарифы» page.
  return kind === 'welcome' ? data.appUrl : `${data.appUrl}/settings/plans`
}

describe.each(mailKinds)('%s', (kind) => {
  const out = renderTemplate(kind, samples[kind])

  it('starts with a greeting in both versions', () => {
    expect(out.text).toMatch(/^Здравствуйте(, Анна)?!/)
    expect(out.html).toContain('Здравствуйте')
  })

  it('puts the link into the text and an escaped href into the HTML', () => {
    const link = linkOf(kind)
    expect(out.text).toContain(link)
    expect(out.html).toContain(`href="${link.replaceAll('&', '&amp;')}"`)
  })

  it('is a complete Russian HTML document', () => {
    expect(out.html).toMatch(/^<!doctype html><html lang="ru">/)
    expect(out.html).toContain(`<title>${out.subject}</title>`)
  })

  it('greets without a name when the name is empty', () => {
    const anonymous = renderTemplate(kind, { ...samples[kind], name: '  ' })
    expect(anonymous.text.startsWith('Здравствуйте!')).toBe(true)
  })
})

describe.each(['verify-email', 'reset-password'] as const)('%s with a one-time link', (kind) => {
  it('never shows the name, even when a payload still carries one', () => {
    // An outbox row written before names were dropped from these letters.
    const data = { ...samples[kind], name: 'Анна' } as unknown as MailData[typeof kind]
    const out = renderTemplate(kind, data)
    expect(out.text.startsWith('Здравствуйте!')).toBe(true)
    expect(out.text).not.toContain('Анна')
    expect(out.html).not.toContain('Анна')
  })
})

describe('welcome greeting', () => {
  const greet = (name: string) =>
    renderTemplate('welcome', { name, appUrl: 'https://raditi.ru/app' }).text.split('\n')[0]

  it.each([
    ['Анна', 'Анна'],
    ['  Анна   Мария ', 'Анна Мария'],
    ['Анна-Мария', 'Анна-Мария'],
    ["O'Brien", "O'Brien"],
    ['ООО «Ромашка»', 'ООО «Ромашка»'],
    ['Иван И. Петров', 'Иван И. Петров'],
    ['Кафе 2000', 'Кафе 2000'],
    ['Я'.repeat(100), 'Я'.repeat(100)],
  ])('greets %j by name', (name, shown) => {
    expect(greet(name)).toBe(`Здравствуйте, ${shown}!`)
  })

  it.each([
    ['too long', 'Я'.repeat(101)],
    ['two lines', 'Анна\nВаш аккаунт заблокирован'],
    ['a line separator', 'Анна\u2028Ваш аккаунт заблокирован'],
    ['a tab', 'Анна\tМария'],
    ['a link', 'Анна, зайдите на https://evil.example'],
    ['a bare domain', 'Анна, зайдите на evil.ru'],
    ['a Cyrillic domain', 'поддержка-радити.рф'],
    ['a fullwidth dot', 'evil．ru'],
    ['an email', 'support@evil.ru'],
    ['a fullwidth at sign', 'support＠evil'],
    ['a phone number', 'Позвоните 8 800 555-35-35'],
    ['a bidi override', 'Анна\u202Eur.live'],
    ['a zero-width space', 'Ан\u200Bна'],
    ['markup', '<b>Анна</b>'],
    ['only spaces', '   '],
  ])('greets without the name when it has %s', (_case, name) => {
    expect(greet(name)).toBe('Здравствуйте!')
  })
})

describe('welcome letter', () => {
  const out = renderTemplate('welcome', samples.welcome)
  const gift =
    'Мы дарим вам 50 кредитов, чтобы попробовать: их хватит на десять небольших задач или на три-пять задач побольше.'

  it('says how the service works and tells of the gift of the registration, in this order', () => {
    // The footer of every letter follows.
    expect(out.text.split('\n\n').slice(0, 5)).toEqual([
      'Здравствуйте, Анна!',
      'Спасибо, что выбрали Радити.',
      'Напишите в чате обычными словами, что нужно сделать: найти и сравнить, написать письмо, собрать таблицу или страницу. Радити сделает и покажет результат.',
      gift,
      'Личный кабинет: https://raditi.ru/app',
    ])
    expect(out.html).toContain(gift)
    expect(out.html.indexOf('покажем результат')).toBeLessThan(out.html.indexOf(gift))
  })

  it('takes the number of the gift from the domain, and the promise from that number', () => {
    expect(signupGiftCredits).toBe(50)
    expect(signupGiftLine()).toBe(gift)
    expect(signupGiftLine(signupGiftCredits)).toBe(gift)
  })

  it.each([
    [
      30,
      'Мы дарим вам 30 кредитов, чтобы попробовать: их хватит на шесть небольших задач или на две-три задачи побольше.',
    ],
    [
      21,
      'Мы дарим вам 21 кредит, чтобы попробовать: его хватит на четыре небольшие задачи или на одну-две задачи побольше.',
    ],
    [
      22,
      'Мы дарим вам 22 кредита, чтобы попробовать: их хватит на четыре небольшие задачи или на одну-две задачи побольше.',
    ],
    [5, 'Мы дарим вам 5 кредитов, чтобы попробовать: их хватит на одну небольшую задачу.'],
    // Below the charge of a small edit nothing is promised about what it is enough for.
    [3, 'Мы дарим вам 3 кредита, чтобы попробовать.'],
    [
      1200,
      'Мы дарим вам 1\u00a0200 кредитов, чтобы попробовать: их хватит на 240 небольших задач или на 80-110 задач побольше.',
    ],
  ])('would say of a gift of %i credits: %s', (credits, line) => {
    expect(signupGiftLine(credits)).toBe(line)
  })

  it('never counts «правки» as the unit and promises no price', () => {
    // «Правка» here is the change on the site; the unit is «кредит».
    expect(out.text).not.toMatch(/\d\s*правк/)
    expect(out.text).not.toMatch(/₽|руб|бесплатн/i)
  })
})

describe('link lifetime', () => {
  it('shows the Moscow time when the link expires', () => {
    const out = renderTemplate('verify-email', samples['verify-email'])
    expect(out.text).toContain('Ссылка действует до 26.09.2026, 21:00 по московскому времени.')
    expect(out.html).toContain('26.09.2026, 21:00')
  })

  it('omits the line when the expiry is unknown', () => {
    const { expiresAt: _expiresAt, ...data } = samples['reset-password']
    const out = renderTemplate('reset-password', data)
    expect(out.text).not.toContain('Ссылка действует')
  })
})

describe('escaping', () => {
  it('escapes the name in HTML and keeps the text version as is', () => {
    const out = renderTemplate('welcome', {
      name: '"Ромашка" & Ко',
      appUrl: 'https://raditi.ru/app',
    })
    expect(out.html).toContain('Здравствуйте, &quot;Ромашка&quot; &amp; Ко!')
    expect(out.text).toContain('Здравствуйте, "Ромашка" & Ко!')
  })

  it('leaves a name with markup out entirely', () => {
    const out = renderTemplate('welcome', {
      name: '<script>alert("x")</script>',
      appUrl: 'https://raditi.ru/app',
    })
    expect(out.html).not.toContain('script')
    expect(out.text).not.toContain('script')
  })

  it('escapes quotes inside a link so it cannot break out of href', () => {
    const out = renderTemplate('verify-email', {
      url: `https://raditi.ru/verify?token="><img src=x onerror=alert(1)>`,
    })
    expect(out.html).not.toContain('<img')
    expect(out.html).toContain('href="https://raditi.ru/verify?token=&quot;&gt;&lt;img')
  })

  it('rejects links that are not http(s)', () => {
    expect(() => renderTemplate('verify-email', { url: 'javascript:alert(1)' })).toThrow()
    expect(() => renderTemplate('welcome', { name: 'Анна', appUrl: 'data:text/html,hi' })).toThrow()
  })
})

describe('the letter of a chat that waits (docs/plan/75, ВВ9)', () => {
  it('says what happened in our own words for each kind, and links to the chat and the settings', () => {
    for (const kind of ['answered', 'question', 'ready', 'failed', 'limit'] as const) {
      const out = renderTemplate('chat-waiting', { ...samples['chat-waiting'], kind })
      expect(out.subject.length).toBeGreaterThan(0)
      expect(out.text).toContain(samples['chat-waiting'].url)
      expect(out.text).toContain('https://raditi.ru/settings')
      expect(out.html).toContain('Открыть чат')
    }
  })
})

describe('the letter of a scheduled task (docs/plan/82-scheduled-tasks.md, Зп38, Зп39)', () => {
  const task = 'https://raditi.ru/scheduled/0199a3f2-0000-7000-8000-000000000002'

  it('says a pass of a run is of a scheduled task, and keeps a chat of the client as it was', () => {
    const plain = renderTemplate('chat-waiting', { ...samples['chat-waiting'], kind: 'question' })
    expect(plain.subject).toBe('Агент задал вопрос в вашем чате')
    const question = renderTemplate('chat-waiting', {
      ...samples['chat-waiting'],
      kind: 'question',
      scheduled: true,
    })
    expect(question.subject).toBe('Запланированной задаче нужен ваш ответ')
    expect(question.html).toContain('Открыть чат')
    const failed = renderTemplate('chat-waiting', {
      ...samples['chat-waiting'],
      kind: 'failed',
      scheduled: true,
    })
    expect(failed.subject).toBe('Запланированная задача не выполнена')
    expect(failed.text).toContain(samples['chat-waiting'].url)
  })

  it('links a notice of the task itself to its page, in our own words alone', () => {
    const subjects = {
      not_started: 'Запланированная задача не запустилась',
      paused: 'Запланированная задача приостановлена',
      missed: 'Запланированная задача пропустила запуск',
    } as const
    for (const [kind, subject] of Object.entries(subjects) as [keyof typeof subjects, string][]) {
      const out = renderTemplate('chat-waiting', {
        kind,
        url: task,
        settingsUrl: 'https://raditi.ru/settings',
      })
      expect(out.subject).toBe(subject)
      expect(out.text).toContain(`Открыть задачу: ${task}`)
      expect(out.html).toContain('Открыть задачу')
      expect(out.html).not.toContain('Открыть чат')
    }
  })

  it('takes no name of a task: the letter has no field for the words of the client (ВВ9)', () => {
    expect(() =>
      renderTemplate('chat-waiting', {
        kind: 'paused',
        url: task,
        settingsUrl: 'https://raditi.ru/settings',
        // @ts-expect-error — a name is not a field of the letter
        name: 'Проверка сайта',
      }),
    ).not.toThrow()
    const out = renderTemplate('chat-waiting', {
      kind: 'paused',
      url: task,
      settingsUrl: 'https://raditi.ru/settings',
      // @ts-expect-error — a name is not a field of the letter
      name: 'Проверка сайта',
    })
    expect(out.text).not.toContain('Проверка сайта')
    expect(out.html).not.toContain('Проверка сайта')
  })
})

describe('the invitation to an artifact (plan 88, Ар35)', () => {
  it('names the inviter only when it is safe, and never a title', () => {
    const named = renderTemplate('artifact-invite', samples['artifact-invite'])
    expect(named.subject).toBe('Анна Петрова приглашает вас в Радити')
    expect(named.text).toContain('Анна Петрова приглашает вас открыть документ в Радити')
    const crafted = renderTemplate('artifact-invite', {
      ...samples['artifact-invite'],
      inviterName: 'Служба безопасности evil.ru',
    })
    expect(crafted.subject).toBe('Вас приглашают в Радити')
    expect(crafted.text).not.toContain('evil.ru')
    expect(crafted.text).toContain('Вас приглашают открыть документ в Радити')
  })
})
