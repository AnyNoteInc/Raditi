import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'

export type TelegramRequestInit = RequestInit & { dispatcher?: Dispatcher }
export type TelegramFetch = (url: string, init: TelegramRequestInit) => Promise<Response>

export interface TelegramTransport {
  fetch: TelegramFetch
  dispatcher: Dispatcher | undefined
}

/**
 * Telegram is reached through the egress proxy when one is configured. The proxy request
 * goes through undici's own fetch so the dispatcher and fetch always come from one undici
 * version (the global fetch may be patched, e.g. by Next.js, or bundle another undici).
 * The URL may carry proxy credentials, so errors never echo it.
 */
export function createTelegramTransport(
  proxyUrl: string | undefined,
  injectedFetch?: TelegramFetch,
): TelegramTransport {
  const value = proxyUrl?.trim()
  if (!value) {
    return { fetch: injectedFetch ?? ((url, init) => fetch(url, init)), dispatcher: undefined }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('Invalid Telegram proxy URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Unsupported Telegram proxy URL protocol')
  }

  return {
    fetch: injectedFetch ?? (undiciFetch as unknown as TelegramFetch),
    dispatcher: new ProxyAgent(url.href),
  }
}
