import { badRequest } from '../lib/http'

export type ParameterType = 'NUMBER' | 'TEXT' | 'DROPDOWN' | 'YES_NO' | 'PASS_FAIL' | 'PHOTO'

/** Stored as the value of a Photo parameter (e.g. Ink Photo) once its photo is attached. */
export const PHOTO_VALUE = 'Photo attached'

export interface ParameterConfig {
  name: string
  type: ParameterType
  unit: string | null
  minValue: number | null
  maxValue: number | null
  options: string[]
  /**
   * Dropdown only: a first choice made before `options`, e.g. the material before the dyne. The
   * reading is then stored as "<material>, <option>". Absent or empty for an ordinary dropdown.
   */
  materialOptions?: string[] | null
  /** Dropdown only: the worker may choose several options. Absent (older callers) means one. */
  multiSelect?: boolean | null
}

/** How several chosen dropdown options are stored and shown: one readable, comma-separated value. */
export const MULTI_SEPARATOR = ', '

/**
 * The options a worker chose for a dropdown, from either a list or the stored text. An option whose
 * own text contains a comma is matched whole first, so it is never split in half.
 */
export function dropdownSelection(p: ParameterConfig, raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.map((v) => String(v).trim())
    : (() => {
        const text = String(raw).trim()
        if (p.options.includes(text)) return [text]
        if (!p.multiSelect && !p.materialOptions?.length) return [text]
        return text.split(',').map((v) => v.trim())
      })()
  const chosen = parts.filter(Boolean)
  // Kept in the order the admin listed them, so the same choice always reads the same way.
  return p.multiSelect ? p.options.filter((o) => chosen.includes(o)).concat(chosen.filter((c) => !p.options.includes(c))) : chosen
}

const formatNumber = (n: number) => String(Number(n.toFixed(4)))

/** Human-readable acceptance rule, e.g. "18 – 22 sec". */
export function ruleText(p: ParameterConfig): string | null {
  const unit = p.unit ? ` ${p.unit}` : ''
  switch (p.type) {
    case 'NUMBER':
      if (p.minValue != null && p.maxValue != null) return `${formatNumber(p.minValue)} – ${formatNumber(p.maxValue)}${unit}`
      if (p.minValue != null) return `Minimum ${formatNumber(p.minValue)}${unit}`
      if (p.maxValue != null) return `Maximum ${formatNumber(p.maxValue)}${unit}`
      return p.unit ? `Value in ${p.unit}` : null
    case 'PASS_FAIL':
      return 'Pass or Fail'
    case 'YES_NO':
      return 'Yes or No'
    case 'DROPDOWN': {
      if (!p.options.length) return null
      const verb = p.multiSelect ? 'Choose one or more' : 'Choose one'
      if (p.materialOptions?.length) return `Material: ${p.materialOptions.join(' / ')}, then ${verb.toLowerCase()}: ${p.options.join(', ')}`
      return `${verb}: ${p.options.join(', ')}`
    }
    case 'PHOTO':
      return 'Photo'
    default:
      return null
  }
}

export function isEmpty(raw: unknown): boolean {
  if (Array.isArray(raw)) return raw.every((v) => isEmpty(v))
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')
}

/**
 * A parameter the worker marked "Not Applicable", with the reason. It is recorded as a value
 * with result NA: N/A never counts as a failed reading and never makes the check FAIL.
 */
export function notApplicableValue(reason: string | null, remark: string | null) {
  return { value: null, result: 'NA' as const, notApplicable: true, naReason: reason, naRemark: remark ?? null }
}

/** A real reading: validated, then PASS / FAIL / NA against the parameter's limits. */
export function readingValue(p: ParameterConfig, raw: unknown) {
  return { ...evaluateValue(p, raw), notApplicable: false, naReason: null, naRemark: null }
}

/** An optional parameter left empty: stored without a result, and never a failure. */
export function emptyValue() {
  return { value: null, result: 'NA' as const, notApplicable: false, naReason: null, naRemark: null }
}

/** Validates a submitted value and works out PASS / FAIL / NA. Throws 400 on invalid input. */
export function evaluateValue(p: ParameterConfig, raw: unknown): { value: string; result: 'PASS' | 'FAIL' | 'NA' } {
  const text = String(raw).trim()

  switch (p.type) {
    case 'NUMBER': {
      const num = Number(text.replace(',', '.'))
      if (!Number.isFinite(num)) throw badRequest(`${p.name} must be a number`)
      if (p.minValue == null && p.maxValue == null) return { value: formatNumber(num), result: 'NA' }
      const ok = (p.minValue == null || num >= p.minValue) && (p.maxValue == null || num <= p.maxValue)
      return { value: formatNumber(num), result: ok ? 'PASS' : 'FAIL' }
    }
    case 'PASS_FAIL': {
      const v = text.toUpperCase()
      if (v !== 'PASS' && v !== 'FAIL') throw badRequest(`${p.name} must be Pass or Fail`)
      return { value: v, result: v }
    }
    case 'YES_NO': {
      const v = text.toUpperCase()
      if (v !== 'YES' && v !== 'NO') throw badRequest(`${p.name} must be Yes or No`)
      return { value: v, result: 'NA' }
    }
    case 'DROPDOWN': {
      const chosen = dropdownSelection(p, raw)
      if (p.materialOptions?.length) {
        // Two answers in one reading: the material, then the option. Both are required.
        const material = chosen.find((c) => p.materialOptions!.includes(c))
        const option = chosen.find((c) => p.options.includes(c))
        if (!material) throw badRequest(`${p.name}: choose the material first`)
        if (!option) throw badRequest(`${p.name}: choose one of the listed options`)
        if (chosen.some((c) => c !== material && c !== option)) throw badRequest(`${p.name}: choose one material and one option`)
        return { value: [material, option].join(MULTI_SEPARATOR), result: 'NA' }
      }
      const unknown = chosen.find((c) => !p.options.includes(c))
      if (unknown || chosen.length === 0) throw badRequest(`${p.name}: choose ${p.multiSelect ? 'from' : 'one of'} the listed options`)
      if (!p.multiSelect && chosen.length > 1) throw badRequest(`${p.name}: choose one of the listed options`)
      return { value: [...new Set(chosen)].join(MULTI_SEPARATOR), result: 'NA' }
    }
    case 'PHOTO':
      // The answer is the photo itself; the submit route checks that it is attached.
      return { value: PHOTO_VALUE, result: 'NA' }
    case 'TEXT':
    default:
      if (text.length > 1000) throw badRequest(`${p.name} is too long`)
      return { value: text, result: 'NA' }
  }
}
