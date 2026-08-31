import { useCallback, useEffect, useState } from 'react'

/**
 * Data that is already there when a screen opens.
 *
 * Every screen used to fetch on mount and render nothing until the answer came
 * back, and switching away threw the answer out — so returning to a screen paid
 * the full wait again. On the pod list that wait is a call to RunPod plus a
 * health probe per pod, which is precisely when somebody is looking at it.
 *
 * So the last value is kept outside the component and handed over immediately,
 * and the fresh one replaces it when it arrives. What was true a few seconds ago
 * is a far better thing to show than an empty box.
 */
const values = new Map<string, unknown>()

/**
 * Requests in flight, so two components mounting together ask once.
 *
 * With the time they started, because joining an *older* request is wrong: press
 * stop, and a refresh that attaches to a call made before the stop returns the
 * state from before it — the list would go on showing the pod as running. Only
 * genuinely simultaneous callers share an answer.
 */
const inFlight = new Map<string, { request: Promise<unknown>; startedAt: number }>()
const SHARE_WINDOW_MS = 150

export interface Cached<T> {
  /** The last known value, or undefined before there has ever been one. */
  data: T | undefined
  /** True only while the very first value is being fetched. */
  loading: boolean
  error: string | null
  /**
   * Fetches again.
   *
   * `'poll'` does nothing while a request for the same key is still running.
   * That is the guarantee that matters: a timer firing every five seconds into
   * a request that takes eight piles up requests without bound, and each one of
   * those was a call to RunPod plus a health probe per pod — which is how one
   * slow screen made every other screen slow too.
   */
  refresh: (mode?: 'user' | 'poll') => Promise<void>
}

export function useCached<T>(
  key: string,
  load: () => Promise<T>,
  options: { pollMs?: number } = {},
): Cached<T> {
  const [data, setData] = useState<T | undefined>(() => values.get(key) as T | undefined)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (mode: 'user' | 'poll' = 'user'): Promise<void> => {
    const pending = inFlight.get(key)

    // A timer never adds to a queue. Whatever is already on its way will
    // deliver the same answer this tick wanted.
    if (mode === 'poll' && pending) {
      await pending.request.catch(() => undefined)
      return
    }

    const shareable =
      pending && Date.now() - pending.startedAt < SHARE_WINDOW_MS
        ? (pending.request as Promise<T>)
        : undefined
    const request =
      shareable ??
      load().finally(() => {
        if (inFlight.get(key)?.request === request) inFlight.delete(key)
      })
    if (!shareable) inFlight.set(key, { request, startedAt: Date.now() })

    try {
      const next = await request
      values.set(key, next)
      setData(next)
      setError(null)
    } catch (cause) {
      // The stale value stays on screen. A failed refresh is a reason to say so,
      // not a reason to blank out what was working a moment ago.
      setError((cause as Error).message)
    }
    // `load` is a fresh closure on every render, so it is deliberately not a
    // dependency; the key is what identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    void refresh()
    if (!options.pollMs) return
    const timer = setInterval(() => void refresh('poll'), options.pollMs)
    return () => clearInterval(timer)
  }, [refresh, options.pollMs])

  return { data, loading: data === undefined && error === null, error, refresh }
}

/** Drops a cached value, after something that certainly changed it. */
export function invalidate(key: string): void {
  values.delete(key)
}
