import { Counter, Gauge, type Registry } from '@prometheus-io/client'

// What the windows of the pool and of the workspaces look like to the operator (plan 70, §4.4):
// gauges of each account's windows after every probe, the error of the forecast a probe replaced,
// refusals by the windows of a workspace. No id of a workspace, a task or a user in a label; the
// label `account` is the operator's label of a pool account, not a customer's id.

type WindowName = '5h' | 'week'

export class UsageMetrics {
  readonly #windows = new Map<
    string,
    { backend: string; plan: string; window: WindowName; used: number; limit: number }
  >()
  readonly #refusals = new Map<string, number>()
  #forecastErrors: number[] = []

  /** The window of an account after a probe, in plan credits. */
  account(input: {
    backend: string
    account: string
    plan: string
    window: WindowName
    used: number
    limit: number
  }): void {
    // A label of the operator is free text (an e-mail, perhaps): only a slug goes to a metric.
    const account = /^[a-z0-9][a-z0-9-]{0,31}$/.test(input.account) ? input.account : 'other'
    this.#windows.set(`${account}\u0000${input.window}`, input)
  }

  /**
   * The free share of each window over the accounts of a backend that were probed, 0…1: every
   * account the role has seen, a paused one too — the pool's own reserve (core, pickAccount)
   * counts only the eligible ones.
   */
  #poolRemaining(): Map<string, number> {
    const sums = new Map<string, { left: number; size: number }>()
    for (const value of this.#windows.values()) {
      const key = `${value.backend}\u0000${value.window}`
      const sum = sums.get(key) ?? { left: 0, size: 0 }
      sum.left += Math.max(0, value.limit - value.used)
      sum.size += value.limit
      sums.set(key, sum)
    }
    return new Map([...sums].map(([key, sum]) => [key, sum.size > 0 ? sum.left / sum.size : 0]))
  }

  /** How far the forecast missed the probe, as a share of the window. */
  forecastError(ratio: number): void {
    this.#forecastErrors.push(ratio)
    if (this.#forecastErrors.length > 1_000) this.#forecastErrors = this.#forecastErrors.slice(-500)
  }

  /** A call refused by a window of its workspace (point `call`). */
  windowRefusal(input: { tier: string; window: string }): void {
    const key = `${input.tier}\u0000${input.window}`
    this.#refusals.set(key, (this.#refusals.get(key) ?? 0) + 1)
  }

  register(registry: Registry): void {
    const windows = this.#windows
    const remaining = () => this.#poolRemaining()
    const refusals = this.#refusals
    const errors = () => this.#forecastErrors
    new Gauge({
      name: 'raditi_llm_account_window_used_credits',
      help: 'Plan credits a window of a pool account has used, by its last probe',
      labelNames: ['account', 'plan', 'window'],
      registers: [registry],
      collect() {
        this.reset()
        for (const [key, value] of windows)
          this.set(
            { account: key.split('\u0000')[0]!, plan: value.plan, window: value.window },
            value.used,
          )
      },
    })
    new Gauge({
      name: 'raditi_llm_account_window_limit_credits',
      help: 'Plan credits a window of a pool account holds',
      labelNames: ['account', 'plan', 'window'],
      registers: [registry],
      collect() {
        this.reset()
        for (const [key, value] of windows)
          this.set(
            { account: key.split('\u0000')[0]!, plan: value.plan, window: value.window },
            value.limit,
          )
      },
    })
    new Gauge({
      name: 'raditi_llm_pool_window_remaining_ratio',
      help: 'Free share of a window over the probed accounts of a backend, paused ones included',
      labelNames: ['backend', 'window'],
      registers: [registry],
      collect() {
        this.reset()
        for (const [key, value] of remaining()) {
          const [backend, window] = key.split('\u0000')
          this.set({ backend: backend!, window: window! }, value)
        }
      },
    })
    new Gauge({
      name: 'raditi_llm_window_projection_error_ratio',
      help: 'Mean error of the forecast of a window against the probe that replaced it, as a share of the window',
      registers: [registry],
      collect() {
        const values = errors()
        this.set(values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length)
      },
    })
    new Counter({
      name: 'raditi_workspace_window_refusals_total',
      help: 'Calls refused by a usage window of their workspace',
      labelNames: ['tier', 'window', 'point'],
      registers: [registry],
      collect() {
        this.reset()
        for (const [key, value] of refusals) {
          const [tier, window] = key.split('\u0000')
          this.inc({ tier: tier!, window: window!, point: 'call' }, value)
        }
      },
    })
  }
}
