import { chatCommandRefusals, type ChatCommandRefusal } from '@repo/domain/release/chat-commands'

// A failed call of the dialog procedures as the tRPC client reports it. The server writes the
// message for the client (packages/trpc/src/errors.ts): Russian, on «вы», the refusal's own
// words; a call that never reached the server has only the browser's words, which are not shown.

interface CallErrorShape {
  message?: unknown
  data?: { code?: unknown; domainCode?: unknown; refusal?: unknown } | null
}

const shapeOf = (error: unknown): CallErrorShape =>
  typeof error === 'object' && error !== null ? (error as CallErrorShape) : {}

/** Said when no answer of the server arrived: the network failed, not the request. */
export const OFFLINE_TEXT =
  'Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.'

/** The server's text for a refusal is Russian already, without a full stop. */
function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/** What to tell the client about a failed call. */
export function callErrorText(error: unknown, offline: string = OFFLINE_TEXT): string {
  const { message, data } = shapeOf(error)
  return data && typeof message === 'string' && message.trim() !== '' ? sentence(message) : offline
}

/** The DomainError code of a refusal; null for any other failure. */
export function callErrorCode(error: unknown): string | null {
  const code = shapeOf(error).data?.domainCode
  return typeof code === 'string' ? code : null
}

/** The server answered that there is no such dialog — or that it is someone else's. */
export function isNotFound(error: unknown): boolean {
  return shapeOf(error).data?.code === 'NOT_FOUND'
}

/** Which refusal a refused command was, when the server named one the chat knows. */
export function commandRefusalOf(error: unknown): ChatCommandRefusal | null {
  const refusal = shapeOf(error).data?.refusal
  return chatCommandRefusals.find((known) => known === refusal) ?? null
}
