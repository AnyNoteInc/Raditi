import { describe, expect, it } from 'vitest'

import {
  BROWSER_HIDDEN_VALUE,
  browserObservationIdSchema,
  browserObservationSchema,
  browserRefSchema,
  browserTreeActiveElement,
  browserTreeElement,
  browserTreeRefs,
  clipTree,
  isSecretFieldName,
  redactSecretValues,
  utf8Length,
  type BrowserObservation,
} from './observation.ts'

/**
 * A login page as `page.ariaSnapshot({ mode: 'ai' })` of Playwright 1.63 printed it in Chromium
 * (filled fields: a password field is a `textbox` with its value, a field named by its placeholder
 * alone takes it as its name, an empty one has no value).
 */
const login = [
  '- generic [ref=e1]:',
  '  - heading "Вход" [level=1] [ref=e2]',
  '  - generic [ref=e3]:',
  '    - generic [ref=e4]:',
  '      - text: Имя пользователя или email',
  '      - textbox "Имя пользователя или email" [ref=e5]: admin@news.example.ru',
  '    - generic [ref=e6]:',
  '      - text: Пароль',
  '      - textbox "Пароль" [ref=e7]: hunter2',
  '    - textbox [ref=e8]: s3cr3t',
  '    - generic [ref=e9]:',
  '      - text: Код подтверждения',
  '      - textbox "Код подтверждения" [ref=e10]:',
  '        - /placeholder: "123456"',
  '        - text: "004211"',
  '    - textbox "Password" [ref=e11]: placeholder-named',
  '    - generic [ref=e12]:',
  '      - text: "Secret: key"',
  '      - \'textbox "Secret: key" [ref=e13]\': top-secret',
  '    - generic [ref=e14]:',
  '      - text: Повторите пароль',
  '      - textbox "Повторите пароль" [ref=e15]',
  '    - textbox "Заметка" [active] [ref=e16]: "line1 line2: x"',
  '    - button "Войти" [ref=e17]',
  '    - link "Забыли пароль?" [ref=e18] [cursor=pointer]:',
  '      - /url: /lost',
  '  - iframe [ref=e19]:',
  '    - generic [ref=f1e1]:',
  '      - textbox "Добавить заголовок" [ref=f1e2]: Открытие',
  '      - paragraph [ref=f1e3]: Абзац',
].join('\n')

/** An editor as the same mode writes it, with keys YAML had to quote. */
const editor = [
  '- iframe [ref=e30]:',
  '  - textbox "Добавить заголовок" [ref=f1e2]: Открытие филиала',
  '  - \'document "Блок: Абзац" [ref=f1e3]\':',
  '    - paragraph [ref=f1e4]: Мы открылись на Ленина, 1.',
  '  - textbox "Шорткод" [ref=f1e5]: "[gallery ids=\\"1,2\\"]"',
  '  - textbox "Кодировка" [ref=f1e6]: UTF-8',
  '- button "Опубликовать" [ref=e31] [cursor=pointer]',
  '- button "Сохранить черновик" [ref=e32]',
  '- textbox "Name [ref=e99] of it" [ref=e33]: plain',
].join('\n')

describe('identifiers of an observation', () => {
  it('numbers observations and takes Playwright references of the page and its frames', () => {
    for (const id of ['o1', 'o12', 'o999999999'])
      expect(browserObservationIdSchema.parse(id)).toBe(id)
    for (const id of ['', 'o0', 'o01', '12', 'O1', 'o1 ', 'o1234567890'])
      expect(browserObservationIdSchema.safeParse(id).success, id).toBe(false)
    for (const ref of ['e1', 'e12', 'f1e5', 'f12e340'])
      expect(browserRefSchema.parse(ref)).toBe(ref)
    for (const ref of ['', 'e0', 'f0e1', 'e', 'x1', 'f1', 'f1f2e3', 'e1 ', 'aria-ref=e1', 's1e2'])
      expect(browserRefSchema.safeParse(ref).success, ref).toBe(false)
  })
})

describe('isSecretFieldName', () => {
  it('knows fields of passwords, codes, tokens and keys in Russian and English', () => {
    for (const name of [
      'Пароль',
      'Новый пароль',
      'Повторите пароль',
      'Введите пароля',
      'Password',
      'New password',
      'Passphrase',
      'PIN',
      'PIN-код',
      'Код подтверждения',
      'Одноразовый код',
      'Код из SMS',
      'Verification code',
      'Authentication Code',
      'OTP',
      '2FA',
      'API token',
      'Токен доступа',
      'Secret key',
      'Секретный ключ',
      'API key',
      'Ключ API',
    ])
      expect(isSecretFieldName(name), name).toBe(true)
  })

  it('leaves alone fields that only contain such letters', () => {
    for (const name of [
      '',
      'Заголовок',
      'Имя пользователя или email',
      'Шорткод',
      'Кодировка',
      'Postcode',
      'Почтовый индекс',
      'Pinterest',
      'Ключевые слова',
      'Опции',
      'Tokenizer settings',
      'Добавить заголовок',
    ])
      expect(isSecretFieldName(name), name).toBe(false)
  })
})

