import { badRequest } from '../lib/http'

export type ParameterType = 'NUMBER' | 'TEXT' | 'DROPDOWN' | 'YES_NO' | 'PASS_FAIL' | 'PHOTO'

/** The largest number accepted as a reading. */
const MAX_READING = 1_000_000_000

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
  /**
   * Pass / Fail only: measurements entered before the answer, e.g. Height, Width, Gusset (in
   * `unit`). Absent or empty for a plain Pass / Fail.
   */
  measureFields?: string[] | null
  /** The measurements are asked for only while this is on. Absent (older callers) means on. */
  measureEnabled?: boolean | null
}

/** How several chosen dropdown options are stored and shown: one readable, comma-separated value. */
export const MULTI_SEPARATOR = ', '

/** Between the answer and each measurement of a measured Pass / Fail: "PASS · Height 120 mm · …". */
export const MEASURE_SEPARATOR = ' · '

/** The measurements a Pass / Fail asks for now: none while the Super Admin or an Admin has them off. */
export const activeMeasureFields = (p: Pick<ParameterConfig, 'measureFields' | 'measureEnabled'>): string[] =>
  p.measureEnabled === false ? [] : (p.measureFields ?? [])

const hasMeasures = (p: ParameterConfig) => activeMeasureFields(p).length > 0

/**
 * A measured Pass / Fail's answer and measurements, from the stored or submitted text
 * ("PASS · Height 120 mm · Width 80 mm · Gusset 30 mm"). A measurement is found by its field name,
 * the longest name first, so "Width 2" is never read as "Width". Missing parts are null.
 */
export function measuredAnswer(p: ParameterConfig, raw: unknown): { result: 'PASS' | 'FAIL' | null; values: Record<string, number | null> } {
  const fields = [...(p.measureFields ?? [])].sort((a, b) => b.length - a.length)
  const values: Record<string, number | null> = Object.fromEntries((p.measureFields ?? []).map((f) => [f, null]))
  let result: 'PASS' | 'FAIL' | null = null
  for (const token of String(raw ?? '').split('·').map((t) => t.trim()).filter(Boolean)) {
    const upper = token.toUpperCase()
    if (upper === 'PASS' || upper === 'FAIL') {
      result = upper
      continue
    }
    const field = fields.find((f) => token.toLowerCase().startsWith(f.toLowerCase()))
    if (!field) continue
    const number = token.slice(field.length).match(/-?\d+(?:[.,]\d+)?/)
    values[field] = number ? Number(number[0].replace(',', '.')) : null
  }
  return { result, values }
}

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
      return hasMeasures(p) ? `${p.measureFields!.join(', ')}${p.unit ? ` (${p.unit})` : ''}, then Pass or Fail` : 'Pass or Fail'
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
      // No plant reading is this large; a value like 1e308 is a typing or input error.
      if (Math.abs(num) > MAX_READING) throw badRequest(`${p.name} is out of range. Check the reading.`)
      if (p.minValue == null && p.maxValue == null) return { value: formatNumber(num), result: 'NA' }
      const ok = (p.minValue == null || num >= p.minValue) && (p.maxValue == null || num <= p.maxValue)
      return { value: formatNumber(num), result: ok ? 'PASS' : 'FAIL' }
    }
    case 'PASS_FAIL': {
      if (hasMeasures(p)) {
        // Every measurement, then the answer: stored together as one readable reading.
        const answer = measuredAnswer(p, raw)
        // A form opened while the measurements were off sends a plain answer: it must be reopened.
        if (p.measureFields!.every((field) => answer.values[field] == null) && /^(PASS|FAIL)$/i.test(text)) {
          throw badRequest(`${p.name} now asks for ${p.measureFields!.join(', ')}. Go back and open the check again.`)
        }
        for (const field of p.measureFields!) {
          const n = answer.values[field]
          if (n == null) throw badRequest(`${p.name}: enter the ${field}`)
          if (!(n > 0) || n > MAX_READING) throw badRequest(`${p.name}: the ${field} must be a number above 0`)
        }
        if (!answer.result) throw badRequest(`${p.name}: choose Pass or Fail`)
        const unit = p.unit ? ` ${p.unit}` : ''
        const parts = p.measureFields!.map((field) => `${field} ${formatNumber(answer.values[field]!)}${unit}`)
        return { value: [answer.result, ...parts].join(MEASURE_SEPARATOR), result: answer.result }
      }
      // A form opened while measurements were on may still send them: only the answer is kept.
      const v = text.split('·')[0].trim().toUpperCase()
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
