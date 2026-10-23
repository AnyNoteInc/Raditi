import { afterEach, describe, expect, it, vi } from 'vitest'

import { EgressHealth } from '../egress/egress-probe.ts'
import { ChannelMonitor } from './channel-monitor.ts'
import { MaintenanceJobs } from './maintenance-jobs.ts'

// The channel of a role with a proxy: its byte probe and the account recheck are the fakes.
const monitored = () => {
  const probe = vi.fn().mockResolvedValue(true)
  const recheckRegion = vi.fn().mockResolvedValue(false)
  const logger = { warn: vi.fn() }
  const channel = new EgressHealth({ check: probe }, logger)
  const jobs = new MaintenanceJobs(logger)
  const monitor = new ChannelMonitor(channel, { recheckRegion }, jobs)
  return { probe, recheckRegion, channel, jobs, monitor }
}

describe('llm role lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a confirmed region closed through channel probes until an account recheck lifts it', async () => {
    vi.useFakeTimers()
    const { probe, recheckRegion, channel, jobs, monitor } = monitored()
    await channel.check()
    monitor.start()
    expect(channel.healthy()).toBe(true)
    // What the pool does when an account probe confirms the region (pool.module.test.ts).
    channel.blockRegion('synthetic-account')
    expect(channel.healthy()).toBe(false)
    // Healthy byte probes of the channel never reopen it.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(channel.healthy()).toBe(false)
    expect(recheckRegion).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(recheckRegion).toHaveBeenCalledExactlyOnceWith('synthetic-account')
    expect(channel.healthy()).toBe(false)
    recheckRegion.mockResolvedValueOnce(true)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(recheckRegion).toHaveBeenCalledTimes(2)
    expect(channel.healthy()).toBe(true)
    monitor.stop()
    jobs.close()
  })

  it('reprobes a failed channel within seconds instead of closing admission for five minutes', async () => {
    vi.useFakeTimers()
    const { probe, channel, jobs, monitor } = monitored()
    await channel.check()
    monitor.start()
    probe.mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(channel.healthy()).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(probe).toHaveBeenCalledTimes(3)
    expect(channel.healthy()).toBe(false)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(probe).toHaveBeenCalledTimes(4)
    expect(channel.healthy()).toBe(true)
    monitor.stop()
    jobs.close()
  })
})
