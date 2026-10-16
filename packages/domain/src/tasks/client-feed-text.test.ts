import { describe, expect, it } from 'vitest'
import {
  CONTACT_MARKER_SOURCE,
  contactMarkerPattern,
  FEED_REQUEST_TEXT_LIMIT,
  feedText,
  hasVisibleText,
  hiddenContactText,
  isFeedText,
  looksLikeSecret,
} from './client-feed-text.ts'

const id = '3f2b8c1e-5d4a-4b6c-8e7f-9a0b1c2d3e4f'

describe('contact marker contract', () => {
  it('matches the markers the content gateway writes and captures kind and id', () => {
    const text = `a [[raditi:phone:${id}]] b [[raditi:email:${id}]]`
    expect([...text.matchAll(contactMarkerPattern())].map((m) => [m[1], m[2]])).toEqual([
      ['phone', id],
      ['email', id],
    ])
  })

  it('hands out a fresh pattern each time, with no shared lastIndex', () => {
    const first = contactMarkerPattern()
    first.test(`[[raditi:phone:${id}]]`)
    expect(first.lastIndex).toBeGreaterThan(0)
    expect(contactMarkerPattern().lastIndex).toBe(0)
    expect(contactMarkerPattern().source).toBe(new RegExp(CONTACT_MARKER_SOURCE).source)
  })
})

