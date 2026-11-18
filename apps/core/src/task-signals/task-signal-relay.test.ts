import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { TaskSignalRelay, type SignalListener } from './task-signal-relay.ts'

const TASK = '01960000-0000-7000-8000-0000000000a1'
const OTHER = '01960000-0000-7000-8000-0000000000b2'

/** A connection of the database the test drives: it notifies, fails and ends on demand. */
class FakeListener extends EventEmitter implements SignalListener {
  readonly queries: string[] = []
  failConnect = false
  ended = false

  async connect() {
    if (this.failConnect) throw new Error('connection refused')
  }

  async query(sql: string) {
    this.queries.push(sql)
  }

  async end() {
    this.ended = true
  }

  notify(payload: string, channel = 'raditi_task') {
    this.emit('notification', { channel, payload })
  }
}

function relay(options: { failFirst?: number } = {}) {
  const listeners: FakeListener[] = []
  const published: [string, string][] = []
  const warnings: string[] = []
  let failing = options.failFirst ?? 0
  const instance = new TaskSignalRelay({
    listener: () => {
      const listener = new FakeListener()
      if (failing > 0) {
        failing -= 1
        listener.failConnect = true
      }
      listeners.push(listener)
      return listener
    },
    publish: async (channel, message) => {
      published.push([channel, message])
    },
    logger: { log: () => undefined, warn: (line) => warnings.push(line) },
    coalesceMs: 20,
    retryMs: 10,
    maxRetryMs: 40,
  })
  return { instance, listeners, published, warnings }
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const relays: TaskSignalRelay[] = []
afterEach(async () => {
  for (const instance of relays.splice(0)) await instance.stop()
})

describe('the relay of the signals of chats', () => {
  it('listens, says resync, and relays each task and kind once per burst', async () => {
    const { instance, listeners, published } = relay()
    relays.push(instance)
    instance.start()
    await settle()
    expect(listeners[0]!.queries).toEqual(['LISTEN raditi_task'])
    expect(published).toEqual([['raditi:tasks:resync', 'resync']])
    published.length = 0
    const listener = listeners[0]!
    for (let index = 0; index < 5; index += 1) listener.notify(`${TASK}:activity`)
    listener.notify(`${TASK}:feed`)
    listener.notify(`${OTHER.toUpperCase()}:feed`)
    // Not one of the triggers': nothing is said.
    listener.notify('anything:feed')
    listener.notify(`${TASK}:delete`)
    await settle(40)
    expect(published.sort()).toEqual(
      [
        [`raditi:task:${TASK}`, 'activity'],
        [`raditi:task:${TASK}`, 'feed'],
        [`raditi:task:${OTHER}`, 'feed'],
      ].sort(),
    )
  })

  it('connects again after a loss, with a wait that grows, and says resync each time', async () => {
    const { instance, listeners, published, warnings } = relay({ failFirst: 2 })
    relays.push(instance)
    instance.start()
    await settle(100)
    // Two refused connections, then one that listens.
    expect(listeners).toHaveLength(3)
    expect(listeners[2]!.queries).toEqual(['LISTEN raditi_task'])
    expect(warnings).toEqual([
      'task_signals_lost cause=Error retry_ms=10',
      'task_signals_lost cause=Error retry_ms=20',
    ])
    expect(published).toEqual([['raditi:tasks:resync', 'resync']])
    // The connection that listened ends: a new one, and resync again.
    listeners[2]!.emit('end')
    await settle(30)
    expect(listeners).toHaveLength(4)
    expect(published).toEqual([
      ['raditi:tasks:resync', 'resync'],
      ['raditi:tasks:resync', 'resync'],
    ])
  })

  it('wakes the outbox relay when rows of the outbox commit, and once it listens', async () => {
    const listener = new FakeListener()
    const outbox = vi.fn()
    const published: [string, string][] = []
    const instance = new TaskSignalRelay({
      listener: () => listener,
      publish: async (channel, message) => {
        published.push([channel, message])
      },
      outbox,
      logger: { log: () => undefined, warn: () => undefined },
    })
    relays.push(instance)
    instance.start()
    await settle()
    expect(listener.queries).toEqual(['LISTEN raditi_task', 'LISTEN raditi_outbox'])
    // What was added while nobody listened is relayed at once.
    expect(outbox).toHaveBeenCalledOnce()
    listener.notify('', 'raditi_outbox')
    expect(outbox).toHaveBeenCalledTimes(2)
    await settle(80)
    expect(published).toEqual([['raditi:tasks:resync', 'resync']])
  })

  it('stops for good: no connection after it, and the open one ends', async () => {
    const { instance, listeners } = relay()
    instance.start()
    await settle()
    await instance.stop()
    expect(listeners[0]!.ended).toBe(true)
    listeners[0]!.emit('end')
    await settle(30)
    expect(listeners).toHaveLength(1)
  })

  it('says nothing that the publish refused twice: the next signal goes as any', async () => {
    const publish = vi
      .fn<(channel: string, message: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('redis away'))
      .mockResolvedValue(1)
    const listener = new FakeListener()
    const warnings: string[] = []
    const instance = new TaskSignalRelay({
      listener: () => listener,
      publish,
      logger: { log: () => undefined, warn: (line) => warnings.push(line) },
      coalesceMs: 5,
    })
    relays.push(instance)
    instance.start()
    await settle()
    expect(warnings).toEqual(['task_signals_resync_not_published: Error'])
    listener.notify(`${TASK}:feed`)
    await settle(20)
    expect(publish).toHaveBeenLastCalledWith(`raditi:task:${TASK}`, 'feed')
  })
})
