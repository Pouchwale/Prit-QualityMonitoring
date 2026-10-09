/**
 * Sign-in tokens in the browser. Browsers have no keychain, so localStorage is used; it is
 * scoped to this site. Private browsing or blocked site data just means signing in again.
 */
const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

export const tokenStorage = {
  get: async (key: string) => safe(() => localStorage.getItem(key), null),
  set: async (key: string, value: string) => safe(() => localStorage.setItem(key, value), undefined),
  remove: async (key: string) => safe(() => localStorage.removeItem(key), undefined)
}

/**
 * Check forms started but not sent yet (typed readings and Not Applicable choices, never photos
 * or videos), in localStorage under one key per check. A full or blocked storage only loses the draft.
 */
const DRAFT_PREFIX = 'quality.checkDraft.'

export const draftStorage = {
  get: async (id: string) => safe(() => localStorage.getItem(DRAFT_PREFIX + id), null),
  set: async (id: string, value: string) => safe(() => localStorage.setItem(DRAFT_PREFIX + id, value), undefined),
  remove: async (id: string) => safe(() => localStorage.removeItem(DRAFT_PREFIX + id), undefined),
  /** At sign out: the next person on this browser starts with empty forms. */
  clear: async () =>
    safe(() => {
      const keys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith(DRAFT_PREFIX)) keys.push(key)
      }
      keys.forEach((key) => localStorage.removeItem(key))
    }, undefined)
}
