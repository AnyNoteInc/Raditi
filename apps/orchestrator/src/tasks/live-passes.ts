/**
 * The passes this core process works on right now, by task, each with the controller that
 * stops it: «Отменить» aborts it (the turn supervisor reads the abort as `cancelled`), and the
 * sweep leaves such a task to its live handler. One core replica, as LiveTurns (spec §8); with
 * several replicas the owner of a pass moves to the database.
 */
export class LivePasses {
  readonly #passes = new Map<string, AbortController>()

  /** The controller of a new pass of the task; null when this process already works on it. */
  enter(taskId: string): AbortController | null {
    if (this.#passes.has(taskId)) return null
    const controller = new AbortController()
    this.#passes.set(taskId, controller)
    return controller
  }

  leave(taskId: string, controller: AbortController): void {
    if (this.#passes.get(taskId) === controller) this.#passes.delete(taskId)
  }

  has(taskId: string): boolean {
    return this.#passes.has(taskId)
  }

  /** Stops the live pass of the task; false when this process works on none. */
  abort(taskId: string): boolean {
    const controller = this.#passes.get(taskId)
    if (!controller) return false
    controller.abort()
    return true
  }
}
