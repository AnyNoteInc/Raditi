'use client'

// The signals of a chat inside its page (spec §7): the feed's hook holds the one stream of
// `task.signals` and passes on what concerns «Ход работы» — the agent's output of a turn came — and
// whether the stream is up, which makes every poll of the page a slower fallback.

type Listener = () => void

const activity = new Map<string, Set<Listener>>()
const connected = new Map<string, boolean>()

export const taskSignalBus = Object.freeze({
  /** The agent's output of a turn of the chat came, or signals may have been missed. */
  activity(taskId: string): void {
    for (const listener of activity.get(taskId) ?? []) listener()
  },
  onActivity(taskId: string, listener: Listener): () => void {
    const set = activity.get(taskId) ?? new Set<Listener>()
    set.add(listener)
    activity.set(taskId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) activity.delete(taskId)
    }
  },
  setConnected(taskId: string, up: boolean): void {
    if (up) connected.set(taskId, true)
    else connected.delete(taskId)
  },
  /** The stream of the chat is up: changes are said as they commit. */
  connected(taskId: string): boolean {
    return connected.get(taskId) === true
  },
})
