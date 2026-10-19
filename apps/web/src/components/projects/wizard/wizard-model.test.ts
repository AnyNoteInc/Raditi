import { codeSourceInputSchema, databaseInputSchema } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import {
  basicsErrors,
  chooseDatabase,
  databaseErrors,
  databaseInput,
  emptyDatabase,
  emptySource,
  newRequestKey,
  normalizeSiteUrl,
  pinnedHostKey,
  sourceErrors,
  sourceInput,
  type SourceDraft,
} from './wizard-model'

const KEY = `ssh-ed25519 SHA256:${'A'.repeat(43)}`

const ssh = (patch: Partial<SourceDraft['sftp']> = {}): SourceDraft => {
  const draft = emptySource()
  return {
    ...draft,
    sftp: {
      ...draft.sftp,
      host: ' ssh.example.ru ',
      username: ' deploy ',
      password: ' pass word ',
      rootPath: ' /var/www/site ',
      ...patch,
    },
  }
}

describe('the site address of the first step', () => {
  it.each([
    ['shop.example.ru:8443', 'https://shop.example.ru:8443'],
    ['example.ru', 'https://example.ru'],
    ['  example.ru  ', 'https://example.ru'],
    ['localhost:8080', 'https://localhost:8080'],
    ['HTTP://example.ru/', 'HTTP://example.ru/'],
    ['http://example.ru:8080', 'http://example.ru:8080'],
  ])('takes %s as %s', (typed, sent) => {
    expect(normalizeSiteUrl(typed)).toBe(sent)
  })

  it.each([
    '',
    'example.ru/shop',
    'mailto:owner@example.ru',
    'ftp://example.ru',
    'javascript:alert(1)',
    'https://user:pass@example.ru',
    'https://example.ru/?a=1',
    'https://example.ru/#top',
  ])('refuses %s', (typed) => {
    expect(normalizeSiteUrl(typed)).toBeNull()
  })

  it('names the field that is missing or wrong', () => {
    expect(basicsErrors({ name: '  ', url: 'example.ru/shop' })).toEqual({
      name: 'Введите название проекта',
      url: 'Укажите адрес сайта без пути к странице, например https://example.ru',
    })
    expect(basicsErrors({ name: 'Кофейня', url: 'example.ru' })).toEqual({})
  })
})