describe('feedText', () => {
  it('replaces masking markers with Russian words', () => {
    const shown = feedText(
      `Позвоните по номеру [[raditi:phone:${id}]] или напишите на [[raditi:email:${id}]].`,
    )
    expect(shown).toBe('Позвоните по номеру (телефон скрыт) или напишите на (почта скрыта).')
    expect(shown).not.toContain('raditi')
    expect(shown).not.toContain('[[')
    expect(shown).not.toContain(id)
  })

  it('hides any other platform marker, also a cut-off one', () => {
    expect(feedText(`Адрес: [[raditi:address:${id}]].`)).toBe(`Адрес: ${hiddenContactText.other}.`)
    expect(feedText('[[raditi:phone:not-a-uuid]]')).toBe(hiddenContactText.other)
    expect(feedText(`[[RADITI:PHONE:${id}]]`)).toBe(hiddenContactText.other)
    expect(feedText(`обрыв [[raditi:phone:${id.slice(0, 10)}`)).toBe('обрыв (скрыто)')
    expect(feedText(`обрыв [[raditi:phone:${id}] дальше`)).toBe('обрыв (скрыто) дальше')
  })

  it.each([
    ['a space inside', '[[raditi:a b]]'],
    ['a single bracket inside', '[[raditi:a]b]]'],
    ['a space after the kind', `[[raditi:phone: ${id}]]`],
    ['a space before the kind', `[[raditi: phone:${id}]]`],
    ['spaces around the name', `[[ raditi :phone:${id}]]`],
    ['a line break inside', `[[raditi:phone:\n${id}]]`],
    ['brackets escaped as in markdown', `\\[\\[raditi:phone:${id}\\]\\]`],
    ['a half-escaped marker', `\\[[raditi:phone:${id}]\\]`],
  ])('hides a malformed marker whole: %s', (_name, marker) => {
    const shown = feedText(`Телефон ${marker} оставил`)
    expect(shown).toBe('Телефон (скрыто) оставил')
    expect(isFeedText(shown)).toBe(true)
    for (const part of ['[[', ']]', '\\', 'raditi', id, id.slice(0, 8)])
      expect(shown).not.toContain(part)
  })

  it('does not run from a cut-off marker across the next one', () => {
    expect(feedText(`x [[raditi:cut и потом [[raditi:address:${id}]] y`)).toBe(
      'x (скрыто) и потом (скрыто) y',
    )
    expect(feedText(`x [[raditi:cut и потом [[raditi:phone:${id}]] y`)).toBe(
      'x (скрыто) и потом (телефон скрыт) y',
    )
    // A closed marker is hidden with all it holds, up to a hundred characters.
    expect(feedText('[[raditi:x и тут два слова]] хвост')).toBe('(скрыто) хвост')
    expect(feedText(`[[raditi:${'я'.repeat(100)}]] хвост`)).toBe('(скрыто) хвост')
    // A longer one counts as cut off: hidden up to the first space.
    expect(feedText(`[[raditi:${'я'.repeat(101)}]] хвост`)).toBe('(скрыто) хвост')
    expect(feedText(`[[raditi:${'я '.repeat(60)}]] хвост`)).toBe(
      `(скрыто) ${'я '.repeat(59)}]] хвост`,
    )
  })

  it('hides a marker with the markers inside it, tail and all', () => {
    // Reproduced in review: the id and the closing brackets of the outer marker stayed.
    expect(feedText(`a [[raditi:pho[[raditi:]]ne:${id}]] b`)).toBe('a (скрыто) b')
    expect(feedText(`a [[raditi:x [[raditi:phone:${id}]] y]] b`)).toBe('a (скрыто) b')
    expect(feedText(`[[raditi:[[raditi:phone:${id}]][[raditi:email:${id}]]]]`)).toBe('(скрыто)')
    expect(feedText('[[raditi:a[[raditi:b[[raditi:c]]d]]e]] хвост')).toBe('(скрыто) хвост')
    expect(feedText(`\\[\\[raditi:a[[ raditi :phone:${id}]]b\\]\\] хвост`)).toBe('(скрыто) хвост')
    // The hundred characters are the marker's own: the markers inside are not counted.
    const inner = `[[raditi:phone:${id}]]`
    expect(feedText(`[[raditi:${'я'.repeat(50)}${inner.repeat(5)}${'я'.repeat(50)}]] b`)).toBe(
      '(скрыто) b',
    )
    expect(feedText(`[[raditi:${'я '.repeat(30)}${inner}${'я '.repeat(30)}]] b`)).toBe(
      `(скрыто) ${'я '.repeat(29)}(телефон скрыт)${'я '.repeat(30)}]] b`,
    )
  })

  it('never reads the words it has put in as a marker', () => {
    // Reproduced in review: the result was «(скрыто) скрыт)».
    expect(feedText(`[[raditi:[[raditi:phone:${id}]]`)).toBe('(скрыто)(телефон скрыт)')
    expect(feedText(`[[raditi:[[raditi:email:${id}]] и дальше`)).toBe(
      '(скрыто)(почта скрыта) и дальше',
    )
    expect(feedText(`[[raditi:x[[raditi:phone:${id}]]`)).toBe('(скрыто)(телефон скрыт)')
    // A `[` that opens no marker leaves the marker around it cut off.
    expect(feedText(`[[raditi:a [b] [[raditi:phone:${id}]] c]]`)).toBe(
      '(скрыто) [b] (телефон скрыт) c]]',
    )
  })

  it.each([
    `a [[raditi:pho[[raditi:]]ne:${id}]] b`,
    `[[raditi:[[raditi:phone:${id}]]`,
    `[[raditi:a[[raditi:b[[raditi:c]]d]]e]]`,
    `[[raditi:a[[raditi:b[[raditi:c]]d]]e`,
    `[[raditi:a]] ]] [[raditi:[[raditi:b ]] ]]`,
    `[[raditi:${'я '.repeat(30)}[[raditi:phone:${id}]]${'я '.repeat(30)}]]`,
  ])('leaves nothing of a nested marker to find on a second pass: %s', (raw) => {
    const shown = feedText(raw)
    expect(isFeedText(shown)).toBe(true)
    expect(shown).not.toMatch(/raditi/iu)
    expect(shown).not.toContain(id)
  })

  it('stays fast on a long run of openers', () => {
    const started = performance.now()
    expect(feedText('[[raditi:'.repeat(20_000))).toBe('(скрыто)'.repeat(20_000))
    expect(feedText(`[[raditi:${'a '.repeat(50_000)}`)).toContain('(скрыто)')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('stays fast on long nested and broken markers', () => {
    const long = [
      // Deep nesting, closed and left open.
      `${'[[raditi:'.repeat(100_000)}${']]'.repeat(100_000)}`,
      `${'[[raditi:a'.repeat(100_000)}${']]'.repeat(50_000)}`,
      // Many ways to close each marker and no way to close the first.
      `[[raditi:${'[[raditi:]]]'.repeat(100_000)}`,
      `[[raditi:${'[[raditi:]]]]]]]]] '.repeat(50_000)}`,
      `[[raditi:${'\\[[raditi:\\]\\]\\'.repeat(60_000)}`,
      '[[raditi:x[[raditi:]]'.repeat(50_000),
      // Spaces around the name, brackets that open nothing, closing pairs alone.
      `[[${' '.repeat(50)}raditi${' '.repeat(50)}`.repeat(10_000),
      `[[raditi:${'[[ '.repeat(300_000)}`,
      `[[raditi:${']]'.repeat(500_000)}`,
      `[[raditi:${'я'.repeat(1_000_000)}]]`,
    ]
    const started = performance.now()
    for (const raw of long)
      expect(feedText(raw).includes('[[raditi:'), raw.slice(0, 30)).toBe(false)
    // Linear work takes about 0.2 s here and 3.4 s on a loaded CI runner; a parse quadratic in
    // these hundreds of thousands of characters would take minutes, so ten seconds still catches it.
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(feedText(long[0] ?? '')).toBe('(скрыто)')
  })

  it('finds a marker split by invisible characters', () => {
    const shown = feedText(`[[rad\u200Biti:pho\u202Ene:${id}]]`)
    expect(shown).toBe(hiddenContactText.phone)
    // Invisible format characters outside the ranges the design lists split a marker as well.
    for (const split of ['\u2060', '\u00AD', '\uFEFF', '\u2064', '\u061C'])
      expect(feedText(`[[rad${split}iti:phone:${id}]]`)).toBe(hiddenContactText.phone)
  })

  it('removes control, invisible and direction-changing characters and keeps line breaks', () => {
    expect(feedText('a\u0000b\u0007c\u007Fd\u0085e')).toBe('abcde')
    expect(feedText('a\u200Bb\u200Fc\u202Ad\u202Ee\u2066f\u2069g')).toBe('abcdefg')
    expect(feedText('первая\nвторая\r\nтретья\rчетвёртая')).toBe(
      'первая\nвторая\nтретья\nчетвёртая',
    )
    expect(feedText('до\tпосле')).toBe('до после')
    expect(feedText('мяг\u00ADкий\u2060 пере\uFEFFнос')).toBe('мягкий перенос')
  })

  it('removes half of a surrogate pair and keeps a whole pair', () => {
    expect(feedText('a\uD83D')).toBe('a')
    expect(feedText('a\uD800b\uDC00c')).toBe('abc')
    expect(feedText('\uDE00\uD83D')).toBe('')
    expect(feedText('a\uD83D\uDE00b')).toBe('a\uD83D\uDE00b')
    expect(feedText('\uD83D\uD83D\uDE00')).toBe('\uD83D\uDE00')
    expect(isFeedText('\uD83D')).toBe(false)
    expect(isFeedText('a\uD800b')).toBe(false)
    expect(isFeedText('a\uD83D\uDE00b')).toBe(true)
    expect(feedText('обрыв\uD83D').isWellFormed()).toBe(true)
  })

  it('normalizes to NFC', () => {
    expect(feedText('й')).toBe('й')
  })

  it('leaves ordinary text alone and is idempotent', () => {
    const plain = 'Готово! Заголовок «О нас» обновлён — проверьте, пожалуйста, https://example.ru'
    expect(feedText(plain)).toBe(plain)
    expect(isFeedText(plain)).toBe(true)
    const raw = `x\u202E [[raditi:phone:${id}]]\r\n[[raditi:other]]\t.`
    expect(feedText(feedText(raw))).toBe(feedText(raw))
    expect(isFeedText(raw)).toBe(false)
    expect(isFeedText(feedText(raw))).toBe(true)
  })

  // A character removed from between a letter and its combining mark leaves the pair to compose.
  it.each([
    ['a zero-width space before an acute', 'e\u200B\u0301', '\u00E9'],
    ['a control character before an acute', 'e\u0001\u0301', '\u00E9'],
    ['a bell before an acute', 'e\u0007\u0301', '\u00E9'],
    ['a zero-width joiner before a breve', '\u0438\u200D\u0306', '\u0439'],
    ['a null before a breve', '\u0438\u0000\u0306', '\u0439'],
    ['a direction override before a breve', '\u0438\u202E\u0306', '\u0439'],
    ['an isolate before a diaeresis', '\u0435\u2066\u0308', '\u0451'],
    ['half a surrogate pair before a diaeresis', '\u0435\uD83D\u0308', '\u0451'],
  ])('composes what a removal brought together: %s', (_name, raw, composed) => {
    expect(feedText(raw)).toBe(composed)
    expect(feedText(feedText(raw))).toBe(feedText(raw))
    expect(isFeedText(feedText(raw))).toBe(true)
  })

  it('keeps a mark apart from a letter when a space stands between them', () => {
    expect(feedText('\u0438\t\u0306')).toBe('\u0438 \u0306')
    expect(isFeedText(feedText('\u0438\t\u0306'))).toBe(true)
  })

  it('is idempotent on every pair and triple of awkward pieces', () => {
    const pieces = [
      'e',
      '\u0438',
      '\u0301',
      '\u0306',
      '\u0323',
      '\u0000',
      '\u0085',
      '\r',
      '\n',
      '\t',
      ' ',
      '\u200B',
      '\u200D',
      '\u202E',
      '\u2060',
      '\u00AD',
      '\uFEFF',
      '\uD83D',
      '\uDE00',
      '\u212B',
      '[[raditi:',
      `[[raditi:phone:${id}]]`,
      '[[',
      ']]',
      ']',
      '\\',
      'raditi:',
      '(',
      '[[ RADITI :',
      '\\]',
      '\\[',
      `[[raditi:email:${id}]`,
      'я'.repeat(101),
    ]
    const broken: string[] = []
    const check = (raw: string) => {
      const once = feedText(raw)
      if (feedText(once) !== once || !once.isWellFormed() || once.includes('[[raditi:')) {
        broken.push(JSON.stringify(raw))
      }
    }
    for (const a of pieces)
      for (const b of pieces) {
        check(a + b)
        for (const c of pieces) check(a + b + c)
      }
    expect(broken).toEqual([])
  })
})

describe('hasVisibleText', () => {
  it('wants something to read: spaces and invisible characters are not enough', () => {
    for (const blank of ['', ' \n\t', '\u200B', '\u200B\u202E\u2066', ' \uFEFF \u00AD\u2060'])
      expect(hasVisibleText(blank), JSON.stringify(blank)).toBe(false)
    for (const text of ['я', 'при\u200Bвет', '\u200B.', '\uD83D\uDC68\u200D\uD83D\uDC69'])
      expect(hasVisibleText(text), JSON.stringify(text)).toBe(true)
  })
})

describe('looksLikeSecret', () => {
  const key = 'sk-abcdefghijklmnopqrstuvwxyz012345'
  const signed =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'

  it.each([
    // A word that reads as a password, whatever stands around it.
    ['a password after a label with a colon', 'Зайдите в админку, пароль: Qwerty123!'],
    ['a password after an inflected label', 'с паролем: Qwerty123'],
    ['a password after a label with a qualifier', 'Пароль от админки: Qwerty123'],
    ['a password after a long dash', 'пароль для входа — Qwerty123'],
    ['a password after a hyphen', 'пароль - Qwerty123'],
    ['a password with no label', 'пароль Qwerty123'],
    ['a password after a name', 'зайди под admin / Qwerty123'],
    ['a label split by an invisible character', 'паро​ль: Qwerty123'],
    ['a label split by a soft hyphen', 'па­роль: Qwerty123'],
    ['an English label glued to a value in two cases', 'DB_PASSWORD=s3cretvalue'],
    // Known key formats.
    ['a private key block', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END'],
    ['a bare private key header', 'вот ключ -----BEGIN PRIVATE KEY----- MIIEv'],
    ['a private key header broken over two lines', '-----BEGIN\nPRIVATE KEY-----'],
    ['a prefixed secret key', key],
    ['a prefixed secret key after a Russian label', `ключ=${key}`],
    ['a prefixed access token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['a prefixed fine-grained token', 'github_pat_abcdefghijklmnopqrst12'],
    ['a prefixed project token', 'glpat-abcdefghijklmnopqrst'],
    ['a prefixed chat token', 'xoxb-1234567890'],
    ['a prefixed cloud key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['a signed token', signed],
    ['a signed token after a Russian label', `токен:${signed}`],
  ])('refuses %s', (_name, text) => {
    expect(looksLikeSecret(text)).toBe(true)
  })

  it.each([
    // The words around a value do not matter, and a word with a Cyrillic letter is no password.
    ['a Russian label glued to its value', 'пароль=Qwerty123'],
    ['a value in Cyrillic', 'пароль: солнышко'],
    ['a label with a value in Cyrillic', 'ключ: зелёный'],
    // One case only.
    ['a value in lowercase with digits', 'пароль: qwerty123'],
    ['a key label with a lowercase value', 'ключ: 9f8e7d6c5b4a'],
    ['a token label with a lowercase value', 'Токен : abcdef123456'],
    ['an English label with a lowercase value', 'password: hunter2000'],
    ['an English label with a qualifier', 'password for admin: hunter22'],
    ['an api key label with a lowercase value', 'api_key = 0123456789abcdef'],
    ['a label with a value of digits', 'ключ: 12345678'],
    ['a label with a value of Latin letters and digits', 'ключ: summer2026'],
    // Shorter than eight characters.
    ['a short label glued to a short value', 'pwd:qwerty1'],
    ['a label with a short value', 'пароль: 12345'],
    // Ordinary requests.
    [
      'a request with a phone, an address and a site',
      'Поменяйте телефон в шапке на +7 (495) 123-45-67, почту на info@example.ru, а ссылку — на https://example.ru/contacts',
    ],
    ['a mail link', 'Сделайте ссылку mailto:info@example.ru в подвале'],
    [
      'a word about passwords without a value',
      'Добавьте на страницу входа ссылку «Забыли пароль?»',
    ],
    ['a label with no separator', 'Ключ от офиса заберите у администратора'],
    ['a word that only contains a label', 'monkey: bananas and more'],
    ['working hours', 'Время работы: 10:00-19:00, без выходных'],
    ['a short prefix look-alike', 'Артикул sk-1234 закончился'],
    ['a price list', 'Цена: 1500 рублей, скидка=10%'],
    ['a page named by the word', 'На странице восстановления пароля: замените текст кнопки'],
    ['a field named by the word', 'Поле пароль: увеличьте шрифт'],
    ['an adjective of the same root', 'Ключевое: поменяйте заголовок на главной'],
    ['a section named by the word', 'Токены: добавьте раздел про токены'],
    ['an English label with Russian words', 'Pass: проверка'],
    ['key words', 'Ключевые слова: wordpress, сайт'],
    ['key words of a page', 'Ключевые слова для страницы: ремонт2026'],
    ['a dash with a word', 'пароль — сложный'],
    ['a dash with a Latin word', 'пароль - required'],
    ['a qualifier and an address', 'Поменяйте пароль на странице входа: https://site.ru/login'],
    ['a field made required', 'Сделайте поле пароль обязательным: required'],
    ['a hyphenated word', 'Замените слово ключ-карта2026 на пропуск'],
  ])('lets through %s', (_name, text) => {
    expect(looksLikeSecret(text)).toBe(false)
  })

  it.each([
    ['seven characters', 'Qwerty1', false],
    ['eight characters', 'Qwerty12', true],
    ['only lowercase letters', 'qwertyui', false],
    ['only uppercase letters', 'QWERTYUI', false],
    ['only digits', '12345678', false],
    ['only special characters', '!@#$%^&*', false],
    ['one lowercase letter among uppercase ones', 'QWERTYu1', true],
    ['one uppercase letter among lowercase ones', 'qwertyU!', true],
    ['letters only, no digit', 'Abcdefgh', true],
    ['special characters with one letter of each case', '!!!!!!aA', true],
    ['the last printable ASCII characters', 'Qwerty~{}|', true],
    ['one Cyrillic letter inside', 'Qwertyя1', false],
    ['one Cyrillic letter at the end', 'Qwerty12я', false],
    ['a full-width Latin letter', 'Ｑwerty123', false],
    // Punctuation stays with its word: ASCII punctuation counts, any other does not.
    ['guillemets around the word', '«Qwerty123»', false],
    ['a long dash after the word', 'Qwerty12—', false],
    ['straight quotes around the word', '"Qwerty123"', true],
    ['brackets around the word', '(Qwerty123)', true],
    ['a full stop after the word', 'Qwerty123.', true],
    ['a full stop that makes the eighth character', 'Qwerty1.', true],
    // Invisible characters are removed before the split.
    ['a zero-width space inside the word', 'Qwer​ty12', true],
    ['a soft hyphen inside the word', 'Qwer­ty12', true],
    ['a zero-width space inside a seven-character word', 'Qwer​ty1', false],
    // What /\s/u matches separates words: tabs, line breaks and the no-break spaces as well.
    ['a space inside', 'Qwer ty12', false],
    ['a tab inside', 'Qwer\tty12', false],
    ['a line break inside', 'Qwer\nty12', false],
    ['a no-break space inside', 'Qwer ty12', false],
    ['a narrow no-break space inside', 'Qwer ty12', false],
    ['tabs around the word', 'a\tQwerty123\tb', true],
    ['line breaks around the word', 'a\nQwerty123\r\nb', true],
    ['a no-break space before the word', 'слово Qwerty123', true],
    ['a no-break space after the word', 'Qwerty123 руб', true],
  ])('reads a password by the letter: %s', (_name, text, refused) => {
    expect(looksLikeSecret(text)).toBe(refused)
  })

  it.each([
    ['a key in the query', 'https://example.ru/promo?key=AbCdEf123456'],
    ['a key-like name in the query', 'Добавьте ссылку https://example.ru/promo?utm_key=Summer2026'],
    ['a name and a password before the host', 'ftp://admin:Qwerty123@example.ru/public_html'],
    ['a database address', 'mysql://root:toor@localhost/shop'],
    ['a known key prefix inside', `https://example.ru/?t=${key}`],
    ['a signed token inside', `https://example.ru/?t=${signed}`],
    ['a port, a path and an at sign', 'Откройте http://Example.ru:8080/a@B и проверьте'],
    ['round brackets', '(https://Example.ru/Page)'],
    ['straight quotes', '"https://Example.ru/Page"'],
    ['angle brackets', '<https://Example.ru/Page>'],
    ['an upper-case scheme', 'HTTPS://EXAMPLE.RU/Page'],
    ['a capitalised scheme', 'Https://Example.Ru'],
    ['www. without a scheme', 'www.Example.ru/Catalog'],
    ['www. in brackets', '(www.Example.ru/Catalog)'],
    ['a private key header glued to it', 'https://example.ru/-----BEGIN PRIVATE KEY-----'],
    // Opening punctuation of any script, as a Russian-speaking customer writes it.
    ['guillemets with a key inside', `«https://example.ru/?t=${key}»`],
    ['guillemets with a signed token inside', `«https://example.ru/?t=${signed}»`],
    ['guillemets with a password before the host', '«ftp://admin:Qwerty123@example.ru»'],
    ['low and high quotes with a key inside', `„www.example.ru/?t=${key}“`],
    ['a long dash glued before it', `—https://example.ru/?t=${key}`],
    ['a bracket and a guillemet before it', `(«https://example.ru/?t=${key}»)`],
    ['a numero sign before it', `№https://example.ru/?t=${key}`],
  ])('never refuses an address: %s', (_name, text) => {
    expect(looksLikeSecret(text)).toBe(false)
  })

  it.each([
    // An address is told narrowly: a scheme with `://` or `www.` at the start of the word.
    ['a bare domain with a path', 'Example.ru/Page', true],
    ['a Latin label glued to an address', 'Link:https://Example.ru/Page', true],
    ['an assignment glued to an address', 'x=https://Example.ru/', true],
    ['one slash after the scheme', 'http:/Example.ru', true],
    ['www without the dot', 'wwwExample.ru', true],
    // A word with a Cyrillic letter is no address, and no password either.
    ['a Russian label glued to an address', 'ссылка:https://Example.ru/Page', false],
    ['a phone link', 'tel:+74951234567', false],
    // Punctuation before a word does not make it an address.
    ['a key in guillemets', `«${key}»`, true],
    ['a key after a long dash', `—${key}`, true],
    ['guillemets and a Latin label before an address', `«Link:https://example.ru/?t=${key}»`, true],
    ['a name in guillemets', '«WordPress2024»', false],
    // An address does not cover the words next to it.
    ['a password next to an address', 'https://example.ru Qwerty123', true],
    [
      'a private key header next to an address',
      'https://example.ru -----BEGIN PRIVATE KEY-----',
      true,
    ],
  ])('reads what is not an address like any other word: %s', (_name, text, refused) => {
    expect(looksLikeSecret(text)).toBe(refused)
  })

  // A known key in two cases is a password already. The list decides for a key in one case or
  // glued to a word with a letter that is not Latin.
  it.each([
    ['twenty characters after the prefix', 'sk-abcdefghijklmnopqrst', true],
    ['nineteen characters after the prefix', 'sk-abcdefghijklmnopqrs', false],
    ['the prefix inside a longer word', 'ask-abcdefghijklmnopqrstuvwxyz', false],
    ['a chat token of ten characters', 'xoxb-1234567890', true],
    ['a chat token of nine characters', 'xoxb-123456789', false],
    ['a cloud key id of twenty characters', 'AKIAIOSFODNN7EXAMPLE', true],
    ['a cloud key id of nineteen characters', 'AKIAIOSFODNN7EXAMPL', false],
    ['a cloud key id in lowercase', 'akiaiosfodnn7example', false],
    ['a signed token in lowercase', signed.toLowerCase(), false],
    ['a signed token after a Cyrillic letter', `я${signed}`, false],
    ['a signed token after a Russian label and a hyphen', `токен-${signed}`, true],
    [
      'a signed token with a short third part',
      'ю:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx.dBjftJeZ4',
      false,
    ],
    ['an unknown prefix in one case', 'myco_live_0123456789abcdef0123456789abcdef', false],
    ['the words of a key header without the dashes', 'BEGIN PRIVATE KEY', false],
  ])('keeps the bounds of the known key formats: %s', (_name, text, refused) => {
    expect(looksLikeSecret(text)).toBe(refused)
  })

  // The rule is applied literally. These outcomes are what the owner decided on 11.10.2026:
  // none of them is softened here, and a change to any of them goes back to the owner.
  describe('ordinary words the rule refuses, as the owner decided', () => {
    it.each([
      // Names of products and services.
      ['WordPress', true],
      ['WordPress2024', true],
      ['Обновите WordPress до 6.5', true],
      ['WordPress,', true],
      ['(WordPress)', true],
      ['«WordPress»', false],
      ['JavaScript', true],
      ['WooCommerce', true],
      ['PhotoShop', true],
      ['Photoshop', true],
      ['VKontakte', true],
      ['Bitrix24', true],
      ['Telegram', true],
      ['WhatsApp', true],
      ['Instagram', true],
      ['Facebook', true],
      ['LinkedIn', true],
      ['Elementor', true],
      ['OpenCart', true],
      ['Wildberries', true],
      ['PlayStation', true],
      ['Google Analytics', true],
      ['Tilda', false],
      ['MySQL', false],
      ['AirPods', false],
      ['MacBook', false],
      ['Wi-Fi', false],
      ['Tele2', false],
      ['Яндекс.Метрика', false],
      // Seven characters pass, and a punctuation mark makes the eighth.
      ['Смотрите нас на YouTube', false],
      ['Смотрите нас на YouTube.', true],
      // Goods with an article number.
      ['iPhone15Pro', true],
      ['iPhone 15 Pro', false],
      ['Samsung Galaxy S24', false],
      ['SM-A546EZKD', false],
      ['Nike Air-Max270', true],
      ['MacBookPro', true],
      ['MacBook Pro', false],
      ['PlayStation5', true],
      ['Xiaomi Redmi Note13', false],
      ['Note13Pro', true],
      ['Версия PHP8.3', false],
      // E-mail addresses, bare domains and links without a scheme.
      ['info@example.ru', false],
      ['Ivan.Petrov@example.ru', true],
      ['Info@Example.ru', true],
      ['ivanov@Gmail.com', true],
      ['mailto:info@example.ru', false],
      ['mailto:Info@example.ru', true],
      ['Example.ru', true],
      ['Raditi.ru', true],
      ['vk.com/MyShop', true],
      ['t.me/RaditiSupport', true],
      ['@Ivan_Petrov', true],
      // Phones and numbers.
      ['+7 (495) 123-45-67', false],
      ['+74951234567', false],
      ['8-800-555-35-35', false],
      ['ИНН 7707083893', false],
      ['ID: GTM-ABC1234', false],
      ['utm_source=Yandex', true],
      // File names.
      ['Price2026.pdf', true],
      ['price2026.pdf', false],
      ['Прайс2026.pdf', false],
      ['IMG_2024.jpg', true],
      ['Logo.png', true],
      // Hashtags and promo codes.
      ['#BlackFriday', true],
      ['#Sale2026', true],
      ['#СкидкиЛета', false],
      ['Промокод Summer2026', true],
      ['Sale2026', true],
      ['SALE2026', false],
      ['sale2026', false],
      // English sentences and headings a customer asks to put on the site.
      ['Welcome to our shop', false],
      ['Замените заголовок на Welcome to our Shop!', false],
      ['Welcome!', true],
      ['Welcome,', true],
      ['Hello, World!', false],
      ['Black Friday', false],
      ['Summer Sale 2026', false],
      ['SummerSale', true],
      ['Contacts', true],
      ['Contact Us', false],
      ['Services', true],
      ['Portfolio', true],
      ['Copyright', true],
      ['Check-In', true],
      ['Delivery & Payment', true],
      ['About Company', false],
      ['AboutUs', false],
      ['Заголовок «AboutUs»', false],
      ['Заголовок "AboutUs"', true],
      ['OurServices', true],
      ['FrequentlyAskedQuestions', true],
      ['ООО "RomashkaPlus"', true],
    ])('%s', (text, refused) => {
      expect(looksLikeSecret(text)).toBe(refused)
    })
  })

  it('answers the same on repeated calls', () => {
    for (const [text, refused] of [
      ['пароль: Qwerty123', true],
      [`ключ=${key}`, true],
      [`токен:${signed}`, true],
      ['-----BEGIN PRIVATE KEY-----', true],
      ['https://example.ru/?key=Qwerty123', false],
    ] as const)
      expect([looksLikeSecret(text), looksLikeSecret(text), looksLikeSecret(text)]).toEqual([
        refused,
        refused,
        refused,
      ])
  })

  it('reads a text of exactly the stored length and stays fast on it', () => {
    // The Cyrillic letter keeps the password rule from answering first, so the key formats
    // read the whole word.
    const limit = FEED_REQUEST_TEXT_LIMIT
    const fill = (piece: string) => piece.repeat(limit).slice(0, limit - 1)
    const long = [
      `я${fill('-eyJ')}`,
      `я${fill('-eyJ').slice(0, -39)}!aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc`,
      `я${fill('aaaaaaaaaaa.')}`,
      `я${fill('sk-!')}`,
      `я${fill('.')}`,
      `${fill('-----BEGIN ')}-`,
      `${fill('-----BEGIN A ')}я`,
      `h${fill('http')}`,
      `(${fill('(')}`,
      `a${fill('a')}`,
      `я${fill(' я')}`,
      `Q${fill('werty1 Q')}`,
      // NFC has to reorder the whole run of marks.
      `a${fill('\u0301\u0323')}`,
    ]
    const started = performance.now()
    for (const text of long) {
      expect(text.length, text.slice(0, 20)).toBe(limit)
      expect(looksLikeSecret(text), text.slice(0, 20)).toBe(false)
    }
    expect(looksLikeSecret(`${'слово '.repeat(600)}Qwerty123`)).toBe(true)
    // Spaces around the text are not counted, as the schema does not count them.
    expect(looksLikeSecret(`  ${'я'.repeat(limit)}\n`)).toBe(false)
    expect(looksLikeSecret(`${' '.repeat(100_000)}пароль Qwerty123\n`)).toBe(true)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('does not read a longer text and refuses it', () => {
    const limit = FEED_REQUEST_TEXT_LIMIT
    const started = performance.now()
    for (const text of [
      'я'.repeat(limit + 1),
      'я '.repeat(100_000),
      'a'.repeat(200_000),
      `я${'-eyJ'.repeat(50_000)}`,
      `https://example.ru/${'a'.repeat(limit)}`,
      // Measured in review: 5 s for 128 000 characters, 22 s for 256 000.
      `a${'\u0301\u0323'.repeat(64_000)}`,
      `a${'\u0301\u0323'.repeat(500_000)}`,
    ])
      expect(looksLikeSecret(text), text.slice(0, 20)).toBe(true)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
