import { describe, expect, it, vi } from 'vitest'

import { appLogger, listenHost, LOCAL_HOST } from './bootstrap.ts'

describe('listenHost', () => {
  it('listens on loopback outside production and on every interface in production', () => {
    expect(listenHost('development')).toBe(LOCAL_HOST)
    expect(listenHost('test')).toBe('127.0.0.1')
    expect(listenHost('production')).toBeUndefined()
  })
})

describe('appLogger', () => {
  const written = (logger: ReturnType<typeof appLogger>) => {
    const lines: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    try {
      logger.log('listening', 'Main')
    } finally {
      spy.mockRestore()
    }
    return lines.join('')
  }

  it('starts the lines of an app with the name of its container', () => {
    // eslint-disable-next-line no-control-regex
    const line = written(appLogger('development', 'llm')).replace(/\u001b\[[0-9;]*m/g, '')
    expect(line).toMatch(/^\[llm\] \d+ {2}- /)
    expect(line).toContain('[Main] listening')
  })

  it('writes one JSON line per record in production', () => {
    const record = JSON.parse(written(appLogger('production', 'runner')))
    expect(record).toMatchObject({ level: 'log', context: 'Main', message: 'listening' })
  })
})
