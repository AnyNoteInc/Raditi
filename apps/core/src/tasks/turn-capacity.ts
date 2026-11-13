import type { TurnExecutor } from '@repo/domain'

/**
 * The places for turns on the whole platform (docs/plan/70-turn-without-time-limit.md, ВР17):
 * no more than AGENT_TURN_CAPACITY at once, and with runner VMs no more than the places their
 * runners report (TurnExecutor.slots). A pass takes one before its turn and gives it back when
 * the pass ends; a pass that finds none waits for the agents in the queue and holds no worker of
 * `agent-turns` meanwhile, so «Отменить», «Обновить» and `/undo` never wait behind long passes.
 * In this process only: core runs as one replica (spec §8).
 */
export class TurnCapacity {
  #held = 0

  constructor(
    private readonly limit: number,
    private readonly executor?: Pick<TurnExecutor, 'slots'> | null,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Invalid turn capacity')
  }

  /** The turns that hold a place now. */
  get held(): number {
    return this.#held
  }

  /** How many places there are now: the setting, and the runners' places when they report any. */
  get size(): number {
    const slots = this.executor?.slots?.()
    return slots === undefined ? this.limit : Math.min(this.limit, Math.max(0, slots))
  }

  /** A place for one turn and how to give it back, once; null while every place is taken. */
  tryAcquire(): (() => void) | null {
    if (this.#held >= this.size) return null
    this.#held += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.#held -= 1
    }
  }
}
