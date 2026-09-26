import { ApiError } from './api'

/** What the error popup says: what went wrong, why (when known) and what to do next. */
export interface FriendlyError {
  message: string
  next: string | null
  /** Trying again may work (connection or server problem). */
  retryable: boolean
}

/**
 * Messages that only make sense to a developer: validation paths ("values.0.value: …"),
 * type errors, status codes, URLs. The server's own sentences ("A record with the same code
 * or name already exists") are written for users and are shown as they are.
 */
const TECHNICAL =
  /(\bexpected\b.*\breceived\b|invalid input|invalid_type|\w+\.\d+\.\w+|typeerror|referenceerror|syntaxerror|undefined|\bnull\b|json|failed to fetch|econn|etimedout|request failed \(\d{3}\)|https?:\/\/|stack|sql|drizzle)/i

export const isTechnical = (message: string) => !message.trim() || message.length > 240 || TECHNICAL.test(message)

/** Turns any error into plain words: what went wrong and what to do next. */
export function describeError(err: unknown): FriendlyError {
  if (!(err instanceof ApiError)) {
    return { message: 'The page ran into an unexpected problem.', next: 'Try again. If it keeps happening, reload the page.', retryable: true }
  }
  const serverText = isTechnical(err.message) ? null : err.message.replace(/\s+/g, ' ').trim()
  if (err.status === 0) {
    return {
      message: 'The admin panel could not reach the Quality Monitoring server.',
      next: 'Check the network connection and that the server is running, then try again.',
      retryable: true
    }
  }
  if (err.status === 401) return { message: serverText ?? 'Your session has ended.', next: 'Sign in again.', retryable: false }
  if (err.status === 403) return { message: serverText ?? 'Your account is not allowed to do this.', next: 'Ask an Admin if you need access.', retryable: false }
  if (err.status === 404) return { message: serverText ?? 'This item no longer exists. It may have been deleted.', next: 'Reload the page to see the latest list.', retryable: false }
  if (err.status === 409) return { message: serverText ?? 'This was changed by someone else in the meantime.', next: 'Reload the page and try again.', retryable: false }
  if (err.status === 413 || /too large/i.test(err.message)) {
    return { message: serverText ?? 'The file is too large to upload.', next: 'Choose a smaller file.', retryable: false }
  }
  if (err.status >= 500) {
    return {
      message: 'The server had a problem and the change was not saved.',
      next: 'Try again in a moment. If it keeps happening, check the server.',
      retryable: true
    }
  }
  return {
    message: serverText ?? 'Some information is missing or not in the right format.',
    next: serverText ? null : 'Check the form and try again.',
    retryable: false
  }
}

/** The same explanation as one line, for messages shown on the page. */
export function friendlyMessage(err: unknown): string {
  const e = describeError(err)
  return [e.message, e.next].filter(Boolean).join(' ')
}
