import type { Request } from 'express'
import { z } from 'zod'
import { HHMM_REGEX } from './time'
import { badRequest } from './http'

export const idParam = (req: Request, name = 'id') => z.uuid('Invalid id').parse(req.params[name])

export const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null))

/**
 * The one Item Code format: FGPO, FGLA or FGSL followed by digits, e.g. FGPO123. The worker app
 * (utils/itemCode.ts) and the admin panel (lib/itemCode.ts) copy this pattern and message.
 */
export const ITEM_CODE_PATTERN = /^(FGPO|FGLA|FGSL)\d+$/
export const ITEM_CODE_ERROR = 'Invalid Item Code. Only FGPO, FGLA, or FGSL followed by numbers are allowed. Example: FGPO123 (several: FGPO123, FGPO234).'

/**
 * Several Item Codes or PO Nos. in one field, separated by commas ("FGPO123, fgpo234"): each one
 * trimmed (Item Codes also upper-cased), empty parts and repeats dropped. One value gives a list of one.
 */
export function splitCodes(raw: string | null | undefined, upper = true): string[] {
  const seen = new Map<string, string>()
  for (const part of (raw ?? '').split(',')) {
    const value = upper ? part.trim().toUpperCase() : part.trim()
    if (value && !seen.has(value.toLowerCase())) seen.set(value.toLowerCase(), value)
  }
  return [...seen.values()]
}

/**
 * The Item Code(s) as typed, trimmed and upper-cased: one ("fgpo123" -> "FGPO123") or several
 * separated by commas ("fgpo123,FGPO234" -> "FGPO123, FGPO234"); empty stays empty. Every code must
 * match the format; anything else is refused (400), never corrected.
 */
export function validItemCode(raw: string | null | undefined): string {
  const codes = splitCodes(raw)
  if (codes.some((code) => !ITEM_CODE_PATTERN.test(code))) throw badRequest(ITEM_CODE_ERROR)
  return codes.join(', ')
}

/**
 * Exception reasons about the machine itself (stopped, maintenance, breakdown) need only the machine.
 * ponytail: matched on the admin-editable label; add a flag on exception_reasons if labels drift.
 */
export const isMachineReason = (reason: string) => /machine|maintenance|breakdown/i.test(reason)

/** Why an exception cannot be sent without its machine and PO No. / Item Code; null when all needed are there. */
export function exceptionDetailsError(machineId: string | null | undefined, poOrItemCode: string | null | undefined, machineOnly = false) {
  const machine = !!machineId?.trim()
  const po = !!poOrItemCode?.trim()
  if (machineOnly) return machine ? null : 'Machine Name is required for an Exception.'
  if (machine && po) return null
  if (!machine && !po) return 'Machine Name and PO No. / Item Code are required for an Exception.'
  return `${machine ? 'PO No. / Item Code' : 'Machine Name'} is required for an Exception.`
}

export const hhmm =z.string().regex(HHMM_REGEX, 'Use 24-hour time like 08:00')

export const optionalUuid = z
  .union([z.uuid(), z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null))

/**
 * A reading an exception reason asks for (e.g. White Viscosity → Viscosity in sec): a number above 0,
 * at most 2 decimals, below 100000. Commas and spaces are not part of a number here ("21,5" is
 * refused, not guessed). `what` names it in the error, e.g. "Viscosity (sec)".
 */
export function validReading(raw: unknown, what: string): number {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw badRequest(`Enter the ${what} value`)
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(text) || Number(text) <= 0) {
    throw badRequest(`Enter a valid ${what} value: a number above 0 with at most 2 decimals, e.g. 21.5`)
  }
  return Number(text)
}

/** "Viscosity: 21.5 sec", for every place an exception is shown; null when the exception has no reading. */
export function readingText(e: { readingLabel: string | null; readingValue: number | null; readingUnit: string | null }): string | null {
  if (e.readingValue === null || e.readingValue === undefined) return null
  return `${e.readingLabel ?? 'Reading'}: ${e.readingValue}${e.readingUnit ? ` ${e.readingUnit}` : ''}`
}
