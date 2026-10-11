import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import { chmod, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  readSecretFile,
  readSecretInput,
  readSecretInputFrom,
  writeSecretFile,
  type SecretInputStream,
} from './secret-input.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, open: vi.fn(actual.open) }
})

const dirs: string[] = []
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'raditi-subscription-input-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('private secret files', () => {
  it('creates an owner-read-only file and reads a single token without printing it', async () => {
    const path = join(await directory(), 'token')
    await writeSecretFile(path, 'synthetic-secret')
    expect((await stat(path)).mode & 0o777).toBe(0o400)
    expect(await readFile(path, 'utf8')).toBe('synthetic-secret')
    expect(await readSecretFile(path)).toBe('synthetic-secret')
  })

  it('accepts a private token file with a single trailing newline', async () => {
    const path = join(await directory(), 'token')
    await writeFile(path, ' synthetic-secret \r\n', { mode: 0o600 })
    expect(await readSecretFile(path)).toBe('synthetic-secret')
  })

  it('never replaces an existing file or a symlink', async () => {
    const dir = await directory()
    const path = join(dir, 'token')
    const link = join(dir, 'link')
    await writeFile(path, 'original-secret', { mode: 0o600 })
    await symlink(path, link)
    await expect(writeSecretFile(path, 'replacement')).rejects.toThrow('безопасно')
    await expect(writeSecretFile(link, 'replacement')).rejects.toThrow('безопасно')
    await expect(readSecretFile(link)).rejects.toThrow('безопасно')
    expect(await readFile(path, 'utf8')).toBe('original-secret')
  })

  it('rejects public permissions, another owner and nonregular paths', async () => {
    const dir = await directory()
    const path = join(dir, 'token')
    await writeFile(path, 'synthetic-secret', { mode: 0o644 })
    await expect(readSecretFile(path)).rejects.toThrow('безопасно')
    await chmod(path, 0o600)
    vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1)
    await expect(readSecretFile(path)).rejects.toThrow('безопасно')
    await expect(readSecretFile(dir)).rejects.toThrow('безопасно')
  })

  it.each(['', 'two\nlines', 'secret\n\n', 'secret\0suffix', 'секрет', 'a'.repeat(8193)])(
    'rejects invalid contents without including them in an error (%#)',
    async (value) => {
      const dir = await directory()
      const path = join(dir, 'private-path')
      await writeFile(path, value, { mode: 0o600 })
      const error = await readSecretFile(path).catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('Не удалось безопасно прочитать или сохранить секрет')
      await expect(writeSecretFile(join(dir, 'new'), value)).rejects.toThrow('безопасно')
    },
  )

  it('rejects relative paths before attempting filesystem I/O', async () => {
    vi.mocked(open).mockClear()
    await expect(readSecretFile('relative')).rejects.toThrow('безопасно')
    await expect(writeSecretFile('relative', 'synthetic-secret')).rejects.toThrow('безопасно')
    expect(open).not.toHaveBeenCalled()
  })
})

function streams(tty = false, raw = false) {
  const input = new PassThrough() as PassThrough &
    SecretInputStream & { isTTY: boolean; isRaw: boolean }
  input.isTTY = tty
  input.isRaw = raw
  const setRawMode = vi.fn((value: boolean) => {
    input.isRaw = value
    return input
  })
  input.setRawMode = setRawMode
  const interrupts = new EventEmitter()
  const writeTerminal = vi.fn(async (_text: string) => undefined)
  const read = (signal?: AbortSignal) =>
    readSecretInputFrom({ input, interrupts, writeTerminal }, 'Введите ключ: ', signal)
  const cleaned = () => {
    for (const name of ['data', 'end', 'close', 'error']) expect(input.listenerCount(name)).toBe(0)
    expect(interrupts.listenerCount('SIGINT')).toBe(0)
    expect(input.isPaused()).toBe(true)
  }
  return { input, interrupts, writeTerminal, setRawMode, read, cleaned }
}

