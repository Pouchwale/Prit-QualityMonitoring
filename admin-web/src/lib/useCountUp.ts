import { useEffect, useRef, useState } from 'react'

/**
 * A figure that counts up to its value when it first appears (and glides to a new value when it
 * changes), e.g. 0 → 74 or 0% → 16.2%. Text that is not a number ("—", "4 / 0") is shown as it is.
 * Users who ask their system for reduced motion see the value straight away.
 */
const NUMBER = /^(-?)(\d+(?:\.\d+)?)(.*)$/

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function useCountUp(value: React.ReactNode, duration = 400): React.ReactNode {
  const parsed = typeof value === 'number' ? { sign: value < 0 ? -1 : 1, n: Math.abs(value), decimals: decimalsOf(String(value)), suffix: '' } : parse(value)
  const target = parsed ? parsed.sign * parsed.n : null
  const [shown, setShown] = useState<number | null>(target === null || reduced() ? target : 0)
  const from = useRef(0)

  useEffect(() => {
    if (target === null) return
    if (reduced()) {
      setShown(target)
      return
    }
    const start = performance.now()
    const begin = from.current
    let frame = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      const v = begin + (target - begin) * eased
      setShown(v)
      if (t < 1) frame = requestAnimationFrame(step)
      else from.current = target
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target, duration])

  if (!parsed || shown === null) return value
  const text = shown.toFixed(parsed.decimals)
  // Whole numbers keep their thousands separators while counting.
  const pretty = parsed.decimals === 0 ? Math.round(shown).toLocaleString('en-IN') : text
  return `${pretty}${parsed.suffix}`
}

function decimalsOf(s: string) {
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}

function parse(value: React.ReactNode) {
  if (typeof value !== 'string') return null
  const m = NUMBER.exec(value.replace(/,/g, '').trim())
  // Only a plain number with an optional unit (%, h, days): "4 / 0" or "12 of 36" stay as text.
  if (!m || /\d/.test(m[3])) return null
  return { sign: m[1] ? -1 : 1, n: Number(m[2]), decimals: decimalsOf(m[2]), suffix: m[3] }
}
