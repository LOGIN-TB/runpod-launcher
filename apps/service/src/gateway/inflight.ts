/**
 * Counts requests currently being served.
 *
 * The scheduler needs to know, because stopping a pod mid-generation throws
 * away work somebody is waiting on. Observed: an agent's request arrived at
 * 21:30:08 and the pod was stopped at 21:30:19 — eleven seconds into a task
 * that then had to start over.
 */
export class InFlight {
  #count = 0
  #lastFinishedAt: number | null = null

  get count(): number {
    return this.#count
  }

  /** Seconds since the last request finished, or null if none has. */
  get quietForSeconds(): number | null {
    return this.#lastFinishedAt === null ? null : Math.round((Date.now() - this.#lastFinishedAt) / 1000)
  }

  async track<T>(work: () => Promise<T>): Promise<T> {
    this.#count += 1
    try {
      return await work()
    } finally {
      this.#count -= 1
      this.#lastFinishedAt = Date.now()
    }
  }
}
