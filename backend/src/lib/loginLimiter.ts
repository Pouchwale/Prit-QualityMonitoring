import { HttpError } from './http'

/**
 * Slows down password guessing. Failed sign-ins are counted per employee ID from one address, and
 * per address over all employee IDs; past the limit that address waits before trying again. A
 * successful sign-in clears the employee ID's count. Kept in memory: a restart forgets the counts,
 * which only gives a guesser a fresh window, never locks anyone out for longer.
 *
 * The per-address limit is generous because a whole plant can share one address behind its router.
 */

const WINDOW_MS = 15 * 60_000
const MAX_PER_ACCOUNT = 10
const MAX_PER_ADDRESS = 50

interface Counter {
  failures: number
  /** When the window of this counter started. */
  since: number
}

const counters = new Map<string, Counter>()

const accountKey = (ip: string, employeeId: string) => `a:${ip}:${employeeId.trim().toLowerCase()}`
const addressKey = (ip: string) => `i:${ip}`

function current(key: string, now: number): Counter | null {
  const counter = counters.get(key)
  if (!counter) return null
  if (now - counter.since > WINDOW_MS) {
    counters.delete(key)
    return null
  }
  return counter
}

/** Refuses the attempt (429) while this address is over a limit. */
export function assertLoginAllowed(ip: string, employeeId: string) {
  const now = Date.now()
  for (const [key, max] of [
    [accountKey(ip, employeeId), MAX_PER_ACCOUNT],
    [addressKey(ip), MAX_PER_ADDRESS]
  ] as const) {
    const counter = current(key, now)
    if (counter && counter.failures >= max) {
      const minutes = Math.max(1, Math.ceil((counter.since + WINDOW_MS - now) / 60_000))
      throw new HttpError(429, `Too many wrong sign-in attempts. Please wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`)
    }
  }
}

export function recordLoginFailure(ip: string, employeeId: string) {
  const now = Date.now()
  for (const key of [accountKey(ip, employeeId), addressKey(ip)]) {
    const counter = current(key, now)
    if (counter) counter.failures++
    else counters.set(key, { failures: 1, since: now })
  }
  // Keep the map small: drop expired counters now and then.
  if (counters.size > 10_000) for (const key of [...counters.keys()]) current(key, now)
}

export function recordLoginSuccess(ip: string, employeeId: string) {
  counters.delete(accountKey(ip, employeeId))
}
