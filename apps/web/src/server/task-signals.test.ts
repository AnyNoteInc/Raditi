import { EventEmitter } from 'node:events'

import type { TaskSignal } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { createTaskSignals, type SignalSubscriber } from './task-signals'

const TASK = '01960000-0000-7000-8000-0000000000a1'
const OTHER = '01960000-0000-7000-8000-0000000000b2'

class FakeRedis extends EventEmitter implements SignalSubscriber {
  readonly channels = new Set<string>()
  async subscribe(...channels: string[]) {
    for (const channel of channels) this.channels.add(channel)
  }
  async unsubscribe(...channels: string[]) {
    for (const channel of channels) this.channels.delete(channel)
  }
}

describe('the signals of chats in web', () => {
  it('listens to a channel while a page watches its chat, and gives each its own', () => {
    const redis = new FakeRedis()
    const signals = createTaskSignals(redis)
    expect([...redis.channels]).toEqual(['raditi:tasks:resync'])
    const first: TaskSignal[] = []
    const second: TaskSignal[] = []
    const other: TaskSignal[] = []
    const stopFirst = signals.subscribe(TASK.toUpperCase(), (signal) => first.push(signal))
    const stopSecond = signals.subscribe(TASK, (signal) => second.push(signal))
    signals.subscribe(OTHER, (signal) => other.push(signal))
    expect(redis.channels.has(`raditi:task:${TASK}`)).toBe(true)
    redis.emit('message', `raditi:task:${TASK}`, 'feed')
    redis.emit('message', `raditi:task:${TASK}`, 'nonsense')
    redis.emit('message', `raditi:task:${OTHER}`, 'activity')
    expect(first).toEqual(['feed'])
    expect(second).toEqual(['feed'])
    expect(other).toEqual(['activity'])
    stopFirst()
    expect(redis.channels.has(`raditi:task:${TASK}`)).toBe(true)
    stopSecond()
    expect(redis.channels.has(`raditi:task:${TASK}`)).toBe(false)
  })

  it('tells every page resync on the word of core and once the connection is back', () => {
    const redis = new FakeRedis()
    const signals = createTaskSignals(redis)
    const heard: TaskSignal[] = []
    signals.subscribe(TASK, (signal) => heard.push(signal))
    redis.emit('ready')
    expect(heard).toEqual([])
    redis.emit('message', 'raditi:tasks:resync', 'resync')
    redis.emit('ready')
    expect(heard).toEqual(['resync', 'resync'])
  })
})