describe('redactSecretValues', () => {
  it('hides values of the fields the adapter named, wherever they are written', () => {
    const tree = redactSecretValues(login, ['e7', 'e8'])
    expect(tree).toContain(`      - textbox "Пароль" [ref=e7]: ${BROWSER_HIDDEN_VALUE}`)
    expect(tree).toContain(`    - textbox [ref=e8]: ${BROWSER_HIDDEN_VALUE}`)
    expect(tree).not.toContain('hunter2')
    expect(tree).not.toContain('s3cr3t')
  })

  it('hides values of password-like fields even with no reference named', () => {
    const tree = redactSecretValues(login)
    for (const secret of ['hunter2', '004211', 'placeholder-named', 'top-secret'])
      expect(tree, secret).not.toContain(secret)
    expect(tree).toContain(`        - text: ${BROWSER_HIDDEN_VALUE}`)
    expect(tree).toContain(`      - 'textbox "Secret: key" [ref=e13]': ${BROWSER_HIDDEN_VALUE}`)
    // An unnamed field is the adapter's to name: the heuristic cannot see it.
    expect(tree).toContain('    - textbox [ref=e8]: s3cr3t')
  })

  it('keeps everything else as it was: names, placeholders, links, other fields', () => {
    const tree = redactSecretValues(login, ['e7', 'e8'])
    expect(tree).toContain(
      '      - textbox "Имя пользователя или email" [ref=e5]: admin@news.example.ru',
    )
    expect(tree).toContain('        - /placeholder: "123456"')
    expect(tree).toContain('      - /url: /lost')
    expect(tree).toContain('      - text: Пароль')
    expect(tree).toContain('    - textbox "Заметка" [active] [ref=e16]: "line1 line2: x"')
    expect(tree).toContain('      - textbox "Повторите пароль" [ref=e15]')
    expect(tree.split('\n')).toHaveLength(login.split('\n').length)
    // An empty value is left: it tells only that the field is empty.
    expect(redactSecretValues('- textbox "Пароль" [ref=e1]: ""')).toBe(
      '- textbox "Пароль" [ref=e1]: ""',
    )
    expect(redactSecretValues(editor)).toBe(editor)
  })

  it('reads a reference only after the name, never inside it', () => {
    const tree = redactSecretValues(editor, ['e99'])
    expect(tree).toContain('[ref=e33]: plain')
    expect(redactSecretValues(editor, ['e33'])).toContain(`[ref=e33]: ${BROWSER_HIDDEN_VALUE}`)
  })

  it('hides the text lines below a secret field, and stops at its siblings', () => {
    const tree = redactSecretValues(
      [
        '- textbox "Токен" [ref=e1]:',
        '  - text: first',
        '  - text: second',
        '- paragraph [ref=e2]: visible',
        '- text: visible too',
      ].join('\n'),
    )
    expect(tree).toBe(
      [
        '- textbox "Токен" [ref=e1]:',
        `  - text: ${BROWSER_HIDDEN_VALUE}`,
        `  - text: ${BROWSER_HIDDEN_VALUE}`,
        '- paragraph [ref=e2]: visible',
        '- text: visible too',
      ].join('\n'),
    )
  })

  it('leaves lines it cannot read alone and never throws', () => {
    for (const text of ['', 'not a tree', "- 'unterminated: x", '- textbox "\\": x', '-', '  -  '])
      expect(redactSecretValues(text)).toBe(text)
  })
})

describe('elements of a tree', () => {
  it('finds the role and name an action is aimed at', () => {
    expect(browserTreeElement(editor, 'e31')).toEqual({ role: 'button', name: 'Опубликовать' })
    expect(browserTreeElement(editor, 'f1e2')).toEqual({
      role: 'textbox',
      name: 'Добавить заголовок',
    })
    expect(browserTreeElement(login, 'e8')).toEqual({ role: 'textbox', name: '' })
    expect(browserTreeElement(login, 'e13')).toEqual({ role: 'textbox', name: 'Secret: key' })
    expect(browserTreeElement(login, 'e17')).toEqual({ role: 'button', name: 'Войти' })
    expect(browserTreeElement(editor, 'e99')).toBeNull()
    expect(browserTreeElement(editor, 'e3')).toBeNull()
  })

  it('finds the element that has the focus, inside the frame that has it', () => {
    // As Playwright 1.63 printed it in Chromium: the frame and the field in it are both marked.
    const focused = [
      '- generic [ref=e1]:',
      '  - iframe [active] [ref=e30]:',
      '    - textbox "Добавить заголовок" [ref=f1e2]: Открытие филиала',
      '    - \'document "Блок: Абзац" [active] [ref=f1e3]\':',
      '      - paragraph [ref=f1e4]: Мы открылись на Ленина, 1.',
      '  - button "Опубликовать" [ref=e31] [cursor=pointer]',
    ].join('\n')
    expect(browserTreeActiveElement(focused)).toEqual({ role: 'document', name: 'Блок: Абзац' })
    expect(
      browserTreeActiveElement('- button "Опубликовать" [active] [ref=e31] [cursor=pointer]'),
    ).toEqual({ role: 'button', name: 'Опубликовать' })
    // Nothing focused: the page's body is.
    expect(
      browserTreeActiveElement('- generic [active] [ref=e1]:\n  - button "Ок" [ref=e2]'),
    ).toEqual({ role: 'generic', name: '' })
    // A name that says `[active]` is a name; a frame alone is no element.
    expect(browserTreeActiveElement('- button "Сохранить [active]" [ref=e2]')).toBeNull()
    expect(browserTreeActiveElement('- iframe [active] [ref=e30]')).toBeNull()
    expect(browserTreeActiveElement(editor)).toBeNull()
  })

  it('lists every reference an action may name', () => {
    expect([...browserTreeRefs(editor)]).toEqual([
      'e30',
      'f1e2',
      'f1e3',
      'f1e4',
      'f1e5',
      'f1e6',
      'e31',
      'e32',
      'e33',
    ])
    expect(browserTreeRefs('').size).toBe(0)
  })
})

