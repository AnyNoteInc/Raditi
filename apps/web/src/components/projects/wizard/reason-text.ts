import type { ConnectionCheckReason } from '@repo/domain'

import type { SourceKind } from './wizard-model'

// What the owner reads when a check of the access to the files or of the database did not
// pass. Coarse on purpose, as the reasons themselves: no message of the server, no address the
// server answered from, nothing the check could be used to map a network with.

/** Words both texts share: where to look, what to try. */
const LATER = 'Попробуйте ещё раз немного позже.'

/**
 * The files of the site: `kind` names the protection of FTP where only FTP has it, `platform`
 * the platform whose files the folder must hold.
 */
export function sourceReasonText(
  reason: ConnectionCheckReason,
  context: { kind: SourceKind | string; platform: string },
): string {
  const ftp = context.kind === 'ftp'
  const texts: Record<ConnectionCheckReason, string> = {
    address_not_allowed:
      'Этот адрес сервера нельзя использовать. Укажите адрес сервера хостинга, который открывается из интернета.',
    host_not_found: 'Сервер с таким адресом не найден. Проверьте адрес сервера в панели хостинга.',
    unreachable: `Не удалось подключиться к серверу. Проверьте адрес и порт: сервер должен принимать подключения по ${ftp ? 'FTP' : 'SSH'}. ${LATER}`,
    tls_unavailable:
      'Сервер не поддерживает шифрование FTPS. Узнайте у хостинга, как его включить, или выберите другую защиту соединения.',
    tls_required:
      'Сервер принимает только защищённые подключения. Выберите FTPS в поле «Защита соединения» — лучше «FTPS с проверкой сертификата».',
    certificate_untrusted:
      'Сертификат сервера не подтверждает этот адрес. Проверьте адрес сервера. Если хостинг подтверждает, что так и должно быть, выберите «FTPS без проверки сертификата».',
    host_key_changed:
      'Сервер назвал не тот ключ, который вы подтвердили. Сверьте новый ключ, прежде чем продолжать.',
    host_key_unknown: 'Сверьте ключ сервера, прежде чем продолжать.',
    auth_failed: ftp
      ? 'Сервер не принял пользователя или пароль. Проверьте их в панели хостинга.'
      : 'Сервер не принял пользователя, пароль или ключ. Проверьте их в панели хостинга.',
    key_invalid:
      'Не удалось прочитать приватный ключ, или к нему не подходит парольная фраза. Вставьте ключ целиком, вместе с первой и последней строкой.',
    host_not_allowed:
      'Сервер не принимает подключения от нас. Разрешите подключения извне в панели хостинга.',
    access_denied:
      'Вход выполнен, но у этого пользователя нет доступа к папке сайта. Проверьте права пользователя или укажите другую папку.',
    not_found: 'Такой папки на сервере нет. Проверьте путь к папке сайта.',
    not_site_root: `В этой папке нет файлов сайта на ${context.platform}. Укажите папку, где лежат файлы сайта.`,
    no_write_access: 'У этого доступа нет права записи.',
    transfer_failed: `Вход выполнен, но получить список файлов не удалось. ${LATER}`,
    unsupported:
      'Этот сервер работает так, как мы пока не умеем. Попробуйте подключиться другим способом — по SSH или по FTP.',
  }
  return texts[reason]
}

/** The database of the site: the same reasons, said of a database server. */
export function databaseReasonText(reason: ConnectionCheckReason): string {
  const unknown = 'Не удалось проверить подключение к базе данных. Проверьте данные подключения.'
  const texts: Record<ConnectionCheckReason, string> = {
    address_not_allowed:
      'Этот адрес сервера базы данных нельзя использовать. Укажите адрес, который открывается из интернета.',
    host_not_found:
      'Сервер базы данных с таким адресом не найден. Проверьте адрес в панели хостинга.',
    unreachable: `Не удалось подключиться к серверу базы данных. Проверьте адрес и порт. Часто хостинг разрешает подключаться к базе только с самого сервера сайта — узнайте у хостинга, можно ли подключиться извне. ${LATER}`,
    tls_unavailable:
      'Сервер базы данных не поддерживает шифрование. Узнайте у хостинга, как его включить, или выберите другую защиту соединения.',
    tls_required:
      'Сервер базы данных принимает только защищённые подключения. Выберите TLS в поле «Защита соединения» — лучше «TLS с проверкой сертификата».',
    certificate_untrusted:
      'Сертификат сервера базы данных не подтверждает этот адрес. Проверьте адрес. Если хостинг подтверждает, что так и должно быть, выберите «TLS без проверки сертификата».',
    host_key_changed: unknown,
    host_key_unknown: unknown,
    auth_failed:
      'Сервер базы данных не принял пользователя или пароль. Проверьте их в панели хостинга.',
    key_invalid: unknown,
    host_not_allowed:
      'Сервер базы данных не принимает подключения от нас. Разрешите внешние подключения к базе в панели хостинга.',
    access_denied: 'У этого пользователя нет доступа к базе данных. Проверьте его права.',
    not_found: 'Базы данных с таким именем на сервере нет. Проверьте имя базы.',
    not_site_root: unknown,
    no_write_access: unknown,
    transfer_failed: `Подключение к базе данных есть, но прочитать список таблиц не удалось. ${LATER}`,
    unsupported: 'Такой сервер базы данных мы пока не поддерживаем.',
  }
  return texts[reason]
}

/** A failed call, as the tRPC client reports it. */
export interface CallError {
  message: string
  /** Absent when no answer of the server arrived: the network failed, not the request. */
  data?: { code?: string; domainCode?: string | null } | null
}

/** The DomainError code of a refusal; null for any other failure. */
export const domainCodeOf = (error: unknown): string | null =>
  (error as CallError | null)?.data?.domainCode ?? null

/** The server's text for a refusal with a domain code is Russian already, without a full stop. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

export const OFFLINE =
  'Не удалось связаться с сервером. Проверьте подключение к интернету и попробуйте ещё раз.'

/**
 * What to tell the owner of a call that failed. A refusal of the domain carries a text written
 * for them; an input the server did not take is `invalid` of the step; a call that never
 * reached the server is `OFFLINE`; anything else is `failed`.
 */
export function callErrorText(error: unknown, texts: { invalid: string; failed: string }): string {
  const call = error as CallError
  if (!call?.data) return OFFLINE
  if (call.data.domainCode) return sentence(call.message)
  return call.data.code === 'BAD_REQUEST' ? texts.invalid : texts.failed
}
