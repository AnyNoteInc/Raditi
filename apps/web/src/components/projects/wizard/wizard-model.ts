import type { ConnectionCheckReason, ConnectionTls, DatabaseEngine } from '@repo/domain'

// What the wizard of a new project holds while it is open, and the requests it makes of it.
// Everything here lives in React memory only: the drafts carry passwords and keys, so they are
// never put into the address, browser storage or the query cache, and never come from the server.

/** The two ways to the files of a site the wizard offers: SSH (SFTP over it) and FTP. */
export type SourceKind = 'sftp' | 'ftp'

export const defaultPorts = { sftp: 22, ftp: 21, postgres: 5432, mysql: 3306 } as const

export interface SshDraft {
  host: string
  port: string
  username: string
  method: 'password' | 'key'
  password: string
  privateKey: string
  passphrase: string
  rootPath: string
}

export interface FtpDraft {
  host: string
  port: string
  username: string
  password: string
  rootPath: string
  tls: ConnectionTls
}

/** Both tabs keep what was typed in them: switching the tab loses nothing. */
export interface SourceDraft {
  kind: SourceKind
  sftp: SshDraft
  ftp: FtpDraft
}

export type DatabaseChoice = 'none' | DatabaseEngine

export interface DatabaseDraft {
  engine: DatabaseChoice
  host: string
  port: string
  /** The user typed a port: switching the provider no longer replaces it with its default. */
  portTouched: boolean
  database: string
  username: string
  password: string
  tls: ConnectionTls
}

/**
 * The public part of a saved source, as the setup screen receives it: what «Изменить доступ»
 * starts from. Never a secret. `hostKey` is the SSH key confirmed for this server and port: the
 * new access to the same server is checked against it, so a key that changed is told as one.
 */
export interface PublicSource {
  kind: string
  host: string
  port: number
  rootPath: string | null
  tls: ConnectionTls | null
  hostKey?: string | null
}

export function emptySource(from?: PublicSource | null): SourceDraft {
  const sftp: SshDraft = {
    host: '',
    port: String(defaultPorts.sftp),
    username: '',
    method: 'password',
    password: '',
    privateKey: '',
    passphrase: '',
    rootPath: '',
  }
  // The strongest protection is the default; a weaker one is only ever the user's explicit choice.
  const ftp: FtpDraft = {
    host: '',
    port: String(defaultPorts.ftp),
    username: '',
    password: '',
    rootPath: '',
    tls: 'verified',
  }
  if (from?.kind === 'ftp') {
    return {
      kind: 'ftp',
      sftp,
      ftp: {
        ...ftp,
        host: from.host,
        port: String(from.port),
        rootPath: from.rootPath ?? '',
        tls: from.tls ?? 'verified',
      },
    }
  }
  if (from?.kind === 'sftp') {
    return {
      kind: 'sftp',
      sftp: { ...sftp, host: from.host, port: String(from.port), rootPath: from.rootPath ?? '' },
      ftp,
    }
  }
  return { kind: 'sftp', sftp, ftp }
}

export function emptyDatabase(): DatabaseDraft {
  return {
    engine: 'none',
    host: '',
    port: '',
    portTouched: false,
    database: '',
    username: '',
    password: '',
    tls: 'verified',
  }
}

/** A provider chosen: an untouched port follows it. */
export function chooseDatabase(draft: DatabaseDraft, engine: DatabaseChoice): DatabaseDraft {
  const port = engine === 'none' || draft.portTouched ? draft.port : String(defaultPorts[engine])
  return { ...draft, engine, port }
}

/** What `siteConnection.checkSource`, `project.create` and `replaceAccess` take as the source. */
export type SourceInput =
  | {
      kind: 'ftp'
      host: string
      port: number
      username: string
      password: string
      rootPath: string
      tls: ConnectionTls
    }
  | {
      kind: 'sftp'
      host: string
      port: number
      username: string
      auth:
        | { method: 'password'; password: string }
        | { method: 'key'; privateKey: string; passphrase?: string }
      rootPath: string
      hostKey?: string
    }

export interface DatabaseInput {
  engine: DatabaseEngine
  host: string
  port: number
  database: string
  username: string
  password: string
  tls: ConnectionTls
}

// Names, addresses and folders lose the spaces around them; a password, a key and its phrase
// never do: a space may be part of them.
const port = (text: string) => Number(text.trim())

/** The request of the source on its tab; `hostKey` is the key the user confirmed, if any. */
export function sourceInput(draft: SourceDraft, hostKey: string | null): SourceInput {
  if (draft.kind === 'ftp') {
    const ftp = draft.ftp
    return {
      kind: 'ftp',
      host: ftp.host.trim(),
      port: port(ftp.port),
      username: ftp.username.trim(),
      password: ftp.password,
      rootPath: ftp.rootPath.trim(),
      tls: ftp.tls,
    }
  }
  const ssh = draft.sftp
  return {
    kind: 'sftp',
    host: ssh.host.trim(),
    port: port(ssh.port),
    username: ssh.username.trim(),
    auth:
      ssh.method === 'password'
        ? { method: 'password', password: ssh.password }
        : {
            method: 'key',
            privateKey: ssh.privateKey,
            ...(ssh.passphrase === '' ? {} : { passphrase: ssh.passphrase }),
          },
    rootPath: ssh.rootPath.trim(),
    ...(hostKey === null ? {} : { hostKey }),
  }
}

/**
 * The key a draft of SSH is expected to present: the saved one while the server and the port
 * are the saved ones, none for any other server — that one is a first check.
 */