describe('bounded secret input', () => {
  it('reads piped stdin only through EOF and emits no prompt or secret', async () => {
    const fixture = streams()
    const result = fixture.read()
    fixture.input.write('synthetic-')
    fixture.input.end('secret\n')
    expect(await result).toBe('synthetic-secret')
    expect(fixture.writeTerminal).not.toHaveBeenCalled()
    expect(fixture.setRawMode).not.toHaveBeenCalled()
    fixture.cleaned()
  })

  it('rejects multiple piped lines even when they arrive in separate chunks', async () => {
    const fixture = streams()
    const result = fixture.read()
    fixture.input.write('synthetic-secret\n')
    fixture.input.end('another-secret\n')
    await expect(result).rejects.toThrow('безопасно')
    fixture.cleaned()
  })

  it('rejects oversized input and disconnects without waiting for EOF', async () => {
    const fixture = streams()
    const result = fixture.read()
    fixture.input.write('a'.repeat(8193))
    await expect(result).rejects.toThrow('безопасно')
    fixture.cleaned()
  })

  it.each([false, true])('hides typing and restores previous raw mode %s', async (raw) => {
    const fixture = streams(true, raw)
    const result = fixture.read()
    await Promise.resolve()
    fixture.input.write('synthetic-secret\r')
    expect(await result).toBe('synthetic-secret')
    expect(fixture.writeTerminal.mock.calls.flat()).toEqual(['Введите ключ: ', '\n'])
    expect(fixture.setRawMode.mock.calls).toEqual([[true], [raw]])
    expect(fixture.input.isRaw).toBe(raw)
    fixture.cleaned()
  })

  it('supports backspace and clearing a hidden line without echo', async () => {
    const fixture = streams(true)
    const result = fixture.read()
    await Promise.resolve()
    fixture.input.write('discard\x15synthetic-x\x7fsecret\n')
    expect(await result).toBe('synthetic-secret')
    expect(fixture.writeTerminal.mock.calls.flat()).toEqual(['Введите ключ: ', '\n'])
    fixture.cleaned()
  })

  it.each(['abort', 'SIGINT', 'ctrl-c', 'close', 'end', 'error'])(
    'restores a terminal after %s without exposing secret bytes',
    async (event) => {
      const fixture = streams(true)
      const controller = new AbortController()
      const result = fixture.read(controller.signal)
      await Promise.resolve()
      fixture.input.write('synthetic-secret')
      if (event === 'abort') controller.abort(new Error('unsafe-secret-reason'))
      else if (event === 'SIGINT') fixture.interrupts.emit('SIGINT')
      else if (event === 'ctrl-c') fixture.input.write('\x03')
      else if (event === 'error') fixture.input.emit('error', new Error('unsafe-secret-error'))
      else fixture.input.emit(event)
      await expect(result).rejects.toThrow('безопасно')
      expect(fixture.input.isRaw).toBe(false)
      expect(fixture.writeTerminal.mock.calls.flat()).toEqual(['Введите ключ: '])
      fixture.cleaned()
    },
  )

  it('bounds an input that never completes and clears the timeout after cleanup', async () => {
    vi.useFakeTimers()
    const fixture = streams(true)
    const result = fixture.read()
    const failed = expect(result).rejects.toThrow('безопасно')
    await vi.advanceTimersByTimeAsync(120_000)
    await failed
    expect(fixture.input.isRaw).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    fixture.cleaned()
  })

  it('cleans up a terminal prompt write failure', async () => {
    const fixture = streams(true)
    fixture.writeTerminal.mockRejectedValueOnce(new Error('unsafe-secret-error'))
    await expect(fixture.read()).rejects.toThrow('безопасно')
    expect(fixture.input.isRaw).toBe(false)
    fixture.cleaned()
  })

  it('preserves existing listeners and a previously flowing input on failure', async () => {
    const fixture = streams(true)
    const previousData = vi.fn()
    const previousClose = vi.fn()
    fixture.input.on('data', previousData)
    fixture.input.on('close', previousClose)
    fixture.input.resume()
    fixture.writeTerminal.mockRejectedValueOnce(new Error('unsafe-secret-error'))
    await expect(fixture.read()).rejects.toThrow('безопасно')
    expect(fixture.input.isRaw).toBe(false)
    expect(fixture.input.isPaused()).toBe(false)
    expect(fixture.input.listeners('data')).toEqual([previousData])
    expect(fixture.input.listeners('close')).toEqual([previousClose])
    expect(fixture.interrupts.listenerCount('SIGINT')).toBe(0)
    fixture.input.pause()
    fixture.input.removeAllListeners()
  })

  it('does not change a terminal when already aborted', async () => {
    const fixture = streams(true)
    const controller = new AbortController()
    controller.abort()
    await expect(fixture.read(controller.signal)).rejects.toThrow('безопасно')
    expect(fixture.setRawMode).not.toHaveBeenCalled()
    expect(fixture.writeTerminal).not.toHaveBeenCalled()
    expect(fixture.interrupts.listenerCount('SIGINT')).toBe(0)
  })

  // The prompts are constants of the command today; the rule is the one of every other one-line
  // text shown to the operator. Cases are named: the reporter would print a raw control.
  it.each([
    ['an escape', 'Ключ\x1b[2J: '],
    ['a line feed', 'Ключ\n: '],
    ['U+009B, an 8-bit CSI', 'Ключ\u009b2J: '],
    ['U+0085, a next-line', 'Ключ\u0085: '],
  ])('refuses a prompt with %s before touching the terminal', async (_name, prompt) => {
    const fixture = streams(true)
    const { input, interrupts, writeTerminal } = fixture
    await expect(readSecretInputFrom({ input, interrupts, writeTerminal }, prompt)).rejects.toThrow(
      'безопасно',
    )
    expect(fixture.setRawMode).not.toHaveBeenCalled()
    expect(writeTerminal).not.toHaveBeenCalled()
    expect(interrupts.listenerCount('SIGINT')).toBe(0)
  })

  it('rejects multiline pastes and escape sequences instead of echoing them', async () => {
    for (const value of ['secret\nsecond', '\x1b[31msecret\n', 'секрет\n']) {
      const fixture = streams(true)
      const result = fixture.read()
      await Promise.resolve()
      fixture.input.write(value)
      await expect(result).rejects.toThrow('безопасно')
      expect(fixture.writeTerminal.mock.calls.flat()).toEqual(['Введите ключ: '])
      fixture.cleaned()
    }
  })
})