describe('clipTree', () => {
  it('keeps a tree within its limit whole', () => {
    expect(clipTree(editor, editor.length)).toEqual({ text: editor, truncated: false })
  })

  it('cuts at the end of a line', () => {
    const limit = editor.indexOf('\n', 100) + 5
    const { text, truncated } = clipTree(editor, limit)
    expect(truncated).toBe(true)
    expect(text.length).toBeLessThanOrEqual(limit)
    expect(editor.startsWith(`${text}\n`)).toBe(true)
  })

  it('cuts by bytes too, whatever the script', () => {
    const tree = Array.from(
      { length: 100 },
      (_, index) => `- paragraph [ref=e${index + 1}]: ${'漢'.repeat(500)}`,
    ).join('\n')
    const { text, truncated } = clipTree(tree, 24_000)
    expect(truncated).toBe(true)
    expect(utf8Length(text)).toBeLessThanOrEqual(40 * 1024)
    expect(tree.startsWith(`${text}\n`)).toBe(true)
    // No whole line fits: the first one is cut on a word, never past the bytes.
    const cut = clipTree(tree, 24_000, 100).text
    expect(cut).toBe('- paragraph [ref=e1]:')
    expect(utf8Length(cut)).toBeLessThanOrEqual(100)
    expect(utf8Length(clipTree('漢'.repeat(50_000), 24_000).text)).toBeLessThanOrEqual(40 * 1024)
  })

  it('counts UTF-8 bytes as an encoder would', () => {
    for (const text of ['', 'abc', 'Пароль', '漢字', '😀 and ж', 'x\ud800y', '\udc00'])
      expect(utf8Length(text), JSON.stringify(text)).toBe(new TextEncoder().encode(text).length)
  })

  it('cuts a first line longer than the limit without leaving part of a contact', () => {
    const line = `- paragraph [ref=e1]: Пишите на info@news.example.ru или звоните ${'x'.repeat(100)}`
    const { text, truncated } = clipTree(`${line}\n- button "OK" [ref=e2]`, 40)
    expect(truncated).toBe(true)
    expect(text.length).toBeLessThanOrEqual(40)
    expect(text).not.toContain('info@')
  })
})

describe('browserObservationSchema', () => {
  const observation: BrowserObservation = {
    observation: 'o3',
    page: {
      pageId: 1,
      url: 'https://news.example.ru/wp-admin/post-new.php',
      title: 'Добавить запись',
    },
    tabs: [
      { pageId: 1, url: 'https://news.example.ru/wp-admin/post-new.php', title: 'Добавить запись' },
    ],
    controller: 'agent',
    tree: redactSecretValues(editor),
    truncated: false,
  }

  it('reads an observation with what waits for the agent', () => {
    expect(browserObservationSchema.parse(observation)).toEqual(observation)
    const waiting = {
      ...observation,
      dialog: { kind: 'confirm', message: 'Покинуть страницу?' },
      chooser: { multiple: true, accept: ['image/*'] },
      checkpoint: { kind: 'post', objectId: '12', state: 'unverified' },
    }
    expect(browserObservationSchema.parse(waiting)).toEqual(waiting)
  })

  it('refuses one that is too large or carries an id of the worker', () => {
    expect(
      browserObservationSchema.safeParse({ ...observation, tree: 'x'.repeat(24_001) }).success,
    ).toBe(false)
    expect(
      browserObservationSchema.safeParse({ ...observation, tree: '漢'.repeat(15_000) }).success,
    ).toBe(false)
    expect(
      browserObservationSchema.safeParse({
        ...observation,
        dialog: { id: 'd1', kind: 'alert', message: '' },
      }).success,
    ).toBe(false)
    expect(
      browserObservationSchema.safeParse({ ...observation, screenshot: 'iVBOR' }).success,
    ).toBe(false)
  })
})