export function pinnedHostKey(draft: SourceDraft, saved: PublicSource | null): string | null {
  if (saved?.kind !== 'sftp' || !saved.hostKey) return null
  const sameHost = draft.sftp.host.trim().toLowerCase() === saved.host.toLowerCase()
  return sameHost && port(draft.sftp.port) === saved.port ? saved.hostKey : null
}

/** null: «Без базы данных». */
export function databaseInput(draft: DatabaseDraft): DatabaseInput | null {
  if (draft.engine === 'none') return null
  return {
    engine: draft.engine,
    host: draft.host.trim(),
    port: port(draft.port),
    database: draft.database.trim(),
    username: draft.username.trim(),
    password: draft.password,
    tls: draft.tls,
  }
}

export type FieldErrors<Field extends string> = Partial<Record<Field, string>>

const portProblem = (text: string) => {
  const value = text.trim()
  return /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65_535
    ? undefined
    : 'Укажите порт — число от 1 до 65535'
}

/** A bare host: no scheme, no path, no user, no spaces. */
const hostProblem = (text: string, example: string) => {
  const value = text.trim()
  if (value === '') return `Укажите адрес сервера, например ${example}`
  return /[/@\s\\]/.test(value)
    ? `Укажите только адрес сервера, без протокола и пути, например ${example}`
    : undefined
}

const folderProblem = (text: string) => {
  const value = text.trim()
  if (value === '') return 'Укажите папку, где лежат файлы сайта'
  return value.includes('\\') || value.split('/').includes('..')
    ? 'Укажите путь через «/», без «..»'
    : undefined
}

export type SourceField = 'host' | 'port' | 'username' | 'password' | 'privateKey' | 'rootPath'

/** The fields in the order of the form: the first with a problem gets the focus. */
export const sourceFieldOrder: readonly SourceField[] = [
  'host',
  'port',
  'username',
  'password',
  'privateKey',
  'rootPath',
]

export function sourceErrors(draft: SourceDraft): FieldErrors<SourceField> {
  const fields = draft.kind === 'ftp' ? draft.ftp : draft.sftp
  const errors: FieldErrors<SourceField> = {
    host: hostProblem(fields.host, draft.kind === 'ftp' ? 'ftp.example.ru' : 'ssh.example.ru'),
    port: portProblem(fields.port),
    username: fields.username.trim() === '' ? 'Укажите пользователя' : undefined,
    rootPath: folderProblem(fields.rootPath),
  }
  if (draft.kind === 'sftp' && draft.sftp.method === 'key') {
    if (draft.sftp.privateKey.trim() === '') errors.privateKey = 'Вставьте приватный ключ'
  } else if (fields.password === '') {
    errors.password = 'Введите пароль'
  }
  return withoutEmpty(errors)
}

export type DatabaseField = 'host' | 'port' | 'database' | 'username' | 'password'

export const databaseFieldOrder: readonly DatabaseField[] = [
  'host',
  'port',
  'database',
  'username',
  'password',
]

export function databaseErrors(draft: DatabaseDraft): FieldErrors<DatabaseField> {
  if (draft.engine === 'none') return {}
  return withoutEmpty({
    host: hostProblem(draft.host, 'db.example.ru'),
    port: portProblem(draft.port),
    database: draft.database.trim() === '' ? 'Укажите имя базы данных' : undefined,
    username: draft.username.trim() === '' ? 'Укажите пользователя базы данных' : undefined,
    password: draft.password === '' ? 'Введите пароль базы данных' : undefined,
  })
}

function withoutEmpty<Field extends string>(errors: FieldErrors<Field>): FieldErrors<Field> {
  return Object.fromEntries(
    Object.entries(errors).filter(([, text]) => text !== undefined),
  ) as FieldErrors<Field>
}

export const NAME_REQUIRED = 'Введите название проекта'
export const URL_INVALID = 'Укажите адрес сайта без пути к странице, например https://example.ru'

/**
 * The address of the site as the server takes it, or null. `https://` is added when no scheme
 * is typed; only `scheme://` is a scheme: `example.ru:8443` is a host and a port.
 */
export function normalizeSiteUrl(text: string): string | null {
  let address = text.trim()
  if (address && !/^[a-z][a-z\d+.-]*:\/\//i.test(address)) address = `https://${address}`
  try {
    const parsed = new URL(address)
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    )
      return null
  } catch {
    return null
  }
  return address
}

export type BasicsField = 'name' | 'url'

export function basicsErrors(draft: { name: string; url: string }): FieldErrors<BasicsField> {
  return withoutEmpty({
    name: draft.name.trim() === '' ? NAME_REQUIRED : undefined,
    url: normalizeSiteUrl(draft.url) === null ? URL_INVALID : undefined,
  })
}

/** The first field of the form that has a problem, in the order of the form. */
export function firstProblem<Field extends string>(
  order: readonly Field[],
  errors: FieldErrors<Field>,
): Field | undefined {
  return order.find((field) => errors[field] !== undefined)
}

/**
 * Why the source or the database was refused, as the server said: a reason of the check, with
 * the folder one level down that holds the site (`not_site_root`) or the key the server
 * presented (`host_key_unknown`, `host_key_changed`).
 */
export interface CheckRefusal {
  reason: ConnectionCheckReason
  suggestedRoot?: string
  hostKey?: string
}

/**
 * The key of one opening of the wizard: a UUID. `crypto.randomUUID` exists only in a secure
 * context, so a page opened over plain http by a network address builds the same version 4 UUID
 * from `getRandomValues`, which every context has.
 */
export function newRequestKey(
  random: Pick<Crypto, 'getRandomValues'> & Partial<Crypto> = crypto,
): string {
  if (typeof random.randomUUID === 'function') return random.randomUUID()
  const bytes = random.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
