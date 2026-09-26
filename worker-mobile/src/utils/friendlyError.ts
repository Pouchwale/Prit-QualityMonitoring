import { ApiError } from '../services/api'

/** What the error popup says: what went wrong, why (when known) and what to do next. */
export interface FriendlyError {
  title: string
  message: string
  /** What the worker should do next. */
  next: string | null
  /** Trying again may work (connection or server problem). */
  retryable: boolean
  tone: 'error' | 'warning'
}

/**
 * Messages that only make sense to a developer: validation paths ("values.0.value: …"),
 * type errors, status codes, URLs. The server's own sentences ("This check was already
 * submitted") are written for workers and are shown as they are.
 */
const TECHNICAL =
  /(\bexpected\b.*\breceived\b|invalid input|invalid_type|\w+\.\d+\.\w+|typeerror|referenceerror|syntaxerror|undefined|\bnull\b|json|fetch|econn|etimedout|\bstatus\b|\(\d{3}\)|https?:\/\/|stack|exception:|sql|drizzle)/i

export const isTechnical = (message: string) => !message.trim() || message.length > 220 || TECHNICAL.test(message)

/**
 * Turns any error into words a worker understands. `title` is what the worker was doing
 * ("Could not submit"); it is kept for errors the server explains itself.
 */
export function describeError(err: unknown, title = 'Something went wrong'): FriendlyError {
  if (!(err instanceof ApiError)) {
    return {
      title,
      message: 'The app ran into an unexpected problem.',
      next: 'Try again. If it keeps happening, close and reopen the app.',
      retryable: true,
      tone: 'error'
    }
  }
  const serverText = isTechnical(err.message) ? null : err.message.replace(/\s+/g, ' ').trim()
  switch (true) {
    case err.status === 0:
      return {
        title: 'No connection to the server',
        message: 'The app could not reach the Quality Monitoring server.',
        next: 'Check that the phone is on the factory Wi-Fi, then try again.',
        retryable: true,
        tone: 'error'
      }
    case err.status === 401:
      return {
        title: 'Please sign in again',
        message: serverText ?? 'Your session has ended.',
        next: 'Sign in with your employee ID and password.',
        retryable: false,
        tone: 'warning'
      }
    case err.status === 403:
      return {
        title: 'Not allowed',
        message: serverText ?? 'Your account is not allowed to do this.',
        next: 'Ask your supervisor if you need access.',
        retryable: false,
        tone: 'warning'
      }
    case err.status === 404:
      return {
        title,
        message: serverText ?? 'This item no longer exists. It may have been removed.',
        next: 'Go back and open the list again.',
        retryable: false,
        tone: 'warning'
      }
    case err.status === 409:
      return {
        title,
        message: serverText ?? 'This was changed in the meantime.',
        next: 'The screen shows the latest information now.',
        retryable: false,
        tone: 'warning'
      }
    case err.status === 413 || /too large/i.test(err.message):
      return {
        title: 'File too large',
        message: serverText ?? 'The photo or video is too large to upload.',
        next: 'Take a shorter video or a new photo, then submit again.',
        retryable: false,
        tone: 'warning'
      }
    case err.status >= 500:
      return {
        title,
        message: 'The server had a problem and nothing was saved.',
        next: 'Try again in a moment. If it keeps happening, tell your supervisor.',
        retryable: true,
        tone: 'error'
      }
    default:
      return {
        title,
        message: serverText ?? 'Some information is missing or not in the right format.',
        next: serverText ? null : 'Check what you entered and try again.',
        retryable: false,
        tone: 'warning'
      }
  }
}

/** The same explanation as one line, for messages shown on the screen instead of in a popup. */
export function friendlyMessage(err: unknown): string {
  const e = describeError(err)
  return [e.message, e.next].filter(Boolean).join(' ')
}
