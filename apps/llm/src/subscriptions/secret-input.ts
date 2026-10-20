import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Readable } from 'node:stream'

const MAX_SECRET_BYTES = 8192
const INPUT_TIMEOUT_MS = 120_000
const TERMINAL_TIMEOUT_MS = 10_000
const unavailable = () => new Error('Не удалось безопасно прочитать или сохранить секрет')

function secretValue(value: string): string {
  const singleLine = value.replace(/\r?\n$/, '')
  if (/[\r\n]/.test(singleLine)) throw unavailable()
  const token = singleLine.trim()
  if (!/^[\x21-\x7e]{1,8192}$/.test(token)) throw unavailable()
  return token
}

function absolutePath(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw unavailable()
}

/** A private regular file is opened without following the final path component. */
export async function readSecretFile(path: string): Promise<string> {
  let file: FileHandle | undefined
  try {
    absolutePath(path)
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      process.getuid === undefined ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 1 ||
      stat.size > MAX_SECRET_BYTES
    )
      throw unavailable()
    const buffer = Buffer.alloc(MAX_SECRET_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, size)
      if (read.bytesRead === 0) break
      size += read.bytesRead
    }
    if (size > MAX_SECRET_BYTES) throw unavailable()
    return secretValue(buffer.subarray(0, size).toString('utf8'))
  } catch {
    throw unavailable()
  } finally {
    await file?.close().catch(() => undefined)
  }
}

/** The token itself is never printed, and an existing path is never replaced. */
export async function writeSecretFile(path: string, secret: string): Promise<void> {
  let file: FileHandle | undefined
  try {
    absolutePath(path)
    if (typeof secret !== 'string' || Buffer.byteLength(secret) > MAX_SECRET_BYTES)
      throw unavailable()
    const value = secretValue(secret)
    file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o400,
    )
    await file.writeFile(value, 'utf8')
  } catch {
    throw unavailable()
  } finally {
    await file?.close().catch(() => undefined)
  }
}

export interface SecretInputStream extends Readable {
  readonly isTTY?: boolean
  readonly isRaw?: boolean
  setRawMode?(mode: boolean): unknown
}

export interface SecretInputIo {
  input: SecretInputStream
  /** Only a controlling terminal may receive the prompt or the final newline. */
  writeTerminal?: (text: string) => Promise<void>
  interrupts: {
    on(event: 'SIGINT', listener: () => void): unknown
    removeListener(event: 'SIGINT', listener: () => void): unknown
  }
}

/** Injectable streams let tests verify terminal restoration without a real terminal. */
export function readSecretInputFrom(
  io: SecretInputIo,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const { input } = io
  if (
    signal?.aborted ||
    typeof prompt !== 'string' ||
    prompt.length > 512 ||
    // One line for the terminal: no Unicode control character, C1 (an 8-bit CSI) included.
    /\p{Cc}/u.test(prompt) ||
    (input.isTTY && (!input.setRawMode || !io.writeTerminal))
  )
    return Promise.reject(unavailable())
  const raw = input.isRaw ?? false
  const flowing = input.readableFlowing === true
  return new Promise<string>((resolve, reject) => {
    const bytes: number[] = []
    let total = 0
    let settled = false
    let rawChanged = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      clearTimeout(timer)
      input.removeListener('data', onData)
      input.removeListener('end', onEnd)
      input.removeListener('close', onDisconnect)
      input.removeListener('error', onDisconnect)
      io.interrupts.removeListener('SIGINT', onDisconnect)
      signal?.removeEventListener('abort', onDisconnect)
      if (rawChanged) {
        try {
          input.setRawMode!(raw)
        } catch {
          // A disconnected terminal cannot be restored; errors contain no terminal data.
        }
      }
      if (flowing) input.resume()
      else input.pause()
      bytes.fill(0)
    }
    const finish = (value?: string) => {
      if (settled) return
      settled = true
      cleanup()
      if (value === undefined) reject(unavailable())
      else resolve(value)
    }
    const complete = () => {
      try {
        const value = secretValue(Buffer.from(bytes).toString('utf8'))
        if (input.isTTY) {
          // Do not keep the secret in a closure while terminal output is pending.
          void io.writeTerminal!('\n').catch(() => undefined)
        }
        finish(value)
      } catch {
        finish()
      }
    }
    const onDisconnect = () => finish()
    const onEnd = () => (input.isTTY ? finish() : complete())
    const onData = (chunk: Buffer | string) => {
      if (settled) return
      const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      total += data.length
      if (total > MAX_SECRET_BYTES) {
        finish()
        return
      }
      if (!input.isTTY) {
        bytes.push(...data)
        return
      }
      for (let index = 0; index < data.length; index += 1) {
        const byte = data[index]!
        if (byte === 3) {
          finish()
          return
        }
        if (byte === 4 || byte === 10 || byte === 13) {
          if (
            index !== data.length - 1 &&
            !(byte === 13 && index === data.length - 2 && data[index + 1] === 10)
          )
            finish()
          else complete()
          return
        }
        if (byte === 8 || byte === 127) bytes.pop()
        else if (byte === 21) bytes.length = 0
        else if (byte < 0x20 || byte > 0x7e) {
          finish()
          return
        } else bytes.push(byte)
      }
    }
    try {
      if (input.isTTY) {
        input.setRawMode!(true)
        rawChanged = true
      }
      input.on('data', onData)
      input.on('end', onEnd)
      input.on('close', onDisconnect)
      input.on('error', onDisconnect)
      io.interrupts.on('SIGINT', onDisconnect)
      signal?.addEventListener('abort', onDisconnect, { once: true })
      timer = setTimeout(onDisconnect, INPUT_TIMEOUT_MS)
      if (signal?.aborted) finish()
      else if (input.destroyed || input.readableEnded) finish()
      else if (input.isTTY) {
        input.pause()
        void io.writeTerminal!(prompt).then(
          () => {
            if (!settled) input.resume()
          },
          () => finish(),
        )
      } else input.resume()
    } catch {
      finish()
    }
  })
}

async function terminalWrite(file: FileHandle, text: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      file.writeFile(text, 'utf8'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(unavailable()), TERMINAL_TIMEOUT_MS)
      }),
    ])
  } catch {
    throw unavailable()
  } finally {
    clearTimeout(timer)
  }
}

async function openTerminal(): Promise<FileHandle> {
  if (!process.stdin.isTTY) throw unavailable()
  try {
    return await open(
      '/dev/tty',
      constants.O_WRONLY | constants.O_NOCTTY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch {
    throw unavailable()
  }
}

export async function readSecretInput(prompt: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw unavailable()
  if (!process.stdin.isTTY)
    return readSecretInputFrom({ input: process.stdin, interrupts: process }, prompt, signal)
  let terminal: FileHandle | undefined
  try {
    terminal = await openTerminal()
    return await readSecretInputFrom(
      {
        input: process.stdin,
        interrupts: process,
        writeTerminal: (text) => terminalWrite(terminal!, text),
      },
      prompt,
      signal,
    )
  } catch {
    throw unavailable()
  } finally {
    await terminal?.close().catch(() => undefined)
  }
}