describe('hidden input on the controlling terminal', () => {
  const withTty = async (value: boolean, body: () => Promise<void>) => {
    const previous = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value })
    try {
      await body()
    } finally {
      if (previous) Object.defineProperty(process.stdin, 'isTTY', previous)
      else Reflect.deleteProperty(process.stdin, 'isTTY')
    }
  }

  it('opens only /dev/tty for its prompt, without following a link, and closes it', async () => {
    const file = { writeFile: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }
    vi.mocked(open).mockClear()
    vi.mocked(open).mockResolvedValueOnce(file as unknown as Awaited<ReturnType<typeof open>>)
    await withTty(true, async () => {
      // The stdin of a test run has no raw mode: the input is refused once the terminal is open.
      await expect(readSecretInput('Введите ключ: ')).rejects.toThrow('безопасно')
    })
    expect(vi.mocked(open).mock.calls).toEqual([
      [
        '/dev/tty',
        constants.O_WRONLY | constants.O_NOCTTY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ],
    ])
    expect(file.writeFile).not.toHaveBeenCalled()
    expect(file.close).toHaveBeenCalledOnce()
  })

  it('opens no terminal for a noninteractive process', async () => {
    vi.mocked(open).mockClear()
    await withTty(false, async () => {
      const controller = new AbortController()
      const reading = readSecretInput('Введите ключ: ', controller.signal)
      controller.abort()
      await expect(reading).rejects.toThrow('безопасно')
    })
    expect(open).not.toHaveBeenCalled()
  })
})
