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
