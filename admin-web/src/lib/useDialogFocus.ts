import { useEffect, useLayoutEffect, useRef } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])'

/**
 * Keyboard and screen-reader behaviour of a dialog, drawer or slide-in panel while it is open:
 *  - focus moves into it: the element marked `data-autofocus`, else the first field of the part
 *    marked `data-dialog-body`, else the dialog itself;
 *  - Tab and Shift+Tab stay inside it instead of reaching the page behind;
 *  - Escape calls `onClose` (unless `closeOnEscape` is false);
 *  - on close, focus returns to whatever opened it, so keyboard users keep their place.
 * Returns the ref to put on the dialog element.
 */
export function useDialogFocus<T extends HTMLElement>(isOpen: boolean, onClose: () => void, closeOnEscape = true) {
  const ref = useRef<T>(null)
  // The latest onClose, without re-running the effect (and moving focus) when the parent re-renders.
  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })

  useEffect(() => {
    if (!isOpen) return
    const opener = document.activeElement as HTMLElement | null
    const node = ref.current
    const focusables = () => (node ? [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement) : [])

    // Focus inside, unless something inside already has it (e.g. an autoFocus field).
    if (node && !node.contains(document.activeElement)) {
      // The marked element, else the first field of the body, else the dialog itself (its title is read).
      const body = node.querySelector<HTMLElement>('[data-dialog-body]')
      const firstInBody = body ? [...body.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => el.offsetParent !== null) : undefined
      const target = node.querySelector<HTMLElement>('[data-autofocus]') ?? firstInBody ?? node
      target.focus({ preventScroll: true })
    }

    /** Only the dialog on top answers keys: e.g. a confirmation opened over a drawer. */
    const onTop = () => {
      if (!node) return false
      const active = document.activeElement
      if (active && node.contains(active)) return true
      if (active?.closest('[aria-modal="true"]')) return false
      const open = document.querySelectorAll('[aria-modal="true"]')
      return open[open.length - 1] === node
    }

    const onKey = (e: KeyboardEvent) => {
      if (!node || !onTop()) return
      if (e.key === 'Escape' && closeOnEscape) {
        e.stopPropagation()
        close.current()
        return
      }
      if (e.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) {
        e.preventDefault()
        node.focus()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      if (e.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // Back to the button that opened it, if it is still on the page.
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true })
    }
  }, [isOpen, closeOnEscape])

  return ref
}