describe('the request of the access to the files', () => {
  it('trims names and folders but never a password, and sends the confirmed key', () => {
    const input = sourceInput(ssh(), KEY)
    expect(input).toEqual({
      kind: 'sftp',
      host: 'ssh.example.ru',
      port: 22,
      username: 'deploy',
      auth: { method: 'password', password: ' pass word ' },
      rootPath: '/var/www/site',
      hostKey: KEY,
    })
    expect(codeSourceInputSchema.safeParse(input).success).toBe(true)
  })

  it('sends no key on the first check: the server then shows its key and logs in nowhere', () => {
    expect(sourceInput(ssh(), null)).not.toHaveProperty('hostKey')
  })

  it('sends a private key with its phrase only when one was typed', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n'
    const without = sourceInput(ssh({ method: 'key', privateKey: key }), KEY)
    expect(without).toMatchObject({ auth: { method: 'key', privateKey: key } })
    expect((without as { auth: object }).auth).not.toHaveProperty('passphrase')
    expect(
      sourceInput(ssh({ method: 'key', privateKey: key, passphrase: 'фраза' }), KEY),
    ).toMatchObject({ auth: { method: 'key', privateKey: key, passphrase: 'фраза' } })
    expect(codeSourceInputSchema.safeParse(without).success).toBe(true)
  })

  it('sends FTP with the protection chosen and no key', () => {
    const draft = emptySource()
    const input = sourceInput(
      {
        ...draft,
        kind: 'ftp',
        ftp: {
          ...draft.ftp,
          host: 'ftp.example.ru',
          username: 'u',
          password: 'p',
          rootPath: 'www',
        },
      },
      KEY,
    )
    expect(input).toEqual({
      kind: 'ftp',
      host: 'ftp.example.ru',
      port: 21,
      username: 'u',
      password: 'p',
      rootPath: 'www',
      tls: 'verified',
    })
    expect(codeSourceInputSchema.safeParse(input).success).toBe(true)
  })

  it('starts from the strongest protection and the usual ports', () => {
    const draft = emptySource()
    expect(draft.kind).toBe('sftp')
    expect(draft.sftp.port).toBe('22')
    expect(draft.ftp.port).toBe('21')
    expect(draft.ftp.tls).toBe('verified')
  })

  it('starts «Изменить доступ» from the public part of the saved source only', () => {
    const ftp = emptySource({
      kind: 'ftp',
      host: 'ftp.example.ru',
      port: 2121,
      rootPath: '/www',
      tls: 'plain',
    })
    expect(ftp.kind).toBe('ftp')
    expect(ftp.ftp).toMatchObject({ host: 'ftp.example.ru', port: '2121', rootPath: '/www' })
    expect(ftp.ftp.tls).toBe('plain')
    expect(ftp.ftp.username).toBe('')
    expect(ftp.ftp.password).toBe('')
    const sftp = emptySource({ kind: 'sftp', host: 'h', port: 2222, rootPath: null, tls: null })
    expect(sftp.sftp).toMatchObject({ host: 'h', port: '2222', rootPath: '', password: '' })
  })

  it('expects the saved key of the server only from the saved server and port', () => {
    const saved = {
      kind: 'sftp',
      host: 'ssh.example.ru',
      port: 2222,
      rootPath: '/var/www',
      tls: null,
      hostKey: KEY,
    }
    const draft = emptySource(saved)
    expect(pinnedHostKey(draft, saved)).toBe(KEY)
    expect(
      pinnedHostKey({ ...draft, sftp: { ...draft.sftp, host: ' SSH.example.ru ' } }, saved),
    ).toBe(KEY)
    expect(
      pinnedHostKey({ ...draft, sftp: { ...draft.sftp, host: 'ssh2.example.ru' } }, saved),
    ).toBeNull()
    expect(pinnedHostKey({ ...draft, sftp: { ...draft.sftp, port: '22' } }, saved)).toBeNull()
    expect(pinnedHostKey(draft, { ...saved, hostKey: null })).toBeNull()
    expect(pinnedHostKey(draft, { ...saved, kind: 'ftp' })).toBeNull()
    expect(pinnedHostKey(draft, null)).toBeNull()
  })

  it('names every missing field of the tab and a port out of range', () => {
    const draft = emptySource()
    expect(sourceErrors({ ...draft, sftp: { ...draft.sftp, port: '70000' } })).toEqual({
      host: 'Укажите адрес сервера, например ssh.example.ru',
      port: 'Укажите порт — число от 1 до 65535',
      username: 'Укажите пользователя',
      password: 'Введите пароль',
      rootPath: 'Укажите папку, где лежат файлы сайта',
    })
    expect(sourceErrors(ssh({ method: 'key' }))).toEqual({
      privateKey: 'Вставьте приватный ключ',
    })
    expect(sourceErrors(ssh())).toEqual({})
  })

  it.each(['sftp://ssh.example.ru', 'ssh.example.ru/path', 'user@ssh.example.ru'])(
    'asks for a bare server instead of %s',
    (host) => {
      expect(sourceErrors(ssh({ host })).host).toMatch(/^Укажите только адрес сервера/)
    },
  )

  it.each(['../etc', '/var/www/../../etc', 'C:\\www'])('refuses the folder %s', (rootPath) => {
    expect(sourceErrors(ssh({ rootPath })).rootPath).toBe('Укажите путь через «/», без «..»')
  })
})

describe('the database step', () => {
  it('has no database by default and asks nothing then', () => {
    expect(databaseInput(emptyDatabase())).toBeNull()
    expect(databaseErrors(emptyDatabase())).toEqual({})
  })

  it('moves an untouched port with the provider and leaves a typed one', () => {
    const postgres = chooseDatabase(emptyDatabase(), 'postgres')
    expect(postgres.port).toBe('5432')
    expect(chooseDatabase(postgres, 'mysql').port).toBe('3306')
    const typed = { ...postgres, port: '6432', portTouched: true }
    expect(chooseDatabase(typed, 'mysql').port).toBe('6432')
  })

  it('sends the database with the strongest protection by default', () => {
    const draft = {
      ...chooseDatabase(emptyDatabase(), 'mysql'),
      host: ' db.example.ru ',
      database: ' wp ',
      username: ' wp ',
      password: ' secret ',
    }
    const input = databaseInput(draft)
    expect(input).toEqual({
      engine: 'mysql',
      host: 'db.example.ru',
      port: 3306,
      database: 'wp',
      username: 'wp',
      password: ' secret ',
      tls: 'verified',
    })
    expect(databaseInputSchema.safeParse(input).success).toBe(true)
  })

  it('names the missing fields of a chosen provider', () => {
    expect(databaseErrors(chooseDatabase(emptyDatabase(), 'postgres'))).toEqual({
      host: 'Укажите адрес сервера, например db.example.ru',
      database: 'Укажите имя базы данных',
      username: 'Укажите пользователя базы данных',
      password: 'Введите пароль базы данных',
    })
  })
})

describe('the request key of the wizard', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it('is a random UUID', () => {
    expect(newRequestKey()).toMatch(/^[0-9a-f-]{36}$/)
    expect(newRequestKey()).not.toBe(newRequestKey())
  })

  it('is a version 4 UUID where the page has no randomUUID (plain http)', () => {
    // The crypto of the page without its randomUUID.
    const insecure: Pick<Crypto, 'getRandomValues'> = {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    }
    const key = newRequestKey(insecure)
    expect(key).toMatch(uuid)
  })
})
